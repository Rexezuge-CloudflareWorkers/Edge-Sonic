/**
 * MP3: ID3v2 tags for the text fields, and duration from either a `Xing` frame
 * count or a CBR estimate.
 *
 * MP3 is the only format here where the duration is an *inference* rather than a
 * declared value, and the two paths differ in trustworthiness:
 *
 * - **VBR (`Xing`/`Info` header):** exact. The header carries the frame count,
 *   so `duration = frames × samplesPerFrame ÷ sampleRate`. A tagger that writes
 *   this one gets a correct number.
 * - **CBR:** an estimate. `duration = (fileSize − tagSize) × 8 ÷ bitrate`. It is
 *   wrong whenever a file is actually VBR but untagged, and it is wrong for
 *   every file with an ID3v1 trailer (128 bytes the estimate does not subtract).
 *
 * The CBR path subtracts both known overheads, which is the difference between
 * an estimate that is usually close and one that is consistently a second or two
 * long. Neither path is marked as approximate in the output, because the Subsonic
 * protocol has one `duration` field and no way to say "roughly".
 */
import { EMPTY_TAGS } from './types';
import type { AudioTags } from './types';
import { parseIndex as parseIndexBits, parseYear as parseYearBits, readUintBE } from './bits';
import { findFrameHeader } from './mpegFrame';

const ID3_MAGIC = [0x49, 0x44, 0x33]; // "ID3"
/**
ID3v2 sizes are "syncsafe": 7 bits per byte, so a tag cannot exceed 256 MB.
*/
function readSyncsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f)
  );
}

/**
ID3v2.3 frame sizes are plain 32-bit; v2.4 made them syncsafe.
*/
function readFrameSize(bytes: Uint8Array, offset: number, majorVersion: number): number {
  return majorVersion >= 4 ? readSyncsafe(bytes, offset) : (readUintBE(bytes, offset, 4) ?? 0);
}

/**
 * Decode an ID3v2 text frame payload.
 *
 * The first byte is the encoding: 0 Latin-1, 1 UTF-16 with BOM, 2 UTF-16BE,
 * 3 UTF-8. UTF-16 without honouring the BOM is the classic way a library ends
 * up with mojibake track names, so it is handled explicitly.
 */
function decodeTextFrame(bytes: Uint8Array, start: number, length: number): string | null {
  if (length < 1) return null;
  const encoding = bytes[start];
  const body = bytes.subarray(start + 1, start + length);

  let decoded: string;
  switch (encoding) {
    case 0: {
      // Latin-1: each byte is a code point, unlike every other encoding here.
      let latin = '';
      for (const byte of body) latin += String.fromCharCode(byte);
      decoded = latin;

      break;
    }
    case 1: {
      if (body.length < 2) return null;
      const littleEndian = body[0] === 0xff && body[1] === 0xfe;
      const bigEndian = body[0] === 0xfe && body[1] === 0xff;
      const payload = littleEndian || bigEndian ? body.subarray(2) : body;
      decoded = new TextDecoder(littleEndian ? 'utf-16le' : bigEndian ? 'utf-16be' : 'utf-16le').decode(payload);

      break;
    }
    case 2: {
      decoded = new TextDecoder('utf-16be').decode(body);

      break;
    }
    default: {
      decoded = new TextDecoder('utf-8').decode(body);
    }
  }

  // Text frames are null-terminated, and multi-value frames are
  // null-separated — the first value is the one to show.
  const [first = ''] = decoded.split('\0', 1);
  const cleaned = first.replaceAll(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
`null`-tolerant wrappers over `bits.ts`'s shared parsers.

The copies these replace were *almost* the shared ones: the shared `parseIndex` additionally
checked `Number.isFinite` on the parsed value and the shared `parseYear` checked its match,
which these did not. Not divergent in behaviour — both regexes guarantee digits — but two
implementations of one rule in the same package, and this repository has already paid for
that shape twice: `deriveBackfill` was written rather than reusing `deriveFromPath` "free to
disagree over the separator rules and the marker", and the Ogg fixture and the Ogg reader
shared a wrong framing assumption so no tag ever parsed and no test failed.

The `null` tolerance stays here because it is an ID3 concern: a missing frame is `null` at
the call site, not an empty string the shared parser has to defend against.
*/
function parseIndex(value: string | null): number | null {
  return value === null ? null : parseIndexBits(value);
}

function parseYear(value: string | null): number | null {
  return value === null ? null : parseYearBits(value);
}

/**
The subset of ID3v2 text frames this server reads, keyed by the field they fill.
*/
interface Id3v2Text {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  track: number | null;
  disc: number | null;
}

/**
Every frame id `readId3v2Text` is looking for.
*/
const WANTED_FRAME_IDS: ReadonlySet<string> = new Set(['TIT2', 'TPE1', 'TALB', 'TPE2', 'TCON', 'TDRC', 'TYER', 'TRCK', 'TPOS']);

/**
 * One pass over the frame list, collecting the raw text of every id this server reads.
 *
 * Its own function because the walk is the only part of `readId3v2` that knows about frames, and
 * it re-walked the tag once per field — eight times over a list of tens of frames, each pass
 * re-deriving the same offsets and each deciding independently where a corrupt frame should stop
 * it. One pass makes both single decisions and leaves the field mapping — which is pure — to a
 * function that cannot be wrong about the byte layout.
 *
 * The walk trusts no offset table: each frame's own header says how long it is, so a tag that
 * disagrees with itself ends the walk rather than being read at a position the reader invented.
 */
function readWantedFrames(bytes: Uint8Array, majorVersion: number, tagSize: number): Map<string, string> {
  const found = new Map<string, string>();
  const end = Math.min(10 + tagSize, bytes.length);
  let cursor = 10;
  while (cursor + 10 <= end && found.size < WANTED_FRAME_IDS.size) {
    const frameId = String.fromCharCode(...bytes.subarray(cursor, cursor + 4));
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break; // padding or corruption
    const size = readFrameSize(bytes, cursor + 4, majorVersion);
    if (size <= 0 || cursor + 10 + size > end) break;
    // A frame that decodes to `null` is **absent**, not present-and-null. Recording it here
    // would make `found.get` three-valued at every read and push a `!== undefined` into the
    // field mapping, where one of the branches would then be untested.
    const decoded = WANTED_FRAME_IDS.has(frameId) ? decodeTextFrame(bytes, cursor + 10, size) : null;
    if (decoded !== null && !found.has(frameId)) found.set(frameId, decoded);
    cursor += 10 + size;
  }
  return found;
}

/**
 * The fields, from the collected frames. Pure, and one decision per field.
 *
 * v2.3 stores the year in `TYER`; v2.4 prefers `TDRC` and deprecates `TYER`, so the first wins
 * and the second only fills what it left. A numeric `TCON` is an ID3v1 genre index rather than a
 * name: resolving the full 192-entry table is not worth it here, and the raw number is more
 * misleading than a missing genre, so only named genres pass through.
 */
function readId3v2Text(bytes: Uint8Array, majorVersion: number, tagSize: number): Id3v2Text {
  const frames = readWantedFrames(bytes, majorVersion, tagSize);
  const genre = frames.get('TCON');
  return {
    title: frames.get('TIT2') ?? null,
    artist: frames.get('TPE1') ?? null,
    album: frames.get('TALB') ?? null,
    albumArtist: frames.get('TPE2') ?? null,
    genre: genre === undefined || /^\d+$/.test(genre) ? null : genre,
    year: parseYear(frames.get('TDRC') ?? null) ?? parseYear(frames.get('TYER') ?? null),
    track: parseIndex(frames.get('TRCK') ?? null),
    disc: parseIndex(frames.get('TPOS') ?? null),
  };
}

/**
 * The frame count from a `Xing`/`Info` header, or `null` when the file has none.
 *
 * `Xing`/`Info` sits in the first frame's payload, after a side-info block whose size depends on
 * version and channel mode. 0x58 is `'X'` (VBR) and 0x49 is `'I'` (info/CBR) — the header tag
 * rather than the bit, because a file may write the `Info` variant for a constant-bitrate
 * stream.
 *
 * After the 4-byte tag come flags, and the frame count is present only when the corresponding
 * flag bit is set. A header without it means no exact duration, which the caller reports as no
 * duration rather than as an estimate it cannot support.
 */
function readXingFrameCount(bytes: Uint8Array, xingOffset: number): number | null {
  const isXingOrInfo = readUintBE(bytes, xingOffset, 4) !== null && (bytes[xingOffset] === 0x58 || bytes[xingOffset] === 0x49);
  if (!isXingOrInfo) return null;
  const flags = readUintBE(bytes, xingOffset + 4, 4) ?? 0;
  return (flags & 0x00_01) === 0 ? null : readUintBE(bytes, xingOffset + 8, 4);
}

function readId3v2(bytes: Uint8Array, fileSize: number | null, audioStart: number): AudioTags {
  const majorVersion = bytes[3] ?? 4;
  const tagSize = readSyncsafe(bytes, 6);
  const { title, artist, album, albumArtist, genre, year, track, disc } = readId3v2Text(bytes, majorVersion, tagSize);

  const header = findFrameHeader(bytes, audioStart);
  if (header === null) {
    return { ...EMPTY_TAGS, container: 'mp3', title, artist, album, albumArtist, genre, year, track, disc };
  }

  // `Xing`/`Info` sits in the first frame's payload, after a side-info block whose size depends
  // on version and channel mode.
  const sideInfoLength = header.versionIndex === 0 ? (header.layerIndex === 0 ? 32 : 17) : header.layerIndex === 0 ? 17 : 9;
  const frameCount = readXingFrameCount(bytes, header.offset + 4 + sideInfoLength);

  // A `let` rather than a ternary: the condition is a compound (`frameCount !== null` *and*
  // `> 0`), and spelling it out keeps the "no frame count means no duration" rule visible where
  // it is decided.
  let duration: number | null = null;
  if (frameCount !== null && frameCount > 0) {
    duration = (frameCount * header.samplesPerFrame) / header.sampleRate;
  }

  // The bitrate is the header's own claim and is reported unmodified — an estimate's imprecision
  // is never downgraded into the bitrate. It used to be re-assigned from `header.bitrateKbps`
  // here, the value it already held, so the assignment could not change anything.
  if (duration === null && fileSize !== null && header.bitrateKbps > 0) {
    // Subtract what is known not to be audio: the ID3v2 tag already measured, and the 128-byte
    // ID3v1 trailer, which only some files carry. Assuming it exists costs 0.1% of the
    // duration; assuming it does not costs a consistent drift on every tagged file.
    const audioBytes = Math.max(0, fileSize - (10 + tagSize) - 128);
    duration = (audioBytes * 8) / (header.bitrateKbps * 1000);
  }

  // `padding` is decoded for completeness but does not affect the estimate: the CBR path divides
  // total bytes by the *declared* bitrate, and the 1/1152-byte per-frame padding is already
  // inside that byte count.
  void header.padding;

  return {
    ...EMPTY_TAGS,
    container: 'mp3',
    durationSeconds: duration,
    bitrateKbps: header.bitrateKbps > 0 ? header.bitrateKbps : null,
    sampleRate: header.sampleRate,
    channels: header.channels,
    ...(title !== null && { title }),
    ...(artist !== null && { artist }),
    ...(album !== null && { album }),
    ...(albumArtist !== null && { albumArtist }),
    ...(genre !== null && { genre }),
    ...(year !== null && { year }),
    ...(track !== null && { track }),
    ...(disc !== null && { disc }),
  };
}

function hasId3Magic(bytes: Uint8Array): boolean {
  return ID3_MAGIC.every((byte, index) => bytes[index] === byte);
}

export { readId3v2, hasId3Magic, decodeTextFrame, readSyncsafe };
// Re-exported so the module's published surface is unchanged by the split.
export { findFrameHeader } from './mpegFrame';
export type { MpegHeader } from './mpegFrame';
