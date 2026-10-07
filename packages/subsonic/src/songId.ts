/**
 * Short, derived song ids.
 *
 * A song id used to be reversible — `s:base64url(libraryId + "\n" + path)` — so
 * `stream` could resolve it without a database lookup. That made ids as long as
 * the path: up to ~1,400 chars with a 1,024-char path, and several hundred for
 * ordinary CJK libraries (3 UTF-8 bytes per char, then base64's 4/3).
 *
 * Clients cache downloads under the id as the filename, and Linux allows 255
 * bytes per path component — so a long id is `ENAMETOOLONG` on the client, with
 * no server-side error anywhere. Measured in the wild via `paige.navic`.
 *
 * New songs are therefore derived here: `s:` plus 22 base64url chars (the first
 * 128 bits of SHA-256 over `libraryId + "\n" + path`). 24 chars total,
 * filename-safe, and stable across an index drop and rescan — the same library
 * and the same path hash to the same id, so every star, play count, bookmark
 * and playlist entry the drop deliberately keeps re-attaches to the row the
 * rescan recreates. See `indexDrop.ts`, which keeps the annotations for
 * exactly this reason.
 *
 * The separator is unambiguous for the same reason `encodeId`'s is: a library
 * id matches `LIBRARY_ID_PATTERN` (no newline) and a stored path never holds
 * one (`normalizeRelativePath` refuses control characters).
 *
 * Legacy ids are still accepted everywhere and resolve through
 * `(library_id, path)`; they are never minted. Album (`alk:`) and artist
 * (`ar:`) ids are out of scope: they name groups, not files, and are never
 * used as download filenames.
 */
import { encodeId, IdKind, toBase64Url } from './ids';
import { sha256Bytes } from './sha256';

/**
 * 128 bits, as 22 unpadded base64url chars.
 */
const SONG_SHORT_PAYLOAD_BYTES = 16;

/**
 * Exactly what {@link deriveShortSongId} produces, and nothing else.
 */
const SONG_SHORT_ID_PATTERN = /^s:[\w-]{22}$/;

/**
 * Above every short id (24 chars) and below every production legacy id (a
 * 36-char UUID plus path, base64-encoded). Selects rows still owing rotation.
 */
const SONG_LEGACY_ID_LENGTH_THRESHOLD = 32;

/**
 * A song's short id, derived from where the file lives.
 *
 * The first 128 bits of SHA-256 over `libraryId + "\n" + path`, base64url
 * without padding. Synchronous because the scan's write path is — the Workers
 * runtime only offers an async digest, so this uses the vendored `sha256.ts`
 * instead (checked against the FIPS vectors in `test/subsonic-sha256.test.ts`).
 *
 * The same library and the same path always produce the same id, so a rescan
 * after an index drop recreates byte-identical ids. A caller holding a row
 * still reuses the row's stored id — see `songSql.ts`, which preserves
 * `songs.id` on conflict — and only a missing row derives.
 */
function deriveShortSongId(libraryId: string, path: string): string {
  const digest = sha256Bytes(new TextEncoder().encode(`${libraryId}\n${path}`));
  return `s:${toBase64Url(digest.subarray(0, SONG_SHORT_PAYLOAD_BYTES))}`;
}

function isShortSongId(id: string): boolean {
  return SONG_SHORT_ID_PATTERN.test(id);
}

/**
 * The id this song carried before rotation, for annotation lookups.
 *
 * Stars, ratings and play counts are stored under the id the song had when the
 * user marked it. Computing the legacy form from the row lets a lookup check
 * both without rewriting user tables.
 */
function legacySongId(libraryId: string, path: string): string {
  return encodeId(IdKind.Song, libraryId, path);
}

export { deriveShortSongId, isShortSongId, legacySongId, SONG_SHORT_ID_PATTERN, SONG_LEGACY_ID_LENGTH_THRESHOLD };
