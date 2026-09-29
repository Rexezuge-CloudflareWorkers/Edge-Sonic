/**
 * Ogg **framing**: pages, the packets inside them, and the granule that says how long
 * the file is.
 *
 * Split from `ogg.ts` because framing and codec are different concerns and because
 * getting framing wrong is silent: a page-oriented reader still returns a plausible
 * container, a plausible sample rate, and a duration — just the wrong one.
 *
 * ### A page is not a packet
 *
 * Packets are delimited by the **segment table**: a packet ends where a lacing entry is
 * below 255, and one page may carry several packets. The two headers of an Opus stream
 * are separate packets, and `libavformat` writes them into a *single* page — so a reader
 * that looks for them only at page starts finds the identification header and never looks
 * again. That is why a library of such files reported no artist, album, genre, track or
 * year, and therefore had nothing to group: `getArtists`, `getAlbumList2`, `getGenres`
 * and `search3` were all empty at once.
 *
 * A packet longer than a page continues onto the next one, split by that page's header,
 * so its bytes are not adjacent and it has to be reassembled. A comment block carrying an
 * embedded cover image is that case: the live file's `METADATA_BLOCK_PICTURE` entry runs
 * to 89,931 bytes.
 *
 * ### A granule is only a duration on the last page
 *
 * The granule position on a page is the number of samples decoded to its end, so only the
 * end-of-stream page's describes the whole file. A prefix read is full of pages that are
 * not that one, plus a final page whose body the buffer cut off — and a granule read off
 * either is still a *number*, so a reader that takes the last one it sees states a
 * confident wrong duration and a client seeks by it. A 240.61 s track was served as 3 s
 * and 15329 kbps instead of 191.
 */
import { readUintLE } from './bits';

const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"

/**
 * The end-of-stream header-type flag (Ogg §4.2.1, bit 2).
 */
const OGG_EOS_FLAG = 0x04;

/**
 * The largest packet this module will reassemble.
 *
 * A comment packet carrying an embedded cover image runs to tens of kilobytes, so the
 * bound is generous — but a hostile header that never terminates its packet would
 * otherwise grow a buffer until the isolate runs out of memory. Past this the packet is
 * dropped and no tag field is read from it.
 */
const MAX_PACKET_BYTES = 512 * 1024;

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  return offset + magic.length > bytes.length ? false : magic.every((byte, index) => bytes[offset + index] === byte);
}

interface OggPage {
  bodyOffset: number;
  bodyLength: number;
  granule: number;
  headerType: number;
  /**
   * Offset of the page's segment table, which is what delimits its packets.
   */
  segmentTable: number;
  segmentCount: number;
  /**
   * Whether the declared body is fully present in the buffer.
   *
   * `false` for the last page of a prefix read, and a granule from such a page is a
   * progress report rather than a duration.
   */
  complete: boolean;
}

/**
 * Parse one page header.
 *
 * The segment table is a list of 255-terminated run lengths, so the payload
 * length is the sum of the first `segmentCount` entries — it is *not* implied by
 * the header size.
 */
function readPage(bytes: Uint8Array, offset: number): OggPage | null {
  if (!startsWith(bytes, OGG_MAGIC, offset)) return null;

  const segmentCount = readUintLE(bytes, offset + 26, 1);
  if (segmentCount === null) return null;

  const tableStart = offset + 27;
  if (tableStart + segmentCount > bytes.length) return null;

  const bodyOffset = tableStart + segmentCount;
  let bodyLength = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    bodyLength += bytes[tableStart + index] ?? 0;
  }

  const granule = readUintLE(bytes, offset + 6, 8);

  return {
    bodyOffset,
    bodyLength,
    segmentTable: tableStart,
    segmentCount,
    complete: bodyOffset + bodyLength <= bytes.length,
    // A granule of -1 is the "no packet ends here" sentinel, written as
    // all-ones. It is legitimately absent, not an enormous sample count.
    granule: granule === null || granule === 0xff_ff_ff_ff_ff_ff_ff_ff ? 0 : granule,
    headerType: bytes[offset + 5] ?? 0,
  };
}

/**
The granule that describes the whole file, or `null` when the buffer does not contain it.

A granule counts only when its page is complete in the buffer *and* carries the
end-of-stream flag. Both halves matter, and both are silent when skipped: the buffer may
hold only middle pages, and its last page may be one the buffer cut in half.
*/
function fileGranule(pages: readonly OggPage[]): number | null {
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const page = pages[index];
    if (page.complete && (page.headerType & OGG_EOS_FLAG) !== 0) return page.granule;
  }
  return null;
}

/**
Walk pages, calling `visit` for each, until the buffer or a bound is reached.

Returns the pages walked, so the caller can ask for the file's granule without
re-parsing. A truncated final page is still visited — its packets are readable, and only
its granule is unusable, which is what `complete` says.
*/
function walkPages(bytes: Uint8Array, visit?: (page: OggPage, pageIndex: number) => boolean | void): OggPage[] {
  const seen: OggPage[] = [];
  let offset = 0;
  for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
    const page = readPage(bytes, offset);
    if (page === null) return seen;
    seen.push(page);
    if (visit !== undefined && visit(page, pageIndex) === false) return seen;
    const next = page.bodyOffset + page.bodyLength;
    if (next <= offset) return seen;
    offset = next;
    if (offset >= bytes.length) return seen;
  }
  return seen;
}

/**
 * Concatenate the pieces of one packet into a contiguous buffer.
 *
 * A packet continued onto the next page is split by that page's 27-byte header, so its
 * bytes are not adjacent in the buffer and a length-prefixed structure cannot be read
 * from a single offset. Reassembly is what makes `parseVorbisComments` correct: reading
 * across the gap instead would consume the page header as comment data.
 */
function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const first = chunks[0];
  if (chunks.length === 1 && first !== undefined) return first;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Walk the stream's **packets**, reassembling any that span a page boundary, and call
 * `visit` with each as a contiguous buffer.
 *
 * A packet past `MAX_PACKET_BYTES`, or one the buffer truncated, is skipped rather than
 * half-parsed.
 */
function walkPackets(bytes: Uint8Array, visit: (packet: Uint8Array) => boolean | void): void {
  let offset = 0;
  let pending: Uint8Array[] = [];
  let pendingLength = 0;

  for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
    const page = readPage(bytes, offset);
    if (page === null) return;

    let cursor = page.bodyOffset;
    for (let index = 0; index < page.segmentCount; index += 1) {
      const segment = bytes[page.segmentTable + index] ?? 0;
      // `subarray` clamps, so a body the buffer cut off yields the bytes that are here
      // rather than a read past the end.
      const piece = bytes.subarray(cursor, cursor + segment);
      cursor += segment;
      pendingLength += piece.length;

      if (segment < 255) {
        pending.push(piece);
        if (pendingLength <= MAX_PACKET_BYTES && visit(concatChunks(pending)) === false) return;
        pending = [];
        pendingLength = 0;
      } else {
        // Still running: keep collecting, but stop growing past the bound. A packet
        // this large is a tag block this module has no business reassembling.
        if (pendingLength <= MAX_PACKET_BYTES) pending.push(piece);
      }
    }

    const next = page.bodyOffset + page.bodyLength;
    if (next <= offset) return;
    offset = next;
    if (offset >= bytes.length) return;
  }
}

/**
 * Whether these bytes start an Ogg stream, whatever codec is inside it.
 */
function hasOggMagic(bytes: Uint8Array): boolean {
  return startsWith(bytes, OGG_MAGIC);
}

export { readPage, walkPages, walkPackets, fileGranule, hasOggMagic, startsWith, OGG_MAGIC, OGG_EOS_FLAG };
export type { OggPage };
