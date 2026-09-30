/**
 * Bit readers and the Vorbis comment block, shared by FLAC and Ogg.
 *
 * All readers here are bounds-checked. A truncated or hostile file must produce
 * `null` for a field, never a read past the end of the buffer and never a
 * number derived from bytes that were not there.
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
Little-endian variant.
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

/**
 * Walk a `VORBIS_COMMENT` / `OpusTags` comment list, calling `visit` with each
 * normalized key and its raw value.
 *
 * Length-prefixed strings, little-endian 32-bit. The `vendor_length` and
 * `comment_count` are read defensively: a bogus count would otherwise make this
 * loop walk off the end of the buffer, which the per-field bounds check catches,
 * but it is cheaper to bound the loop too.
 *
 * The walk is factored out because there are now **two** readers of this list and
 * they must not disagree about where a comment ends. `parseVorbisComments` takes the
 * fields it knows by name; `findVorbisComment` takes the one whose value is not a
 * field at all — `METADATA_BLOCK_PICTURE`, a base64 FLAC picture block, which is
 * artwork rather than text. A second copy of this loop would be free to disagree
 * with the first over the framing, and a disagreement about where a length-prefixed
 * list ends is invisible until a picture silently decodes to the wrong bytes.
 */
function walkVorbisCommentList(bytes: Uint8Array, offset: number, visit: (key: string, value: string) => boolean | void): void {
  const vendorLength = readUintLE(bytes, offset, 4);
  if (vendorLength === null) return;
  let cursor = offset + 4 + vendorLength;

  const count = readUintLE(bytes, cursor, 4);
  if (count === null) return;
  cursor += 4;

  // A real library has tens of comments per file; the cap is a bound on a
  // hostile header, not a policy limit.
  const limit = Math.min(count, 4096);

  for (let index = 0; index < limit; index += 1) {
    const length = readUintLE(bytes, cursor, 4);
    if (length === null) break;
    const start = cursor + 4;
    const end = start + length;
    if (end > bytes.length) break;
    const comment = new TextDecoder().decode(bytes.subarray(start, end));
    cursor = end;

    const equals = comment.indexOf('=');
    if (equals <= 0) continue;
    const value = comment.slice(equals + 1);
    if (value.length === 0) continue;
    if (visit(normalizeCommentKey(comment.slice(0, equals)), value) === false) return;
  }
}

/**
 * Parse a `VORBIS_COMMENT` / `OpusTags` payload (vendor string and framing
 * already stripped by the caller).
 */
function parseVorbisComments(bytes: Uint8Array, offset: number): CommentFields {
  const fields: CommentFields = {
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    genre: null,
    year: null,
    track: null,
    disc: null,
  };

  walkVorbisCommentList(bytes, offset, (key, value) => {
    switch (key) {
      case 'TITLE': {
        fields.title ??= value;
        break;
      }
      case 'ARTIST': {
        fields.artist ??= value;
        break;
      }
      case 'ALBUM': {
        fields.album ??= value;
        break;
      }
      case 'ALBUMARTIST':
      case 'ALBUMARTISTSORT': {
        fields.albumArtist ??= value;
        break;
      }
      case 'GENRE': {
        fields.genre ??= value;
        break;
      }
      case 'DATE':
      case 'YEAR':
      case 'ORIGINALDATE': {
        fields.year ??= parseYear(value);
        break;
      }
      case 'TRACKNUMBER': {
        fields.track ??= parseIndex(value);
        break;
      }
      case 'DISCNUMBER': {
        fields.disc ??= parseIndex(value);
        break;
      }
      default: {
        break;
      }
    }
  });

  return fields;
}

/**
 * The first value for one comment key, or `null`.
 *
 * For the key whose value is not text. `METADATA_BLOCK_PICTURE` is how an Ogg file
 * carries artwork: the value is a base64-encoded FLAC `PICTURE` block, so it is
 * artwork in a comment list and this module has to reach the list to find it.
 */
function findVorbisComment(bytes: Uint8Array, offset: number, wanted: string): string | null {
  const target = normalizeCommentKey(wanted);
  // A box rather than a `let`: the assignment happens inside a callback, and a
  // narrowed-to-`null` local would be reported as unreachable at the return.
  const box: { value: string | null } = { value: null };
  walkVorbisCommentList(bytes, offset, (key, value) => {
    if (key !== target) return;
    box.value = value;
    return false;
  });
  return box.value;
}

export { readUintBE, readUintLE, readBitsBE, parseVorbisComments, findVorbisComment, walkVorbisCommentList, normalizeCommentKey };
export type { CommentFields };
