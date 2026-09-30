/**
 * Ogg embedded artwork: the `METADATA_BLOCK_PICTURE` comment, which is base64 around a
 * FLAC `PICTURE` block.
 *
 * ### Ogg does not have a picture of its own
 *
 * A Vorbis or Opus file carries artwork as a comment whose value is a **base64-encoded
 * FLAC `PICTURE` block** — the same structure, base64-wrapped. So the FLAC block reader is
 * the only picture-block reader in the package and this module is base64 plus a call into
 * it. That is deliberate: a second implementation of the FLAC block would be free to
 * disagree with the first about where the data begins, and the disagreement is invisible
 * until a client is handed a JPEG missing its first byte.
 *
 * ### `inline` only when it fits, and a claim for the fetch when it does not
 *
 * This used to say "always `inline`", on the reasoning that the comment packet is
 * reassembled so the base64 decodes without a second request. Both halves of that were
 * true of the fixture and false of every real file: a reassembly bound of 512 KB dropped
 * the 1,158,339-byte packet of a 9 MB Opus track outright, and even unbounded, a 128 KiB
 * prefix read stops 1.03 MB short of the base64. So the Ogg path found nothing for a
 * library that is **100% Opus with embedded covers**, `getCoverArt` answered the
 * placeholder PNG, and the client cached a transparent pixel and never asked again —
 * reported as "no cover image can be loaded" rather than as a failure.
 *
 * So the same rule as FLAC applies here: locating is not having. A picture small enough to
 * already be in the buffer comes back `inline`; one that is not comes back as the fetch
 * that would produce it — and that fetch cannot be a byte range, because the base64 is
 * split by every page header the comment packet continues across. See `OggCommentRange`.
 */
import { findVorbisCommentExtent } from './vorbisComment';
import { readFlacPictureHeader } from './flacPicture';
import { resolveImageBytes } from './imageBytes';
import type { EmbeddedPicture } from './imageBytes';
import { startsWith, walkPackets } from './oggFraming';
import type { LogicalPacket } from './oggFraming';
import type { PictureSource } from './picture';

const OPUS_TAGS = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]; // "OpusTags"
const VORBIS_COMMENT_MAGIC = [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // "\x03vorbis"
const METADATA_BLOCK_PICTURE = 'METADATA_BLOCK_PICTURE';

/**
 * Where an Ogg file's cover is, when the base64 that carries it is too large to hold.
 *
 * Not a `PictureRange`, because the base64 is not contiguous in the file: the comment
 * packet is split by every page header it continues across, so a range of its logical
 * bytes is **not** a range of file bytes. Handing that to a caller that fetches one range
 * and decodes it yields base64 with page headers threaded through it, which decodes to
 * nothing — and "no artwork" is the answer a client cannot distinguish from a working
 * one. So this claim is a *page-aligned* file range that reproduces the whole packet,
 * and re-deriving the value's extent from it is the materializer's first step.
 */
interface OggCommentRange {
  /**
  File offset of the `OggS` header to start the fetch at.
  */
  readonly fileOffset: number;
  readonly fileLength: number;
  /**
  Packet offset the comment list begins at: 8 after `OpusTags`, 7 after `\x03vorbis`.
  */
  readonly commentBase: number;
}

/**
 * The largest base64 `METADATA_BLOCK_PICTURE` worth *trying* to decode from the buffer
 * already in hand.
 *
 * Not a decision: `LogicalPacket.read` still has to succeed, and when it does not the
 * picture falls through to a fetch. The threshold only avoids attempting a decode of
 * something enormous, so it can be generous — and it has to be, because the interesting
 * case is a value comfortably under it and comfortably past a 128 KiB prefix.
 */
const INLINE_BASE64_BYTES = 256 * 1024;

/**
 * The offset the comment list starts at for this packet, or `-1` when it is not a comment
 * packet.
 *
 * Shared by the locator and the materializer because they must agree on where the list
 * begins: one answering `8` and the other `7` re-derives a different picture from the
 * same bytes, and the difference is a cover that decodes to nothing.
 */
function oggCommentBase(packet: LogicalPacket): number {
  const tags = packet.read(0, OPUS_TAGS.length);
  if (tags !== null && startsWith(tags, OPUS_TAGS, 0)) return OPUS_TAGS.length;
  const comment = packet.read(0, VORBIS_COMMENT_MAGIC.length);
  if (comment !== null && startsWith(comment, VORBIS_COMMENT_MAGIC, 0)) return VORBIS_COMMENT_MAGIC.length;
  return -1;
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
 * The picture block inside one base64 comment value.
 */
function pictureFromBase64(value: string): EmbeddedPicture | null {
  const decoded = base64ToBytes(value);
  if (decoded === null) return null;
  const header = readFlacPictureHeader(decoded, 0, decoded.length);
  if (header === null) return null;
  const data = decoded.subarray(header.dataOffset, header.dataOffset + header.dataLength);
  // Sniffed, not taken from the block: the base64 round trip is where a declared
  // type is most likely to survive while the bytes are damaged.
  return resolveImageBytes(data);
}

/**
 * An Ogg file's artwork, from its comment packet.
 *
 * @param fileSize The file's size, so the fetch can be clamped to it.
 */
function locateOggPicture(bytes: Uint8Array, fileSize: number | null): PictureSource | null {
  let found: PictureSource | null = null;
  walkPackets(bytes, (packet) => {
    const base = oggCommentBase(packet);
    if (base === -1) return;
    const extent = findVorbisCommentExtent(packet, base, METADATA_BLOCK_PICTURE);
    if (extent === null) return;

    if (extent.length <= INLINE_BASE64_BYTES) {
      const raw = packet.read(extent.offset, extent.length, INLINE_BASE64_BYTES);
      // `read` answers the only question that matters here — **are the bytes already
      // here** — and a `null` means "not here", so the fetch is the right answer.
      //
      // Deciding on the declared length instead is what this replaced, and it is wrong in
      // the middle of the range that matters: a 198 KB cover is *under* the 256 KiB inline
      // threshold and *past* a 128 KiB prefix, so it took the inline path, the read came
      // back `null`, and the file reported no artwork at all. The live library has both
      // shapes — 274 KB and 868 KB covers — so the threshold caught one and missed the
      // other, and only the one it missed was invisible.
      if (raw !== null) {
        // The bytes are here and they are not a picture: base64 that will not decode, or a
        // block that is not a picture. That is an answer, and it is `null` — claiming a
        // fetch would spend a subrequest to be told the same thing, and it would make a
        // malformed tag indistinguishable from a big one.
        const picture = pictureFromBase64(new TextDecoder().decode(raw));
        if (picture !== null) found = { kind: 'inline', picture };
        return false;
      }
    }

    const range = packet.fileRangeFor(extent.offset + extent.length, fileSize);
    if (range !== null && range.length > 0) {
      found = { kind: 'ogg-comment', fileOffset: range.offset, fileLength: range.length, commentBase: base };
    }
    return false;
  });
  return found;
}

export { locateOggPicture, oggCommentBase, pictureFromBase64, base64ToBytes, METADATA_BLOCK_PICTURE, INLINE_BASE64_BYTES };
export type { OggCommentRange };
