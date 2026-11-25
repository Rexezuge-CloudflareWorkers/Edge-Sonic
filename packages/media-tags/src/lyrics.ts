/**
 * Lyrics, from a file's own tags.
 *
 * ### Two questions, and why they are separate
 *
 * "What do the lyrics say" and "when does each line start" are different values. A
 * plain-text tag answers the first and says nothing about the second, while an LRC sidecar
 * answers both. So {@link readEmbeddedLyrics} — bytes in, text out — lives here, and
 * `lyricsText.ts` owns the half that turns text from **any** source into lines. The caller
 * decides precedence between a sidecar and the tags; this layer cannot see a sidecar at all.
 *
 * ### Why a reader version of its own
 *
 * `READER_VERSION` stamps `songs` rows: bumping it re-reads every track in the library,
 * which is the right cost for a corrected duration and the wrong cost for lyrics. Lyrics
 * are not stored in D1 — they are cached in KV under a key that carries this counter, so
 * a corrected extractor makes superseded entries unreachable without touching a single
 * song row. See `LYRICS_READER_VERSION`.
 *
 * ### Layer 0
 *
 * Pure functions over bytes: no fetch, no credential, no cache. A bounded prefix is all a
 * caller needs for FLAC and Ogg, whose comment blocks sit at the front, and for ID3 the
 * `USLT` frame is walked from the tag header — a tag whose frame lies past the read reports
 * no lyrics rather than a partial line, because a half-read lyric is worse than none.
 */
import { readUintBE } from './bits';
import { hasFlacMagic } from './flac';
import { id3TagSize } from './id3Picture';
import { hasId3Magic } from './mp3';
import { hasOggMagic, walkPackets } from './oggFraming';
import { oggCommentBase } from './oggPicture';
import { findVorbisComment, walkVorbisCommentSource } from './vorbisComment';

/**
 * Which version of the lyrics extractor produced a cached answer.
 *
 * Bumped whenever a change makes a previously cached value wrong — a newly supported tag,
 * a corrected frame walk, a fixed timestamp rule. KV entries are keyed on this value, so a
 * bump makes them structurally unreachable. It is deliberately **not** `READER_VERSION`:
 * that one stamps song rows and a bump re-reads every file in the library.
 */
const LYRICS_READER_VERSION = 1;

/**
 * The tag keys an embedded lyric can live under.
 *
 * `LYRICS` is what Picard, beets and `ffmpeg` write. `UNSYNCEDLYRICS` is the older
 * MusicBrainz Picard spelling, and `SYNCEDLYRICS` appears on files that carry LRC inside a
 * Vorbis comment. Tried in this order: the modern key first, then the legacy ones.
 */
const LYRICS_TAGS = ['LYRICS', 'UNSYNCEDLYRICS', 'SYNCEDLYRICS'] as const;

/**
 * The lyrics embedded in an audio file's tags, or `null` when it has none.
 *
 * @param bytes The leading bytes of the file. FLAC and Ogg keep their comment block at the
 *   front, so a bounded prefix is enough; ID3's `USLT` frame is located by walking the tag,
 *   and a frame past the read is reported as absent rather than returned truncated.
 */
function readEmbeddedLyrics(bytes: Uint8Array): string | null {
  if (hasFlacMagic(bytes)) return flacLyrics(bytes);
  if (hasOggMagic(bytes)) return oggLyrics(bytes);
  if (hasId3Magic(bytes)) return id3Lyrics(bytes);
  return null;
}

function flacLyrics(bytes: Uint8Array): string | null {
  let cursor = 4;
  let lastBlockSeen = false;
  for (let guard = 0; guard < 64 && !lastBlockSeen; guard += 1) {
    const header = readUintBE(bytes, cursor, 1);
    if (header === null) break;
    const length = readUintBE(bytes, cursor + 1, 3);
    if (length === null) break;
    const type = header & 0x7f;
    const body = cursor + 4;
    if (type === 4) {
      for (const tag of LYRICS_TAGS) {
        const value = findVorbisComment(bytes, body, tag);
        if (value !== null) return value;
      }
    }
    cursor = body + length;
    lastBlockSeen = (header & 0x80) !== 0;
  }
  return null;
}

function oggLyrics(bytes: Uint8Array): string | null {
  const found: { value: string | null } = { value: null };
  walkPackets(bytes, (packet) => {
    if (found.value !== null) return;
    const base = oggCommentBase(packet);
    if (base === -1) return;
    for (const tag of LYRICS_TAGS) {
      walkVorbisCommentSource(packet, base, (key, value) => {
        if (key !== tag || value === null) return;
        found.value = value;
        return false;
      });
      if (found.value !== null) return;
    }
  });
  return found.value;
}

function id3Lyrics(bytes: Uint8Array): string | null {
  const tagSize = id3TagSize(bytes);
  if (tagSize === null) return null;
  const majorVersion = bytes[3] ?? 0;
  // v2.2's three-character frame ids and six-byte headers are a different walk. The
  // format is old enough that "no lyrics" is the honest answer rather than a parser that
  // would read v2.3 frames as garbage.
  if (majorVersion < 3 || majorVersion > 4) return null;

  const end = Math.min(10 + tagSize, bytes.length);
  let cursor = 10;
  while (cursor + 10 <= end) {
    const frameId = String.fromCharCode(...bytes.subarray(cursor, cursor + 4));
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    const size = readFrameSize(bytes, cursor + 4, majorVersion);
    if (size <= 0 || cursor + 10 + size > end) break;
    if (frameId === 'USLT' || frameId === 'ULT') {
      const value = decodeUsltPayload(bytes, cursor + 10, size);
      if (value !== null) return value;
    }
    cursor += 10 + size;
  }
  return null;
}

function readFrameSize(bytes: Uint8Array, offset: number, majorVersion: number): number {
  if (majorVersion >= 4) {
    return (
      ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f)
    );
  }
  return readUintBE(bytes, offset, 4) ?? 0;
}

/**
 * A `USLT` frame: encoding byte, three-byte language, a terminated content descriptor, then
 * the lyric text to the end of the frame.
 *
 * The descriptor is skipped rather than decoded: it names the lyric's purpose (`Lyrics`,
 * `Karaoke`) and is not content. Its terminator width follows the encoding — two bytes for
 * UTF-16 — and stepping one byte at a time through UTF-16 finds a `00 00` straddling two
 * characters, cutting the descriptor in half and shifting the lyric by one byte.
 */
function decodeUsltPayload(bytes: Uint8Array, start: number, length: number): string | null {
  const end = start + length;
  if (start + 4 > end) return null;
  const encoding = bytes[start];
  // Two encodings need the wide terminator: `1` is UTF-16 with a BOM, `2` is UTF-16BE
  // without one. Everything else is single-byte terminated.
  const wideTerminator = encoding === 1 || encoding === 2;
  const at = findDescriptorEnd(bytes, start + 4, end, wideTerminator);
  if (at === -1) return null;

  const body = bytes.subarray(at, end);
  if (body.length === 0) return null;
  const text =
    encoding === 0
      ? latin1(body)
      : encoding === 1
        ? decodeUtf16WithBom(body)
        : encoding === 2
          ? new TextDecoder('utf-16be').decode(body)
          : new TextDecoder('utf-8').decode(body);
  const cleaned = text.replace(/^\uFEFF/, '').replace(/\s+$/, '');
  return cleaned.trim().length > 0 ? cleaned : null;
}

/**
 * Where a `USLT` content descriptor ends — the byte after its terminator, or `-1`.
 *
 * The width follows the encoding, and that is the whole point: stepping one byte at a time
 * through a UTF-16 descriptor finds a `00 00` straddling two characters, cutting it in half
 * and shifting the lyric. Stepping by two keeps the terminator aligned with the code units
 * it separates.
 */
function findDescriptorEnd(bytes: Uint8Array, from: number, end: number, wide: boolean): number {
  if (wide) {
    for (let index = from; index + 2 <= end; index += 2) {
      if (bytes[index] === 0 && bytes[index + 1] === 0) return index + 2;
    }
    return -1;
  }
  for (let index = from; index < end; index += 1) {
    if (bytes[index] === 0) return index + 1;
  }
  return -1;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function decodeUtf16WithBom(bytes: Uint8Array): string {
  if (bytes.length < 2) return '';
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff;
  const payload = littleEndian || bigEndian ? bytes.subarray(2) : bytes;
  return new TextDecoder(littleEndian ? 'utf-16le' : bigEndian ? 'utf-16be' : 'utf-16le').decode(payload);
}

export { LYRICS_READER_VERSION, LYRICS_TAGS, readEmbeddedLyrics };
