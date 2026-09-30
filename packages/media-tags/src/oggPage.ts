/**
 * Ogg **page** framing: the `OggS` headers, their segment tables, and the granule that
 * says how long the file is.
 *
 * Split from `oggFraming` because a page and a packet are different things and confusing
 * them is silent: a page-oriented reader still returns a plausible container, a plausible
 * sample rate, and a duration — just the wrong one.
 *
 * ### A granule is only a duration on the last page
 *
 * The granule position on a page is the number of samples decoded to its end, so only the
 * end-of-stream page's describes the whole file. A prefix read is full of pages that are
 * not that one, plus a final page whose body the buffer cut off — and a granule read off
 * either is still a *number*, so a reader that takes the last one it sees states a
 * confident wrong duration and a client seeks by it. A 240.61 s track was served as 3 s
 * and 15329 kbps instead of 191.
 *
 * That is why {@link OggPage.complete} and {@link fileGranule} are here rather than being
 * decided by the caller: the two halves of the test are each easy to forget, and each one
 * forgotten produces a plausible number.
 */
import { readUintLE } from './bits';

const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"

/**
 * The end-of-stream header-type flag (Ogg §4.2.1, bit 2).
 */
const OGG_EOS_FLAG = 0x04;

/**
 *  A page body cannot exceed 255 segments of 255 bytes (Ogg §4.2.1).
 */

/**
 * The most bytes a page header can occupy: the fixed 27 plus a 255-entry segment table.
 */
const MAX_PAGE_HEADER_BYTES = 27 + 255;

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
 * Whether these bytes start an Ogg stream, whatever codec is inside it.
 */
function hasOggMagic(bytes: Uint8Array): boolean {
  return startsWith(bytes, OGG_MAGIC);
}

export { readPage, walkPages, fileGranule, hasOggMagic, startsWith, OGG_MAGIC, OGG_EOS_FLAG, MAX_PAGE_HEADER_BYTES };
export type { OggPage };
