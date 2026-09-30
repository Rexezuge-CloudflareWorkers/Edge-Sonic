/**
 * Embedded artwork: the contract, and the dispatch onto the three containers.
 *
 * Separate from `readAudioTags` on purpose. Tags are a few hundred bytes and every play
 * wants them; artwork is routinely half a megabyte and only a cover grid wants it. Folding
 * the picture into the tag read would spend the bounded-prefix budget on a `getSong` that
 * has no use for the bytes, and would make the prefix large enough that tag reads start
 * costing real egress on every track.
 *
 * ### The three containers are not three formats
 *
 * Ogg does not have a picture of its own: a Vorbis or Opus file carries artwork as a
 * `METADATA_BLOCK_PICTURE` comment whose value is a **base64-encoded FLAC `PICTURE`
 * block**. So the FLAC picture parser is the only picture parser in the package, and the
 * Ogg reader is base64 plus a call into it. The three locators live beside this file —
 * `flacPicture`, `id3Picture`, `oggPicture` — and each answers in the same vocabulary,
 * because a caller that had to learn three different shapes would implement one and drop
 * two.
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
 * - **Ogg** carries the picture as base64 inside the comment packet, and that packet is
 *   routinely **larger than any buffer this server will read**: 1,158,339 bytes on a real
 *   9 MB Opus track, because the cover is 868 KB of PNG. So the same rule as FLAC applies
 *   — a small picture is `inline`, and one past the read comes back as a claim for the
 *   fetch that would produce it, with the packet's *page-aligned* extent rather than a
 *   byte range, because those bytes are not adjacent in the file.
 *
 * A `range` or `ogg-comment` source is a *claim about bytes*, not bytes, and the caller is
 * expected to honour it — which is why {@link materializePicture} lives beside the claim
 * rather than in the caller: the two variants need different work to satisfy, and the one
 * that needs format knowledge is the Ogg one.
 *
 * ### The answer is never a partial image
 *
 * Every path here returns bytes the caller can hand to a client, or nothing. A truncated
 * cover is a cover that "loaded" and renders as a grey box, which is worse than the
 * placeholder: the placeholder is visibly a placeholder, so a user clears the client's
 * image cache, and a grey box is not.
 *
 * Whether a run of bytes is an image at all is `./imageBytes`, which every container here
 * routes through.
 */
import { findVorbisCommentExtent } from './vorbisComment';
import { resolveImageBytes } from './imageBytes';
import type { EmbeddedPicture } from './imageBytes';
import { hasFlacMagic } from './flac';
import { locateFlacPicture } from './flacPicture';
import { hasId3Magic } from './mp3';
import { locateId3Picture } from './id3Picture';
import { hasOggMagic, walkPackets } from './oggFraming';
import { METADATA_BLOCK_PICTURE, locateOggPicture, oggCommentBase, pictureFromBase64 } from './oggPicture';
import type { OggCommentRange } from './oggPicture';

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

type PictureSource =
  | { readonly kind: 'inline'; readonly picture: EmbeddedPicture }
  | ({ readonly kind: 'range' } & PictureRange)
  | ({ readonly kind: 'ogg-comment' } & OggCommentRange);

/**
 * Reads a byte range of a file, for the claims {@link PictureSource} makes.
 *
 * @returns `null` when the origin could not serve it — never a short read, which
 *   {@link materializePicture} treats as "not there" rather than as an image.
 */
type PictureReader = (offset: number, length: number) => Promise<Uint8Array | null>;

/**
 * Bounds on what a cover request will spend and accept.
 */
interface PictureLimits {
  /**
  The largest image accepted. A length field read from a file is attacker-influenced, so
  this is a refusal rather than a hope: comfortably above any real cover.
  */
  readonly maxImageBytes: number;
  /**
   * The largest fetch this module will issue, which for Ogg is the base64 *text* rather than
   * the image it decodes to — so it must exceed {@link PictureLimits.maxImageBytes} by the
   * base64 expansion (4/3) plus the page headers threaded between the bytes.
   */
  readonly maxFetchBytes: number;
}

/**
 * Turn a located picture into bytes, spending the second request only where one is needed.
 *
 * Lives here rather than in the caller because the third variant needs format knowledge
 * this module owns: an `ogg-comment` claim is not a range of image bytes, so the caller
 * cannot honour it with a fetch and a `sniff` — it has to re-walk the packet and re-derive
 * where the value is. A caller that implemented `range` alone would have had no way to
 * express it, and the failure mode is a placeholder nobody can act on.
 *
 * @param read The one ranged fetch available. Called at most once.
 */
async function materializePicture(source: PictureSource, read: PictureReader, limits: PictureLimits): Promise<EmbeddedPicture | null> {
  if (source.kind === 'inline') return source.picture;
  if (source.kind === 'range') {
    if (source.length === 0 || source.length > limits.maxImageBytes) return null;
    const data = await read(source.offset, source.length);
    // A short read means the origin served less than the block declared — a truncated
    // file, or a server that ignored the `Range` and sent the head instead. Either way the
    // bytes are not the image, and a partial image handed to a client is a cover that
    // "loaded" and renders as a grey box, so it is refused rather than served.
    if (data === null || data.byteLength !== source.length) return null;
    return resolveImageBytes(data);
  }

  if (source.fileLength === 0 || source.fileLength > limits.maxFetchBytes) return null;
  const buffer = await read(source.fileOffset, source.fileLength);
  if (buffer === null || buffer.byteLength < source.fileLength) return null;

  // The fetch began on a page boundary, so this is a walkable stream and the packet comes
  // back with the *same* logical offsets the prefix gave — which is what lets the extent
  // be re-derived here instead of being carried across as a second value that could
  // disagree with the first.
  let picture: EmbeddedPicture | null = null;
  walkPackets(buffer, (packet) => {
    if (oggCommentBase(packet) !== source.commentBase) return;
    const extent = findVorbisCommentExtent(packet, source.commentBase, METADATA_BLOCK_PICTURE);
    if (extent === null) return;
    const raw = packet.read(extent.offset, extent.length, limits.maxFetchBytes);
    if (raw === null) return;
    picture = pictureFromBase64(new TextDecoder().decode(raw));
    return false;
  });
  return picture;
}

/**
 * Find the embedded picture in a prefix of an audio file.
 *
 * @param bytes The leading bytes of the file. A short buffer is normal and returns
 *   `null` or a claim rather than throwing.
 * @param fileSize The file's size, when known. Only the Ogg claim needs it, to clamp its
 *   fetch to the file.
 *
 * Dispatch is on the magic bytes rather than the extension, for the same reason
 * `readAudioTags` dispatches that way: the extension is client-supplied and routinely
 * wrong, and serving the wrong container's bytes as an image is worse than serving
 * nothing.
 */
function findPicture(bytes: Uint8Array, fileSize: number | null = null): PictureSource | null {
  if (bytes.length < 4) return null;
  if (hasFlacMagic(bytes)) return locateFlacPicture(bytes);
  if (hasId3Magic(bytes)) return locateId3Picture(bytes);
  if (hasOggMagic(bytes)) return locateOggPicture(bytes, fileSize);
  return null;
}

export { findPicture, materializePicture };
export { id3TagSize } from './id3Picture';
export type { PictureSource, PictureRange, PictureReader, PictureLimits };
export type { OggCommentRange } from './oggPicture';
// Re-exported so a caller that already imports the container reader does not need a
// second import to recognise what it got back.
export { resolveImageBytes, sniffImageType } from './imageBytes';
export type { EmbeddedPicture } from './imageBytes';
