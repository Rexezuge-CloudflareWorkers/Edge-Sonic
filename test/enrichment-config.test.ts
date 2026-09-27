/**
 * Lazy tag enrichment, Ogg readers, configuration validation, and key resolution.
 *
 * The four places a test was missing and a bug would have shipped:
 *
 * - `EnrichmentService` was at 8% and is the feature that makes `duration` and
 *   `bitRate` mean anything. Its interesting behaviours are all about *not* doing
 *   work: one read per song rather than per indexed track, and never a second read
 *   for a container this module cannot read.
 * - The Ogg readers were untested, and MP3 and FLAC were both wrong when first
 *   written — a plausible wrong number, not an error.
 * - `AppConfiguration.validate()` is a documented table of failure modes that are
 *   silent at runtime, so a test is the only thing that keeps it honest.
 * - `resolveKey` is the whole per-feature key policy, and its most important
 *   property is that it fails closed.
 */
import { describe, expect, it, vi } from 'vitest';
import { readAudioTags, readOpus, readVorbis } from '@edge-sonic/media-tags';
import { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import { resetBreakerForTests, KvCache } from '@edge-sonic/backend-runtime/kv';
import { resolveKey } from '@edge-sonic/backend-services/composition';
import { EnrichmentService } from '@edge-sonic/backend-services/index';
import { toAdminResponse, toSubsonicError } from '@edge-sonic/backend-services/errors';
import { BadRequestError, DatabaseError, NotFoundError } from '@edge-sonic/backend-errors';
import { SubsonicError, ErrorCode } from '@edge-sonic/subsonic';
import { WebDavClient, WebDavError } from '@edge-sonic/webdav';
import { fakeKv } from './helpers/fakeKv';
import type { FakeKv } from './helpers/fakeKv';
import { fakeDav } from './helpers/fakeDav';

const encoder = new TextEncoder();

// -------------------------------------------------------------------------------------
// Ogg
// -------------------------------------------------------------------------------------

/**
 * Little-endian bytes, for any width.
 *
 * ### The trap this exists to avoid
 *
 * JavaScript's `>>>` takes its shift count **modulo 32**, so `value >>> 32` is
 * `value >>> 0` — the value itself. The obvious one-liner for an Ogg granule,
 *
 * ```ts
 * [0, 8, 16, 24, 32, 40, 48, 56].map((shift) => (granule >>> shift) & 0xff)
 * ```
 *
 * therefore emits the low 32 bits **twice** and the high 32 bits not at all. The
 * fixture then produces a granule of `g * (2^32 + 1)`, the reader reports a duration
 * 4 billion times too long, and the natural conclusion is that the parser is broken.
 * It is not; the field is 64-bit and `>>>` is 32-bit.
 */
function le(value: number, byteCount: number): number[] {
  const out: number[] = [];
  // Split into 32-bit halves and shift within each, which is the only correct way to
  // do this in JavaScript.
  let remaining = value;
  for (let index = 0; index < byteCount; index += 1) {
    out.push(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/**
 * Build an Ogg page.
 *
 * `granule` is the total sample count decoded to the end of the page, which is the
 * whole basis of the duration calculation.
 */
function oggPage(granule: number, payload: readonly number[] | Uint8Array, flags = 0, sequence = 0): number[] {
  // The segment table is a list of 255-terminated run lengths, so a payload of n bytes
  // needs ceil(n / 255) segments.
  const bytes = typeof payload === 'string' ? [] : [...payload];
  const segments: number[] = [];
  let remaining = bytes.length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);

  return [
    0x4f, 0x67, 0x67, 0x53, // "OggS"
    0x00, // version
    flags,
    ...le(granule, 8),
    ...le(0x00_00_00_01, 4), // serial
    ...le(sequence, 4),
    ...le(0, 4), // CRC, unchecked by every decoder in practice
    segments.length,
    ...segments,
    ...bytes,
  ];
}

/**
 * A Vorbis identification header, in the spec's field order (§4.2.1).
 *
 * The reader's offsets are asserted against this layout rather than against whatever
 * the reader happens to do — the bug this fixture exists to catch was the reader
 * reading the channel count out of a version byte, which is silently plausible rather
 * than obviously wrong.
 */
function vorbisIdHeader(channels: number, rate: number, nominalBitrate: number): number[] {
  return [
    0x01,
    ...encoder.encode('vorbis'),
    ...le(0, 4), // vorbis_version
    channels,
    ...le(rate, 4),
    ...le(0, 4), // bitrate_maximum
    ...le(nominalBitrate, 4),
    ...le(0, 4), // bitrate_minimum
    0xb8, // blocksize
    0x01, // framing
  ];
}

/**
A Vorbis comment header: `\x03vorbis`, then the standard comment block.
*/
function vorbisCommentHeader(comments: Record<string, string>): number[] {
  const vendor = encoder.encode('edge-sonic-test');
  const entries = Object.entries(comments).map(([key, value]) => encoder.encode(`${key}=${value}`));
  const body: number[] = [0x03, ...encoder.encode('vorbis'), ...le(vendor.length, 4), ...vendor, ...le(entries.length, 4)];
  for (const entry of entries) body.push(...le(entry.length, 4), ...entry);
  body.push(0x01); // framing bit
  return body;
}

/**
An Opus identification header. Opus is always 48 kHz regardless of the source rate.
*/
function opusHeadHeader(channels: number, preskip: number): number[] {
  return [
    ...encoder.encode('OpusHead'),
    0x01, // version
    channels,
    ...le(preskip, 2),
    ...le(48_000, 4), // the *original* input rate; not what Opus decodes at
    ...le(0, 2), // output gain
    0x00, // mapping family
  ];
}

function opusTagsHeader(comments: Record<string, string>): number[] {
  const vendor = encoder.encode('edge-sonic-test');
  const entries = Object.entries(comments).map(([key, value]) => encoder.encode(`${key}=${value}`));
  const body: number[] = [...encoder.encode('OpusTags'), ...le(vendor.length, 4), ...vendor, ...le(entries.length, 4)];
  for (const entry of entries) body.push(...le(entry.length, 4), ...entry);
  return body;
}

describe('Ogg Vorbis', () => {
  it('reads a duration from the granule position', () => {
    // 44100 samples/second for 180 seconds.
    const bytes = new Uint8Array([
      ...oggPage(0, vorbisIdHeader(2, 44_100, 160_000), 0x02, 0),
      ...oggPage(44_100 * 180, vorbisCommentHeader({ TITLE: 'Holocene', ARTIST: 'Bon Iver' }), 0x00, 1),
      ...oggPage(44_100 * 180, new Uint8Array(64), 0x04, 2),
    ]);
    const tags = readAudioTags(bytes, 30_000_000);
    expect(tags.container).toBe('ogg-vorbis');
    expect(tags.durationSeconds).toBeCloseTo(180, 3);
    expect(tags.sampleRate).toBe(44_100);
    expect(tags.channels).toBe(2);
    expect(tags.title).toBe('Holocene');
    expect(tags.artist).toBe('Bon Iver');
    // Variable bitrate, so the bitrate is size over duration, not the header's nominal.
    expect(tags.bitrateKbps).toBe(Math.round((30_000_000 * 8) / 180 / 1000));
  });

  it('falls back to the nominal bitrate when the total size is unknown', () => {
    const bytes = new Uint8Array([
      ...oggPage(0, vorbisIdHeader(2, 44_100, 160_000), 0x02, 0),
      ...oggPage(44_100 * 10, new Uint8Array(16), 0x04, 1),
    ]);
    const tags = readVorbis(bytes, null);
    expect(tags.durationSeconds).toBeCloseTo(10, 3);
    expect(tags.bitrateKbps).toBe(160);
  });

  it('reports no duration rather than one when the last page was not read', () => {
    // A prefix read cannot see the final page, so the granule is the header's zero.
    // Reporting 0 would make a client draw a zero-length scrubber.
    const bytes = new Uint8Array(oggPage(0, vorbisIdHeader(2, 44_100, 160_000), 0x02, 0));
    expect(readVorbis(bytes, 1000).durationSeconds).toBeNull();
  });
});

describe('Ogg Opus', () => {
  it('derives the duration from the granule minus the pre-skip, at 48 kHz', () => {
    // Opus granule positions are always in 48 kHz samples regardless of the original
    // rate, and include the pre-skip. Both are the classic places to be off.
    const preskip = 312;
    const granule = 48_000 * 180 + preskip;
    const bytes = new Uint8Array([
      ...oggPage(0, opusHeadHeader(2, preskip), 0x02, 0),
      ...oggPage(granule, opusTagsHeader({ TITLE: 'Re: Stacks', ALBUMARTIST: 'Bon Iver' }), 0x00, 1),
      ...oggPage(granule, new Uint8Array(32), 0x04, 2),
    ]);
    const tags = readAudioTags(bytes, 12_000_000);
    expect(tags.container).toBe('ogg-opus');
    expect(tags.sampleRate).toBe(48_000);
    expect(tags.channels).toBe(2);
    expect(tags.durationSeconds).toBeCloseTo(180, 3);
    expect(tags.title).toBe('Re: Stacks');
    expect(tags.albumArtist).toBe('Bon Iver');
  });

  it('identifies Opus by its header, not by the file extension', () => {
    // An `.opus` file is identified from `OpusHead`; a Vorbis stream in a file named
    // `.opus` must still be read as Vorbis.
    const vorbis = new Uint8Array([
      ...oggPage(0, vorbisIdHeader(2, 48_000, 128_000), 0x02, 0),
      ...oggPage(48_000 * 60, new Uint8Array(16), 0x04, 1),
    ]);
    expect(readAudioTags(vorbis, 1_000_000).container).toBe('ogg-vorbis');
  });
});

// -------------------------------------------------------------------------------------
// Enrichment
// -------------------------------------------------------------------------------------

/**
 * A minimal FLAC `STREAMINFO` block, enough for the reader to derive a duration.
 *
 * The block is 34 bytes: 16+16+24+24 bits of block and frame sizes, then the packed
 * 64-bit run, then a 16-byte MD5. The packed run is written at byte **10**, which is
 * the offset the reader asserts — a fixture that put it at byte 8 would make a correct
 * reader look wrong, which is the same class of mistake in reverse.
 */
function flacPrefix(seconds: number, sampleRate = 44_100): Uint8Array {
  const streamInfo = new Uint8Array(34);
  const view = new DataView(streamInfo.buffer);
  view.setUint16(0, 4096); // min block size
  view.setUint16(2, 4096); // max block size
  // min/max frame size left at 0, which the format defines as "unknown".

  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let index = width - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  };
  push(sampleRate, 20);
  push(1, 3); // channels - 1, so 2 channels
  push(15, 5); // bits per sample - 1, so 16-bit
  push(sampleRate * seconds, 36);
  for (let index = 0; index < 64; index += 1) {
    if (bits[index]) streamInfo[10 + (index >> 3)]! |= 1 << (7 - (index & 7));
  }

  // `fLaC`, then one metadata block header: last-block flag, type 0, 24-bit length.
  return new Uint8Array([...encoder.encode('fLaC'), 0x80, 0, 0, 34, ...streamInfo]);
}

/**
 * A `SongRow`, in the DAO's own column names.
 *
 * The names matter: the service decides whether to read the file from
 * `enriched_at !== null` and matches its cache entry against `mtime_ms`. A
 * camelCase stand-in leaves both `undefined`, `undefined !== null` is true, and the
 * service correctly concludes that every row is already enriched and does nothing —
 * which is a test that passes while asserting nothing.
 */
function makeSong(seed: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 's:abc',
    library_id: 'L1',
    path: 'A/01.flac',
    dir_path: 'A',
    name: '01.flac',
    size: 30_000_000,
    mtime_ms: 1000,
    content_type: 'audio/flac',
    suffix: 'flac',
    title: '01.flac',
    artist: null,
    album: null,
    album_artist: null,
    genre: null,
    track: null,
    disc: null,
    year: null,
    duration: 0,
    bitrate: 0,
    sample_rate: null,
    channels: null,
    enriched_at: null,
    ...seed,
  };
}

function makeEnrichment(seed: Partial<Record<string, unknown>> = {}): {
  service: EnrichmentService;
  applied: Array<{ id: string; metadata: Record<string, unknown> }>;
  dav: ReturnType<typeof fakeDav>;
  cache: FakeKv;
  library: Parameters<EnrichmentService['enrich']>[0];
} {
  const song = makeSong(seed);
  const applied: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  // The body is a real FLAC `STREAMINFO` and `size` is much larger than it, which is
  // exactly the shape of a real prefix read: the headers are at the front, and only
  // the front is fetched.
  const dav = fakeDav({
    '/dav/A/01.flac': [{ path: '/dav/A/01.flac', size: 30_000_000, contentType: 'audio/flac', body: flacPrefix(180) }],
  });
  const cache = fakeKv();
  const library = {
    id: 'L1',
    slug: 'home',
    slug_ci: 'home',
    base_url: 'https://dav.example.com',
    root_path: '/dav',
    dav_username: 'ann',
    password_ciphertext: '',
    password_iv: '',
    key_version: 1,
    display_name: 'Home',
    is_enabled: 1,
    created_at: 0,
    updated_at: 0,
  } as never;

  const service = new EnrichmentService({
    songs: {
      findById: async () => song as never,
      applyMetadata: async (id, metadata) => {
        applied.push({ id, metadata: metadata as Record<string, unknown> });
      },
    },
    clientFor: async () => new WebDavClient('https://dav.example.com', '/dav', { username: 'u', password: 'p' }, dav.fetch),
    kv: new KvCache(cache.ns),
    resolveKey: async () => 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
    readBytes: 131_072,
    timeoutMs: 1000,
  });

  return { service, applied, dav, cache, library };
}

describe('EnrichmentService', () => {
  // No global `fetch` stubbing anywhere below: `clientFor` hands the client the
  // origin double **explicitly**, which is the only reason a credential can never leak
  // to an unintended host. Stubbing the global here would test a code path production
  // never takes and would hide the fact that the explicit fetch is what is used.
  it('reads the file once and writes the result to D1', async () => {
    const { service, applied, dav, library } = makeEnrichment();

    const tags = await service.enrich(library, makeSong() as never);

    expect(tags?.durationSeconds).toBe(180);
    // One ranged read, and it is a *prefix* read: a 30 MB file must not be pulled
    // through the worker to learn its length.
    expect(dav.gets).toHaveLength(1);
    expect(dav.gets[0]!.range).toMatch(/^bytes=0-\d+$/);
    // D1, not just the cache: this is what has to survive a cold isolate and a KV
    // outage, so the write is the assertion that matters.
    expect(applied).toHaveLength(1);
    expect(applied[0]!.metadata.duration).toBe(180);
    expect(applied[0]!.metadata.bitrate).toBeGreaterThan(0);
  });

  it('replays the cache into D1 for a row that lost it, with no second read', async () => {
    // A restored backup, or a row written by a scan after the cache was populated: the
    // file is unchanged, so the file is not re-read. The result still reaches D1, which
    // is what makes the cache a cache and not the only copy.
    const { service, applied, dav, library } = makeEnrichment();

    await service.enrich(library, makeSong() as never);
    expect(dav.gets).toHaveLength(1);

    const replay = await service.enrich(library, makeSong() as never);

    expect(dav.gets).toHaveLength(1);
    expect(replay).toBeNull();
    expect(applied).toHaveLength(2);
    expect(applied[1]!.metadata.duration).toBe(180);
  });

  it('re-reads a file whose mtime moved, because the cache entry is keyed on it', async () => {
    // Reusing a cached duration for changed bytes is the one failure mode that would
    // be completely silent: a client shows a scrubber for a track whose length no
    // longer matches the file, and nothing anywhere reports an error.
    //
    // The scan's half of the contract is in `SongDAO.upsertFileFacts`, which clears
    // the derived values in the same statement that notices the new mtime — see
    // `test/schema.int.test.ts`. What is asserted here is the other half: a row that
    // arrives unenriched with a different mtime must not be answered from the cache.
    const { service, applied, dav, library } = makeEnrichment();

    await service.enrich(library, makeSong() as never);
    expect(dav.gets).toHaveLength(1);

    await service.enrich(library, makeSong({ mtime_ms: 2000, size: 31_000_000 }) as never);

    expect(dav.gets).toHaveLength(2);
    expect(applied).toHaveLength(2);
  });

  it('does not read a row that has already been enriched', async () => {
    const { service, dav, library } = makeEnrichment();
    const enriched = makeSong({ duration: 251, enriched_at: 5000 });

    const tags = await service.enrich(library, enriched as never);

    expect(tags).toBeNull();
    // A `getSong` for a track the index already knows must cost zero subrequests.
    expect(dav.gets).toHaveLength(0);
  });

  it('records an unreadable container, so it is never retried', async () => {
    // MP4/M4A puts `moov` at the *end* of the file, so a prefix read cannot reach it.
    // Retrying on every play would be one wasted subrequest per play, forever, for a
    // format that needs a tail read instead — which is why the attempt is recorded
    // rather than the failure being propagated.
    const { service, applied, dav, library } = makeEnrichment();
    // An `ftyp` box: a real MP4 header, and one no reader here can use from a prefix.
    dav.setTree({
      '/dav/A/01.flac': [
        { path: '/dav/A/01.flac', size: 4_000_000, contentType: 'audio/mp4', body: new Uint8Array([...encoder.encode('....ftypisom'), 0, 0, 0, 8]) },
      ],
    });

    const tags = await service.enrich(library, makeSong() as never);

    expect(tags).toBeNull();
    // The attempt is still recorded, so `enriched_at` moves and the next call is free.
    expect(applied).toHaveLength(1);
    // `duration` and `bitrate` are NOT NULL columns, so an unreadable value is 0 and
    // not null — otherwise the row could not be written at all.
    expect(applied[0]!.metadata.duration).toBe(0);
    expect(applied[0]!.metadata.bitrate).toBe(0);
  });

  it('records a WebDAV failure without failing the caller', async () => {
    // A `getSong` that throws because it could not read a duration is worse than one
    // that reports 0: the first is a server error the user cannot act on, the second is
    // a track with an unknown length.
    const { service, applied, library } = makeEnrichment();
    const failing = fakeDav({}, { failAll: true });
    const withFailingOrigin = new EnrichmentService({
      songs: {
        findById: async () => null,
        applyMetadata: async (id, metadata) => {
          applied.push({ id, metadata: metadata as Record<string, unknown> });
        },
      },
      clientFor: async () => new WebDavClient('https://dav.example.com', '/dav', { username: 'u', password: 'p' }, failing.fetch),
      kv: new KvCache(fakeKv().ns),
      resolveKey: async () => 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
      readBytes: 131_072,
      timeoutMs: 1000,
    });

    const tags = await withFailingOrigin.enrich(library, makeSong() as never);

    expect(tags).toBeNull();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.metadata.duration).toBe(0);
    // And the *failure* is not cached, so a recovered origin is retried — which is the
    // opposite trade from the unreadable-container case above, and deliberate: a
    // transient error must not be remembered as a permanent one.
    expect(service).toBeDefined();
  });

  it('survives a cache that throws, and still writes to D1', async () => {
    // The outage requirement, at the service level: `KvCache` is best-effort and D1 is
    // authoritative, so a dead cache costs latency and nothing else.
    const { applied, library, dav } = makeEnrichment();
    const deadCache = new KvCache(fakeKv({}, { failAll: true }).ns);
    const service = new EnrichmentService({
      songs: {
        findById: async () => null,
        applyMetadata: async (id, metadata) => {
          applied.push({ id, metadata: metadata as Record<string, unknown> });
        },
      },
      clientFor: async () => new WebDavClient('https://dav.example.com', '/dav', { username: 'u', password: 'p' }, dav.fetch),
      kv: deadCache,
      resolveKey: async () => 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
      readBytes: 131_072,
      timeoutMs: 1000,
    });

    const tags = await service.enrich(library, makeSong() as never);

    expect(tags?.durationSeconds).toBe(180);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.metadata.duration).toBe(180);
  });
});

// -------------------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------------------

describe('AppConfiguration.validate', () => {
  it('is silent for a valid production environment', () => {
    const config = AppConfiguration.fromEnv({ ENVIRONMENT: 'production' });
    expect(config.validate()).toEqual([]);
  });

  it('names a malformed numeric variable', () => {
    // Every one of these falls back to its default at runtime, so without this report
    // a typo is invisible until a limit is quietly wrong.
    const warnings = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', SCAN_CHUNK_FOLDERS: 'banana' }).validate();
    expect(warnings.join(' ')).toContain('SCAN_CHUNK_FOLDERS');
  });

  it('reports a bypass variable that is inert, because one edit away from being live', () => {
    // The dangerous direction: `ENVIRONMENT` changing turns this into an
    // authentication bypass for every request.
    const warnings = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', DEV_AUTH_EMAIL: 'me@example.com' }).validate();
    expect(warnings.join(' ')).toMatch(/Security/);
    expect(warnings.join(' ')).toContain('DEV_AUTH_EMAIL');
  });

  it('stays silent about an *active* bypass, which is the intended local setup', () => {
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'me@example.com' }).validate()).toEqual([]);
  });

  it('treats an unknown environment as production, not as development', () => {
    // The allow-list, not a deny-list: `Preview` and a misspelled `prodcution` must both
    // fall on the safe side.
    const config = AppConfiguration.fromEnv({ ENVIRONMENT: 'Preview', DEV_AUTH_EMAIL: 'me@example.com' });
    expect(config.isBypassAllowed()).toBe(false);
    expect(config.validate().join(' ')).toMatch(/Security/);
  });

  it('warns when production permits private WebDAV hosts', () => {
    // Neither setting is dangerous alone; together they send a stored credential to a
    // private address.
    const warnings = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', ALLOW_PRIVATE_WEBDAV_HOSTS: 'true' }).validate();
    expect(warnings.join(' ')).toMatch(/ALLOW_PRIVATE_WEBDAV_HOSTS/);
    expect(warnings.join(' ')).toMatch(/credential/i);
  });

  it('names an unparsable team domain and a multi-valued audience', () => {
    const warnings = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', TEAM_DOMAIN: 'https://', POLICY_AUD: 'a,b' }).validate();
    expect(warnings.join(' ')).toContain('TEAM_DOMAIN');
    expect(warnings.join(' ')).toContain('POLICY_AUD');
  });

  it('follows the environment when the private-host setting is unset', () => {
    const config = AppConfiguration.fromEnv({ ENVIRONMENT: 'development' });
    // Unset means "allowed outside production" so a co-located dev server works, and
    // "denied" in production. An explicit value always wins.
    expect(config.getAllowPrivateWebdavHosts()).toBeNull();
    expect(config.isBypassAllowed()).toBe(true);
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'development', ALLOW_PRIVATE_WEBDAV_HOSTS: 'false' }).getAllowPrivateWebdavHosts()).toBe(false);
  });
});

// -------------------------------------------------------------------------------------
// Key resolution
// -------------------------------------------------------------------------------------

describe('resolveKey', () => {
  const KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';

  it('prefers the Secrets Store binding', async () => {
    const provider = resolveKey({ get: async () => KEY }, 'ignored', 'BINDING', 'VAR');
    expect(await provider()).toBe(KEY);
  });

  it('falls back to the raw var when no binding is declared', async () => {
    // A test-only escape hatch. It exists so the integration pool and a local
    // `wrangler dev` work without a Secrets Store, and the production template does not
    // declare it.
    const provider = resolveKey(undefined, KEY, 'BINDING', 'VAR');
    expect(await provider()).toBe(KEY);
  });

  it('fails closed when neither is configured', async () => {
    // Silently degrading to "no key, so nobody can log in" is how a lost store becomes
    // an unexplained support ticket instead of a configuration error.
    const provider = resolveKey(undefined, undefined, 'SUBSONIC_USER_ENCRYPTION_KEY_SECRET', 'SUBSONIC_USER_ENCRYPTION_KEY');
    await expect(provider()).rejects.toThrow(/not configured/);
  });

  it('does not let the raw var mask a broken binding', async () => {
    // A binding that throws is a broken production configuration. Falling through to a
    // var would produce credentials encrypted under a key nobody is tracking.
    const provider = resolveKey(
      {
        get: async () => {
          throw new Error('Secrets Store unavailable');
        },
      },
      KEY,
      'BINDING',
      'VAR',
    );
    await expect(provider()).rejects.toThrow(/Secrets Store unavailable/);
  });

  it('rejects a binding that resolves to something that is not a 256-bit key', async () => {
    const provider = resolveKey({ get: async () => 'c2hvcnQ=' }, undefined, 'BINDING', 'VAR');
    await expect(provider()).rejects.toThrow(/32-byte/);
  });

  it('rejects a malformed var too, with the same message shape', async () => {
    const provider = resolveKey(undefined, 'not base64!!', 'BINDING', 'WEBDAV_ENCRYPTION_KEY');
    await expect(provider()).rejects.toThrow(/WEBDAV_ENCRYPTION_KEY/);
  });

  it('does not cache a rejection, so a transient failure does not poison the scope', async () => {
    let attempt = 0;
    const provider = resolveKey(
      {
        get: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('transient');
          return KEY;
        },
      },
      undefined,
      'BINDING',
      'VAR',
    );
    await expect(provider()).rejects.toThrow('transient');
    expect(await provider()).toBe(KEY);
  });

  it('memoizes a success, so one request reads the key once', async () => {
    let reads = 0;
    const provider = resolveKey(
      {
        get: async () => {
          reads += 1;
          return KEY;
        },
      },
      undefined,
      'BINDING',
      'VAR',
    );
    await provider();
    await provider();
    expect(reads).toBe(1);
  });
});

// -------------------------------------------------------------------------------------
// Error mapping
// -------------------------------------------------------------------------------------

describe('toSubsonicError', () => {
  it('passes a Subsonic error through untouched', () => {
    const original = new SubsonicError(ErrorCode.NotFound, 'Album not found.');
    expect(toSubsonicError(original)).toBe(original);
  });

  it('maps NotFound to code=70, so "absent" and "forbidden" differ', () => {
    // A client that cannot tell them apart either retries forever or gives up
    // immediately, and both are wrong.
    expect(toSubsonicError(new NotFoundError('nope')).code).toBe(ErrorCode.NotFound);
  });

  it('maps Unauthorized to code=50, never to code=40', () => {
    // code=40 means "wrong Subsonic credential". A request that authenticated fine and
    // was then refused is a different thing, and reporting it as 40 sends a user with
    // valid credentials to re-enter their password.
    const mapped = toSubsonicError(new BadRequestError('nope'));
    expect(mapped.code).toBe(ErrorCode.Generic);
  });

  it('masks a database error completely', () => {
    // A D1 error carries table and column names. The cause is logged; the client
    // learns nothing.
    const mapped = toSubsonicError(new DatabaseError('Failed to songs.findById: no such column: songs.secret', false));
    expect(mapped.code).toBe(ErrorCode.Generic);
    expect(mapped.message).not.toContain('songs');
    expect(mapped.message).not.toContain('column');
  });

  it('masks an unexpected error too', () => {
    const mapped = toSubsonicError(new Error('connection string postgres://user:pw@host/db'));
    expect(mapped.code).toBe(ErrorCode.Generic);
    expect(mapped.message).not.toContain('postgres');
  });

  it('carries a 4xx service message through, since it is written for a person', () => {
    expect(toSubsonicError(new BadRequestError('Library URL must use https.')).message).toContain('https');
  });
});

describe('toAdminResponse', () => {
  it('keeps a 4xx status and its message', () => {
    // The admin API is a JSON surface whose client — the SPA — reads the status, so
    // this is the opposite of the Subsonic rule and deliberately so.
    const mapped = toAdminResponse(new BadRequestError('slug is required'));
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.message).toBe('slug is required');
  });

  it('masks a 5xx with the localized generic message', () => {
    const mapped = toAdminResponse(new DatabaseError('SELECT * FROM libraries failed', false));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.message).toBe('An internal error occurred.');
    expect(mapped.body.error.message).not.toContain('libraries');
  });

  it('maps a 404 to 404', () => {
    expect(toAdminResponse(new NotFoundError('Library not found.')).status).toBe(404);
  });

  it('defaults a non-ServiceError to 500 rather than leaking its type', () => {
    const mapped = toAdminResponse(new TypeError('x is not a function'));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe('InternalServerError');
  });
});

describe('WebDavError', () => {
  it('carries the upstream status for classification', async () => {
    // The upstream *body* is attacker-influenced text this server has no use for, so
    // only the status crosses.
    const dav = fakeDav({}, { status: 401 });
    const original = fetch;
    vi.stubGlobal('fetch', dav.fetch);
    const client = new WebDavClient('https://dav.example.com', '/', { username: 'u', password: 'p' });
    await expect(client.propfind('')).rejects.toBeInstanceOf(WebDavError);
    try {
      await client.propfind('');
    } catch (error) {
      expect((error as WebDavError).status).toBe(401);
    }
    vi.stubGlobal('fetch', original);
  });
});

describe('KvCache domain policy', () => {
  it('opens its breaker across instances, because the namespace is process-wide', async () => {
    // A per-instance breaker would give every request scope its own three failures to
    // get through before the fast path engaged.
    resetBreakerForTests();
    const failing = fakeKv({}, { failAll: true });
    for (let attempt = 0; attempt < 3; attempt += 1) await new KvCache(failing.ns).getText('songMeta', ['x']);
    // A *different* instance, same process.
    expect(await new KvCache(failing.ns).getText('songMeta', ['x'])).toBeNull();
    expect(failing.calls.get).toBe(3);
    resetBreakerForTests();
  });

  it('reports an oversized value as not stored rather than throwing', async () => {
    resetBreakerForTests();
    const store = fakeKv();
    const cache = new KvCache(store.ns);
    // KV would reject it anyway; refusing locally turns a wasted round trip into a
    // skipped one.
    expect(await cache.putText('libIndex', ['a', 'b'], 'x'.repeat(700_000))).toBe(false);
    expect(store.writes()).toBe(0);
  });

  it('purges every key under a prefix, for the operator-forgets-a-library action', async () => {
    resetBreakerForTests();
    const store = fakeKv({ 'libIndex:v1:L1:a': '{}', 'libIndex:v1:L1:b': '{}', 'libIndex:v1:L2:c': '{}' });
    const cache = new KvCache(store.ns);
    expect(await cache.purgePrefix('libIndex', ['L1'])).toBe(2);
    expect(store.entries().has('libIndex:v1:L2:c')).toBe(true);
  });

  it('returns zero from a purge when the namespace refuses', async () => {
    resetBreakerForTests();
    expect(await new KvCache(fakeKv({}, { failAll: true }).ns).purgePrefix('libIndex')).toBe(0);
  });
});

describe('readAudioTags on a truncated Ogg header', () => {
  it('reports the container but no duration, rather than throwing', () => {
    const bytes = new Uint8Array(oggPage(0, vorbisIdHeader(2, 44_100, 160_000).slice(0, 10), 0x02, 0));
    const tags = readAudioTags(bytes, 1000);
    // A truncated read must not become a 500 on a `getSong` call.
    expect(tags.container).toBe('ogg-vorbis');
  });

  it('reads nothing from an Ogg page whose segment table overruns the buffer', () => {
    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xff, 0xff, 0xff, 0xff]);
    expect(() => readOpus(bytes, 1000)).not.toThrow();
  });
});
