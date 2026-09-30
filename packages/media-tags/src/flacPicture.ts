/**
 * The FLAC `PICTURE` metadata block: where the image starts, and whether it is already
 * here.
 *
 * ### FLAC keeps all metadata at the front, and `PICTURE` is still the last one
 *
 * The block *table* is in the file's first few hundred bytes and every block's extent is
 * arithmetic from it, so the image's offset is known without reading the image — which is
 * what makes a second, exact range request possible from a short prefix. A `PICTURE` block
 * is conventionally last and is as large as the picture, so `range` is the **common**
 * answer and `inline` is the rare one.
 *
 * ### One implementation, because Ogg is base64 plus a call into this
 *
 * An Ogg file carries its artwork as a `METADATA_BLOCK_PICTURE` comment whose value is a
 * **base64-encoded FLAC `PICTURE` block** — the same structure, base64-wrapped. So
 * `readFlacPictureHeader` is the only picture-block reader in the package, and `oggPicture`
 * calls it. A second implementation would be free to disagree about where the data begins,
 * and that disagreement is invisible until a client is handed a JPEG missing its first byte.
 */
import { readUintBE } from './bits';
import { latin1, resolveImageBytes } from './imageBytes';
import type { PictureSource } from './picture';

const FLAC_PICTURE_BLOCK_TYPE = 6;

/**
 *  The `METADATA_BLOCK_PICTURE` MIME for a picture that is a link rather than an
 *  image. The block carries no data in that case, and the length check rejects it
 *  anyway; this is here so the intent is stated rather than implied.
 */
const FLAC_URL_MIME = '-->';

/**
 * A media type worth putting on the wire, or `null`.
 */
function normalizeImageMimeType(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed === FLAC_URL_MIME || trimmed === 'image') return null;
  if (trimmed === 'jpg' || trimmed === 'jpeg' || trimmed === 'image/jpg' || trimmed === 'image/pjpeg') return 'image/jpeg';
  if (trimmed === 'png' || trimmed === 'image/x-png') return 'image/png';
  return trimmed.startsWith('image/') ? trimmed : null;
}

interface FlacPictureHeader {
  mimeType: string | null;
  /**
  Offset of the image bytes, from the start of `bytes`.
  */
  dataOffset: number;
  dataLength: number;
}

/**
 * The FLAC `PICTURE` block header (format spec §8.2), and where the image starts.
 *
 * All fields are big-endian `u32`: picture type, MIME length + MIME, description
 * length + description, width, height, colour depth, indexed colours, data length,
 * then the data. So the data begins at a *computed* offset — there is no fixed one —
 * which is why the MIME and description lengths have to be read rather than assumed.
 *
 * `blockLength` bounds the walk to the block the file's own header declared. A header
 * that claims more data than the block holds is a **missing** picture rather than a
 * short one: a truncated image is not a degraded cover, it is a cover no client
 * renders, and it is indistinguishable from a corrupt one to whoever is looking at it.
 *
 * @param bytes The buffer the block starts in.
 * @param start Offset of the block's first field.
 * @param blockLength The block's declared length, from the metadata block header.
 */
function readFlacPictureHeader(bytes: Uint8Array, start: number, blockLength: number): FlacPictureHeader | null {
  const limit = start + blockLength;
  let at = start;

  // Picture type. Read for its bounds check and skipped for its value: a `PICTURE`
  // block holding a link rather than an image is type 1, and type 3 is a front cover,
  // so there is no "interesting" value here to keep.
  if (readUintBE(bytes, at, 4) === null) return null;
  at += 4;

  const mimeLength = readUintBE(bytes, at, 4);
  if (mimeLength === null || at + 4 + mimeLength > limit) return null;
  const mimeType = normalizeImageMimeType(latin1(bytes.subarray(at + 4, at + 4 + mimeLength)));
  at += 4 + mimeLength;

  const descriptionLength = readUintBE(bytes, at, 4);
  if (descriptionLength === null || at + 4 + descriptionLength > limit) return null;
  at += 4 + descriptionLength;

  // Width, height, colour depth, indexed colours. All four are u32 and none is used.
  for (let field = 0; field < 4; field += 1) {
    if (readUintBE(bytes, at, 4) === null) return null;
    at += 4;
  }

  const dataLength = readUintBE(bytes, at, 4);
  if (dataLength === null || dataLength <= 0) return null;
  at += 4;

  if (at + dataLength > limit) return null;
  return { mimeType, dataOffset: at, dataLength };
}

/**
 * Walk FLAC's metadata block table looking for block type 6.
 *
 * The table is a run of 4-byte headers — one type byte, of which bit 7 marks the last
 * block, then a 24-bit big-endian length — so every block's extent is known from the
 * headers alone. That is what makes a `range` answer possible from a short prefix: the
 * picture's offset is arithmetic, not something that has to be read.
 */
function locateFlacPicture(bytes: Uint8Array): PictureSource | null {
  let cursor = 4; // past the "fLaC" magic
  // Bounded because the loop is driven by lengths read from the file. The format caps
  // a metadata block at 8 KiB *except* `PICTURE`, which is as large as the image, so
  // this cannot be the format's own limit — it is a bound on a header that never
  // reaches a last-block flag.
  for (let guard = 0; guard < 64; guard += 1) {
    const typeByte = bytes[cursor];
    if (typeByte === undefined) return null;
    const length = readUintBE(bytes, cursor + 1, 3);
    if (length === null) return null;
    const body = cursor + 4;

    if ((typeByte & 0x7f) === FLAC_PICTURE_BLOCK_TYPE) {
      const header = readFlacPictureHeader(bytes, body, length);
      if (header === null) return null;
      // Present only when the whole image is in this buffer. A `PICTURE` block is
      // normally last and normally large, so `range` is the common answer and the
      // caller should expect to spend the second request.
      if (header.dataOffset + header.dataLength <= bytes.length) {
        // Through `resolveImageBytes` like every other path, so the media type comes from
        // the image's own bytes in all three containers. Bytes that are present but are
        // not an image are not worth a second request: there is nothing to fetch.
        const picture = resolveImageBytes(bytes.subarray(header.dataOffset, header.dataOffset + header.dataLength));
        return picture === null ? null : { kind: 'inline', picture };
      }
      return { kind: 'range', mimeType: header.mimeType, offset: header.dataOffset, length: header.dataLength };
    }

    cursor = body + length;
    if ((typeByte & 0x80) !== 0) return null; // last metadata block, and it was not a picture
  }
  return null;
}

export { readFlacPictureHeader, locateFlacPicture, normalizeImageMimeType };
export type { EmbeddedPicture } from './imageBytes';
