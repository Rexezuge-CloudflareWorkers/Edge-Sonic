/**
 * ID3v2 frame sizing and text decoding, shared by the lyrics and info readers.
 *
 * ### Why this is one module
 *
 * A `USLT`, a `COMM` and a `TXXX` frame all begin with an encoding byte followed by a
 * terminated descriptor, and the terminator is **two** bytes under UTF-16. Stepping one
 * byte at a time through a UTF-16 descriptor finds a `00 00` straddling two code units,
 * cuts the descriptor in half and shifts the value by one byte — which produces a lyric
 * or a comment that starts one character in, with no parse error anywhere.
 *
 * The rule used to live in `lyrics.ts`, where the info reader would have needed a second
 * copy of it. Two copies of a byte-layout rule are free to disagree about which encodings
 * are wide, and a disagreement is invisible on the ASCII files every fixture uses.
 *
 * ### Layer 0
 *
 * Pure functions over a bounded buffer. A frame that lies past the read reports no text
 * rather than a truncated string; a half-read comment is worse than none.
 */
import { readUintBE } from './bits';

/**
 * A frame's declared size. v2.4 uses 7-bit syncsafe bytes; v2.3 uses a plain 32-bit
 * integer. A frame whose size runs past the buffer is rejected by the caller.
 */
function id3FrameSize(bytes: Uint8Array, offset: number, majorVersion: number): number | null {
  if (majorVersion >= 4) {
    const first = bytes[offset];
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const fourth = bytes[offset + 3];
    if (first === undefined || second === undefined || third === undefined || fourth === undefined) return null;
    return ((first & 0x7f) << 21) | ((second & 0x7f) << 14) | ((third & 0x7f) << 7) | (fourth & 0x7f);
  }
  return readUintBE(bytes, offset, 4);
}

/**
 * Where a descriptor's terminator ends, or `-1`.
 *
 * `wide` is the encoding's property, not the byte at the cursor: UTF-16 with a BOM (1) and
 * UTF-16BE (2) both terminate on two aligned zero bytes. Stepping by two is what keeps the
 * terminator aligned with the code units it separates.
 */
function findDescriptorEnd(bytes: Uint8Array, from: number, end: number, wide: boolean): number {
  if (wide) {
    // The aligned pass is the specification's rule: real UTF-16 descriptors are two bytes
    // per code unit, and a `00 00` straddling two of them can be data rather than a
    // terminator. The unaligned pass is for the files in the wild that put an ASCII
    // descriptor under an encoding byte of 1 or 2 — its terminator sits between code units
    // from the aligned scan's point of view. Trying the aligned pass first keeps the
    // specification's answer on files that follow it.
    for (const start of [from, from + 1]) {
      for (let index = start; index + 2 <= end; index += 2) {
        if (bytes[index] === 0 && bytes[index + 1] === 0) return index + 2;
      }
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

/**
 * Decode an ID3 text body under its encoding byte, dropping a BOM and any trailing NUL
 * padding. Whitespace-only text is absent: a `COMM= ` is a junk note, and publishing a
 * blank biography beside a real artist panel is worse than publishing none.
 */
function decodeId3Text(bytes: Uint8Array, start: number, end: number, encoding: number): string | null {
  if (start >= end) return null;
  const body = bytes.subarray(start, end);
  const text =
    encoding === 0
      ? latin1(body)
      : encoding === 1
        ? decodeUtf16WithBom(body)
        : encoding === 2
          ? new TextDecoder('utf-16be').decode(body)
          : new TextDecoder('utf-8').decode(body);
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/\0+$/, '')
    .trimEnd();
  return cleaned.trim().length > 0 ? cleaned : null;
}

/**
 * A descriptor's text. A UTF-16 descriptor interleaves zero bytes; an ASCII one written
 * under a wide encoding byte does not, and decoding the latter as UTF-16 would turn
 * `DESCRIPTION` into garbage whose normalized key matches no tag this server reads.
 */
function decodeDescriptor(bytes: Uint8Array, start: number, end: number, encoding: number): string {
  if (start >= end) return '';
  if (bytes.subarray(start, end).includes(0)) return decodeId3Text(bytes, start, end, encoding) ?? '';
  return latin1(bytes.subarray(start, end)).trimEnd();
}

/**
 * A frame's descriptor and value, or `null` when the descriptor has no terminator in the
 * bytes available. `skip` is the number of fixed bytes before the descriptor — three for
 * a `COMM`'s language, zero for a `TXXX`.
 */
function decodeDescribedFrame(
  bytes: Uint8Array,
  start: number,
  length: number,
  skip: number,
): { descriptor: string; value: string | null } | null {
  const end = start + length;
  if (start + 1 + skip > end) return null;
  const encoding = bytes[start];
  const wide = encoding === 1 || encoding === 2;
  const descriptorStart = start + 1 + skip;
  const valueStart = findDescriptorEnd(bytes, descriptorStart, end, wide);
  if (valueStart === -1) return null;
  return {
    descriptor: decodeDescriptor(bytes, descriptorStart, Math.max(descriptorStart, valueStart - (wide ? 2 : 1)), encoding),
    value: decodeId3Text(bytes, valueStart, end, encoding),
  };
}

export { id3FrameSize, findDescriptorEnd, decodeId3Text, decodeDescribedFrame };
