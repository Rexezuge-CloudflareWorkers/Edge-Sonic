/**
 * `@edge-sonic/media-tags` — duration, bitrate and text tags from a *prefix* of
 * an audio file.
 *
 * Layer 0, zero dependencies, no I/O. Every export is a pure function over
 * `Uint8Array`, which is what lets the whole thing be tested from the node suite
 * with real byte fixtures and no Workers runtime.
 */
import { readFlac, hasFlacMagic } from './flac';
import { readId3v2, hasId3Magic } from './mp3';
import { detectOggCodec, hasOggMagic, readOpus, readVorbis } from './ogg';
import { EMPTY_TAGS } from './types';
import type { AudioTags } from './types';

/**
How much of a file to read for enrichment.
*/
const DEFAULT_PREFIX_BYTES = 128 * 1024;

/**
 * Which version of this reader a row's enrichment came from.
 *
 * ### Why a row has to carry this
 *
 * What a prefix read can extract is a property of the *reader*, not only of the file. A
 * reader that learns to read something it previously could not leaves every row it
 * already wrote looking current: the file's bytes have not changed, so `mtime_ms` still
 * matches, so anything that skips a read on a matching mtime correctly declines to read
 * it — and the previously-wrong value is served for ever.
 *
 * It shipped. A reader that had been treating an Ogg page as a packet, and a page's
 * granule as the file's length, produced a 240.61 s track reported as 3 s at 15329 kbps
 * with no artist, album, genre, track or year. A deploy carrying the corrected reader
 * changed nothing: not a `getSong`, not a rescan, not a re-index. The rows were correct
 * by every test the incrementality logic had — the bytes really had not moved — and
 * wrong all the same, because the *other* half of the staleness condition was not
 * recorded anywhere.
 *
 * So this counter is bumped whenever a change makes a previously-written value wrong, and
 * a row whose `reader_version` differs from it is re-read. The same shape as the
 * `key_version` on the credential rows, and for the same reason: a superseded value is
 * better made **structurally unreachable** than left to be detected.
 *
 * ### When to bump it
 *
 * Any change to what `readAudioTags` or `readOggTailDuration` can extract from the same
 * bytes — a fixed packet walk, a corrected granule rule, a newly supported container.
 * Bumping it costs one re-read per track, so it is not a thing to do for a refactor.
 */
const READER_VERSION = 1;

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  return offset + magic.length > bytes.length ? false : magic.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Read whatever tags the available bytes can support.
 *
 * @param bytes The leading bytes of the file. A short or empty buffer is normal
 *   and returns `EMPTY_TAGS` rather than throwing — a truncated read must not
 *   become a 500 on a `getSong` call.
 * @param fileSize The **total** file size, when known (from
 *   `getcontentlength`). Required for a variable-bitrate file's bitrate, which
 *   is only computable as `size × 8 ÷ duration`.
 *
 * `container` is `'unknown'` for a format this module cannot read rather than
 * being guessed from the file extension — the extension is client-supplied and
 * routinely wrong, whereas the magic bytes are not.
 */
function readAudioTags(bytes: Uint8Array, fileSize: number | null = null): AudioTags {
  // Four bytes is the floor because that is the length of an MPEG frame header, and
  // it is enough to identify the container and read the sample rate. A higher floor
  // would silently report "unknown" for a short-but-valid buffer; each reader's own
  // bounds checks decide what it can actually read.
  if (bytes.length < 4) return EMPTY_TAGS;

  if (hasFlacMagic(bytes)) return readFlac(bytes, fileSize);
  if (hasOggMagic(bytes)) {
    return detectOggCodec(bytes) === 'opus' ? readOpus(bytes, fileSize) : readVorbis(bytes, fileSize);
  }
  if (hasId3Magic(bytes)) {
    // The audio starts after the tag, and the tag length is inside the first
    // 10 bytes, so the frame search is positioned rather than blind.
    const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    return readId3v2(bytes, fileSize, 10 + tagSize);
  }
  // A raw MPEG frame with no ID3 tag at all is common in stripped rips.
  return startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3]) || startsWith(bytes, [0xff, 0xf2]) ? readId3v2(bytes, fileSize, 0) : EMPTY_TAGS;
}

export * from './types';
export { readAudioTags,        DEFAULT_PREFIX_BYTES, READER_VERSION };
export { parseVorbisComments, readUintBE, readUintLE, readBitsBE } from './bits';

export {readFlac, hasFlacMagic} from './flac';
export {readOpus, readVorbis, hasOggMagic, readOggTailDuration} from './ogg';
export {readId3v2, hasId3Magic} from './mp3';