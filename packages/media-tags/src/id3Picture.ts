/**
 * ID3v2 embedded artwork: the `APIC` (v2.3/v2.4) and `PIC` (v2.2) frames.
 *
 * ### The one case a prefix cannot answer
 *
 * Every other container here has an offset table in its first few hundred bytes, so a
 * picture past the prefix is still *locatable*. ID3v2 has none: frame headers are
 * interleaved with their payloads, so finding the `APIC` frame means walking every frame
 * before it — and taggers **append** the picture after the text frames. So a large `APIC`
 * is routinely past any prefix worth reading, and the only way to reach it is to read the
 * tag, whose own size field says how long it is. That is why `id3TagSize` is exported: the
 * walk is bounded by a number read from the file, so the caller has to be able to check
 * that number before spending the request.
 *
 * v2.2 is handled separately rather than by a tolerant parser: three-character ids and
 * six-byte headers, so a walk written for v2.4 reads `PIC` as garbage and misses every
 * picture a v2.2 tagger wrote.
 */
import { readUintBE } from './bits';
import { findImageMagic, latin1, resolveImageBytes } from './imageBytes';
import type { PictureSource } from './picture';

/**
 * The ID3v2 tag's total size, from its syncsafe length field, or `null`.
 *
 * Exported because the caller needs it to decide whether a tag is worth a second
 * read: an `APIC` frame past the end of the prefix is the normal case, not an error,
 * and the only way to reach it is to read the tag the header already told us the size
 * of.
 */
function id3TagSize(bytes: Uint8Array): number | null {
  if (bytes.length < 10) return null;
  return ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
}

/**
 * Skip a null-terminated ID3v2 text field, honouring its encoding.
 *
 * The terminator is one byte for Latin-1 and UTF-8 and **two** for UTF-16, and a
 * UTF-16 description must be scanned on its own alignment — stepping one byte at a
 * time finds a `00 00` straddling two characters and cuts the description in half,
 * which shifts the image start by one byte and produces a JPEG no client decodes.
 */
function skipTerminatedText(bytes: Uint8Array, from: number, end: number, encoding: number): number | null {
  if (encoding === 1 || encoding === 2) {
    for (let at = from; at + 2 <= end; at += 2) {
      if (bytes[at] === 0 && bytes[at + 1] === 0) return at + 2;
    }
    return null;
  }
  for (let at = from; at < end; at += 1) {
    if (bytes[at] === 0) return at + 1;
  }
  return null;
}

/**
 * A 4-byte syncsafe integer, or `null`.
 *
 * Distinct from the v2.3 branch's plain 32-bit read. v2.4 made frame sizes syncsafe, and
 * reading one as plain big-endian turns a 500 KB `APIC` into a number around 2 billion —
 * which fails the bounds check and reports "no picture" on a file that has one.
 */
function syncsafeAt(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length || (bytes[offset] | bytes[offset + 1] | bytes[offset + 2] | bytes[offset + 3]) > 0x7f) return null;
  return (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];
}

/**
 * The `APIC` (v2.3/v2.4) or `PIC` (v2.2) payload, and where its image starts.
 *
 * Layout: an encoding byte, then a null-terminated MIME string — or a 3-character
 * format code for `PIC` — then a picture-type byte, then a null-terminated description
 * whose terminator width follows the encoding, then the image to the end of the frame.
 */
function readAttachedPictureFrame(bytes: Uint8Array, start: number, length: number, legacy: boolean): PictureSource | null {
  if (start >= bytes.length) return null;
  const end = start + length;
  const encoding = bytes[start] ?? 0;
  let at = start + 1;

  // The MIME string — or the v2.2 `PIC` frame's three-character format code, which is
  // stepped over rather than read — is walked to find where it ends and is then
  // **discarded**. The image's type comes from its own bytes; see `resolveImageBytes`.
  // The walk is still required: it is how the picture-type byte after it is found, and
  // `JPG` is not a media type, so translating it would only be a second opinion to
  // disagree with the image.
  if (legacy) {
    if (at + 3 > bytes.length) return null;
    at += 3;
  } else {
    // Bounded by the frame, not the buffer: a MIME string with no terminator inside
    // its own frame is a corrupt frame, and running to the end of the buffer would let
    // it swallow the frames after it.
    let nul = -1;
    for (let scan = at; scan < end; scan += 1) {
      if (bytes[scan] === 0) {
        nul = scan;
        break;
      }
    }
    if (nul === -1) return null;
    at = nul + 1;
  }

  at += 1; // picture type: front cover, back cover, and so on. Not used.
  const dataStart = skipTerminatedText(bytes, at, end, encoding);
  if (dataStart === null || dataStart >= end) return null;

  // The framing above is exact, so the slice is normally the image outright. The
  // fallback is for taggers whose description terminator does not match the encoding
  // they declared — a mismatch that shifts the start by a byte, which is invisible in
  // every field and fatal to every client.
  const direct = resolveImageBytes(bytes.subarray(dataStart, end));
  if (direct !== null) return { kind: 'inline', picture: direct };
  const shifted = findImageMagic(bytes, dataStart, end);
  if (shifted === null) return null;
  const recovered = resolveImageBytes(bytes.subarray(shifted, end));
  return recovered === null ? null : { kind: 'inline', picture: recovered };
}

/**
 * Walk the ID3v2 frame list for `APIC` or `PIC`.
 *
 * The frame *headers* are interleaved with the payloads, so there is no way to find a
 * frame without walking every frame before it — which is exactly why this cannot be
 * answered from a table of offsets and why a large `APIC` is unreachable from a short
 * prefix.
 */
function locateId3Picture(bytes: Uint8Array): PictureSource | null {
  const tagSize = id3TagSize(bytes);
  if (tagSize === null) return null;
  const majorVersion = bytes[3] ?? 4;
  const legacy = majorVersion <= 2;
  const idLength = legacy ? 3 : 4;
  const headerLength = legacy ? 6 : 10;
  const idPattern = legacy ? /^[A-Z0-9]{3}$/ : /^[A-Z0-9]{4}$/;

  const frameStart = 10;
  const end = Math.min(frameStart + tagSize, bytes.length);
  let cursor = frameStart;
  while (cursor + headerLength <= end) {
    const frameId = latin1(bytes.subarray(cursor, cursor + idLength));
    if (!idPattern.test(frameId)) break; // padding or corruption
    const size = legacy
      ? readUintBE(bytes, cursor + 3, 3)
      : majorVersion >= 4
        ? syncsafeAt(bytes, cursor + 4)
        : readUintBE(bytes, cursor + 4, 4);
    if (size === null || size <= 0 || cursor + headerLength + size > end) break;
    if (frameId === 'APIC' || frameId === 'PIC') {
      return readAttachedPictureFrame(bytes, cursor + headerLength, size, frameId === 'PIC');
    }
    cursor += headerLength + size;
  }
  return null;
}

export { id3TagSize, locateId3Picture };
