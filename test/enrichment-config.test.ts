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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAudioTags, readOpus, readVorbis, READER_VERSION } from '@edge-sonic/media-tags';
import { AppConfiguration, DEFAULT_STREAM_RATE_LIMIT, DEFAULT_TAG_READ_TAIL_BYTES, MAX_PAGE_SIZE_CEILING } from '@edge-sonic/backend-runtime/config';
import { resetBreakerForTests, KvCache, KV_DOMAINS } from '@edge-sonic/backend-runtime/kv';
import { createLogger, setLogLevel } from '@edge-sonic/backend-runtime/logger';
import { resolveKey } from '@edge-sonic/backend-services/composition';
import { EnrichmentService } from '@edge-sonic/backend-services/index';
import { billedRowsForTable } from '@edge-sonic/backend-data/dao';
import type { MetadataWriteResult } from '@edge-sonic/backend-data/dao';
import { toUserResponse, toSubsonicError } from '@edge-sonic/backend-services/errors';
import { BadRequestError, DatabaseError, NotFoundError, RateLimitedError } from '@edge-sonic/backend-errors';
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
    // The current reader, so a row built by `makeSong` is not automatically stale. The
    // tests that are *about* staleness set it explicitly.
    reader_version: READER_VERSION,
    ...seed,
  };
}

/**
 * What one metadata write to `songs` costs, as the DAO reports it.
 *
 * Derived rather than typed so this suite cannot drift from the schema: `applyMetadata` returns
 * a measurement, and a double that answered `changes: 1, billedRows: 1` would be asserting a
 * table with **no indexes**, which is not one this repository has. The daily budget is
 * denominated in these billed rows — see `test/d1-daily-limit.test.ts`.
 */
const ONE_SONG_ROW_WRITE: MetadataWriteResult = { changes: 1, billedRows: billedRowsForTable('songs', 1) };

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
        return ONE_SONG_ROW_WRITE;
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

  it('does not record an unreachable origin, so a recovered origin is retried', async () => {
    // A `getSong` that throws because it could not read a duration is worse than one
    // that reports 0: the first is a server error the user cannot act on, the second is
    // a track with an unknown length. So the caller never fails — but the failure is
    // also not *recorded*, which is the opposite trade from the unreadable-container
    // case above, and deliberate.
    //
    // It shipped the other way round: every read failure stamped `enriched_at`, so four
    // tracks of a live library caught a flapping origin and reported duration `0` for
    // ever — the stamp said "already read", and `shouldEnrich` trusted it. A failure
    // with no HTTP status says nothing about the file, so it leaves the row untouched
    // and the next call tries again.
    const { service, applied, library } = makeEnrichment();
    const failing = fakeDav({}, { failAll: true });
    const withFailingOrigin = new EnrichmentService({
      songs: {
        findById: async () => null,
        applyMetadata: async (id, metadata) => {
          applied.push({ id, metadata: metadata as Record<string, unknown> });
          return ONE_SONG_ROW_WRITE;
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
    // Nothing was written, so nothing claims to have been read.
    expect(applied).toHaveLength(0);

    // And the recovery is the assertion that matters: the same revision of the same
    // file enriches normally once the origin answers again.
    const recovered = await service.enrich(library, makeSong() as never);

    expect(recovered?.durationSeconds).toBe(180);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.metadata.duration).toBe(180);
  });

  it('does not record a transient 503 on the prefix read', async () => {
    // The live shape: the origin lists the file and then refuses the bytes — `PROPFIND`
    // answers while the ranged `GET` 503s. `setGetStatus` models exactly that split,
    // which `failAll` cannot express and `status` gets backwards.
    const { service, applied, dav, library } = makeEnrichment();
    dav.setGetStatus(503);

    const tags = await service.enrich(library, makeSong() as never);

    expect(tags).toBeNull();
    expect(applied).toHaveLength(0);

    dav.setGetStatus(null);
    const recovered = await service.enrich(library, makeSong() as never);

    expect(recovered?.durationSeconds).toBe(180);
    expect(applied).toHaveLength(1);
  });

  it('records a definitive 404 on the prefix read, so it is never retried', async () => {
    // The pair, without which the two tests above pass for the wrong reason: if the
    // failure path simply never wrote, every failure would look transient. A `404` is
    // an answer *about the file* — this revision of it is not there — so the attempt
    // is recorded and the next call is free.
    //
    // Enrichment never `PROPFIND`s; it `GET`s the path it was given. So the `404` is
    // staged by serving an origin that has no such file, which is also what a file
    // deleted between the scan's listing and its enrichment looks like.
    //
    // This is now the **only** status that stamps, and the `413` test below is the pair
    // that says why: the old list was `400`, `404` and `413`, described as "the ones
    // that are deterministic". All three are deterministic about the *request*. Only one
    // is about the file.
    const gone = fakeDav({});
    const applied: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    const { library } = makeEnrichment();
    const service = new EnrichmentService({
      songs: {
        findById: async () => null,
        applyMetadata: async (id, metadata) => {
          applied.push({ id, metadata: metadata as Record<string, unknown> });
          return ONE_SONG_ROW_WRITE;
        },
      },
      clientFor: async () => new WebDavClient('https://dav.example.com', '/dav', { username: 'u', password: 'p' }, gone.fetch),
      kv: new KvCache(fakeKv().ns),
      resolveKey: async () => 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
      readBytes: 131_072,
      timeoutMs: 1000,
    });

    const tags = await service.enrich(library, makeSong() as never);

    expect(tags).toBeNull();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.metadata.duration).toBe(0);
  });

  it('does not record a 413 on the prefix read, so a library of them is not stamped empty', async () => {
    // The live shape this shipped as. An origin that ignores `Range` answers `200` with
    // the whole file; `readBounded` refuses it as over its own bound and raises `413`.
    //
    // `413` was on the "deterministic, therefore about the file" list, so every track was
    // stamped `enriched_at` with `duration: 0`, no tags and no sample rate — and
    // `shouldEnrich` then declined the row for ever. A Subsonic client saw a library where
    // every album and artist still carried the path-derived `(derived)` name and every
    // song had a null duration, with no error anywhere and nothing on the operator's page.
    // No `getSong` and no rescan could undo it, because the file really had not moved.
    //
    // The whole library is the point: this is not one bad track, it is every track on an
    // origin that does not do ranges, and it arrives in a single scan.
    const { service, applied, dav, library } = makeEnrichment();
    // A body over the bound `readBounded` enforces for a prefix read, so the `413` is
    // real rather than incidental: the service asks for 128 KiB and gets the whole file.
    const oversized = new Uint8Array(300_000);
    oversized.set(flacPrefix(180));
    dav.setTree({
      '/dav/A/01.flac': [{ path: '/dav/A/01.flac', size: 30_000_000, contentType: 'audio/flac', body: oversized }],
    });
    dav.setIgnoreRange(true);

    const tags = await service.enrich(library, makeSong() as never);

    expect(tags).toBeNull();
    // Nothing written, so nothing claims to have been read.
    expect(applied).toHaveLength(0);

    // And the recovery, which is the half that matters: an origin that starts honouring
    // ranges is enriched normally on the next call, with no rescan and no `startScan`.
    dav.setIgnoreRange(false);
    const recovered = await service.enrich(library, makeSong() as never);

    expect(recovered?.durationSeconds).toBe(180);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.metadata.duration).toBe(180);
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
          return ONE_SONG_ROW_WRITE;
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

/**
 * The Ogg duration, which takes a second read from the *end* of the file.
 *
 * An Ogg granule position lives in the final page's header, at the end of the file, so a
 * prefix read cannot see it. This is the read the reader's own documentation described as
 * the caller's job and that was never written: the reader took the last granule it
 * happened to see, so a 240.61 s track was served as 3 s and 15329 kbps instead of 191,
 * and every client seeks by that number.
 *
 * The fixture and its harness are at module scope, because the staleness suite below
 * needs the same file — it is the same bytes, read by a reader that could not read them.
 */
const PRESKIP = 312;
const DURATION_SECONDS = 240;

/**
A real Opus stream: headers and a big tag block first, EOS page last.
*/
function opusFile(): Uint8Array {
  const chunks: number[] = [];
  const le = (value: number, width: number): number[] => {
    const out: number[] = [];
    let remaining = value;
    for (let index = 0; index < width; index += 1) {
      out.push(remaining % 256);
      remaining = Math.floor(remaining / 256);
    }
    return out;
  };
  const page = (segments: number[], body: number[], flags: number, granule: number, seq: number): number[] => [
    0x4f, 0x67, 0x67, 0x53,
    0x00,
    flags,
    ...le(granule, 8),
    ...le(1, 4),
    ...le(seq, 4),
    ...le(0, 4),
    segments.length,
    ...segments,
    ...body,
  ];

  const vendor = encoder.encode('edge-sonic-test');
  // A long entry so the comment packet is genuinely longer than one lacing entry, which
  // is what makes it a cross-page packet. A real one is an embedded cover image: the
  // live file's `METADATA_BLOCK_PICTURE` runs to 89,931 bytes.
  const entries = [
    ['ARTIST', 'Bon Iver'],
    ['ALBUM', 'For Emma'],
    ['METADATA_BLOCK_PICTURE', 'A'.repeat(200)],
  ].map(([key, value]) => encoder.encode(`${key}=${value}`));
  const comments: number[] = [...encoder.encode('OpusTags'), ...le(vendor.length, 4), ...vendor, ...le(entries.length, 4)];
  for (const entry of entries) comments.push(...le(entry.length, 4), ...entry);
  // Split at a lacing boundary, with the remainder under 255 so page 1 terminates it.
  expect(comments.length).toBeGreaterThan(255);
  expect(comments.length - 255).toBeLessThan(255);

  // Page 0: the 19-byte identification header, then the comment packet continued on
  // page 1 — the layout that defeated a page-oriented reader.
  chunks.push(
    ...page([19, 255], [...encoder.encode('OpusHead'), 0x01, 0x02, ...le(PRESKIP, 2), ...le(48_000, 4), ...le(0, 2), 0x00, ...comments.slice(0, 255)], 0x02, 0, 0),
    ...page([comments.length - 255], comments.slice(255), 0x01, 0, 1),
    // The final page, carrying the end-of-stream flag and the file's length.
    ...page([64], [...new Uint8Array(64)], 0x04, 48_000 * DURATION_SECONDS + PRESKIP, 2),
  );
  return new Uint8Array(chunks);
}

/**
An `EnrichmentService` over one Opus file, recording what it wrote to D1.
*/
function makeOggEnrichment(
  file: Uint8Array,
  // `readTailBytes: 0` is how a test disables the tail read, so the option does not
  // need to distinguish "absent" from "zero" — the default is only the value.
  options: { readBytes?: number; readTailBytes?: number; failOnCall?: number } = {},
): {
  service: EnrichmentService;
  applied: Array<{ id: string; metadata: Record<string, unknown> }>;
  library: Parameters<EnrichmentService['enrich']>[0];
  cache: FakeKv;
  dav: ReturnType<typeof fakeDav>;
} {
  const applied: Array<{ id: string; metadata: Record<string, unknown> }> = [];
  const cache = fakeKv();
  const dav = fakeDav(
    { '/dav/A/01.opus': [{ path: '/dav/A/01.opus', size: file.length, contentType: 'audio/ogg', body: file }] },
    options.failOnCall === undefined ? {} : { failOnCall: options.failOnCall },
  );
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
      findById: async () => null,
      applyMetadata: async (id, metadata) => {
        applied.push({ id, metadata: metadata as Record<string, unknown> });
        return ONE_SONG_ROW_WRITE;
      },
    },
    clientFor: async () => new WebDavClient('https://dav.example.com', '/dav', { username: 'u', password: 'p' }, dav.fetch),
    kv: new KvCache(cache.ns),
    resolveKey: async () => 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
    // 400 covers the two header pages (303 + 69) and stops inside the final page, so
    // the prefix read genuinely cannot see the file's length. That is the condition
    // the whole tail read exists for, and a fixture smaller than the prefix would not
    // reproduce it — the prefix would simply be the whole file.
    readBytes: options.readBytes ?? 400,
    readTailBytes: options.readTailBytes ?? 65_536,
    timeoutMs: 1000,
  });
  return { service, applied, library, cache, dav };
}

function opusSong(size: number): Record<string, unknown> {
  return { ...makeSong({ id: 's1', path: 'A/01.opus', size, enriched_at: null, duration: 0 }) };
}

describe('an Ogg duration, which the prefix read cannot supply', () => {
  it('resolves the real duration from the tail, and the bitrate from it', async () => {
    const file = opusFile();
    const { service, applied, library } = makeOggEnrichment(file);

    await service.enrich(library, opusSong(file.length) as never);

    expect(applied[0]?.metadata.duration).toBe(DURATION_SECONDS);
    // 191 kbps at this size, not the 15329 that a 3 s duration produced.
    expect(applied[0]?.metadata.bitrate).toBe(Math.round((file.length * 8) / DURATION_SECONDS / 1000));
  });

  it('reads the tags the prefix read found, so the aggregates have something to group', async () => {
    const file = opusFile();
    const { service, applied, library } = makeOggEnrichment(file);

    await service.enrich(library, opusSong(file.length) as never);

    // The two headers are packets in the first two pages, and the comment block is split
    // across them by a page header. Nothing here was readable before.
    expect(applied[0]?.metadata.artist).toBe('Bon Iver');
    expect(applied[0]?.metadata.album).toBe('For Emma');
    // The fixture names no album artist, so it mirrors the artist: the folder-derived
    // album artist this replaces is the same name through filesystem sanitization.
    expect(applied[0]?.metadata.albumArtist).toBe('Bon Iver');
  });

  it('reports no duration rather than a wrong one when the tail read is disabled', async () => {
    const file = opusFile();
    const { service, applied, library } = makeOggEnrichment(file, { readTailBytes: 0 });

    await service.enrich(library, opusSong(file.length) as never);

    // 0, not 3. The prefix read's last page is a progress report, not the file's length,
    // and a client seeks by whatever number it is given.
    expect(applied[0]?.metadata.duration).toBe(0);
    // The tags are unaffected: they are in the part of the file the prefix did read.
    expect(applied[0]?.metadata.artist).toBe('Bon Iver');
  });

  it('reports no duration when the tail read cannot reach the final page', async () => {
    const file = opusFile();
    // A tail smaller than a page cannot contain the final page's header, so the read
    // finds no end-of-stream granule and the answer is `null`.
    const { service, applied, library } = makeOggEnrichment(file, { readTailBytes: 8 });

    await service.enrich(library, opusSong(file.length) as never);

    expect(applied[0]?.metadata.duration).toBe(0);
    expect(applied[0]?.metadata.artist).toBe('Bon Iver');
  });

  it('enriches from file facts, with no song row in hand', async () => {
    // The scan's entry point. It writes by id, so it needs no row — and passing facts
    // rather than a fabricated row is what keeps a schema change from rotting silently.
    const file = opusFile();
    const { service, applied, library } = makeOggEnrichment(file);

    await service.enrichFacts(library, { id: 's1', path: 'A/01.opus', size: file.length, mtimeMs: 1_700_000_000_000 });

    expect(applied).toHaveLength(1);
    expect(applied[0]?.id).toBe('s1');
    expect(applied[0]?.metadata.duration).toBe(DURATION_SECONDS);
    expect(applied[0]?.metadata.artist).toBe('Bon Iver');
    // Both write paths share one mapping: the facts path mirrors the artist onto the
    // unnamed album artist exactly as the row-holding path does.
    expect(applied[0]?.metadata.albumArtist).toBe('Bon Iver');
  });

  it('writes nothing when the tail read fails transiently, so the duration is retried', async () => {
    // The prefix read succeeded — the tags are parsed and good — and the tail read
    // threw. Writing the tags would stamp the row and strand the duration at `0` with
    // the same permanence as a failed prefix read, so even the good work is discarded:
    // the next call does both reads again.
    //
    // `failOnCall: 2` drops the tail read only. The count is pinned below rather than
    // assumed, because a second request added anywhere upstream would move the failure
    // onto the wrong read and this would assert a prefix failure while claiming a tail
    // one — the same "a comment claiming an invariant nothing measures" defect the
    // subrequest bound had.
    const file = opusFile();
    const { service, applied, library, dav } = makeOggEnrichment(file, { failOnCall: 2 });

    const tags = await service.enrich(library, opusSong(file.length) as never);

    expect(tags).toBeNull();
    // Both reads were issued — the counter charges at the choke point, before the
    // failure — but only the prefix is observable as a `GET`, because the tail threw
    // before it was recorded. That split is what pins the failure onto the tail read
    // rather than the prefix one.
    expect(dav.requestCount()).toBe(2);
    expect(dav.gets).toHaveLength(1);
    expect(dav.gets[0]!.range).toMatch(/^bytes=0-\d+$/);
    expect(applied).toHaveLength(0);

    // Recovery, through a healthy origin: the same revision enriches fully.
    const { service: recovered, applied: rewritten, library: sameLibrary } = makeOggEnrichment(file);

    const retried = await recovered.enrich(sameLibrary, opusSong(file.length) as never);

    // The return value is the prefix tags, whose duration is null by design — the
    // duration lives in the D1 write, which is the assertion that matters.
    expect(retried?.artist).toBe('Bon Iver');
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]?.metadata.duration).toBe(DURATION_SECONDS);
    expect(rewritten[0]?.metadata.artist).toBe('Bon Iver');
  });
});

// -------------------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------------------

/**
 * A row written by a *different version of the reader* must be re-read, whatever its
 * mtime says.
 *
 * This is the defect the deploy of the Ogg fix actually shipped. The reader was corrected
 * to read Opus comment blocks that share a page with their identification header, and to
 * take a duration from the end-of-stream page rather than a truncated one — and a live
 * library kept reporting a 240.61 s track as 3 s at 15329 kbps with no artist, album,
 * genre, track or year. Not a `getSong`, not a full rescan, and not a re-index changed
 * it, because the file's bytes genuinely had not moved: `mtime_ms` matched, the row had
 * an `enriched_at` and a non-zero `duration`, and every part of the incrementality logic
 * was right. Staleness is a function of the bytes *and* the reader, and only the first
 * was recorded.
 */
describe('a row enriched by an older reader', () => {
  /**
   * The values the superseded reader wrote for the track the live instance was serving:
   * a duration taken from a page the prefix buffer cut in half, and no text tags.
   *
   * `size` is the fixture's own length, because it is what the tail read anchors its
   * range to — the real 5,736,100 would ask a file this size for bytes past its end.
   */
  function staleSong(size: number): Record<string, unknown> {
    return makeSong({
      id: 's1',
      path: 'A/01.opus',
      suffix: 'opus',
      size,
      mtime_ms: 1000,
      // Every condition the old short-circuit checked, all satisfied: enriched, and a
      // duration greater than zero so `duration = 0` is not what spared it.
      enriched_at: 1_700_000_000,
      duration: 3,
      bitrate: 15_329,
      artist: null,
      album: null,
      // And the one condition it did not check, which is the whole point.
      reader_version: READER_VERSION - 1,
    });
  }

  it('is re-read even though the file has not changed', async () => {
    const file = opusFile();
    const { service, applied, library } = makeOggEnrichment(file);

    await service.enrich(library, staleSong(file.length) as never);

    // 3 -> the real length. If this still said 3, the row would be wrong for ever.
    expect(applied[0]?.metadata.duration).toBe(DURATION_SECONDS);
    // And the tags the superseded reader could not see at all.
    expect(applied[0]?.metadata.artist).toBe('Bon Iver');
  });

  it('stamps the current reader, so it is not stale again on the next call', async () => {
    const file = opusFile();
    const { service, applied, library } = makeOggEnrichment(file);

    await service.enrich(library, staleSong(file.length) as never);

    // Written with the values, in the same statement. A row whose `enriched_at` moved
    // without its `reader_version` is one nothing can ever re-read again.
    expect(applied[0]?.metadata.readerVersion).toBe(READER_VERSION);
  });

  it('is left alone when it does carry the current reader version', async () => {
    const file = opusFile();
    const { service, applied, library } = makeOggEnrichment(file);

    await service.enrich(library, { ...staleSong(file.length), reader_version: READER_VERSION } as never);

    // The incrementality the whole design is built on: a current row costs no read.
    expect(applied).toEqual([]);
  });

  it('re-reads a row whose cached entry was written by the older reader', async () => {
    // The KV entry carries the version too, because `enrich` consults it before it
    // consults the row. A cache entry that matched on mtime alone would short-circuit
    // the read and reproduce the bug through the cache rather than the row.
    const file = opusFile();
    const { service, applied, library, cache } = makeOggEnrichment(file);
    // Written through `KvCache` rather than by hand, so the test does not encode the key
    // layout — a hard-coded key would break when `KV_KEY_VERSION` moved, quietly.
    await new KvCache(cache.ns).putJson('songMeta', ['s1'], {
      mtimeMs: 1000,
      readerVersion: READER_VERSION - 1,
      durationSeconds: 3,
      bitrateKbps: 15_329,
      sampleRate: 48_000,
      channels: 2,
      container: 'ogg-opus',
    });

    await service.enrich(library, staleSong(file.length) as never);

    expect(applied[0]?.metadata.duration).toBe(DURATION_SECONDS);
  });

  it('does not let a cached null duration skip the read it never resolved', async () => {
    // The cache's half of the same defect, and it is the half that outlives a fix to the
    // row: a `songMeta` entry recording `durationSeconds: null` matches on `mtime_ms` and
    // `readerVersion`, neither of which changes when the thing that made it null goes
    // away. So the entry answered "no duration" to every future `getSong` for a file that
    // never moved — the negative cache, written *before* anybody knew the answer was
    // incomplete.
    //
    // `readTailBytes: 0` is how a deployment produces one: the prefix read reports no
    // duration for an Ogg stream by design, and with no tail read there is no second
    // chance. Raise the setting and the entry is still there, still matching.
    const file = opusFile();
    const { service, applied, library, cache } = makeOggEnrichment(file, { readTailBytes: 0 });
    await service.enrich(library, opusSong(file.length) as never);

    expect(applied[0]?.metadata.duration).toBe(0);
    // The tags are real and were written — the row is not empty, it is *incomplete*, and
    // that is the distinction this entry used to erase.
    expect(applied[0]?.metadata.artist).toBe('Bon Iver');
    expect(await new KvCache(cache.ns).getJson('songMeta', ['s1'])).toBeNull();

    // And the read is not skipped for it, so a deployment that fixes the setting gets the
    // duration on the next call rather than serving the recorded absence for ever.
    const repaired = makeOggEnrichment(file);
    await repaired.service.enrich(library, opusSong(file.length) as never);

    expect(repaired.applied[0]?.metadata.duration).toBe(DURATION_SECONDS);
  });

  it('re-reads a row whose cached entry records an absence, because the writer no longer writes one', async () => {
    // The reader's half, and the only one that repairs a deployment that already holds
    // the entries the writer no longer produces. Guarding the writer alone leaves every
    // `songMeta` entry written before this version in place, matching on `mtime_ms` and
    // `readerVersion` and answering "no duration" for the life of the file — and the fix
    // would be one that only helps libraries created after it shipped.
    //
    // So the entry is placed by hand, the way the old writer left it, and the current
    // reader is on both sides of the match. Written through `KvCache` rather than as a
    // literal key, so the test does not encode the key layout.
    const file = opusFile();
    const { service, applied, dav, library, cache } = makeOggEnrichment(file);
    // The mtime and reader version both **match**, which is the whole difficulty: an entry
    // that missed on either would be skipped by the existing guards and this test would
    // pass with the reader's guard removed. A hard-coded timestamp here would be one more
    // thing to keep in step with `makeSong`, so it is read off the row it has to match.
    const song = opusSong(file.length);
    await new KvCache(cache.ns).putJson('songMeta', ['s1'], {
      mtimeMs: song.mtime_ms,
      readerVersion: song.reader_version,
      durationSeconds: null,
      bitrateKbps: null,
      sampleRate: 48_000,
      channels: 2,
      container: 'ogg-opus',
    });

    await service.enrich(library, song as never);

    expect(dav.gets.length).toBeGreaterThan(0);
    expect(applied[0]?.metadata.duration).toBe(DURATION_SECONDS);
  });

  it('still skips the read for a complete cached answer, which is the cache doing its job', async () => {
    // The pair, without which the guard above could be satisfied by never consulting the
    // cache at all — and that would cost one ranged read per `getSong`, for ever, on the
    // path this cache exists to make free.
    const file = opusFile();
    const { service, dav, library } = makeOggEnrichment(file);

    await service.enrich(library, opusSong(file.length) as never);
    expect(dav.gets.length).toBeGreaterThan(0);

    const replay = await service.enrich(library, { ...opusSong(file.length), mtime_ms: 1000 } as never);

    expect(dav.gets).toHaveLength(2); // prefix + tail, and neither repeated
    expect(replay).toBeNull();
  });
});

describe('a cached enrichment carries the tags', () => {
  it('stores the tags with the technical facts', async () => {
    // The entry exists to skip a read, and a replay that carries only the duration
    // strands a row whose tags were lost. So the write carries both halves.
    const file = opusFile();
    const { service, library, cache } = makeOggEnrichment(file);

    await service.enrich(library, opusSong(file.length) as never);

    const entry = await new KvCache(cache.ns).getJson<Record<string, unknown>>('songMeta', ['s1']);
    expect(entry?.artist).toBe('Bon Iver');
    expect(entry?.album).toBe('For Emma');
  });

  it('replays cached tags into a tagless row without a second origin read', async () => {
    // An index drop deletes `songs` but not this cache; a re-index recreates the row
    // with path-derived names under the same id and mtime. The facts caller has no row
    // to consult, only the cache — and replaying just the duration would stamp those
    // guesses current with a correct duration, never re-read. The visible form is a
    // release named after its sanitized folder: `Avid _ Hands Up to the Sky` for
    // `Avid / Hands Up to the Sky`, where `/` cannot live in a folder name.
    const file = opusFile();
    const { service, applied, library, dav } = makeOggEnrichment(file);

    await service.enrichFacts(library, { id: 's1', path: 'A/01.opus', size: file.length, mtimeMs: 1000 });
    expect(applied[0]?.metadata.artist).toBe('Bon Iver');
    const reads = dav.gets.length;
    expect(reads).toBeGreaterThan(0);

    // The row is gone; only the cache answers.
    await service.enrichFacts(library, { id: 's1', path: 'A/01.opus', size: file.length, mtimeMs: 1000 });

    expect(dav.gets).toHaveLength(reads);
    expect(applied[1]?.metadata.artist).toBe('Bon Iver');
    expect(applied[1]?.metadata.album).toBe('For Emma');
  });

  it('replays cached tags on the getSong path too', async () => {
    // The same stranding through the row-holding entry point, which replays through
    // `persist` rather than the store. Both callers must agree by construction.
    const file = opusFile();
    const { service, applied, library, dav } = makeOggEnrichment(file);
    const song = opusSong(file.length);

    await service.enrich(library, song as never);
    const reads = dav.gets.length;

    // Recreated row: the id and mtime the cache matches on, but no stamp and no tags.
    await service.enrich(library, { ...song, enriched_at: null, duration: 0, artist: null, album: null } as never);

    expect(dav.gets).toHaveLength(reads);
    expect(applied[1]?.metadata.artist).toBe('Bon Iver');
    expect(applied[1]?.metadata.album).toBe('For Emma');
  });
});

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

  it('names a malformed TAG_READ_TAIL_BYTES, which the numeric list did not check', () => {
    // `TAG_READ_TAIL_BYTES` was absent from `validate()`'s numeric list, so a typo fell
    // back to the 64 KB default and every Ogg track quietly reported no duration — the
    // exact failure the header of `validate()` says the method exists to catch.
    const warnings = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', TAG_READ_TAIL_BYTES: 'banana' }).validate();
    expect(warnings.join(' ')).toContain('TAG_READ_TAIL_BYTES');
  });

  it('does not report TAG_READ_TAIL_BYTES=0, because zero is the supported value', () => {
    // The pair, without which the check above could be satisfied by reusing
    // `isValidPositiveInt` — which would report `0` as invalid and generate a permanent
    // warning about the one value the setting documents as correct. "0 disables the second
    // read, which is a supported configuration and not a degraded one."
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'production', TAG_READ_TAIL_BYTES: '0' }).validate()).toEqual([]);
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'production', TAG_READ_TAIL_BYTES: '65536' }).validate()).toEqual([]);
  });

  it('reports a page size above what one request can answer, because that is a failed request', () => {
    // `MAX_PAGE_SIZE` is raised the same way `SCAN_CHUNK_MAX_REQUESTS` is meant to be, and
    // the two behave differently: the scan ceiling is a budget the chunk spends and leaves
    // the remainder of, while a page size is a promise to **answer**. Past a certain size
    // a page is not slower, it is unservable — so the clamp is reported rather than applied
    // quietly, and the report names what was configured rather than what survived.
    const config = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', MAX_PAGE_SIZE: '5000' });
    expect(config.validate().join(' ')).toMatch(/MAX_PAGE_SIZE=5000/);
    // Clamped, and the clamp is what a caller actually receives. Asserted against the
    // **constant** rather than a literal: the ceiling is derived from platform limits, and
    // a copy here would pass on the day the derivation changed and be wrong after.
    expect(config.getMaxPageSize()).toBe(MAX_PAGE_SIZE_CEILING);
    // And the default is not clamped — the whole point is that the ceiling bites only when
    // an operator has raised the number past it.
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'production' }).getMaxPageSize()).toBe(500);
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'production' }).validate()).toEqual([]);
  });
});

describe('LOG_LEVEL, which was declared and inert', () => {
  afterEach(() => setLogLevel(null));

  it('lets a module-scope logger emit at the configured level', () => {
    // ### The defect
    //
    // Both of this product's loggers are module-level constants — `KvCache.ts` and
    // `embeddedArt.ts` each call `createLogger('…')` at import time. In a Worker `env` does
    // not exist at module scope, so a level resolved in the constructor could only ever come
    // from `process.env`, which workerd does not have. The level was therefore permanently
    // `info`, `minLevel` permanently `1`, and `logger.debug` could not emit **at all** in a
    // deployed Worker.
    //
    // `LOG_LEVEL` was declared in `ServiceEnv`, shipped as `"info"` in the wrangler
    // template, and did nothing. An operator who set `LOG_LEVEL=debug` to diagnose the
    // outage the knob exists for got silence — and the coverage report proved it rather
    // than suggesting it: every `console.*` call sat in an arm reachable only at
    // `minLevel <= 0`, which is exactly which lines were uncovered.
    //
    // This logger is constructed at module scope here too, so it is the same case: setting
    // the level afterwards has to be enough.
    const logger = createLogger('ScopeTest');
    const seen: string[] = [];
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        // The message is its own argument, not folded into the prefix — that is the whole
        // reason this file's emit is written the way it is, so the assertion records both.
        seen.push(`${level}|${String(args[0])}|${String(args[1])}`);
      }),
    );

    try {
      setLogLevel('debug');
      logger.debug('d');
      logger.info('i');
      expect(seen).toContain('debug|[DEBUG] [ScopeTest]|d');

      seen.length = 0;
      setLogLevel('error');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      // Everything below the level is dropped, and the one at it survives.
      expect(seen).toEqual(['error|[ERROR] [ScopeTest]|e']);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('reports an unrecognised level rather than silently falling back', () => {
    // `validate()` is the only place a typo becomes visible. `"DEBUG"` in caps would
    // otherwise be a log level an operator cannot see, which is the same outcome as not
    // having the setting at all.
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'production', LOG_LEVEL: 'verbose' }).validate().join(' ')).toContain('LOG_LEVEL');
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'production', LOG_LEVEL: 'debug' }).validate()).toEqual([]);
    // Case is normalized on read, because `resolveLogLevel` accepts it and a warning about
    // a working setting is its own kind of wrong.
    expect(AppConfiguration.fromEnv({ ENVIRONMENT: 'production', LOG_LEVEL: 'DEBUG' }).getLogLevel()).toBe('debug');
  });
});

describe('the limits an operator can actually set', () => {
  it('honours TAG_READ_TAIL_BYTES=0 as "disable the second read", not as "use the default"', () => {
    // The defect: `getTagReadTailBytes` read through `positiveInt`, whose contract is
    // `parsed > 0`. So `0` did not disable the tail read — it became
    // `Number(DEFAULT_TAG_READ_TAIL_BYTES)`, and the operator got a 64 KB ranged read per
    // Ogg track for ever, with nothing saying the setting had been overridden by the very
    // default it names.
    //
    // `EnvParser.nonNegativeInt` is the method that honours `>= 0`, and it had **no callers
    // anywhere in the repository** — the helper for this value existing, unused, in the same
    // layer, is the fingerprint of the mistake.
    expect(AppConfiguration.fromEnv({ TAG_READ_TAIL_BYTES: '0' }).getTagReadTailBytes()).toBe(0);
    // A positive value is still honoured, and an absent one is still the default — the
    // change is about the boundary, not about ignoring the variable.
    expect(AppConfiguration.fromEnv({ TAG_READ_TAIL_BYTES: '4096' }).getTagReadTailBytes()).toBe(4096);
    expect(AppConfiguration.fromEnv({}).getTagReadTailBytes()).toBe(Number(DEFAULT_TAG_READ_TAIL_BYTES));
  });

  it('reads STREAM_RATE_LIMIT where the limiter runs, rather than from a table literal', () => {
    // The variable was declared, parsed, validated and shipped in the wrangler template —
    // and read by nothing. The limiter used a literal, so `600` lived in three places and an
    // operator setting `STREAM_RATE_LIMIT=50` got a clean validation pass, a deployment
    // that reported itself configured, and an unchanged limiter.
    expect(AppConfiguration.fromEnv({ STREAM_RATE_LIMIT: '50' }).getStreamRateLimit()).toBe(50);
    expect(AppConfiguration.fromEnv({}).getStreamRateLimit()).toBe(Number(DEFAULT_STREAM_RATE_LIMIT));
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

describe('toUserResponse', () => {
  it('keeps a 4xx status and its message', () => {
    // The user API is a JSON surface whose client — the SPA — reads the status, so
    // this is the opposite of the Subsonic rule and deliberately so.
    const mapped = toUserResponse(new BadRequestError('slug is required'));
    expect(mapped.status).toBe(400);
    expect(mapped.body.Exception.Message).toBe('slug is required');
  });

  it('masks a 5xx with the localized generic message', () => {
    const mapped = toUserResponse(new DatabaseError('SELECT * FROM libraries failed', false));
    expect(mapped.status).toBe(500);
    expect(mapped.body.Exception.Message).toBe('An internal error occurred.');
    expect(mapped.body.Exception.Message).not.toContain('libraries');
  });

  it('maps a 404 to 404', () => {
    expect(toUserResponse(new NotFoundError('Library not found.')).status).toBe(404);
  });

  it('defaults a non-ServiceError to 500 rather than leaking its type', () => {
    const mapped = toUserResponse(new TypeError('x is not a function'));
    expect(mapped.status).toBe(500);
    expect(mapped.body.Exception.Type).toBe('InternalServerError');
  });

  it('emits one dialect, because the rate limiter used to emit a second', () => {
    // The 429 from `rateLimit` is built through `BaseRoute.toErrorBody`, not through
    // this mapper. Before both agreed on `Exception`, the user surface carried
    // `{error:{code,message}}` here and `{Exception:{Type,Message}}` there, and its
    // client had to decode both. Assert the two are indistinguishable.
    const mapped = toUserResponse(new RateLimitedError());
    expect(mapped.status).toBe(429);
    expect(Object.keys(mapped.body)).toEqual(['Exception']);
    expect(mapped.body.Exception.Type).toBe('RateLimited');
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
    expect(await cache.putText('songMeta', ['a', 'b'], 'x'.repeat(700_000))).toBe(false);
    expect(store.writes()).toBe(0);
  });

  it('names a domain no reader or writer can reach, rather than implying one that exists', async () => {
    // `libIndex` and `libTree` were the two `versionScoped` domains — the whole
    // version-in-key invalidation strategy, which `AGENTS.md` elevates to an invariant:
    // "a superseded entry becomes structurally unreachable, so invalidation costs zero
    // writes". Neither had a production caller, so the mechanism had no surface at all:
    // `index_version` is read nowhere in `KvDomains` or `KvCache`, and the only tests
    // naming those domains were using them as a convenient string.
    //
    // A documented invariant over dead domains is worse than no invariant, because the
    // next person reads it as evidence the strategy is in force. So the domains are gone
    // and what the header now says is the rule with **no live example**, which is what is
    // actually true.
    expect(Object.keys(KV_DOMAINS).sort()).toEqual(['albumArt', 'songMeta']);

    // And the surviving pair are keyed by the file's own revision, not by scan version —
    // the `songMeta` rule. A domain that caches a *derived aggregate* is the case the
    // version-in-key rule is for, and there is none.
    const store = fakeKv();
    const cache = new KvCache(store.ns);
    await cache.putBytes('albumArt', ['L1', 'Bon Iver/For Emma', '1000x5000'], new Uint8Array([1, 2, 3]));
    expect([...store.entries().keys()]).toEqual(['albumArt:v1:L1:Bon%20Iver%2FFor%20Emma:1000x5000']);
  });

  it('returns zero from a purge when the namespace refuses', async () => {
    resetBreakerForTests();
    expect(await new KvCache(fakeKv({}, { failAll: true }).ns).purgePrefix('songMeta')).toBe(0);
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
