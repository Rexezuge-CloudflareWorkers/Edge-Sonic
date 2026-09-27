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

/** How much of a file to read for enrichment. */
const DEFAULT_PREFIX_BYTES = 128 * 1024;

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (offset + magic.length > bytes.length) return false;
  return magic.every((byte, index) => bytes[offset + index] === byte);
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
  if (bytes.length < 12) return EMPTY_TAGS;

  if (hasFlacMagic(bytes)) return readFlac(bytes, fileSize);
  if (hasOggMagic(bytes)) {
    return detectOggCodec(bytes) === 'opus' ? readOpus(bytes, fileSize) : readVorbis(bytes, fileSize);
  }
  if (hasId3Magic(bytes)) {
    // The audio starts after the tag, and the tag length is inside the first
    // 10 bytes, so the frame search is positioned rather than blind.
    const tagSize = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    return readId3v2(bytes, fileSize, 10 + tagSize);
  }
  // A raw MPEG frame with no ID3 tag at all is common in stripped rips.
  if (startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3]) || startsWith(bytes, [0xff, 0xf2])) {
    return readId3v2(bytes, fileSize, 0);
  }

  return EMPTY_TAGS;
}

export * from './types';
export { readAudioTags, readFlac, readOpus, readVorbis, readId3v2, hasFlacMagic, hasOggMagic, hasId3Magic, DEFAULT_PREFIX_BYTES };
export { parseVorbisComments, readUintBE, readUintLE, readBitsBE } from './bits';
