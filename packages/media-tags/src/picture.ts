/**
 * Embedded artwork: FLAC `PICTURE`, ID3v2 `APIC`/`PIC`, and an Ogg file's
 * `METADATA_BLOCK_PICTURE` comment.
 *
 * Separate from `readAudioTags` on purpose. Tags are a few hundred bytes and every
 * play wants them; artwork is routinely half a megabyte and only a cover grid wants
 * it. Folding the picture into the tag read would spend the bounded-prefix budget on
 * a `getSong` that has no use for the bytes, and would make the prefix large enough
 * that tag reads start costing real egress on every track.
 *
 * ### The three containers are not three formats
 *
 * Ogg does not have a picture of its own. A Vorbis or Opus file carries artwork as a
 * `METADATA_BLOCK_PICTURE` comment whose value is a **base64-encoded FLAC `PICTURE`
 * block** — the same structure, base64-wrapped. So the FLAC picture parser is the
 * only picture parser here, and the Ogg reader is base64 plus a call into it. That is
 * why there is one `readFlacPictureHeader` rather than a FLAC one, an MP3 one and an
 * Ogg one: a second implementation of the FLAC block would be free to disagree with
 * the first about where the data begins, and that disagreement is invisible until a
 * client is handed a JPEG missing its first byte.
 *
 * ### Locating is separate from decoding
 *
 * `findPicture` answers *where* the image is, which is not the same as *having* it:
 *
 * - **FLAC** keeps all metadata blocks at the front, but `PICTURE` is conventionally
 *   the **last** one, so a 500 KB image routinely starts past any prefix worth reading
 *   and needs a second, exact range request. The block *table* is in the first few
 *   hundred bytes, so the range is known without reading the image.
 * - **MP3** keeps the whole `APIC` frame inside the ID3v2 tag, and taggers append it
 *   after the text frames — so again the header is cheap and the payload is not.
 * - **Ogg** is different: `walkPackets` already reassembles the comment packet, so the
 *   picture comes back whole. It is always `inline` and never needs a second read.
 *
 * A `range` source is a *claim about a byte range*, not bytes, and the caller is
 * expected to honour it with a request for exactly that range.
 *
 * Whether a run of bytes is an image at all is `./imageBytes`, which every container
 * here routes through.
 */
import { findVorbisComment, readUintBE } from './bits';
import { hasFlacMagic } from './flac';
import { findImageMagic, latin1, resolveImageBytes } from './imageBytes';
import type { EmbeddedPicture } from './imageBytes';
import { hasId3Magic } from './mp3';
import { hasOggMagic, startsWith, walkPackets } from './oggFraming';

const FLAC_PICTURE_BLOCK_TYPE = 6;
const OPUS_TAGS = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]; // "OpusTags"
const VORBIS_COMMENT_MAGIC = [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // "\x03vorbis"
const METADATA_BLOCK_PICTURE = 'METADATA_BLOCK_PICTURE';

/**
 * The `METADATA_BLOCK_PICTURE` MIME for a picture that is a link rather than an
 * image. The block carries no data in that case, and the length check rejects it
 * anyway; this is here so the intent is stated rather than implied.
 */
const FLAC_URL_MIME = '-->';

interface PictureRange {
  /**
   * What the container declared, which may be wrong. `resolveImageBytes` prefers the
   * bytes' own magic over this.
   */
  readonly mimeType: string | null;
  /**
  Byte offset from the start of the file.
  */
  readonly offset: number;
  readonly length: number;
}

type PictureSource = { readonly kind: 'inline'; readonly picture: EmbeddedPicture } | ({ readonly kind: 'range' } & PictureRange);

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
 * prefix. v2.2 is handled separately: three-character ids and six-byte headers, so a
 * walk written for v2.4 reads `PIC` as a frame id of `'PIC\0'`-ish garbage and misses
 * every picture a v2.2 tagger wrote.
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

/**
 * A 4-byte syncsafe integer, or `null`.
 *
 * Distinct from `readFrameSize`'s v2.3 branch, which is a plain 32-bit read. v2.4
 * made frame sizes syncsafe, and reading one as plain big-endian turns a 500 KB
 * `APIC` into a number around 2 billion — which fails the bounds check and reports "no
 * picture" on a file that has one.
 */
function syncsafeAt(bytes: Uint8Array, offset: number): number | null {
  if ((offset + 4 > bytes.length) || ((bytes[offset] | bytes[offset + 1] | bytes[offset + 2] | bytes[offset + 3]) > 0x7f)) return null;
  return (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];
}

function base64ToBytes(value: string): Uint8Array | null {
  // Whitespace is stripped because a base64 value that has been line-wrapped is still
  // a valid comment, and `atob` rejects it.
  const compact = value.replaceAll(/\s+/g, '');
  if (compact.length === 0) return null;
  try {
    const binary = atob(compact);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  } catch {
    return null;
  }
}

/**
 * An Ogg file's artwork, from its comment packet.
 *
 * Always `inline`: `walkPackets` reassembles a packet that spans a page boundary, so
 * the comment arrives whole and the base64 decodes without a second request. The
 * packet is bounded at 512 KB by `oggFraming`, which is generous for a picture and is
 * the same bound the tag reader already relies on.
 */
function readOggPicture(bytes: Uint8Array): EmbeddedPicture | null {
  let picture: EmbeddedPicture | null = null;
  walkPackets(bytes, (packet) => {
    const base = startsWith(packet, OPUS_TAGS, 0) ? 8 : startsWith(packet, VORBIS_COMMENT_MAGIC, 0) ? 7 : -1;
    if (base === -1) return;
    const value = findVorbisComment(packet, base, METADATA_BLOCK_PICTURE);
    if (value === null) return;
    const decoded = base64ToBytes(value);
    if (decoded === null) return;
    const header = readFlacPictureHeader(decoded, 0, decoded.length);
    if (header === null) return;
    const data = decoded.subarray(header.dataOffset, header.dataOffset + header.dataLength);
    // Sniffed, not taken from the block: the base64 round trip is where a declared
    // type is most likely to survive while the bytes are damaged.
    const resolved = resolveImageBytes(data);
    if (resolved !== null) picture = resolved;
    return false;
  });
  return picture;
}

/**
 * Find the embedded picture in a prefix of an audio file.
 *
 * @param bytes The leading bytes of the file. A short buffer is normal and returns
 *   `null` or a `range` rather than throwing.
 *
 * Dispatch is on the magic bytes rather than the extension, for the same reason
 * `readAudioTags` dispatches that way: the extension is client-supplied and routinely
 * wrong, and serving the wrong container's bytes as an image is worse than serving
 * nothing.
 */
function findPicture(bytes: Uint8Array): PictureSource | null {
  if (bytes.length < 4) return null;
  if (hasFlacMagic(bytes)) return locateFlacPicture(bytes);
  if (hasId3Magic(bytes)) return locateId3Picture(bytes);
  if (hasOggMagic(bytes)) {
    const picture = readOggPicture(bytes);
    return picture === null ? null : { kind: 'inline', picture };
  }
  return null;
}

export { findPicture, id3TagSize };
export type { PictureSource, PictureRange };
// Re-exported so a caller that already imports the container reader does not need a
// second import to recognise what it got back.
export { resolveImageBytes, sniffImageType } from './imageBytes';
export type { EmbeddedPicture } from './imageBytes';
