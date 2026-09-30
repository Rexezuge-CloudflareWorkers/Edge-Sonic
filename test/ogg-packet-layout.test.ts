/**
 * Ogg **packet** layout, and the two defects a page-oriented reader cannot see.
 *
 * ### Why this file exists separately from `enrichment-config.test.ts`
 *
 * The fixtures there build one packet per page, because that is what a page-oriented
 * reader needs in order to find the headers: it looks for `OpusHead` and `OpusTags` at
 * the *start* of a page body. A fixture and a reader that share a wrong assumption both
 * look right, so that suite was green while the deployed server returned no artist,
 * album, genre, track or year for any Opus file, and a duration 80x too small.
 *
 * The fixtures here are written from the Ogg framing spec instead of from the reader,
 * and the lacing table each one produces is decoded back and asserted, so the fixture
 * is checked against the spec rather than against the reader it is meant to catch.
 *
 * ### The two defects
 *
 * 1. **Packets are delimited by the lacing table, not by pages.** A packet ends where a
 *    segment value is `< 255`, and a page may carry several packets. `libavformat`
 *    writes the Opus identification header and the comment block as two packets in
 *    **one** page, which is what the live file here does: `OpusHead` at offset 282,
 *    `OpusTags` at 301, and a single lacing entry `19` marking the boundary. A reader
 *    that checks only page starts reads the first packet and never looks again.
 *
 * 2. **A prefix read cannot see the last page, and must say so.** The duration comes
 *    from the granule position on the final page. When the buffer ends mid-page, that
 *    granule belongs to a page whose body was cut off, so it is not the file's duration.
 *    Reporting it is not a rounding error: a 240.61 s track was reported as 3 s, and
 *    15329 kbps instead of 191, which is what a player seeks against.
 */
import { describe, expect, it } from 'vitest';
import { findPicture, materializePicture, readAudioTags, readOggTailDuration, readOpus, readVorbis } from '@edge-sonic/media-tags';

const encoder = new TextEncoder();

/**
Little-endian bytes, `width` of them.
*/
function le(value: number, width: number): number[] {
  const out: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  for (let index = 0; index < width; index += 1) {
    out.push(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/**
Big-endian bytes, for the FLAC `PICTURE` block whose fields the format spec fixes as
big-endian. Built forwards rather than as `le(...).reverse()`: `reverse()` mutates in
place, and a helper that silently mutated its caller's array would be a trap the next
fixture walks into.
*/
function be(value: number, width: number): number[] {
  const out: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  for (let index = 0; index < width; index += 1) {
    out.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/**
 * Byte-ish input: a `number[]` from a literal, or a `Uint8Array` view of one.
 */
type Bytes = number[] | Uint8Array;

/**
 * The lacing table for a list of packets, per the Ogg framing spec.
 *
 * Each segment is a run length of at most 255, and **a packet ends where a segment is
 * less than 255** — that is the only thing that delimits packets inside a page. A
 * packet whose length is an exact multiple of 255 needs a trailing `0` to terminate
 * it, or it silently merges with the packet after it.
 */
function lacing(packets: readonly Bytes[]): number[] {
  const segments: number[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      segments.push(255);
      remaining -= 255;
    }
    segments.push(remaining);
  }
  return segments;
}

/**
 * Decode a page's lacing table back into absolute packet start offsets.
 *
 * This is the fixture checking itself: it derives packet boundaries from the bytes on
 * the wire by the spec's own rule, independently of any reader in this repository, so a
 * reader that agrees with it is agreeing with the format and not with a shared bug.
 */
function packetStarts(page: readonly number[]): number[] {
  const segmentCount = page[26] as number;
  const tableStart = 27;
  const bodyStart = tableStart + segmentCount;
  const starts: number[] = [];
  let cursor = bodyStart;
  for (let index = 0; index < segmentCount; index += 1) {
    const segment = page[tableStart + index] as number;
    if (segment < 255) starts.push(cursor);
    cursor += segment;
  }
  return starts;
}

/**
One Ogg page carrying every packet given, in order.
*/
function oggPageWith(packets: readonly Bytes[], flags: number, granule: number, sequence: number): number[] {
  return oggPageRaw(lacing(packets), packets.flatMap((packet) => [...packet]), flags, granule, sequence);
}

/**
 * One Ogg page from an explicit segment table and body.
 *
 * `lacing` always terminates every packet, which is right for a page that ends a packet
 * and wrong for a page a packet *runs off the end of*: a continued packet is encoded as
 * a run of 255s with no terminating entry at all, and that is the only shape a
 * cross-page packet has.
 */
function oggPageRaw(segments: readonly number[], body: Bytes, flags: number, granule: number, sequence: number): number[] {
  expect(segments.length).toBeLessThanOrEqual(255);
  return [
    0x4f, 0x67, 0x67, 0x53, // "OggS"
    0x00, // version
    flags,
    ...le(granule, 8),
    ...le(0x00_00_00_01, 4), // serial
    ...le(sequence, 4),
    ...le(0, 4), // CRC, unchecked by every decoder in practice
    segments.length,
    ...segments,
    ...body,
  ];
}

/**
An Opus identification header, in the spec's field order (RFC 7845 §4.1).
*/
function opusHead(channels: number, preskip: number): number[] {
  return [
    ...encoder.encode('OpusHead'),
    0x01, // version
    channels,
    ...le(preskip, 2),
    ...le(48_000, 4), // original input rate; Opus always decodes at 48 kHz
    ...le(0, 2), // output gain
    0x00, // channel mapping family
  ];
}

/**
An Opus comment header (RFC 7845 §4.2): "OpusTags" then a Vorbis comment block.
*/
function opusTags(comments: Record<string, string>): number[] {
  const vendor = encoder.encode('edge-sonic-test');
  const entries = Object.entries(comments).map(([key, value]) => encoder.encode(`${key}=${value}`));
  return [
    ...encoder.encode('OpusTags'),
    ...le(vendor.length, 4),
    ...vendor,
    ...le(entries.length, 4),
    ...entries.flatMap((entry) => [...le(entry.length, 4), ...entry]),
  ];
}

/**
A Vorbis identification header, in the spec's field order (Vorbis I §4.2.1).
*/
function vorbisId(channels: number, rate: number, nominalBitrate: number): number[] {
  return [
    0x01,
    ...encoder.encode('vorbis'),
    ...le(0, 4), // vorbis_version
    channels,
    ...le(rate, 4),
    ...le(0, 4), // bitrate_maximum
    ...le(nominalBitrate, 4),
    ...le(0, 4), // bitrate_minimum
    0xb8, // blocksize
    0x01, // framing
  ];
}

/**
A Vorbis comment header, in the spec's field order (Vorbis I §4.2.3).
*/
function vorbisComments(comments: Record<string, string>): number[] {
  const vendor = encoder.encode('edge-sonic-test');
  const entries = Object.entries(comments).map(([key, value]) => encoder.encode(`${key}=${value}`));
  return [
    0x03,
    ...encoder.encode('vorbis'),
    ...le(vendor.length, 4),
    ...vendor,
    ...le(entries.length, 4),
    ...entries.flatMap((entry) => [...le(entry.length, 4), ...entry]),
    0x01, // framing
  ];
}

/**
The tags a real Lavf-encoded file carried, with the non-ASCII bytes intact.

`GENRE` is `Game%` here, which the real file is not: its genre is `Game`, and the `%` that
first looked like part of it is `0x25`, the low byte of the *next* entry's 37-byte length
prefix. The value is kept with a percent sign here on purpose — Vorbis comments are not
URL-encoded, so a parser that "helpfully" decoded one would corrupt it.
*/
const REAL_COMMENTS = {
  TITLE: 'H-A-J-I-M-A-R-I-U-T-A-!!',
  ARTIST: '777☆SISTERS',
  ALBUM: 'Summer of t7s',
  DATE: '2021',
  TRACKNUMBER: '01',
  GENRE: 'Game%',
};

describe('Ogg framing: the fixture checks itself against the spec', () => {
  it('delimits packets by the lacing table, so two headers can share one page', () => {
    const page = oggPageWith([opusHead(2, 312), opusTags(REAL_COMMENTS)], 0x02, 0, 0);

    // OpusHead is 19 bytes, so the first lacing entry is 19 and marks a packet
    // boundary 19 bytes into the body — which is exactly where OpusTags begins.
    // This is the layout libavformat writes and the layout the live file has.
    expect(page[26]).toBe(2);
    expect(page[27]).toBe(19);
    expect(page[28]).toBe(opusTags(REAL_COMMENTS).length);

    const starts = packetStarts(page);
    const body = new Uint8Array(page);
    const at = (offset: number) => new TextDecoder().decode(body.subarray(offset, offset + 8));
    expect(starts).toHaveLength(2);
    expect(at(starts[0] as number)).toBe('OpusHead');
    expect(at(starts[1] as number)).toBe('OpusTags');
  });

  it('terminates a packet that is an exact multiple of 255 with a zero segment', () => {
    // Without the trailing 0 this packet merges with the next one and the boundary
    // the reader depends on is gone.
    const page = oggPageWith([new Uint8Array(255), encoder.encode('OpusTags')], 0x02, 0, 0);
    expect(page[27]).toBe(255);
    expect(page[28]).toBe(0);
    expect(packetStarts(page)).toHaveLength(2);
  });
});

describe('Opus: a comment block sharing a page with the identification header', () => {
  const singlePage = new Uint8Array(oggPageWith([opusHead(2, 312), opusTags(REAL_COMMENTS)], 0x02, 0, 0));

  it('reads every text tag, which is the whole aggregation surface', () => {
    const tags = readAudioTags(singlePage, 5_736_100);

    expect(tags.container).toBe('ogg-opus');
    expect(tags.sampleRate).toBe(48_000);
    expect(tags.channels).toBe(2);
    expect(tags.title).toBe(REAL_COMMENTS.TITLE);
    expect(tags.artist).toBe('777☆SISTERS');
    expect(tags.album).toBe('Summer of t7s');
    expect(tags.genre).toBe('Game%');
    expect(tags.track).toBe(1);
    expect(tags.year).toBe(2021);
  });

  it('still reads tags when the two headers are on separate pages', () => {
    // The layout the old suite only ever built. It must keep working, or the fix
    // would trade one encoder's layout for another's.
    const bytes = new Uint8Array([
      ...oggPageWith([opusHead(2, 312)], 0x02, 0, 0),
      ...oggPageWith([opusTags({ ARTIST: 'Bon Iver' })], 0x00, 0, 1),
    ]);
    expect(readAudioTags(bytes, 1000).artist).toBe('Bon Iver');
  });

  it('reassembles a comment packet that straddles a page boundary', () => {
    // A packet longer than one page is continued on the next, and the bytes of the two
    // halves are NOT adjacent: the next page's 27-byte header sits between them. Reading
    // across that gap would consume the page header as comment data, so the halves have
    // to be joined first.
    //
    // Modelling this needs a first half whose lacing entries are all 255, because a
    // packet is only continued when no entry terminates it — an entry below 255 ends it
    // where it stands. The live file is shaped exactly this way: page 0 is `19, 255 ×
    // 254`, and its 89,931-byte `METADATA_BLOCK_PICTURE` continues onto page 1.
    const tags = opusTags({
      ARTIST: 'Bon Iver',
      ALBUM: 'For Emma',
      TITLE: 'Feels Like We Only Go Backwards',
      // Stands in for the embedded cover image that makes a real tag block this long.
      METADATA_BLOCK_PICTURE: 'A'.repeat(600),
    });
    const split = 510;
    expect(tags.length).toBeGreaterThan(split);

    // Page 0: the 19-byte identification header terminates, then two 255-byte runs with
    // no terminating entry — so the comment packet runs off the end and continues.
    const head = oggPageRaw([19, 255, 255], [...opusHead(2, 312), ...tags.slice(0, split)], 0x02, 0, 0);
    expect(head[26]).toBe(3);
    expect(head[27]).toBe(19);
    expect(head[28]).toBe(255);

    const bytes = new Uint8Array([
      ...head,
      ...oggPageWith([new Uint8Array(tags.slice(split))], 0x01, 0, 1),
    ]);

    const read = readOpus(bytes, 1000);
    expect(read.channels).toBe(2);
    expect(read.artist).toBe('Bon Iver');
    expect(read.album).toBe('For Emma');
    expect(read.title).toBe('Feels Like We Only Go Backwards');
  });
});

describe('Vorbis: the same packet rule', () => {
  it('reads a comment block that shares a page with the identification header', () => {
    const bytes = new Uint8Array(
      oggPageWith([vorbisId(2, 44_100, 160_000), vorbisComments({ TITLE: 'Holocene', ARTIST: 'Bon Iver' })], 0x02, 0, 0),
    );
    const tags = readVorbis(bytes, 30_000_000);
    expect(tags.container).toBe('ogg-vorbis');
    expect(tags.title).toBe('Holocene');
    expect(tags.artist).toBe('Bon Iver');
    expect(tags.sampleRate).toBe(44_100);
  });
});

describe('A truncated read must not report a duration', () => {
  const preskip = 312;
  const realGranule = 48_000 * 240 + preskip;

  /**
  A page that claims more payload than the buffer holds, as a prefix read produces.
  */
  function pageClaimingMoreThanItHas(granule: number): Uint8Array {
    const page = oggPageWith([opusHead(2, preskip), opusTags(REAL_COMMENTS)], 0x02, 0, 0);
    // A second page whose granule describes the whole file but whose body runs past the
    // end of the buffer, which is exactly the shape a truncated prefix read has.
    const audio = oggPageWith([new Uint8Array(4000)], 0x00, granule, 1);
    return new Uint8Array([...page, ...audio]);
  }

  it('returns no duration when the buffer ends mid-page', () => {
    const full = pageClaimingMoreThanItHas(realGranule);
    const truncated = full.subarray(0, - 3000);

    const tags = readOpus(truncated, 5_736_100);

    // The point of the assertion is the absence, not the value: a granule read off a
    // page whose body was cut off is a number, it is just not this file's duration.
    expect(tags.durationSeconds).toBeNull();
    // And the tags still parse, because they live in the part of the page we did read.
    expect(tags.artist).toBe('777☆SISTERS');
  });

  it('reports no bitrate either, since it is derived from that duration', () => {
    const truncated = pageClaimingMoreThanItHas(realGranule).subarray(0, 3000);
    expect(readOpus(truncated, 5_736_100).bitrateKbps).toBeNull();
  });

  it('uses a granule only from the end-of-stream page, not from a middle page', () => {
    // Every page is complete in the buffer, but none of them is the last one, so the
    // duration is still unknown. A complete-but-not-final page is exactly what a
    // prefix read is full of, and its granule is a progress report, not a duration.
    const bytes = new Uint8Array([
      ...oggPageWith([opusHead(2, preskip), opusTags(REAL_COMMENTS)], 0x02, 0, 0),
      ...oggPageWith([new Uint8Array(64)], 0x00, realGranule, 1),
    ]);
    expect(readOpus(bytes, 5_736_100).durationSeconds).toBeNull();
  });

  it('the guard has teeth: it is the page layout, not the page count, that decides', () => {
    // Same two pages, same granule — the only difference is that the last page now
    // carries the end-of-stream flag. If this test and the one above both passed for
    // the same reason, the guard above would be removable and that would be a defect.
    const withoutEos = new Uint8Array([
      ...oggPageWith([opusHead(2, preskip), opusTags(REAL_COMMENTS)], 0x02, 0, 0),
      ...oggPageWith([new Uint8Array(64)], 0x00, realGranule, 1),
    ]);
    const withEos = new Uint8Array([
      ...oggPageWith([opusHead(2, preskip), opusTags(REAL_COMMENTS)], 0x02, 0, 0),
      ...oggPageWith([new Uint8Array(64)], 0x04, realGranule, 1),
    ]);

    expect(readOpus(withoutEos, 5_736_100).durationSeconds).toBeNull();
    expect(readOpus(withEos, 5_736_100).durationSeconds).toBeCloseTo(240, 3);
  });
});

describe('The tail read, which is what supplies the real duration', () => {
  it('reads the final granule out of the last page of the file', () => {
    // What a suffix-anchored WebDAV read returns: the end of the file, where the only
    // page carrying the end-of-stream flag lives.
    const tail = new Uint8Array([
      ...oggPageWith([new Uint8Array(1000)], 0x00, 11_000_000, 90),
      ...oggPageWith([new Uint8Array(1000)], 0x04, 48_000 * 240 + 312, 91),
    ]);
    expect(readOggTailDuration(tail, 48_000, 312)).toBeCloseTo(240, 3);
  });

  it('works when the tail buffer starts part-way through a page', () => {
    // A byte range does not start on a page boundary, so the buffer opens in the middle
    // of the first page and its header is gone. What matters is that the reader can
    // still find the *later* page by its magic, rather than assuming offset 0 is one.
    const first = oggPageWith([new Uint8Array(2000)], 0x00, 5_000_000, 4);
    const last = oggPageWith([new Uint8Array(2000)], 0x04, 48_000 * 90, 5);
    const full = new Uint8Array([...first, ...last]);
    const tail = full.subarray(777);

    expect(readOggTailDuration(tail, 48_000, 0)).toBeCloseTo(90, 3);
  });

  it('reports no duration when the final page is not in the buffer', () => {
    const tail = new Uint8Array(oggPageWith([new Uint8Array(1000)], 0x00, 5_000_000, 90));
    expect(readOggTailDuration(tail, 48_000, 0)).toBeNull();
  });

  it('reports no duration for a buffer with no page in it at all', () => {
    expect(readOggTailDuration(new Uint8Array(2048), 48_000, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// The live library's shape: a comment packet far larger than any bounded read.
// ---------------------------------------------------------------------------------------

/**
 * The page body ceiling: 255 segments of 255 bytes (Ogg §4.2.1). Every muxer in use writes
 * pages at exactly this size, which is what makes a fetch sized from the observed page
 * body an upper bound rather than a guess.
 */
const PAGE_BODY_LIMIT = 255 * 255;

/**
 * An Opus comment header built from **raw** `KEY=value` entries.
 *
 * `opusTags` takes a `Record<string, string>`, which cannot express the case this file
 * exists for: a field of 1.16 MB. It also cannot express a field that is *not* valid
 * text, and the artwork case is a field whose value is base64 spanning every page of the
 * file.
 */
function opusTagsRaw(entries: readonly Uint8Array[]): number[] {
  const vendor = encoder.encode('edge-sonic-test');
  return [
    ...encoder.encode('OpusTags'),
    ...le(vendor.length, 4),
    ...vendor,
    ...le(entries.length, 4),
    ...entries.flatMap((entry) => [...le(entry.length, 4), ...entry]),
  ];
}

function commentEntry(key: string, value: string): Uint8Array {
  return Uint8Array.from([...encoder.encode(`${key}=`), ...encoder.encode(value)]);
}

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

/**
 * A FLAC `PICTURE` block, big-endian fields per the format spec §8.2.
 */
function pictureBlock(data: Uint8Array): number[] {
  const mime = encoder.encode('image/png');
  return [
    ...be(3, 4), // picture type 3, front cover
    ...be(mime.length, 4),
    ...mime,
    ...be(0, 4), // no description
    ...be(1400, 4),
    ...be(1400, 4),
    ...be(24, 4),
    ...be(0, 4),
    ...be(data.length, 4),
    ...data,
  ];
}

/**
 * A PNG body big enough that its base64 is larger than any bound this server keeps.
 *
 * The magic is what `sniffImageType` reads, and the size is the point: 600 KiB of image is
 * 800 KiB of base64, which puts the comment packet at over 800 KiB — past the 512 KiB that
 * used to be the largest packet this module would reassemble, and far past the 128 KiB
 * prefix read that has to find it.
 */
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 600 * 1024 }, () => 0x42)]);

/**
 * The *other* real cover size: 150 KiB of image, so 200 KiB of base64.
 *
 * This is the size that was missed. It is **under** the 256 KiB the Ogg path treats as
 * decodable-from-the-buffer and **over** the 128 KiB prefix read, so a locator that
 * decided on the declared length took the inline path, the read came back nothing, and it
 * reported no artwork on a file that plainly has one. The live library has covers of both
 * this size and the 868 KB one, so a fixture of only the larger would have left the whole
 * middle of the range untested — which is how a threshold catches one file and misses the
 * next.
 */
const MID_IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 150 * 1024 }, () => 0x20), 0xff, 0xd9]);

/**
 * The prefix this server actually reads: `TAG_READ_BYTES`.
 */
const PREFIX_BYTES = 131_072;

/**
 * An Opus file laid out the way `libavformat` lays one out, with a comment packet that
 * crosses many pages.
 *
 * Page 0 carries the identification header **and** the start of the comment packet, with
 * the segment table `19` marking the packet boundary and a run of 255s after it — no
 * terminator, because the packet continues. That is the live file's first page exactly:
 * `nseg=255`, `body=64789`, `OpusHead` at 0, `OpusTags` at 301.
 */
function oggFileWithEmbeddedPicture(image: Uint8Array): { file: Uint8Array; tagsLength: number } {
  const head = opusHead(2, 312);
  const tags = opusTagsRaw([
    commentEntry('TITLE', '燐光'),
    commentEntry('ARTIST', 'Daoko'),
    commentEntry('ALBUM', 'MementoMori (メメントモリ)'),
    commentEntry('TRACKNUMBER', '1'),
    commentEntry('METADATA_BLOCK_PICTURE', toBase64(Uint8Array.from(pictureBlock(image)))),
  ]);

  const pages: number[] = [];
  let consumed = 0;
  let sequence = 0;
  // Page 0: the identification header, then as much of the comment packet as fits after
  // it. 254 segments of 255 leave the packet running into the next page.
  const firstTake = 254 * 255;
  pages.push(
    ...oggPageRaw([head.length, ...Array.from({ length: 254 }, () => 255)], [...head, ...tags.slice(0, firstTake)], 0x02, 0, sequence),
  );
  consumed += firstTake;
  sequence += 1;

  // Whole pages of a packet still running: 255 segments of 255, and no terminator.
  while (tags.length - consumed >= PAGE_BODY_LIMIT) {
    pages.push(...oggPageRaw(Array.from({ length: 255 }, () => 255), tags.slice(consumed, consumed + PAGE_BODY_LIMIT), 0x00, 0, sequence));
    consumed += PAGE_BODY_LIMIT;
    sequence += 1;
  }

  // The page that ends the packet: 255s and then the remainder, which is the only entry
  // below 255 and so the only thing that delimits it.
  const rest = tags.length - consumed;
  const trailing = Math.floor(rest / 255);
  const remainder = rest % 255;
  pages.push(
    ...oggPageRaw([...Array.from({ length: trailing }, () => 255), remainder], tags.slice(consumed), 0x00, 0, sequence),
  );
  sequence += 1;

  // One audio page, so the file has an end-of-stream page a tail read can use.
  pages.push(...oggPageWith([new Uint8Array(4096)], 0x04, 48_000 * 241 + 312, sequence));

  return { file: Uint8Array.from(pages), tagsLength: tags.length };
}

describe('The live library: a comment packet larger than any bounded read', () => {
  const { file, tagsLength } = oggFileWithEmbeddedPicture(IMAGE_BYTES);
  const prefix = file.subarray(0, PREFIX_BYTES);

  /**
   * The fixture has to be the case, or these assertions prove nothing about it.
   *
   * Every one of these is a way the fixture could quietly stop testing what it exists for:
   * a picture small enough to sit inside the prefix, a packet small enough to reassemble, a
   * "prefix" that is really the whole file. The bug this guards was invisible for exactly
   * that reason — the previous fixture's picture was 89,931 bytes and the live file's is
   * 868 KB, so no assertion ever reached the bound that dropped the packet.
   */
  it('is over every bound it is meant to exceed', () => {
    expect(tagsLength).toBeGreaterThan(512 * 1024);
    expect(tagsLength).toBeGreaterThan(PREFIX_BYTES);
    expect(prefix).toHaveLength(PREFIX_BYTES);
    expect(file.length).toBeGreaterThan(tagsLength);
    // The picture's own bytes are past the prefix, which is the whole premise.
    expect(tagsLength - 200).toBeGreaterThan(PREFIX_BYTES);
  });

  it('reads every text tag out of the prefix alone, with no extra request', () => {
    // The four text fields end within the first few hundred bytes of the packet — in this
    // file, of the whole file. A reader that refuses the packet because it is too large
    // reports "no tags at all" for a file whose tags it was already holding, and that is
    // what every Opus track in the live library got: no artist, album, genre, track or
    // year, and therefore nothing for `getArtists`/`getAlbumList2`/`getGenres` to group.
    const tags = readAudioTags(prefix, file.length);
    expect(tags.title).toBe('燐光');
    expect(tags.artist).toBe('Daoko');
    expect(tags.album).toBe('MementoMori (メメントモリ)');
    expect(tags.track).toBe(1);
    expect(tags.container).toBe('ogg-opus');
  });

  it('claims a page-aligned range for a picture it cannot hold, rather than nothing', () => {
    // The Ogg path used to have no claim at all — it was `inline` or `null` — so a picture
    // past the read produced `null`, `getCoverArt` answered its 1x1 placeholder, and the
    // client cached a transparent pixel and never asked again.
    const located = findPicture(prefix, file.length);
    expect(located?.kind).toBe('ogg-comment');
    if (located?.kind !== 'ogg-comment') return;
    // Page-aligned, because a fetch that does not start at `OggS` cannot be re-walked.
    expect(new TextDecoder().decode(file.subarray(located.fileOffset, located.fileOffset + 4))).toBe('OggS');
    // And big enough to hold the base64 plus the headers threaded between its pages.
    expect(located.fileOffset + located.fileLength).toBeGreaterThanOrEqual(file.length - 4096 - 300);
  });

  it('materialises that range into the exact image bytes', async () => {
    // One ranged read, then the packet is re-walked and the value re-derived. Reading the
    // range as if it were the base64 would decode page headers as data, which is why the
    // claim is a page-aligned extent rather than a byte range.
    const located = findPicture(prefix, file.length);
    expect(located).not.toBeNull();
    if (located === null) return;

    let requests = 0;
    const picture = await materializePicture(
      located,
      async (offset, length) => {
        requests += 1;
        return file.slice(offset, offset + length);
      },
      { maxImageBytes: 8 * 1024 * 1024, maxFetchBytes: 16 * 1024 * 1024 },
    );

    expect(requests).toBe(1);
    expect(picture?.mimeType).toBe('image/png');
    expect(picture?.data.length).toBe(IMAGE_BYTES.length);
    expect(Buffer.from(picture?.data ?? new Uint8Array(0)).equals(Buffer.from(IMAGE_BYTES))).toBe(true);
  });

  it('refuses a short read rather than serving a partial cover', async () => {
    // The failure mode this whole feature has is "a valid image that is wrong": a truncated
    // cover renders, caches, and is never re-requested. So an origin that serves less than
    // the packet needs is "no artwork", not a partial picture.
    const located = findPicture(prefix, file.length);
    if (located === null) return;
    const picture = await materializePicture(
      located,
      async (offset, length) => file.slice(offset, offset + Math.floor(length / 2)),
      { maxImageBytes: 8 * 1024 * 1024, maxFetchBytes: 16 * 1024 * 1024 },
    );
    expect(picture).toBeNull();
  });

  it('claims a fetch for a cover under the inline threshold but past the prefix', async () => {
    // The size the live library actually has most of, and the one the length-based
    // threshold missed: 200 KiB of base64 is under the 256 KiB "decode it from here" bar
    // and over the 128 KiB prefix, so `read` returns nothing and the only correct answer
    // is the fetch. Deciding on the declared length rather than on whether the bytes are
    // present reported **no artwork** for these files — a valid, cacheable, invisible
    // wrong answer.
    const mid = oggFileWithEmbeddedPicture(MID_IMAGE_BYTES);
    const midPrefix = mid.file.subarray(0, PREFIX_BYTES);
    const base64Length = toBase64(Uint8Array.from(pictureBlock(MID_IMAGE_BYTES))).length;
    // The premise: small enough to look inline, too large to be in the buffer.
    expect(base64Length).toBeLessThan(256 * 1024);
    expect(base64Length).toBeGreaterThan(PREFIX_BYTES);

    const located = findPicture(midPrefix, mid.file.length);
    expect(located?.kind).toBe('ogg-comment');
    if (located?.kind !== 'ogg-comment') return;
    const picture = await materializePicture(
      located,
      async (offset, length) => mid.file.slice(offset, offset + length),
      { maxImageBytes: 8 * 1024 * 1024, maxFetchBytes: 16 * 1024 * 1024 },
    );
    expect(picture?.mimeType).toBe('image/jpeg');
    expect(Buffer.from(picture?.data ?? new Uint8Array(0)).equals(Buffer.from(MID_IMAGE_BYTES))).toBe(true);
  });

  it('claims a fetch when the file size is missing, rather than reporting no artwork', async () => {
    // A row that reached the reader without a usable `size` produced a zero-length range,
    // and a zero-length range is indistinguishable from "this file has no picture" — so a
    // missing size silently cost every cover in that album. The origin truncates a range
    // at end-of-file, and a short answer is refused on the way back, so over-asking is the
    // safe direction.
    for (const size of [0, null]) {
      const located = findPicture(prefix, size);
      expect(located?.kind).toBe('ogg-comment');
      if (located?.kind !== 'ogg-comment') return;
      expect(located.fileLength).toBeGreaterThan(0);
    }
  });

  it('decodes a small picture in place when the whole file is already in the buffer', () => {
    // No prefix at all: the packet is whole, so the value is decodable where it lies and no
    // request is warranted. This is the case a `read` bound with no fallback breaks, and the
    // case a fixture that is *always* a prefix would never see.
    const mid = oggFileWithEmbeddedPicture(MID_IMAGE_BYTES);
    const located = findPicture(mid.file, mid.file.length);
    expect(located?.kind).toBe('inline');
    if (located?.kind !== 'inline') return;
    expect(located.picture.mimeType).toBe('image/jpeg');
    expect(Buffer.from(located.picture.data).equals(Buffer.from(MID_IMAGE_BYTES))).toBe(true);
  });

  it('still claims the 868 KB cover even with the whole file in hand', () => {
    // Deliberate: decoding 1.16 MB of base64 to answer a question a 1.16 MB fetch answers
    // identically is the copy the threshold exists to avoid. The claim is not a failure to
    // find the picture, and `materializePicture` turns it back into the same bytes.
    const located = findPicture(file, file.length);
    expect(located?.kind).toBe('ogg-comment');
    if (located?.kind !== 'ogg-comment') return;
    const picture = materializePicture(
      located,
      async (offset, length) => file.slice(offset, offset + length),
      { maxImageBytes: 8 * 1024 * 1024, maxFetchBytes: 16 * 1024 * 1024 },
    );
    return picture.then((resolved) => {
      expect(Buffer.from(resolved?.data ?? new Uint8Array(0)).equals(Buffer.from(IMAGE_BYTES))).toBe(true);
    });
  });
});
