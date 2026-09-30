/**
 * Album artwork, end to end, through the real endpoint.
 *
 * ### The failure this exists for
 *
 * `getCoverArt` found artwork by listing the album folder and matching a fixed list of
 * names. For a library whose covers are **embedded in the tracks** — what Picard, beets,
 * Metaflac, `ffmpeg` and every ripped disc produce, and what most people have — that
 * lookup finds nothing, and the endpoint answered with `PLACEHOLDER_PNG`: a **valid**
 * 70-byte 1×1 transparent PNG, `200`, `image/png`.
 *
 * So the client decoded an image, cached it, and drew a transparent pixel. Nothing
 * anywhere reported an error, which is why it presented as "no cover image can be
 * loaded" rather than as a failure: from the outside, a transparent pixel and a network
 * fault are the same observation.
 *
 * And the suite was green, because the harness seeds a `cover.jpg` **node row**
 * (`helpers/harness.ts:188`) — a library that already has a sidecar, which is the one
 * library that already worked. So these tests delete that row to stand up the library
 * that was broken, and say so: the absence is the fixture, stated rather than assumed.
 *
 * ### What these hold
 *
 * - An album with **no sidecar** serves the picture out of its own tracks.
 * - A sidecar still wins, so a library that has both is unaffected.
 * - An album with neither serves a *valid* placeholder image.
 * - The audio file is read **once**, then cached — a grid of covers is the request shape
 *   this has to survive, and each cell is its own invocation against a 50-external-
 *   subrequest ceiling on the Free plan.
 * - The cache key carries the track's `mtime_ms`, so re-tagging a track re-reads it.
 * - A cover request never answers with a Subsonic envelope, whatever the origin does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, ALBUM_DIR, LIBRARY_ID, subsonicId } from './helpers/harness';
import { NodeDAO } from '@edge-sonic/backend-data/dao';
import type { Harness } from './helpers/harness';
import type { DavEntry } from './helpers/fakeDav';

/**
 * A real JPEG: SOI, an APP0/JFIF segment, then EOI. Long enough that a truncated read
 * would produce something that still sniffs as a JPEG but is not one, which is why the
 * length is asserted alongside the magic.
 */
const COVER = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

/**
 * Audio-frame filler: no `fLaC` magic, so `findPicture` reports no picture. This is what
 * an album with no artwork of any kind looks like to the reader.
 */
const AUDIO_ONLY = new Uint8Array(8192);

const ROOT = '/remote.php/dav/files/alice/Music';
const ALBUM_PATH = `${ROOT}/${ALBUM_DIR}`;
const COVER_NODE = `${ALBUM_DIR}/cover.jpg`;

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function concat(...parts: readonly (readonly number[])[]): number[] {
  return parts.flat();
}

/**
 * A FLAC `PICTURE` block body — picture type, MIME, description, the four dimension
 * fields, then the data. Every length is a big-endian u32 (format spec §8.2).
 */
function pictureBlock(data: Uint8Array): number[] {
  return concat(u32(3), u32(10), ascii('image/jpeg'), u32(0), u32(640), u32(480), u32(24), u32(0), u32(data.length), [...data]);
}

/**
A metadata block header: a type byte (bit 7 = last) then a 24-bit length.
*/
function blockHeader(type: number, length: number, last = false): number[] {
  return [last ? type | 0x80 : type, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

/**
 * A FLAC file carrying `PICTURE` as its **last** metadata block — the conventional
 * order, and the one that puts the image past any prefix worth reading, so the reader
 * has to locate it from the block table and then fetch exactly that range.
 */
function flacWithCover(cover: Uint8Array): Uint8Array {
  const body = pictureBlock(cover);
  return Uint8Array.from(concat(ascii('fLaC'), blockHeader(0, 34), Array.from({length: 34}, () => 0), blockHeader(6, body.length, true), body, Array.from({length: 4096}, () => 0)));
}

/**
 * An origin tree for the fixture album.
 *
 * @param sidecar A cover file to place beside the tracks, or `null` for a library whose
 *   artwork is embedded only — the layout that was broken. Its declared
 *   `contentType` is derived from its own bytes, because a fixture that says
 *   `image/jpeg` for a PNG makes the assertion about which path ran ambiguous: the
 *   passthrough prefers the origin's type, so a mismatched fixture reports the
 *   embedded picture's type and looks like the sidecar was ignored.
 */
function originTree(options: { sidecar?: { name: string; bytes: Uint8Array } | null; trackBytes?: Uint8Array } = {}): Record<string, DavEntry[]> {
  const track = options.trackBytes ?? flacWithCover(COVER);
  const entries: DavEntry[] = [
    { path: ALBUM_PATH, collection: true, mtime: 1000, etag: '"b"' },
    { path: `${ALBUM_PATH}/01.flac`, size: track.length, contentType: 'audio/flac', mtime: 1000, etag: '"c"', body: track },
    { path: `${ALBUM_PATH}/02.flac`, size: track.length, contentType: 'audio/flac', mtime: 1000, etag: '"d"', body: track },
  ];
  const sidecar = options.sidecar === undefined ? { name: 'cover.jpg', bytes: COVER } : options.sidecar;
  if (sidecar !== null) {
    entries.push({ path: `${ALBUM_PATH}/${sidecar.name}`, size: sidecar.bytes.byteLength, contentType: 'image/png', mtime: 1000, etag: '"e"', body: sidecar.bytes });
  }
  return { [ALBUM_PATH]: entries };
}

let harness: Harness;
let originalFetch: typeof fetch;

/**
 * Put a cover file's **node** back, so the sidecar lookup can find it.
 *
 * Through the DAO rather than hand-written SQL, for the same reason the scan uses it:
 * every name in `nodes` has a `_ci` twin, and a hand-inserted row that omits one fails
 * a `NOT NULL` constraint — which is the DAO's schema knowledge doing its job.
 */
async function addCoverNode(name: string): Promise<void> {
  await new NodeDAO(harness.db.db).upsertMany([{ libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/${name}`, parentPath: ALBUM_DIR, name, mtimeMs: 1000, etag: '"e"', depth: 3, isScanned: true }]);
}

/**
 * Remove the seeded `cover.jpg` node, standing up the library that was broken.
 *
 * Stated rather than assumed: the harness seeds this node for every test in the
 * repository, so an embedded-artwork test that left it in place would be exercising the
 * sidecar path and calling it the embedded one — which is precisely how this defect
 * stayed green.
 */
async function removeSidecarNode(): Promise<void> {
  await harness.db.db.prepare('DELETE FROM nodes WHERE path = ?').bind(COVER_NODE).run();
}

beforeEach(async () => {
  harness = await createHarness(originTree({ sidecar: null }));
  originalFetch = fetch;
  // `fakeDav.fetch` is a real `function`, not an arrow, precisely so it can be installed
  // as a global `fetch` and observe the class of bug where a platform global is invoked
  // as a stored method and gets the wrong receiver.
  globalThis.fetch = harness.dav.fetch;
  await removeSidecarNode();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  harness.close();
});

const coverUrl = (id: string): string => harness.restUrl('getCoverArt', { id });
const coverFor = (id: string): Promise<Response> => harness.fetch(coverUrl(id));

describe('getCoverArt with embedded artwork', () => {
  it('serves the picture out of the track when the album folder has no image file', async () => {
    // The reported failure. The album directory holds two audio files and nothing else,
    // so the sidecar lookup finds nothing — which used to be the end of the line,
    // answered with a 1×1 transparent PNG the client decoded and drew.
    const response = await coverFor(subsonicId('al', ALBUM_DIR));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The real bytes, not a placeholder: the 1×1 PNG is 70 bytes and starts `89 50`.
    expect(bytes.byteLength).toBe(COVER.byteLength);
    expect([...bytes]).toEqual([...COVER]);
  });

  it('finds the picture from a song id as well as from an album id', async () => {
    // Clients pass whatever id they happen to be holding, and a track id resolves to its
    // album directory — the same directory the album id names.
    const response = await coverFor(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(COVER.byteLength);
  });

  it('still prefers a sidecar file, so a library that has both is unaffected', async () => {
    // A different image, so "which one answered" is answerable rather than assumed.
    const sidecarBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    harness.dav.setTree(originTree({ sidecar: { name: 'folder.png', bytes: sidecarBytes }, trackBytes: flacWithCover(COVER) }));
    await addCoverNode('folder.png');

    const response = await coverFor(subsonicId('al', ALBUM_DIR));
    expect(response.status).toBe(200);
    // The sidecar is a PNG and the embedded picture is a JPEG, so the bytes — and the
    // type — each say which path ran. Asserting only the type would pass against a
    // fixture whose origin mislabelled its own sidecar.
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...sidecarBytes]);
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  it('serves a valid placeholder, not an error and not zero bytes, when there is no artwork', async () => {
    // The contract every client's placeholder path depends on. A `404`, or a `200` with
    // zero bytes, is the worst answer available: a client caches it and never asks
    // again, so artwork added later never appears.
    harness.dav.setTree(originTree({ sidecar: null, trackBytes: AUDIO_ONLY }));

    const response = await coverFor(subsonicId('al', ALBUM_DIR));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    // A PNG signature: a decodable image, which is the entire point of the placeholder.
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('caches the extracted picture, so a grid of covers does not re-read the origin', async () => {
    // Each cover is its own invocation, and a client draws one per grid cell. Without a
    // cache, a 50-album browse is 50 ranged reads of audio files, every time the
    // client's own 24h cache misses.
    const before = harness.dav.requestCount();
    const first = await coverFor(subsonicId('al', ALBUM_DIR));
    await first.arrayBuffer();
    const afterFirst = harness.dav.requestCount();
    expect(afterFirst).toBeGreaterThan(before);

    const second = await coverFor(subsonicId('al', ALBUM_DIR));
    expect([...new Uint8Array(await second.arrayBuffer())]).toEqual([...COVER]);
    // Answered from KV: the origin was not touched at all.
    expect(harness.dav.requestCount()).toBe(afterFirst);
  });

  it('does not answer before its cache write has settled, so the write is not abandoned', async () => {
    // The cache test above passes either way, which is the whole problem. `fakeKv`'s `put`
    // is an `async` function with no `await` in it, so it settles on the microtask queue —
    // an unawaited write lands in time, every time, and the omission is invisible.
    //
    // It shipped: `albumArt` was the only write in the product issued as
    // `void deps.cache.putBytes(...)`, and a promise a request handler does not await is
    // not guaranteed to run at all. Against a live origin it populated nothing: each
    // request for a cover read the track, served the image, and left the cache empty, so
    // every cell of an album grid did it again — up to two ranged reads each, against a
    // **50** external-subrequest Free-plan ceiling. That is an endpoint that fails, not one
    // that is slow, and the suite was green throughout.
    //
    // So the double is made slow on purpose. `deferPuts` holds every write until the test
    // releases it, which is the only way to tell a *completed* promise from an
    // *abandoned* one — the same reason `withReceiverCheck` exists for `fetch`, and the
    // same reason `latencyMs` exists for the scan's deadline.
    //
    // The assertion is ordering, not content: while the write is held, the response must
    // not have resolved. It is what an `await` buys and what a `void` cannot, and it holds
    // for the negative entry too — which is the one that makes a cover *stay* missing.
    const held = await createHarness(originTree({ sidecar: null }), { deferPuts: true });
    globalThis.fetch = held.dav.fetch;
    try {
      await held.db.db.prepare('DELETE FROM nodes WHERE path = ?').bind(COVER_NODE).run();

      const inFlight = held.fetch(held.restUrl('getCoverArt', { id: subsonicId('al', ALBUM_DIR) }));
      let answered = false;
      void inFlight.then(() => {
        answered = true;
      });

      // Let the handler reach the write, and prove it did: `calls.put` is the choke point,
      // so a handler that never wrote would never trip it and this would time out rather
      // than pass vacuously.
      await vi.waitFor(() => {
        expect(held.cache.calls.put).toBeGreaterThan(0);
      });
      await Promise.resolve();
      expect(answered).toBe(false);

      await held.cache.releasePuts();
      const served = await inFlight;
      expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...COVER]);

      // And the bytes are actually in there, so the test is not merely observing a handler
      // that blocks on something it never did. `putBytes` hands KV an `ArrayBuffer`, which
      // is why this reads `.byteLength` rather than `.length` — an `ArrayBuffer` has no
      // `.length`, so `value.length > 0` is `undefined > 0` and silently filters the entry
      // out. A green assertion that measured nothing is the failure mode this file exists
      // to catch, so it does not get to commit one.
      const stored = [...held.cache.entries().values()].map((value) => (typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)));
      expect(stored.map((value) => value.byteLength)).toContain(COVER.length);
    } finally {
      globalThis.fetch = originalFetch;
      held.close();
    }
  });

  it('re-reads the origin when the track changes, because the key carries its mtime and size', async () => {
    // The `reader_version` rule one level up: a re-tagged file changes its picture
    // without anything else in the library moving, so a cached entry has to become
    // structurally unreachable rather than left to be detected. The row's `mtime_ms` is
    // one of the two inputs the key is built from.
    const first = await coverFor(subsonicId('al', ALBUM_DIR));
    await first.arrayBuffer();
    const cached = harness.dav.requestCount();

    await harness.db.db.prepare('UPDATE songs SET mtime_ms = ? WHERE dir_path = ?').bind(2000, ALBUM_DIR).run();

    const second = await coverFor(subsonicId('al', ALBUM_DIR));
    expect([...new Uint8Array(await second.arrayBuffer())]).toEqual([...COVER]);
    expect(harness.dav.requestCount()).toBeGreaterThan(cached);
  });

  it('does not re-read the origin for an album it has already found has no artwork', async () => {
    // The negative answer is cached too, as a zero-length entry. Without it an album
    // whose tracks carry no picture pays the probe on every request for ever — and a
    // library of compilations with no art is a grid of exactly those.
    harness.dav.setTree(originTree({ sidecar: null, trackBytes: AUDIO_ONLY }));

    const first = await coverFor(subsonicId('al', ALBUM_DIR));
    await first.arrayBuffer();
    const afterFirst = harness.dav.requestCount();
    expect(afterFirst).toBeGreaterThan(0);

    const second = await coverFor(subsonicId('al', ALBUM_DIR));
    await second.arrayBuffer();
    expect(harness.dav.requestCount()).toBe(afterFirst);
  });

  it('does not cache a transport failure as "this album has no artwork"', async () => {
    // The negative cache is written whenever no picture is found, and it used to be
    // written whenever the *probe* found nothing — including when the probe threw. So one
    // `503` from the origin became "no artwork" for that album for the length of the TTL,
    // and nothing could undo it: the key is the tracks' revisions, and those had not
    // changed. It is not a hypothetical. The library this was found on answers `503` on
    // ranged reads while still listing the file, so covers were being poisoned faster than
    // they were being filled, and the symptom — a transparent tile — is identical to the
    // one that has no cause a client can report.
    //
    // "We looked and there is nothing" and "we could not look" are different observations,
    // and only the first is worth remembering. Not caching is cheap; caching the wrong one
    // is a correct-looking, invisible, permanent loss.
    harness.dav.setTree(originTree({ sidecar: null }));
    harness.dav.setGetStatus(503);

    const failed = await coverFor(subsonicId('al', ALBUM_DIR));
    expect(failed.status).toBe(200);
    expect((await failed.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const whileBroken = harness.dav.requestCount();
    expect(whileBroken).toBeGreaterThan(0);

    // The origin recovers. Nothing about the album changed, so the cached negative would
    // still be in force — and the cover would stay a placeholder for ever.
    harness.dav.setGetStatus(null);

    const recovered = await coverFor(subsonicId('al', ALBUM_DIR));
    expect([...new Uint8Array(await recovered.arrayBuffer())]).toEqual([...COVER]);
    expect(harness.dav.requestCount()).toBeGreaterThan(whileBroken);
  });

  it('still caches the negative answer when a read *did* complete and found nothing', async () => {
    // The pair, without which the test above passes for the wrong reason: if the negative
    // cache were simply removed, the previous test would also go green. The bound the
    // first test defends is "a completed read with no picture", and this is that — and it
    // has to be a *completed* read, because the fixture hands back a real `206` full of
    // audio bytes, which is exactly what the broken origin in the test above never did.
    harness.dav.setTree(originTree({ sidecar: null, trackBytes: AUDIO_ONLY }));

    const first = await coverFor(subsonicId('al', ALBUM_DIR));
    expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const afterFirst = harness.dav.requestCount();

    const second = await coverFor(subsonicId('al', ALBUM_DIR));
    await second.arrayBuffer();
    expect(harness.dav.requestCount()).toBe(afterFirst);
  });

  it('never answers a cover request with a Subsonic envelope, even when the origin 404s the cover', async () => {
    // A cover endpoint that answers JSON is wrong in a way nothing reports: the client
    // hands the body to an image decoder, it fails, and the only evidence is a
    // client-side log line. This is the response the old code produced whenever the
    // origin's `GET` on a cover 404'd — a thrown `WebDavError`, classified by the error
    // mapper, and returned as a masked `200 application/json` envelope.
    //
    // Staged by putting the `cover.jpg` **node** back while leaving the file off the
    // origin, which is exactly the divergence the read-through index can hold.
    await addCoverNode('cover.jpg');

    const response = await coverFor(subsonicId('al', ALBUM_DIR));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\//);
    expect(await response.text()).not.toContain('subsonic-response');
  });
});
