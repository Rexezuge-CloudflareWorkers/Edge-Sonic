/**
 * Album artwork, read out of the tracks' own tags.
 *
 * ### Why this exists at all
 *
 * `getCoverArt` finds artwork by listing the album folder and matching a fixed list of
 * names — `cover`, `folder`, `front`, `album`, `albumart`, `thumb` × `jpg`/`jpeg`/
 * `png`/`webp`. That is a complete implementation of *one* way a music library stores
 * artwork, and it is not the common one. Picard, beets, MusicBrainz Picard's
 * `embedding` mode, Metaflac, `ffmpeg`'s default metadata mapping and every ripped
 * disc put the picture **inside the audio file**, and most people never also drop a
 * sidecar image beside the tracks.
 *
 * For such a library the sidecar lookup returns nothing, and the endpoint answered with
 * `PLACEHOLDER_PNG` — a valid 70-byte 1×1 transparent PNG, `200`, `image/png`. So the
 * client decoded an image, cached it, and drew a transparent pixel. Nothing anywhere
 * reported an error, which is why it presents as "no cover image can be loaded" rather
 * than as a failure: from the outside, a transparent pixel and a network fault are the
 * same observation.
 *
 * The whole tag reader had no artwork path either — `AudioTags` carries no picture
 * field, `flac.ts` *skipped* block type 6 for its length, and no migration had an art
 * column. So this was a capability that had never been written, not one that broke.
 *
 * ### Artwork is not stored in D1
 *
 * The obvious place to put a picture is the database, and it is the wrong one. D1 is
 * the *index* here; the bytes belong to the origin. A 500 KB JPEG per album across a
 * 5,000-album library is 2.5 GB in a database whose free tier also allots 5,000 row
 * *writes* a day — the scan would spend its entire write budget on artwork and starve
 * the index it exists to serve. So nothing is written: a picture is read on demand,
 * cached in KV, and re-derived from the origin whenever the cache misses.
 *
 * The consequence worth stating: **a cold cache costs one ranged read per album**, and
 * there is no migration, no column, and no backfill.
 *
 * ### Reads are bounded, and the bound is the point
 *
 * Two subrequests in the worst case, per album:
 *
 * 1. A bounded prefix read. FLAC's metadata block table and ID3v2's frame headers are
 *    both at the front, so this is enough to *locate* a picture without reading it. For
 *    Ogg the same read walks the comment packet and either decodes the picture from it
 *    or measures the page-aligned fetch that would reproduce it.
 * 2. One exact range read for the image itself, when the picture is past the prefix —
 *    which for FLAC is the normal case, because `PICTURE` is conventionally last, and
 *    for Ogg is the fetch the first read sized.
 *
 * The probe is capped at {@link ART_TRACK_LIMIT} tracks, mirroring the artist cover
 * path's own `ARTIST_COVER_PROBE_LIMIT`. Real libraries have albums where the picture
 * is on some files and not others, so one track is not enough; a compilation with
 * none of them is not worth more than three reads to discover.
 */
import { findPicture, id3TagSize, materializePicture, READER_VERSION, sniffImageType } from '@edge-sonic/media-tags';
import type { EmbeddedPicture, PictureSource } from '@edge-sonic/media-tags';
import type { WebDavClient } from '@edge-sonic/webdav';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { createLogger } from '@edge-sonic/backend-runtime/logger';

/**
 * How many of an album's tracks to try before reporting no artwork.
 *
 * A bound, and the same shape as the artist cover probe: a client draws one cover per
 * album row, so this is multiplied by every row on a grid. Three covers the common case
 * (the picture is on the first file a tagger touched) and stops.
 */
const ART_TRACK_LIMIT = 3;

/**
 * The first read. Enough for FLAC's block table and ID3v2's frame headers, and — because
 * it is also where a small picture lives — often the whole answer.
 *
 * 128 KiB matches `DEFAULT_PREFIX_BYTES` in `media-tags` rather than inventing a second
 * number for the same idea.
 */
const ART_PREFIX_BYTES = 128 * 1024;

/**
 * The largest image this server will read out of a tag.
 *
 * A bound on a length field read from a file, so a hostile or corrupt header cannot ask
 * for a gigabyte. Comfortably above any real cover: 8 MiB is a 3000×3000 uncompressed
 * TIFF, and a 1400×1400 JPEG is a few hundred kilobytes.
 */
const ART_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The largest **fetch** this module will issue for one picture.
 *
 * Distinct from {@link ART_MAX_BYTES} because for Ogg the bytes on the wire are not the
 * image: the cover is carried as base64, so 868 KB of PNG is 1,158,199 bytes of text, and
 * that text is split across 18 Ogg pages whose headers have to be fetched and stripped as
 * well. The bound covers the expansion and the headers rather than assuming the image's
 * own bound is enough — a fetch refused for being "too big" is the placeholder, which is
 * the answer a client cannot act on.
 */
const ART_MAX_FETCH_BYTES = 16 * 1024 * 1024;

/**
 * The largest ID3v2 tag this server will read in full, for the second attempt.
 *
 * The retry below exists because an `APIC` frame is normally the *last* frame in the tag,
 * so a 500 KB picture lands past any prefix worth reading — and the frame headers are
 * interleaved with the payloads, so there is no offset table to consult and the tag has
 * to be walked. 16 MiB covers a tag carrying a 4 K cover; beyond it the answer is "no
 * artwork" rather than a read sized by a number in a file.
 */
const ART_MAX_TAG_BYTES = 16 * 1024 * 1024;

const logger = createLogger('EmbeddedArt');

/**
 * The subset of a song row this module needs.
 *
 * Not `SongRow`: a fabricated full row is a copy of the schema that rots silently the
 * day a column is added, which is the same argument `EnrichFacts` makes on the scan
 * side. Every field here is load-bearing in the cache key.
 */
interface ArtSource {
  readonly id: string;
  /**
  Library-relative path, and the key the origin is asked for.
  */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface EmbeddedArtDeps {
  clientFor: (library: LibraryRow) => Promise<WebDavClient>;
  cache: KvCache;
}

interface ResolvedArt {
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * Turn a located picture into bytes, spending the second request only if it is needed.
 *
 * Delegates to `materializePicture` rather than implementing the two claim kinds here,
 * because the Ogg one needs the Ogg framing — a claim about a comment packet's
 * page-aligned extent is not a range of image bytes, and a caller that only knew how to
 * fetch a range and sniff it had no way to satisfy it. The bounds are still decided here,
 * where the cost is budgeted.
 */
async function materialize(client: WebDavClient, source: ArtSource, located: PictureSource, timeoutMs: number): Promise<EmbeddedPicture | null> {
  return await materializePicture(
    located,
    async (offset, length) => await client.readRange(source.path, offset, length, timeoutMs),
    { maxImageBytes: ART_MAX_BYTES, maxFetchBytes: ART_MAX_FETCH_BYTES },
  );
}

/**
 * The picture in one file, or `null`.
 *
 * Two reads at most, and the second is conditional on a fact the first read established
 * rather than on a guess: for an ID3 tag larger than the prefix, the picture is
 * somewhere past it and the tag's own size field says how far. For Ogg it is the comment
 * packet's own page geometry, which the first read has already measured.
 */
async function pictureFromFile(client: WebDavClient, source: ArtSource, timeoutMs: number): Promise<EmbeddedPicture | null> {
  const head = await client.readPrefix(source.path, ART_PREFIX_BYTES, timeoutMs);

  const located = findPicture(head, source.size);
  if (located !== null) {
    const picture = await materialize(client, source, located, timeoutMs);
    if (picture !== null) return picture;
  }

  // No picture in the prefix. For FLAC and Ogg that is a real answer — their pictures
  // are at the front, so a prefix that did not contain one does not contain one. For
  // MP3 it is the *normal* case, because taggers append `APIC` after the text frames.
  // So this retry is MP3-only: it spends a second subrequest only where a second
  // subrequest can buy something.
  const tagSize = id3TagSize(head);
  if (tagSize === null) return null;
  const tagEnd = 10 + tagSize;
  if (tagEnd <= head.length || tagEnd > ART_MAX_TAG_BYTES) return null;

  const tag = await client.readRange(source.path, 0, tagEnd, timeoutMs);
  const retry = findPicture(tag, source.size);
  return retry === null ? null : await materialize(client, source, retry, timeoutMs);
}

/**
 * The cache key for an album's artwork.
 *
 * Keyed on the `mtimeMs`+`size` of **every track this module would probe**, not just the
 * one the art came from. That is what makes the negative answer cacheable: a plain
 * "no art" marker under the album's path would survive a re-tag that added a picture to
 * track 1, and the album would show no artwork until the entry aged out 30 days later.
 * Putting the probed tracks' revisions in the key makes that entry structurally
 * unreachable the moment any of them changes.
 *
 * ### And on `READER_VERSION`, which is the other half
 *
 * A row's `enriched_at` plus `songs.reader_version` is what lets a **corrected reader**
 * reach a row an older one wrote: the file genuinely has not moved, so keying only on the
 * file's bytes makes the wrong value permanently current. This module's key had only the
 * bytes.
 *
 * So a deploy carrying a fixed `flacPicture` offset, a corrected `id3Picture` terminator
 * or a fixed `oggPicture` lacing assumption left every already-cached cover structurally
 * reachable **with its old bytes**, and the "this album has no artwork" marker — which is
 * written by the same path and lives for 30 days — survived it too. That is
 * `reader_version` one level down, in the one place the module's own header cited the rule
 * and did not apply it.
 *
 * `READER_VERSION` is bumped whenever a change makes a prior extraction wrong, so the
 * entries written under the old one become unreachable rather than left to be detected.
 */
function artKey(library: LibraryRow, dirPath: string, sources: readonly ArtSource[]): string[] {
  const revision = sources.map((source) => `${source.mtimeMs}x${source.size}`).join('.');
  return [library.id, dirPath, `v${READER_VERSION}`, revision];
}

/**
 * Artwork for an album, from its tracks' tags.
 *
 * @param candidates The album's tracks, in the order they should be tried. The caller
 *   owns that order and it must be **deterministic**: the same album must resolve to
 *   the same bytes on every request, or the cache never hits and two clients can be
 *   served different covers for one album.
 * @returns `null` when no probed track has a picture. That is an ordinary answer, not
 *   a failure — the caller serves the placeholder.
 */
async function embeddedAlbumArt(
  library: LibraryRow,
  dirPath: string,
  candidates: readonly ArtSource[],
  deps: EmbeddedArtDeps,
  timeoutMs: number,
): Promise<ResolvedArt | null> {
  const sources = candidates.slice(0, ART_TRACK_LIMIT);
  if (sources.length === 0) return null;

  const key = artKey(library, dirPath, sources);
  const cached = await deps.cache.getBytes('albumArt', key);
  if (cached !== null) {
    // A zero-length entry is the **negative** answer, cached. Distinguishable from a
    // miss (`null`) and from any real image, because no image is zero bytes. Without
    // it, an album whose tracks carry no art pays the probe on every single request,
    // for ever.
    if (cached.byteLength === 0) return null;
    const mimeType = sniffImageType(cached);
    if (mimeType === null) {
      // Logged, because this is the one branch on the cache path that means something
      // other than what it says, and it said it silently.
      //
      // No writer here can produce it: `resolveImageBytes` refuses a non-image before it
      // is stored, so every entry under this key was a picture on the way in. An entry
      // that is *not* a picture on the way out therefore means the **bytes changed in
      // transit** — which is exactly what a reader that asked KV for `text` got, since
      // UTF-8 replaces every invalid sequence and a JPEG is mostly invalid sequences. It
      // shipped: 42 covers on the first sweep of an 80-album library, 0 on the second,
      // with no line anywhere naming a cause. `test/kv-outage.test.ts` pins the reader;
      // this line is what would have named it.
      logger.warn(`Cached artwork for ${dirPath} is not a recognised image (${cached.byteLength} bytes); serving the placeholder.`);
      return null;
    }
    return { mimeType, data: cached };
  }

  const client = await deps.clientFor(library);
  // Whether any candidate was actually **read**. Not "did we look", which is always true,
  // but "did a read complete" — and the difference is the whole point of the negative
  // cache below.
  let examined = false;
  for (const source of sources) {
    let picture: EmbeddedPicture | null;
    try {
      picture = await pictureFromFile(client, source, timeoutMs);
      examined = true;
    } catch (error) {
      // One unreadable track is not a failed request. The next candidate may well have
      // the picture, and if none does the answer is "no artwork" — which is what a
      // rotated credential or a 404 on one file actually means to a client drawing a
      // grid. Logged, not thrown: a cover request has no way to report a partial
      // failure that a client could act on.
      logger.warn(`Embedded art unreadable for ${source.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (picture === null || picture.data.byteLength === 0) continue;
    const mimeType = picture.mimeType;
    if (mimeType === null) continue;
    // **Awaited, not fire-and-forget.** The reasoning that produced `void` here was that
    // "a cache write that fails must not fail the request that already has the bytes in
    // hand" — and `KvCache` already guarantees that: `putBytes` fails soft and returns
    // `false`, so awaiting it cannot throw. What `void` actually cost is the write
    // itself, because a promise a request handler does not await is not guaranteed to run
    // at all.
    //
    // It did not run. `albumArt` was the only cache write in the product issued this way,
    // and against a live origin it populated nothing: a request for an album's cover read
    // the track, served the image, and left the cache empty, so the next cell of an album
    // grid did it again. Each cover costs up to two ranged reads against a **50**
    // external-subrequest Free-plan ceiling, so a grid is not a slow endpoint — it is a
    // failing one. This is the same defect as voiding `requireForUser`: an unawaited
    // promise is not a cheaper version of an awaited one, it is a different one.
    await deps.cache.putBytes('albumArt', key, picture.data);
    return { mimeType, data: picture.data };
  }

  // Cached under the same key, so the next request for this exact revision of this album
  // skips the probe entirely — **but only when a read actually completed.**
  //
  // This is the negative cache's other half, and it shipped without it: an origin that
  // answered `503` once had "this album has no artwork" written for it, which is a
  // 30-day entry. Nothing re-reads it, because the key is the tracks' revisions and those
  // have not changed — so one transient fault cost the album its cover until the file moved
  // or the entry aged out. It is not hypothetical: the library this was found on answers
  // `503` intermittently, so covers were being poisoned faster than they were being filled.
  //
  // A transport failure and "there is no picture" are different observations, and only one
  // of them is worth remembering. Not caching is cheap — the negative entry exists so an
  // album that genuinely has no art does not re-probe on every request — while caching the
  // wrong one is a correct-looking, invisible, permanent loss.
  // Awaited for the reason the positive write is, and it matters more here: this entry is
  // the one that makes a cover *stay* missing, so a write that silently never happened is
  // the cheapest possible outcome and the hardest to notice.
  if (examined) await deps.cache.putBytes('albumArt', key, new Uint8Array(0));
  return null;
}

/**
 * The media type of a cached image is re-derived from its own bytes, not stored
 * beside them: a key holding a content type as well as bytes is two things that can
 * disagree, and the disagreement would be a cover served with the wrong
 * `Content-Type` — which several clients refuse outright. The bytes are the only
 * authority, and they are what was validated on the way in.
 *
 * It is `sniffImageType`, not a second copy of it. This module used to carry its own
 * magic-byte table covering PNG, JPEG, GIF, WebP and BMP, while the extractor's own
 * `resolveImageBytes` called the shared one — which also knows TIFF in both byte
 * orders, AVIF and HEIF. So a TIFF cover was extracted correctly, cached, and then
 * re-sniffed to `null` on the next request and answered with the transparent
 * placeholder for the whole 30-day TTL of a key that only the file's own revision can
 * invalidate. It is the "a placeholder that is a valid success is the worst possible
 * answer" defect arriving from the other direction: the first request was right, and
 * the cache turned the right answer into a grey box. The suite stayed green because
 * `test/embedded-art.test.ts` asserted those formats through the path that already
 * worked — the same class as a fixture holding only the case that passes.
 */
export { embeddedAlbumArt, pictureFromFile, artKey, ART_TRACK_LIMIT, ART_PREFIX_BYTES, ART_MAX_BYTES, ART_MAX_TAG_BYTES };
export type { ArtSource, EmbeddedArtDeps, ResolvedArt };
