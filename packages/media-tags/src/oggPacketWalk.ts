/**
 * The packet walk: how a stream's pages become the packets a reader sees.
 *
 * Split out of [`oggPage.ts`](./oggPage.ts)'s consumer side because the two are different jobs
 * with different failure modes. `oggPage` reads a page header; this reads *packets*, which are
 * not addressed anywhere in the container — they are implied by the segment table, they cross
 * page boundaries, and a packet the buffer cut in half still has to be reported. That is the
 * whole reason this file exists, and it is invisible in a page reader.
 *
 * The bound that used to live here moved into {@link LogicalPacket.read}: dropping an oversized
 * packet is what cost this server every tag on every Opus file with embedded artwork, because
 * the packet was never the thing that needed protecting — the copy was.
 */
import { MAX_PAGE_HEADER_BYTES, readPage } from './oggPage';
import type { OggPage } from './oggPage';

/**
 * How many bytes of a packet may be materialized.
 *
 * The bound protects the **copy**, not the packet: a packet larger than this is still walked and
 * still reported, with its `read` refusing past the limit. Dropping such a packet outright is what
 * cost this server every tag on every Opus file with embedded artwork — the artwork frame is
 * megabytes and it precedes the comment header, so the header was never reached at all.
 */
const MAX_MATERIALIZED_BYTES = 512 * 1024;

/**
 * A packet as an **index** rather than a buffer.
 *
 * A packet longer than a page is split by every page header it continues across, so its
 * bytes are not adjacent in the file and a length-prefixed structure cannot be read from one
 * offset. The old answer was to concatenate the lot, which is why a packet carrying a real
 * cover — 1,158,339 bytes — could not be read at all. This is the other answer: keep where
 * the bytes are, and read the few you need.
 */
interface LogicalPacket {
  /**
   * The packet's full length, or `null` when the buffer ended before the packet did.
   */
  readonly totalLength: number | null;
  /**
   * How many of the packet's bytes are actually in the buffer. Less than `totalLength` on
   * a prefix read, and equal to it when the packet is whole.
   */
  readonly available: number;
  readonly spans: readonly PacketSpan[];
  /**
   * The largest page body among the pages this packet spans.
   *
   * The basis for {@link fileRangeFor}: a run of logical bytes cannot cross more pages
   * than this divides them by, and each crossing costs a header. Every muxer in use writes
   * 64 KiB pages, so this is measured from the file rather than assumed.
   */
  readonly maxPageBody: number;
  /**
   * Read `length` bytes at packet offset `offset`.
   *
   * @param maxBytes Refuse a copy larger than this, so a length field read from a file
   *     cannot ask for a gigabyte. Defaults to `MAX_MATERIALIZED_BYTES`.
   * @returns `null` when the bytes are not all present, or the copy is over the bound.
   */
  read(offset: number, length: number, maxBytes?: number): Uint8Array | null;
  /**
   * A file byte range that, fetched and handed back to `walkPackets`, reproduces this
   * packet.
   *
   * Two things make this more than `fileOffsetOf` plus a length. It starts at the **page**
   * boundary rather than at the packet's first byte, so the fetched buffer is a walkable Ogg
   * stream; and it is sized from the page geometry, because the smallest range containing a
   * run of logical bytes is not knowable from a prefix — the pages between here and there
   * have not been read yet, and each contributes a header. For the live 9 MB Opus file that
   * is one request of ~1.16 MB covering an 868 KB cover, instead of a megabyte of base64
   * this server could never hold.
   *
   * @param through Packet offset to cover **through**, exclusive. Zero-length runs from the
   *     packet's start are the useful case.
   * @param fileSize The file's size, to clamp against. Omit when unknown.
   */
  fileRangeFor(through: number, fileSize?: number | null): { offset: number; length: number } | null;
}

function makeLogicalPacket(
  bytes: Uint8Array,
  spans: readonly PacketSpan[],
  totalLength: number | null,
  maxPageBody: number,
): LogicalPacket {
  const available = spans.reduce((total, span) => total + span.length, 0);
  return {
    totalLength,
    available,
    spans,
    maxPageBody,
    read(offset: number, length: number, maxBytes = MAX_MATERIALIZED_BYTES): Uint8Array | null {
      if (offset < 0 || length < 0 || length > maxBytes || offset + length > available) return null;
      const out = new Uint8Array(length);
      let written = 0;
      for (const span of spans) {
        const from = Math.max(offset, span.logicalOffset);
        const to = Math.min(offset + length, span.logicalOffset + span.length);
        if (to <= from) continue;
        out.set(bytes.subarray(span.fileOffset + (from - span.logicalOffset), span.fileOffset + (to - span.logicalOffset)), written);
        written += to - from;
      }
      return written === length ? out : null;
    },
    fileRangeFor(through: number, fileSize?: number | null): { offset: number; length: number } | null {
      const first = spans[0];
      if (first === undefined || through < 0) return null;
      const start = first.pageOffset;
      // The run already in progress, plus one page per `maxPageBody` logical bytes after
      // it. Every crossing costs one header, and the header is bounded, so this is an
      // upper bound on the physical length rather than a guess at it.
      const pages = Math.ceil(through / Math.max(1, maxPageBody)) + 1;
      const physical = through + pages * MAX_PAGE_HEADER_BYTES;
      // A non-positive size is treated as **unknown**, not as "a file of no bytes".
      //
      // Clamping to it produced a zero-length range, and a zero-length range is
      // indistinguishable from "there is no picture" — so a row that reached the reader
      // without a usable `size` silently reported no artwork on a file that has one. The
      // origin truncates a range at end-of-file anyway, and the short-read check on the
      // other side refuses an answer that came back short, so over-asking is safe and
      // under-asking is the failure.
      const known = typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize > 0;
      const capped = known ? Math.min(physical, Math.max(0, fileSize - start)) : physical;
      return { offset: start, length: capped };
    },
  };
}

/**
 * Walk the stream's **packets**, and call `visit` with each as a {@link LogicalPacket}.
 *
 * Every packet is visited, including one larger than any bound and one the buffer cut in
 * half. The bound moved to the copy ({@link LogicalPacket.read}) because dropping the
 * packet is what cost this server every tag on every Opus file with embedded artwork: the
 * packet is not the thing that needed protecting, the copy was.
 */

/**
 *  One contiguous run of a packet's bytes, and where it sits in the file.
 *
 *  A packet's segments are laid out consecutively inside a page body, so the bytes a
 *  packet holds in one page are **one** run — however many 255-terminated segments it
 *  took. That is what keeps the index to one entry per page rather than one per segment:
 *  a packet spanning the file's 18 pages is 18 entries, not 4,590, so walking a hostile
 *  header costs no more than walking its pages already does.
 */
interface PacketSpan {
  fileOffset: number;
  length: number;
  logicalOffset: number;
  pageOffset: number;
}

/**
The walk's carried state: what is open right now, and where it sits in the logical stream.
*/
interface WalkState {
  /**
  Index of the bytes the open packet has taken so far, one entry per page it crossed.
  */
  spans: PacketSpan[];
  /**
  Logical base of this page's run — the bytes the packet took from *earlier* pages.
  */
  logicalOffset: number;
  /**
  Largest body seen so far, which is the bound a packet copy is capped by.
  */
  maxPageBody: number;
  /**
  Where this page's run began, or `-1` when no run is open.
  */
  runStart: number;
  /**
  How long this page's run is.
  */
  runLength: number;
}

/**
 * Walk one page's segment table, calling `visit` for each packet that ends within it.
 *
 * Its own function because it is the only part of the walk that knows about segments, and it is
 * three levels deep: page, segment, and the packet-closing step inside the segment loop. Split
 * out, the closing step is the only thing left nested and each of the four carries its own
 * reason.
 *
 * `maxPageBody` is reset to *this* page's length after a packet closes, because the page can span
 * the next packet — the normal case for the Opus headers `libavformat` writes into one page.
 *
 * @returns the state to carry into the next page, and whether `visit` asked to stop.
 */
function walkPageSegments(
  bytes: Uint8Array,
  page: OggPage,
  pageOffset: number,
  visit: (packet: LogicalPacket) => boolean | void,
  state: WalkState,
): { state: WalkState; keepGoing: boolean } {
  const next: WalkState = { ...state };
  let cursor = page.bodyOffset;

  for (let index = 0; index < page.segmentCount; index += 1) {
    const segment = bytes[page.segmentTable + index] ?? 0;
    // `subarray` clamps, so a body the buffer cut off contributes the bytes that are here
    // rather than a read past the end.
    const present = Math.min(segment, Math.max(0, bytes.length - cursor));
    if (next.runStart < 0) next.runStart = cursor;
    next.runLength += present;

    if (segment < 255) {
      // A segment below 255 terminates a packet. `logicalOffset` is the base for this page's
      // run and is never advanced inside this loop, because a run is contiguous within a page
      // and its start is the base.
      next.spans.push({ fileOffset: next.runStart, length: next.runLength, logicalOffset: next.logicalOffset, pageOffset });
      const packet = makeLogicalPacket(bytes, next.spans, next.logicalOffset + next.runLength, next.maxPageBody);
      next.spans = [];
      next.logicalOffset = 0;
      next.maxPageBody = page.bodyLength;
      next.runStart = -1;
      next.runLength = 0;
      if (visit(packet) === false) return { state: next, keepGoing: false };
    }
    cursor += segment;
  }

  return { state: next, keepGoing: true };
}

/**
 * Walk the stream's **packets**, and call `visit` with each as a {@link LogicalPacket}.
 *
 * Every packet is visited, including one larger than any bound and one the buffer cut in half.
 * A page loop capped at 256 iterations is a deliberate bound rather than a guess: the pages are
 * walked to decide whether to continue, and a stream whose page count is driven by an attacker
 * costs a page read per iteration — so the walk stops rather than spending the invocation.
 */
function walkPackets(bytes: Uint8Array, visit: (packet: LogicalPacket) => boolean | void): void {
  let pageOffset = 0;
  let state: WalkState = { spans: [], logicalOffset: 0, maxPageBody: 0, runStart: -1, runLength: 0 };

  for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
    const page: OggPage | null = readPage(bytes, pageOffset);
    if (page === null) break;
    state.maxPageBody = Math.max(state.maxPageBody, page.bodyLength);

    const stepped = walkPageSegments(bytes, page, pageOffset, visit, state);
    if (!stepped.keepGoing) return;
    state = stepped.state;

    // The page ended with a packet still running, so close its run here and only now advance
    // the base. This is the case the whole module exists for: a packet long enough to cross a
    // page boundary has its bytes in one run *per page*, and recording only the page it ends on
    // throws away every page it passed through.
    if (state.runLength > 0) {
      state.spans.push({ fileOffset: state.runStart, length: state.runLength, logicalOffset: state.logicalOffset, pageOffset });
      state.logicalOffset += state.runLength;
      state.runStart = -1;
      state.runLength = 0;
    }

    const next = page.bodyOffset + page.bodyLength;
    if (next <= pageOffset) return;
    pageOffset = next;
    if (pageOffset >= bytes.length) break;
  }

  // A packet the buffer cut in half is still visited: its readable prefix is where the fields a
  // bounded read can reach live, and refusing to look reports "no tags" for a file whose tags are
  // in its first few hundred bytes. `spans` is emptied per packet, so anything left here is a
  // packet still running.
  if (state.spans.length > 0) visit(makeLogicalPacket(bytes, state.spans, null, state.maxPageBody));
}

export { MAX_MATERIALIZED_BYTES, walkPackets };
export type { LogicalPacket, PacketSpan, WalkState };
