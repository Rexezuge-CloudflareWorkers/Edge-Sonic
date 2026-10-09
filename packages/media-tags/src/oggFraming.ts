/**
 * Ogg **packets**: the logical streams inside the pages, read as an index rather than as
 * a buffer.
 *
 * A barrel over the two modules that do the work, and the reason a caller does not need both.
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
 * Reassembling that is not an option — it is a megabyte copied per track on a bounded read,
 * and the bound that forbade it simply deleted the packet, taking every tag with it. So a
 * packet is a `LogicalPacket`: an index of the runs its bytes occupy, read a field at a
 * time. The four text fields of that live file end at byte 437 of the packet, so its tags
 * cost no extra bytes and no extra request, and its cover costs the one ranged request that
 * `LogicalPacket.fileRangeFor` sizes for it.
 *
 * ### Why two modules behind one import
 *
 * [`oggPage`](./oggPage.ts) reads a page **header**; [`oggPacketWalk`](./oggPacketWalk.ts) turns
 * a stream's pages into **packets**, which are addressed nowhere in the container and are
 * implied by the segment table. They fail differently and have no table in common, and while
 * they shared a file the packet walk's per-page bookkeeping sat beside the page reader's
 * bounds checks as one 275-line function.
 */

// The page layer is re-exported alongside the packet layer because `ogg.ts` and `picture.ts`
// keep one import for "Ogg framing" — the two are one concern to a caller, and the split is an
// implementation detail of where each decision lives.
export { MAX_PAGE_HEADER_BYTES, OGG_EOS_FLAG, OGG_MAGIC, fileGranule, hasOggMagic, readPage, startsWith, walkPages } from './oggPage';
export type { OggPage } from './oggPage';
export { MAX_MATERIALIZED_BYTES, walkPackets } from './oggPacketWalk';
export type { LogicalPacket, PacketSpan, WalkState } from './oggPacketWalk';
