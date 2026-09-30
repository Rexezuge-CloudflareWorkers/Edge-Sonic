/**
 * Ogg **packets**: the logical streams inside the pages, read as an index rather than as
 * a buffer.
 *
 * Split from `oggPage` because a page is not a packet, and getting that wrong is silent.
 *
 * ### A page is not a packet
 *
 * Packets are delimited by the **segment table**: a packet ends where a lacing entry is
 * below 255, and one page may carry several packets. The two headers of an Opus stream are
 * separate packets, and `libavformat` writes them into a *single* page — so a reader that
 * looks for them only at page starts finds the identification header and never looks again.
 * That is why a library of such files reported no artist, album, genre, track or year, and
 * therefore had nothing to group: `getArtists`, `getAlbumList2`, `getGenres` and `search3`
 * were all empty at once.
 *
 * A packet longer than a page continues onto the next one, split by that page's header, so
 * its bytes are not adjacent — neither in the buffer nor in the file. A comment block
 * carrying an embedded cover image is that case, and **how big that case is** is the part
 * that was wrong here: the fixture this reader was written against carried an 89,931-byte
 * `METADATA_BLOCK_PICTURE`, and a real 9 MB Opus track carries an 868 KB one, which makes
 * its whole comment packet **1,158,339 bytes** spanning 18 pages.
 *
 * Reassembling that is not an option — it is a megabyte copied per track on a bounded
 * read, and the bound that forbade it simply deleted the packet, taking every tag with it.
 * So a packet here is a {@link LogicalPacket}: an index of the runs its bytes occupy, read a
 * field at a time. The four text fields of that live file end at byte 437 of the packet, so
 * its tags cost no extra bytes and no extra request, and its cover costs the one ranged
 * request that {@link LogicalPacket.fileRangeFor} sizes for it.
 */
import { readPage, MAX_PAGE_HEADER_BYTES } from './oggPage';
import type { OggPage } from './oggPage';

/**
 * The most logical bytes this module will **materialize** into one contiguous buffer.
 *
 * A bound on a copy, not on a packet. A hostile header that never terminates its packet
 * would otherwise grow a buffer until the isolate runs out of memory, and the pages of such
 * a packet are walked by `walkPackets`' own page bound regardless — so what needed limiting
 * was the copy, and that is what this is.
 *
 * ### It is not a bound on packet size, and treating it as one loses every tag
 *
 * It used to be exactly that, and the live library showed why that is the wrong shape. A
 * real 9 MB Opus file's comment packet is **1,158,339 bytes**, because it carries an 868 KB
 * cover as a base64 `METADATA_BLOCK_PICTURE`. That is over twice this bound, so the packet
 * was dropped whole and `parseVorbisComments` was never called: the track reported no
 * title, artist, album, genre, track or year — while a test fixture whose picture was
 * 89,931 bytes passed, because **a fixture that cannot reach the bound cannot see it**.
 *
 * So a packet is now a {@link LogicalPacket}: an index of where its bytes sit, read a
 * field at a time. Nothing here is proportional to the packet any more, and the four text
 * fields of that file end at byte 437 of it — so its tags cost **no extra bytes** and no
 * extra request.
 */
const MAX_MATERIALIZED_BYTES = 512 * 1024;

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
  /**
  Where this run starts in the file. Byte offsets into the *packet* are a different
  thing entirely — see {@link LogicalPacket.fileOffsetOf}.
  */
  readonly fileOffset: number;
  readonly length: number;
  /**
  The packet-relative offset this run starts at.
  */
  readonly logicalOffset: number;
  /**
   * File offset of the `OggS` header of the page this run sits in.
   *
   * A fetch has to start on a page boundary to be re-walkable, and the packet's first byte
   * is never one — it is inside a body. So the claim this produces is anchored here, which
   * is why a caller can hand the fetched buffer straight back to `walkPackets` and get the
   * same packet with the same logical offsets.
   */
  readonly pageOffset: number;
}

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
   * The file offset of packet offset `offset`, or `null` when it is not in the buffer.
   */
  fileOffsetOf(offset: number): number | null;
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

function spanAt(spans: readonly PacketSpan[], logicalOffset: number): PacketSpan | null {
  for (const span of spans) {
    if (logicalOffset >= span.logicalOffset && logicalOffset < span.logicalOffset + span.length) return span;
  }
  return null;
}

function makeLogicalPacket(bytes: Uint8Array, spans: readonly PacketSpan[], totalLength: number | null, maxPageBody: number): LogicalPacket {
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
    fileOffsetOf(offset: number): number | null {
      const span = spanAt(spans, offset);
      return span === null ? null : span.fileOffset + (offset - span.logicalOffset);
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
function walkPackets(bytes: Uint8Array, visit: (packet: LogicalPacket) => boolean | void): void {
  let pageOffset = 0;
  let spans: PacketSpan[] = [];
  let logicalOffset = 0;
  let maxPageBody = 0;
  // Where this packet's run inside the current page began, and how long it is. The
  // segments of a packet are consecutive in the page body, so a whole page's worth is
  // one run and the index stays one entry per page.
  let runStart = -1;
  let runLength = 0;

  for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
    const page: OggPage | null = readPage(bytes, pageOffset);
    if (page === null) break;
    maxPageBody = Math.max(maxPageBody, page.bodyLength);

    let cursor = page.bodyOffset;
    for (let index = 0; index < page.segmentCount; index += 1) {
      const segment = bytes[page.segmentTable + index] ?? 0;
      // `subarray` clamps, so a body the buffer cut off contributes the bytes that are
      // here rather than a read past the end.
      const present = Math.min(segment, Math.max(0, bytes.length - cursor));
      if (runStart < 0) runStart = cursor;
      runLength += present;

      if (segment < 255) {
        // `logicalOffset` is the base for this page's run: the bytes the packet took from
        // *earlier* pages. It is advanced once per page below and never inside this loop,
        // because a run is contiguous within a page and its start is the base.
        spans.push({ fileOffset: runStart, length: runLength, logicalOffset, pageOffset });
        const packet = makeLogicalPacket(bytes, spans, logicalOffset + runLength, maxPageBody);
        spans = [];
        logicalOffset = 0;
        // This page still spans the *next* packet when two packets share it, which is the
        // normal case for the Opus headers `libavformat` writes into one page.
        maxPageBody = page.bodyLength;
        runStart = -1;
        runLength = 0;
        if (visit(packet) === false) return;
      }
      cursor += segment;
    }

    // The page ended with a packet still running, so close its run here and only now
    // advance the base. This is the case the whole module exists for: a packet long
    // enough to cross a page boundary has its bytes in one run *per page*, and recording
    // only the page it ends on throws away every page it passed through.
    if (runLength > 0) {
      spans.push({ fileOffset: runStart, length: runLength, logicalOffset, pageOffset });
      logicalOffset += runLength;
      runStart = -1;
      runLength = 0;
    }

    const next = page.bodyOffset + page.bodyLength;
    if (next <= pageOffset) return;
    pageOffset = next;
    if (pageOffset >= bytes.length) break;
  }

  // A packet the buffer cut in half is still visited: its readable prefix is where the
  // fields a bounded read can reach live, and refusing to look reports "no tags" for a
  // file whose tags are in its first few hundred bytes. `spans` is emptied per packet, so
  // anything left here is a packet still running.
  if (spans.length > 0) visit(makeLogicalPacket(bytes, spans, null, maxPageBody));
}

export { walkPackets, MAX_MATERIALIZED_BYTES };
export type { LogicalPacket, PacketSpan };
// The page layer is re-exported so `ogg.ts` and `picture.ts` keep one import for "Ogg
// framing": they are one concern to a caller, and the split is an implementation detail of
// where the granule test lives.
export { readPage, walkPages, fileGranule, hasOggMagic, startsWith, OGG_MAGIC, OGG_EOS_FLAG, MAX_PAGE_HEADER_BYTES } from './oggPage';
export type { OggPage } from './oggPage';
