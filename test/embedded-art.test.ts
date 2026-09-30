/**
 * Embedded artwork: FLAC `PICTURE`, ID3v2 `APIC`/`PIC`, and an Ogg file's
 * `METADATA_BLOCK_PICTURE`.
 *
 * ### The fixtures are built from the specs, and they decode themselves back
 *
 * Every builder here writes bytes by following the format specification, and each one
 * then **re-reads its own output** through an independent path and asserts the result.
 * That is the rule this repository learned the hard way twice: a fixture built to match
 * the reader's assumptions cannot fail for the reader's reason.
 *
 * - The FLAC reader and the FLAC fixture once shared a wrong byte offset, so every
 *   duration was wrong by 2^16 and nothing failed.
 * - The Ogg fixture and the Ogg reader once shared a wrong *framing* assumption — one
 *   packet per page — so no tag ever parsed and no test failed. The fix was a fixture
 *   that builds the **lacing table** from the spec and then decodes it back
 *   (`test/ogg-packet-layout.test.ts`).
 *
 * So `flacFile` below lays out a real metadata block table and `decodeBlockTable`
 * walks it independently; `id3File` lays out real frame headers; `oggFile` builds a
 * real segment table and `packetStarts` decodes it. If a builder and the reader ever
 * agree on something wrong, the self-check disagrees with both and the test fails
 * before it can mislead anyone.
 *
 * ### The cases that matter are the awkward ones
 *
 * A picture that fits in the prefix is the easy case and proves very little. What
 * matters:
 *
 * - a FLAC `PICTURE` block **past** the prefix, so the two-step locate-then-fetch path
 *   is the one exercised (`picturePastPrefix`),
 * - an `APIC` frame behind other frames, so the frame walk has to skip correctly,
 * - a **truncated** block and a block whose declared length **lies**, because both
 *   report "no picture" rather than a picture that is short or shifted.
 */
import { describe, expect, it } from 'vitest';
import { findPicture, resolveImageBytes, id3TagSize } from '@edge-sonic/media-tags';

/**
 * A recognisable JPEG body, so "these are the right bytes" is checkable rather than
 * "some bytes of about the right length".
 *
 * A plain `number[]`, **not** a `Uint8Array`, and that is load-bearing:
 * `Array.prototype.flat` flattens `Array` instances only, so a typed array passed to
 * `concat` survives as one *element* rather than as its bytes. A `Uint8Array` body
 * therefore produced a frame whose declared size was 20 rather than 33, every offset
 * after it wrong, and the reader correctly reported "no picture" — which is the
 * fixture failing rather than the reader, and is exactly the mirror of the mistake
 * this file exists to prevent.
 */
const JPEG_BODY = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9];
const PNG_BODY = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];

/**
 * A JPEG body large enough that its syncsafe and plain 32-bit frame-size readings
 * differ. Used by the teeth test that guards the v2.4 size field.
 */
const LARGE_JPEG_BODY = [0xff, 0xd8, 0xff, 0xe0, ...Array.from({length: 400}, () => 0x20), 0xff, 0xd9];

function bytes(...values: number[]): number[] {
  return values;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * An Ogg granule position is **64-bit** (Ogg §4.2.1). Writing a 4-byte zero here
 * shortens the whole page header by four bytes, which puts the segment count four
 * bytes early — and then the reader parses the lacing table as if it were the count,
 * which looks like a reader bug and is not.
 */
function u64(value: number): number[] {
  return [0, 0, 0, 0, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function concat(...parts: readonly (readonly number[])[]): number[] {
  return parts.flat();
}

// --------------------------------------------------------------------------------------
// FLAC
// --------------------------------------------------------------------------------------

const FLAC_MAGIC = ascii('fLaC');

/**
 * A FLAC metadata block header: one type byte (bit 7 = last block) then a 24-bit
 * big-endian length. Format spec §8.1.
 */
function blockHeader(type: number, length: number, last = false): number[] {
  return [last ? type | 0x80 : type, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

/**
 * A `PICTURE` block body. Format spec §8.2: picture type, MIME, description, width,
 * height, colour depth, indexed colours, then the data. Every length is big-endian u32.
 */
function pictureBlock(mime: string, description: string, data: readonly number[]): number[] {
  return concat(
    u32(3), // picture type: 3 = front cover
    u32(mime.length),
    ascii(mime),
    u32(description.length),
    ascii(description),
    u32(640),
    u32(480),
    u32(24),
    u32(0),
    u32(data.length),
    data,
  );
}

/**
 * `STREAMINFO`, exactly 34 bytes, of which this module reads the packed sample rate and
 * total samples. Written out so the fixture is a real FLAC rather than a magic number
 * plus a picture — and at the right length, because the block table is a *chain*: a
 * `STREAMINFO` two bytes long shifts every block after it, and the reader then reports
 * no picture on a file that plainly has one.
 *
 * Layout: min/max block size u16, min/max frame size u24, then one 64-bit packed run
 * (20 bits sample rate, 3 bits channels−1, 5 bits depth−1, 36 bits total samples), then
 * a 16-byte MD5. The run below is 44100 Hz, 2 channels, 16-bit, 44100 samples.
 */
function streamInfoBlock(): number[] {
  return concat(
    bytes(0x10, 0x00), // min block size
    bytes(0x10, 0x00), // max block size
    bytes(0x00, 0x00, 0x00), // min frame size
    bytes(0x00, 0x10, 0x00), // max frame size
    bytes(0x00, 0xac, 0x42, 0xf0, 0x00, 0x00, 0xac, 0x44), // the packed run
    Array.from({length: 16}, () => 0), // MD5 of the unencoded audio
  );
}

function vorbisCommentBlock(comments: readonly string[]): number[] {
  return concat(u32(0), u32(comments.length), ...comments.map((comment) => concat(u32(comment.length), ascii(comment))));
}

interface FlacFixture {
  bytes: Uint8Array;
  /**
  Where the image bytes start, so a test can assert the reported offset.
  */
  imageOffset: number;
}

/**
 * A FLAC file carrying a `PICTURE` block.
 *
 * @param options.paddingBefore Bytes of `PADDING` before the picture block.
 * @param options.pictureFirst Put `PICTURE` immediately after `STREAMINFO` rather than
 *   last. This is what makes the **two-step** path reachable: the block *header* has to
 *   be inside the prefix while the image bytes are not, and with `PICTURE` last — which
 *   is the conventional order — a 300 KB image puts its own header past a 128 KB
 *   prefix too, so the block is simply not locatable from the head. That is a real
 *   limit of locating-from-a-prefix and it is stated rather than papered over; this
 *   option is how the reachable case is exercised.
 */
function flacFile(image: readonly number[], options: { paddingBefore?: number; mime?: string; pictureFirst?: boolean } = {}): FlacFixture {
  const mime = options.mime ?? 'image/jpeg';
  const paddingBefore = options.paddingBefore ?? 0;
  const body = pictureBlock(mime, 'front', image);

  const streamInfo = concat(blockHeader(0, 34), streamInfoBlock());
  const comments = concat(blockHeader(4, vorbisCommentBlock(['TITLE=For Emma']).length), vorbisCommentBlock(['TITLE=For Emma']));
  const padding = paddingBefore > 0 ? blockHeader(1, paddingBefore) : [];
  const picture = blockHeader(6, body.length, true);

  // Laid out in order, so the image's offset is a property of the layout rather than a
  // number typed in beside it. The offset has to account for whatever *follows* the
  // picture block as well as what precedes it — computing it from the end of the file
  // is wrong the moment anything comes after the image, which is the normal case.
  const bodyHeaderLength = body.length - image.length;
  const imageOffset = options.pictureFirst
    ? FLAC_MAGIC.length + streamInfo.length + 4 + bodyHeaderLength
    : FLAC_MAGIC.length + streamInfo.length + comments.length + padding.length + 4 + bodyHeaderLength;
  const parts = options.pictureFirst ? concat(FLAC_MAGIC, streamInfo, picture, body, comments, padding) : concat(FLAC_MAGIC, streamInfo, comments, padding, picture, body);

  return { bytes: Uint8Array.from(concat(parts, [0xff, 0xf8])), imageOffset }; // a frame sync, so the file is not just metadata
}

/**
 * Walk a metadata block table **independently** of the reader, and decode the header
 * fields back out of the bytes that were written.
 *
 * This is the self-check. A builder and a reader that share a wrong assumption agree on
 * the result; a builder checked against a second implementation of the *spec* does not.
 */
function decodeBlockTable(bytes: Uint8Array): { type: number; offset: number; length: number }[] {
  const blocks: { type: number; offset: number; length: number }[] = [];
  let cursor = 4; // past "fLaC"
  for (let guard = 0; guard < 64; guard += 1) {
    const header = bytes[cursor];
    if (header === undefined) break;
    // **Three** bytes, not four. A block length is a 24-bit field, and reading four
    // bytes and masking pulls in the first byte of the block's *body* — which is how
    // this verifier first reported a 34-byte block as 8720 bytes and made a correct
    // reader look broken. The reader uses a three-byte read; so does this.
    const length = ((bytes[cursor + 1] ?? 0) << 16) | ((bytes[cursor + 2] ?? 0) << 8) | (bytes[cursor + 3] ?? 0);
    blocks.push({ type: header & 0x7f, offset: cursor + 4, length });
    cursor += 4 + length;
    if ((header & 0x80) !== 0) break;
  }
  return blocks;
}

describe('FLAC picture', () => {
  it('locates an inline picture and returns the exact bytes', () => {
    const fixture = flacFile(JPEG_BODY);
    // The fixture is checked against the spec before it is checked against the reader.
    const table = decodeBlockTable(fixture.bytes);
    expect(table.map((block) => block.type)).toEqual([0, 4, 6]);
    expect(fixture.bytes[fixture.imageOffset]).toBe(0xff);

    const source = findPicture(fixture.bytes);
    expect(source?.kind).toBe('inline');
    if (source?.kind !== 'inline') return;
    expect([...source.picture.data]).toEqual([...JPEG_BODY]);
    expect(source.picture.mimeType).toBe('image/jpeg');
  });

  it('reports a byte range, not bytes, when PICTURE is past the prefix', () => {
    // The two-step case, and the one that matters in production: `PICTYPE` holds an
    // image, so with a 300 KB cover its data starts past any prefix worth reading, and
    // the caller has to spend a second request for exactly that range. Locating it must
    // therefore be possible from the block table alone — the offset is arithmetic, not
    // something that has to be read.
    const big = [0xff, 0xd8, 0xff, 0xe0, ...Array.from({length: 300_000}, () => 0x20), 0xff, 0xd9];
    const fixture = flacFile(big, { pictureFirst: true });
    const prefix = fixture.bytes.subarray(0, 128 * 1024);

    // The precondition is the two-step condition exactly: the block header is inside the
    // prefix, so the picture is *locatable*, while the image runs past the end of it, so
    // the bytes are *not* available. Asserting only that the offset is beyond the prefix
    // would be a different (and unreachable) claim — a picture whose header is out of
    // reach cannot be located at all.
    expect(fixture.imageOffset).toBeLessThan(prefix.length);
    expect(fixture.imageOffset + big.length).toBeGreaterThan(prefix.length);
    expect(decodeBlockTable(prefix).map((block) => block.type)).toContain(6);

    const source = findPicture(prefix);
    expect(source?.kind).toBe('range');
    if (source?.kind !== 'range') return;
    expect(source.offset).toBe(fixture.imageOffset);
    expect(source).toHaveLength(big.length);
    expect(source.mimeType).toBe('image/jpeg');
    // The reported offset really does address the image in the full file.
    expect(fixture.bytes[source.offset]).toBe(0xff);
    expect([...fixture.bytes.subarray(source.offset, source.offset + source.length)]).toEqual(big);
  });

  it('cannot locate a PICTURE whose own block header is past the prefix', () => {
    // The limit of locating-from-a-prefix, asserted rather than left implicit: with
    // `PICTYPE` last and 300 KB of `PADDING` before it, the block header is out of
    // reach and the honest answer is "no picture" — the placeholder — not a wrong
    // offset. Enormous padding blocks are rare, which is why this is a limit and not a
    // reason to read the whole file.
    const big = [0xff, 0xd8, 0xff, 0xe0, ...Array.from({length: 300_000}, () => 0x20), 0xff, 0xd9];
    const fixture = flacFile(big, { paddingBefore: 300_000 });
    expect(findPicture(fixture.bytes.subarray(0, 128 * 1024))).toBeNull();
  });

  it('reports a range for a PICTURE the buffer cut short, and does not claim the bytes', () => {
    // A prefix that ends mid-image. The block header still says how long the picture
    // is, so the range is reportable — but the bytes are **not** invented from what is
    // there. A truncated image handed to a client is a cover that "loaded" and renders
    // as a grey box, which is worse than the placeholder it replaced.
    const fixture = flacFile(JPEG_BODY, { pictureFirst: true });
    const source = findPicture(fixture.bytes.subarray(0, fixture.imageOffset + 4));
    expect(source?.kind).toBe('range');
    if (source?.kind !== 'range') return;
    expect(source).toHaveLength(JPEG_BODY.length);
    expect(source.offset).toBe(fixture.imageOffset);
  });

  it('reads no picture from a FLAC that has none', () => {
    const noPicture = Uint8Array.from(concat(FLAC_MAGIC, blockHeader(0, 34), streamInfoBlock(), blockHeader(4, vorbisCommentBlock(['TITLE=x']).length, true), vorbisCommentBlock(['TITLE=x'])));
    expect(findPicture(noPicture)).toBeNull();
  });
});

// --------------------------------------------------------------------------------------
// MP3 / ID3v2
// --------------------------------------------------------------------------------------

function id3Header(tagSize: number, majorVersion = 4): number[] {
  // "ID3", version, flags, then a **syncsafe** size: 7 bits per byte.
  return concat(ascii('ID3'), [majorVersion, 0, 0], [(tagSize >>> 21) & 0x7f, (tagSize >>> 14) & 0x7f, (tagSize >>> 7) & 0x7f, tagSize & 0x7f]);
}

/**
A v2.4 frame header: id, syncsafe size, flags.
*/
function frameHeader(id: string, size: number): number[] {
  return concat(ascii(id), [(size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f], [0, 0]);
}

/**
 * Decode a 4-byte syncsafe integer, independently of the reader.
 *
 * Each byte contributes **seven** bits, so the inverse is a shift and an OR per byte.
 * The tempting one-liner — `((v >>> 21) & 0x7f) | ((v >>> 14) & 0x7f) | ((v >>> 7) & 0x7f) | v`
 * — is wrong: it ORs the *whole* value into the low byte instead of `v & 0x7f`, so it
 * returns 423 for 420 and every assertion built on it is meaningless.
 */
function decodeSyncsafe(bytes: readonly number[], offset: number): number {
  return ((bytes[offset] ?? 0) << 21) | ((bytes[offset + 1] ?? 0) << 14) | ((bytes[offset + 2] ?? 0) << 7) | (bytes[offset + 3] ?? 0);
}

/**
The same four bytes read as a plain 32-bit big-endian integer.
*/
function decodePlain32(bytes: readonly number[], offset: number): number {
  return ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
}

/**
A v2.2 frame header: three-character id, 24-bit plain size. No flags.
*/
function legacyFrameHeader(id: string, size: number): number[] {
  return concat(ascii(id), [(size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]);
}

function textFrame(id: string, text: string): number[] {
  const payload = concat([0x00], ascii(text)); // Latin-1
  return concat(frameHeader(id, payload.length), payload);
}

/**
 * An `APIC` payload: encoding, null-terminated MIME, picture type, null-terminated
 * description, then the image. ID3v2.4 §4.14.
 *
 * Split from the frame so a test can state the payload's length without restating the
 * framing — a declared size that disagrees with the bytes makes the *next* frame start
 * in the wrong place, and that surfaces as "no picture" rather than as a bad fixture.
 */
function apicPayload(mime: string, description: string, image: readonly number[], encoding = 0): number[] {
  return concat(
    [encoding],
    ascii(mime),
    [0x00],
    [0x03], // picture type: front cover
    encoding === 1 ? concat([0xff, 0xfe], ascii(description), [0x00, 0x00]) : concat(ascii(description), [0x00]),
    image,
  );
}

function apicFrame(mime: string, description: string, image: readonly number[], encoding = 0): number[] {
  const payload = apicPayload(mime, description, image, encoding);
  return concat(frameHeader('APIC', payload.length), payload);
}

/**
 * A v2.2 `PIC` payload: encoding, a three-character format code (**not** a MIME
 * string), picture type, description, image.
 */
function picFrame(format: string, image: readonly number[]): number[] {
  const payload = concat([0x00], ascii(format), [0x03], [0x00], image);
  return concat(legacyFrameHeader('PIC', payload.length), payload);
}

describe('ID3v2 picture', () => {
  it('finds an APIC frame behind other frames', () => {
    // The walk has to skip real frames to get here, and taggers put `APIC` after the
    // text frames — so a reader that assumed the first frame is the picture, or that
    // trusted a frame offset table, would miss it.
    const frames = concat(textFrame('TIT2', 'Skinny Love'), textFrame('TPE1', 'Bon Iver'), textFrame('TALB', 'For Emma'), apicFrame('image/jpeg', 'front', JPEG_BODY));
    const file = Uint8Array.from(concat(id3Header(frames.length), frames, [0xff, 0xfb, 0x90, 0x00]));

    const source = findPicture(file);
    expect(source?.kind).toBe('inline');
    if (source?.kind !== 'inline') return;
    expect([...source.picture.data]).toEqual([...JPEG_BODY]);
    expect(source.picture.mimeType).toBe('image/jpeg');
  });

  it('reads a v2.2 PIC frame, whose header layout differs from v2.4', () => {
    // v2.2 predates v2.4 in two ways that both break a walk written for the later tag: a
    // **three-character** frame id, and a **six-byte** frame header whose size is a plain
    // 24-bit integer rather than a syncsafe 32-bit one. Read with the v2.4 offsets, the
    // id comes out as three characters plus a stray byte, fails the `[A-Z0-9]{4}` test,
    // and the walk stops — reporting no picture on a file that plainly has one.
    //
    // The format code is stepped over rather than read: `JPG` is not a media type, and
    // the image's type comes from its own bytes, so translating it would be a second
    // opinion free to disagree with the picture.
    //
    // The declared size is computed from the payload rather than typed in, because a size
    // that disagrees with the bytes makes the *next* frame start in the wrong place and
    // the failure looks like "no picture" rather than "bad fixture".
    const title = concat(legacyFrameHeader('TT2', 1 + 'Holocene'.length), concat([0x00], ascii('Holocene')));
    const frames = concat(title, picFrame('JPG', JPEG_BODY));
    const file = Uint8Array.from(concat(id3Header(frames.length, 2), frames, [0xff, 0xfb, 0x90, 0x00]));

    const source = findPicture(file);
    expect(source?.kind).toBe('inline');
    if (source?.kind !== 'inline') return;
    expect(source.picture.mimeType).toBe('image/jpeg');
    expect([...source.picture.data]).toEqual([...JPEG_BODY]);
  });
  it('honours a UTF-16 description terminator', () => {
    // A UTF-16 description ends in `00 00`, and a reader that scans one byte at a time
    // finds a `00 00` straddling two characters, cuts the description in half, and
    // starts the image one byte early — a JPEG no client decodes, with every field
    // looking correct.
    const frames = concat(apicFrame('image/jpeg', '封面', PNG_BODY, 1));
    const file = Uint8Array.from(concat(id3Header(frames.length), frames));

    const source = findPicture(file);
    expect(source?.kind).toBe('inline');
    if (source?.kind !== 'inline') return;
    expect([...source.picture.data]).toEqual([...PNG_BODY]);
    expect(source.picture.mimeType).toBe('image/png');
  });

  it('reports the tag size so a caller can reach a picture past its prefix', () => {
    // `id3TagSize` exists for the one case a prefix cannot answer: an `APIC` past the
    // end of the read. Without the size there is no second read to issue, because the
    // frame headers are interleaved with the payloads and there is no offset table.
    const frames = concat(textFrame('TIT2', 'Holocene'), apicFrame('image/jpeg', '', JPEG_BODY));
    const file = Uint8Array.from(concat(id3Header(frames.length), frames));
    expect(id3TagSize(file)).toBe(frames.length);
    expect(10 + (id3TagSize(file) ?? 0)).toBe(file.length);
  });

  it('reads no picture from a tag that has none', () => {
    const frames = concat(textFrame('TIT2', 'Skinny Love'), textFrame('TPE1', 'Bon Iver'));
    expect(findPicture(Uint8Array.from(concat(id3Header(frames.length), frames)))).toBeNull();
  });

  it('reads no picture from a truncated APIC frame', () => {
    // A frame whose size runs past the end of the buffer. The walk stops rather than
    // reading a partial image.
    const file = Uint8Array.from(concat(id3Header(4096), ascii('APIC'), [0x00, 0x00, 0x40, 0x00, 0x00, 0x00], [0x00], ascii('image/jpeg'), [0x00, 0x03, 0x00]));
    expect(findPicture(file)).toBeNull();
  });
});

// --------------------------------------------------------------------------------------
// Ogg
// --------------------------------------------------------------------------------------

/**
 * Build a single-page Ogg stream carrying one packet, with a **correct** lacing table.
 *
 * A packet longer than 255 bytes needs several lacing entries of 255 followed by a
 * remainder — which is the case a real `METADATA_BLOCK_PICTURE` hits, since the base64
 * of a 60 KB JPEG runs past 255. A fixture that emitted one entry per packet, or one
 * page per packet, would be modelling the reader's assumption rather than the format.
 *
 * @throws when the packet cannot fit one page. The segment count is a **single byte**,
 *   so a page carries at most 255 lacing values and a packet at most 65,025 bytes; a
 *   larger one continues onto the next page, split by that page's 27-byte header. That
 *   case is `walkPackets`' job and is covered by `test/ogg-packet-layout.test.ts`.
 *   Silently truncating the count here produced a page whose "count" was `count & 0xff`
 *   and whose lacing table was then read as a packet list — a malformed fixture that
 *   looked exactly like a broken reader, so it is refused instead.
 */
function oggFile(packet: readonly number[]): Uint8Array {
  const lacing: number[] = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    lacing.push(255);
    remaining -= 255;
  }
  lacing.push(remaining);
  if (lacing.length > 255) throw new Error(`Packet of ${packet.length} bytes needs ${lacing.length} lacing entries; one Ogg page holds at most 255.`);

  // 'OggS' | version | header type | granule u64 | serial u32 | page seq u32 |
  // checksum u32 | segment count u8 | segment table | body. 27 bytes before the table.
  const page = concat(
    ascii('OggS'),
    [0x00, 0x00],
    u64(0),
    [0x00, 0x00, 0x00, 0x00],
    u32(0),
    [0x00, 0x00, 0x00, 0x00],
    [lacing.length],
    lacing,
    packet,
  );
  return Uint8Array.from(page);
}

/**
 * Decode the lacing table back out of the bytes, independently of the reader, and
 * return where each **packet** starts.
 *
 * A packet *starts* at the first segment after the table and *ends* where a lacing entry
 * drops below 255. Conflating the two is easy and wrong: a 10,780-byte packet has its
 * last segment at 10,780, and a helper that pushes on the terminating entry reports
 * that as the packet's start — a plausible-looking number that asserts nothing.
 */
function packetStarts(bytes: Uint8Array): number[] {
  const segmentCount = bytes[26];
  if (segmentCount === undefined) return [];
  const starts: number[] = [27 + segmentCount];
  let cursor = 27 + segmentCount;
  for (let index = 0; index < segmentCount; index += 1) {
    const lacing = bytes[27 + index] ?? 0;
    cursor += lacing;
    if (lacing < 255 && index < segmentCount - 1) starts.push(cursor);
  }
  return starts;
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
A Vorbis comment payload: vendor, count, then `KEY=value` entries.
*/
function commentList(entries: readonly string[]): number[] {
  return concat(u32LE(0), u32LE(entries.length), ...entries.map((entry) => concat(u32LE(entry.length), ascii(entry))));
}

function u32LE(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

describe('Ogg picture', () => {
  it('reads METADATA_BLOCK_PICTURE out of a Vorbis comment packet', () => {
    // The picture in an Ogg file is a **base64-encoded FLAC PICTURE block** in a
    // comment. So this is the FLAC parser reached through base64, not a second format
    // — which is why there is one picture parser in this module and not two.
    const encoded = base64(Uint8Array.from(pictureBlock('image/jpeg', 'front', JPEG_BODY)));
    const packet = concat(ascii('\x03vorbis'), commentList([`METADATA_BLOCK_PICTURE=${encoded}`, 'TITLE=For Emma']));
    const file = oggFile(packet);

    // The fixture is checked against the framing, not against the reader: the packet
    // must begin exactly where the segment table ends, which is 27 header bytes plus
    // however many lacing entries this packet needed.
    expect(packetStarts(file)).toEqual([file.length - packet.length]);
    expect(file.length - packet.length).toBe(27 + 1); // one lacing entry for a short packet

    const source = findPicture(file);
    expect(source?.kind).toBe('inline');
    if (source?.kind !== 'inline') return;
    expect([...source.picture.data]).toEqual([...JPEG_BODY]);
    expect(source.picture.mimeType).toBe('image/jpeg');
  });

  it('reads a picture from a packet that spans several lacing entries', () => {
    // A base64'd cover runs well past 255 bytes, so the packet is split across lacing
    // entries and has to be **reassembled**. A fixture that built one packet per page —
    // the assumption that made this module's tag reader find the first Opus header and
    // never look again — could not see this case at all.
    // Real image bytes, not filler. The filler has to begin with a magic or the reader
    // refuses it — correctly, since `resolveImageBytes` trusts nothing but the bytes,
    // and a payload of `0x41` is not a picture however well it is framed.
    const big = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({length: 8000}, () => 0x41)];
    const encoded = base64(Uint8Array.from(pictureBlock('image/png', '', big)));
    const packet = concat(ascii('\x03vorbis'), commentList([`METADATA_BLOCK_PICTURE=${encoded}`]));
    const file = oggFile(packet);

    // Precondition: this really is a multi-entry lacing table, so the test is about
    // reassembly rather than about a packet that happened to fit.
    expect(encoded.length).toBeGreaterThan(255);
    expect(file[26]).toBeGreaterThan(1);
    expect(packetStarts(file)).toEqual([file.length - packet.length]);

    const source = findPicture(file);
    expect(source?.kind).toBe('inline');
    if (source?.kind !== 'inline') return;
    expect(source.picture.data).toHaveLength(big.length);
    expect(source.picture.mimeType).toBe('image/png');
  });

  it('refuses to build a one-page fixture for a packet that needs more than 255 lacing entries', () => {
    // The guard in `oggFile` above, asserted so it cannot be quietly removed: the
    // segment count is one byte, so a page holds at most 255 lacing values.
    expect(() => oggFile(Array.from({length: 70_000}, () => 0))).toThrow(/at most 255/);
  });

  it('reads a picture from an OpusTags packet', () => {
    const encoded = base64(Uint8Array.from(pictureBlock('image/jpeg', '', JPEG_BODY)));
    const packet = concat(ascii('OpusTags'), commentList([`METADATA_BLOCK_PICTURE=${encoded}`]));
    const source = findPicture(oggFile(packet));
    expect(source?.kind).toBe('inline');
    if (source?.kind !== 'inline') return;
    expect([...source.picture.data]).toEqual([...JPEG_BODY]);
  });

  it('reads no picture from a comment packet that has none', () => {
    const file = oggFile(concat(ascii('\x03vorbis'), commentList(['TITLE=For Emma', 'ARTIST=Bon Iver'])));
    expect(findPicture(file)).toBeNull();
  });
});

// --------------------------------------------------------------------------------------
// The bytes are the authority
// --------------------------------------------------------------------------------------

describe('resolveImageBytes', () => {
  it('trusts the bytes over a declared type the tagger got wrong', () => {
    // `image/jpg` is not a real media type and several clients refuse an image served
    // with it. The bytes are a PNG, so the answer is a PNG.
    expect(resolveImageBytes(Uint8Array.from(PNG_BODY))?.mimeType).toBe('image/png');
  });

  it('refuses bytes that are not an image, rather than trusting a declared type', () => {
    // The refusal is the point. Text or audio served as `image/jpeg` is a file a client
    // writes into its image cache and then fails to decode, and the operator sees a
    // cover that "loaded". So an unidentifiable payload is not served — and note there
    // is deliberately **no** declared-type parameter to override this with.
    expect(resolveImageBytes(Uint8Array.from(ascii('this is not an image')))).toBeNull();
    expect(resolveImageBytes(new Uint8Array(0))).toBeNull();
    // A FLAC link block: MIME `-->`, no data.
    expect(resolveImageBytes(Uint8Array.from(ascii('-->')))).toBeNull();
  });

  it('recognises TIFF in both byte orders', () => {
    expect(resolveImageBytes(Uint8Array.from(bytes(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00)))?.mimeType).toBe('image/tiff');
    expect(resolveImageBytes(Uint8Array.from(bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00)))?.mimeType).toBe('image/tiff');
  });

  it('identifies an ISO-BMFF image by its ftyp brand, not by a prefix', () => {
    expect(resolveImageBytes(Uint8Array.from(concat(bytes(0x00, 0x00, 0x00, 0x20), ascii('ftypavif'), ascii('mif1'))))?.mimeType).toBe('image/avif');
    expect(resolveImageBytes(Uint8Array.from(concat(bytes(0x00, 0x00, 0x00, 0x20), ascii('ftypheic'))))?.mimeType).toBe('image/heif');
    // A brand we do not know is not served as an image.
    expect(resolveImageBytes(Uint8Array.from(concat(bytes(0x00, 0x00, 0x00, 0x20), ascii('ftypmp42'))))).toBeNull();
  });

  it('identifies a RIFF/WEBP by its bytes at offset 8, not by RIFF alone', () => {
    // `RIFF` also heads a WAV and an AVI, so a four-byte prefix test would claim a
    // four-byte WAV is a WebP and serve it as one.
    const webp = Uint8Array.from(concat(ascii('RIFF'), u32(100), ascii('WEBP'), ascii('VP8 ')));
    expect(resolveImageBytes(webp)?.mimeType).toBe('image/webp');
    const wav = Uint8Array.from(concat(ascii('RIFF'), u32(100), ascii('WAVE')));
    expect(resolveImageBytes(wav)).toBeNull();
  });
});

// --------------------------------------------------------------------------------------
// Teeth
// --------------------------------------------------------------------------------------

describe('the picture reader has teeth', () => {
  it('rejects a FLAC whose PICTURE header runs past its own block', () => {
    // The MIME length claims more than the block holds. Reading past it would put the
    // image at an offset derived from a number that was never there.
    const lying = concat(
      FLAC_MAGIC,
      blockHeader(0, 34),
      streamInfoBlock(),
      blockHeader(6, 32, true),
      u32(3),
      u32(9999), // MIME length, far beyond the 32-byte block
      ascii('image/jpeg'),
    );
    expect(findPicture(Uint8Array.from(lying))).toBeNull();
  });

  it('rejects an APIC with no MIME terminator inside its own frame', () => {
    // A MIME string with no terminator would otherwise run to the end of the buffer and
    // swallow the frames after it.
    const payload = concat([0x00], ascii('image/jpeg-with-no-terminator'));
    const file = Uint8Array.from(concat(id3Header(payload.length + 10), frameHeader('APIC', payload.length), payload));
    expect(findPicture(file)).toBeNull();
  });

  it('rejects a base64 picture comment that does not decode', () => {
    const packet = concat(ascii('\x03vorbis'), commentList(['METADATA_BLOCK_PICTURE=!!!not base64!!!']));
    expect(findPicture(oggFile(packet))).toBeNull();
  });

  it('rejects a base64 picture comment that decodes to something that is not a picture block', () => {
    const packet = concat(ascii('\x03vorbis'), commentList([`METADATA_BLOCK_PICTURE=${base64(Uint8Array.from(ascii('too short')))}`]));
    expect(findPicture(oggFile(packet))).toBeNull();
  });

  it('rejects a buffer too short to identify', () => {
    expect(findPicture(Uint8Array.from([0x66, 0x4c]))).toBeNull();
    expect(findPicture(new Uint8Array(0))).toBeNull();
  });

  it('rejects a v2.4 frame size read as plain big-endian, which is the bug this guards', () => {
    // v2.4 sizes are syncsafe — 7 bits per byte. Read as a plain 32-bit integer, a
    // 400-byte `APIC` comes out as 838 860 800, which fails the bounds check and
    // reports "no picture" on a file that plainly has one. So the fixture uses a payload
    // large enough that the two readings genuinely differ, and asserts that
    // precondition rather than assuming it.
    const size = apicPayload('image/jpeg', '', LARGE_JPEG_BODY).length;
    const header = frameHeader('APIC', size);
    // Precondition, decoded independently: the syncsafe reading round-trips, and the
    // plain reading of the *same four bytes* is a different, absurd number. Without
    // this the test would pass against a reader that used either convention.
    expect(decodeSyncsafe(header, 4)).toBe(size);
    expect(decodePlain32(header, 4)).not.toBe(size);

    const frames = concat(textFrame('TIT2', 'x'), apicFrame('image/jpeg', '', LARGE_JPEG_BODY));
    const file = Uint8Array.from(concat(id3Header(frames.length), frames));
    const source = findPicture(file);
    expect(source?.kind).toBe('inline');
    if (source?.kind !== 'inline') return;
    expect(source.picture.data.byteLength).toBe(LARGE_JPEG_BODY.length);
  });
});
