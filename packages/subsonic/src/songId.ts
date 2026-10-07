/**
 * Short, opaque song ids.
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
 * New songs are therefore minted here: `s:` plus 22 base64url chars (128 random
 * bits). 24 chars total, filename-safe, and stable because the row keeps it —
 * see `songSql.ts`, which preserves `songs.id` on conflict.
 *
 * Legacy ids are still accepted everywhere and resolve through
 * `(library_id, path)`; they are never minted. Album (`alk:`) and artist
 * (`ar:`) ids are out of scope: they name groups, not files, and are never
 * used as download filenames.
 */
import { encodeId, IdKind, toBase64Url } from './ids';

/**
 * 128 bits, as 22 unpadded base64url chars.
 */
const SONG_SHORT_PAYLOAD_BYTES = 16;

/**
 * Exactly what {@link mintSongId} produces, and nothing else.
 */
const SONG_SHORT_ID_PATTERN = /^s:[\w-]{22}$/;

/**
 * Above every short id (24 chars) and below every production legacy id (a
 * 36-char UUID plus path, base64-encoded). Selects rows still owing rotation.
 */
const SONG_LEGACY_ID_LENGTH_THRESHOLD = 32;

function mintSongId(): string {
  const bytes = new Uint8Array(SONG_SHORT_PAYLOAD_BYTES);
  crypto.getRandomValues(bytes);
  return `s:${toBase64Url(bytes)}`;
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

export { mintSongId, isShortSongId, legacySongId, SONG_SHORT_ID_PATTERN, SONG_LEGACY_ID_LENGTH_THRESHOLD };
