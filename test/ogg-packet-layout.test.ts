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
import { readAudioTags, readOggTailDuration, readOpus, readVorbis } from '@edge-sonic/media-tags';

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
