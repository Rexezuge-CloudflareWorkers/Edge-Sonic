/**
 * Bit readers and comment-key helpers, shared by FLAC, MP3 and Ogg.
 *
 * All readers here are bounds-checked. A truncated or hostile file must produce
 * `null` for a field, never a read past the end of the buffer and never a
 * number derived from bytes that were not there.
 *
 * The comment *list* these feed lives in `./vorbisComment`, and it is a separate module
 * for one reason: it is read through a `ByteSource` rather than a buffer, because the
 * field it has to step over is the artwork. What is here is the framing both share.
 */

/**
 * Read a big-endian unsigned integer.
 *
 * @returns `null` when the range extends past `bytes`, which the caller treats
 *   as "this field is unknown" rather than as zero.
 */
function readUintBE(bytes: Uint8Array, offset: number, length: number): number | null {
  if (offset < 0 || length < 0 || offset + length > bytes.length) return null;
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + bytes[offset + index];
  }
  return value;
}

/**
 * Little-endian variant.
 */
function readUintLE(bytes: Uint8Array, offset: number, length: number): number | null {
  if (offset < 0 || length < 0 || offset + length > bytes.length) return null;
  let value = 0;
  for (let index = length - 1; index >= 0; index -= 1) {
    value = value * 256 + bytes[offset + index];
  }
  return value;
}

/**
 * Read a 32-bit value from a *bit* offset — the layout FLAC's `STREAMINFO` uses
 * for its packed 20/3/5/36-bit fields.
 */
function readBitsBE(bytes: Uint8Array, bitOffset: number, bitCount: number): number | null {
  if (bitOffset < 0 || bitCount < 0 || bitOffset + bitCount > bytes.length * 8) return null;
  let value = 0;
  for (let index = 0; index < bitCount; index += 1) {
    const bit = bitOffset + index;
    const set = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
    value = value * 2 + set;
  }
  return value;
}

/**
Split a Vorbis comment key such as `ALBUMARTIST` into a comparable form.
*/
function normalizeCommentKey(key: string): string {
  return key.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');
}

interface CommentFields {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  track: number | null;
  disc: number | null;
}

/**
`3/12` → 3. Track and disc numbers are routinely written as `n/total`.
*/
function parseIndex(value: string): number | null {
  const head = value.split('/', 1)[0]?.trim() ?? '';
  if (!/^\d+$/.test(head)) return null;
  const parsed = Number.parseInt(head, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
A four-digit year, tolerating the `1994-06-01` form some taggers write.
*/
function parseYear(value: string): number | null {
  const match = /(\d{4})/.exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Re-exported so the comment-list API keeps one import path for its callers: it was one
// module until the god-file limit forced the split, and a caller reaching into two files
// for one feature is the shape that lets the two halves drift apart.
export {
  parseVorbisComments,
  parseVorbisCommentSource,
  findVorbisComment,
  findVorbisCommentExtent,
  walkVorbisCommentList,
  walkVorbisCommentSource,
  contiguousSource,
} from './vorbisComment';
export type { ByteSource, CommentValue } from './vorbisComment';

export { readUintBE, readUintLE, readBitsBE, normalizeCommentKey, parseIndex, parseYear };
export type { CommentFields };
