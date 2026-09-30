/**
 * Recognising image bytes.
 *
 * Split from `picture.ts` because this is a different question from the one that file
 * asks. `picture.ts` answers *where* a container keeps its picture — walking a FLAC
 * metadata block table, an ID3 frame list, an Ogg comment packet. This answers *whether
 * a run of bytes is an image at all*, and all three containers route their answer
 * through it, so it is one implementation rather than three.
 *
 * ### The bytes are the only authority
 *
 * A container's declared media type is a claim by whatever wrote the tag, and the
 * failures are mundane and total: `image/jpg` (not a real type), `image/pjpeg`, a bare
 * `-->`, or an empty FLAC link block. A client handed `Content-Type: image/jpg` refuses
 * the image on some platforms and shows nothing on others, and a client handed audio
 * bytes as `image/jpeg` writes a file into its image cache and then fails to decode it.
 *
 * So an unrecognised payload is **refused** rather than served on the strength of a
 * declared type. Every format in real use as cover art is in {@link IMAGE_MAGICS} or
 * checked explicitly in {@link sniffImageType}, so refusing the unknown costs nothing
 * real and buys an answer that is either right or absent.
 */

/**
 * Image magics, longest first so a prefix match is unambiguous.
 */
const IMAGE_MAGICS: ReadonlyArray<{ mimeType: string; magic: readonly number[] }> = [
  { mimeType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] }, // "GIF8"
  { mimeType: 'image/bmp', magic: [0x42, 0x4d] }, // "BM"
  // TIFF is little- or big-endian, so both byte orders are listed.
  { mimeType: 'image/tiff', magic: [0x49, 0x49, 0x2a, 0x00] }, // "II*\0"
  { mimeType: 'image/tiff', magic: [0x4d, 0x4d, 0x00, 0x2a] }, // "MM\0*"
];

/**
 * RIFF carries its four identifying bytes at offset 8, not at the front.
 *
 * A constant rather than a magic entry, because the offset is the whole point: `RIFF`
 * also heads a WAV and an AVI, and a four-byte prefix test would claim a four-byte WAV
 * is a WebP and serve it as one.
 */
const RIFF = 0x52; // "R"
const WEBP_AT = 8;
const WEBP_BRAND = 'WEBP';

/**
An ISO-BMFF brand starts 8 bytes in, after the 4-byte size and the `ftyp` box type.
*/
const FTYP_AT = 4;
const FTYP = 'ftyp';

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function matchesAt(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (offset < 0 || offset + magic.length > bytes.length) return false;
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

function isRiffWebp(bytes: Uint8Array, offset: number): boolean {
  return bytes[offset] === RIFF && latin1(bytes.subarray(offset + WEBP_AT, offset + WEBP_AT + 4)) === WEBP_BRAND;
}

/**
 * The media type implied by the bytes, or `null`.
 *
 * Two container families identify themselves away from the front, and both are checked
 * explicitly rather than by prefix: **RIFF/WEBP** at offset 8, and **ISO-BMFF** (AVIF,
 * HEIC) whose `ftyp` box is at offset 4 with the real format in the brand after it.
 */
function sniffImageType(bytes: Uint8Array): string | null {
  for (const candidate of IMAGE_MAGICS) {
    if (matchesAt(bytes, 0, candidate.magic)) return candidate.mimeType;
  }
  if (isRiffWebp(bytes, 0)) return 'image/webp';
  if (latin1(bytes.subarray(FTYP_AT, FTYP_AT + 4)) === FTYP) {
    const brand = latin1(bytes.subarray(8, 12));
    if (brand.startsWith('avi')) return 'image/avif';
    if (brand.startsWith('hei') || brand.startsWith('mif')) return 'image/heif';
  }
  return null;
}

/**
 * The first offset in `[from, to)` where a known image magic appears.
 *
 * A fallback for a container whose framing we read slightly wrong — a tagger whose
 * description terminator does not match the encoding it declared, say, which shifts the
 * start by one byte. The magics are long and specific, so a match is not a coincidence,
 * whereas a slice that is off by one byte is *not* an image and no client will decode it.
 */
function findImageMagic(bytes: Uint8Array, from: number, to: number): number | null {
  const end = Math.min(to, bytes.length);
  for (let at = Math.max(from, 0); at < end; at += 1) {
    for (const candidate of IMAGE_MAGICS) {
      if (matchesAt(bytes, at, candidate.magic)) return at;
    }
    if (isRiffWebp(bytes, at)) return at;
  }
  return null;
}

interface EmbeddedPicture {
  /**
   * The image's media type, always **derived from the bytes**.
   *
   * Never the container's claim, and never `null`: if the bytes were not recognised,
   * there is no picture. That is what makes this type non-nullable, and it is why a
   * caller never has to decide what to send when the sniff failed — it got `null`.
   */
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * Recognise image bytes, or `null`.
 */
function resolveImageBytes(bytes: Uint8Array): EmbeddedPicture | null {
  const mimeType = sniffImageType(bytes);
  return mimeType === null ? null : { mimeType, data: bytes };
}

export { resolveImageBytes, sniffImageType, findImageMagic, latin1 };
export type { EmbeddedPicture };
