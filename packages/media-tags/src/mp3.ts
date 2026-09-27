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
import { MPEG_BITRATES, MPEG_SAMPLE_RATES } from './types';
import { EMPTY_TAGS } from './types';
import type { AudioTags } from './types';
import { readUintBE } from './bits';

const ID3_MAGIC = [0x49, 0x44, 0x33]; // "ID3"
const MPEG_FRAME_SYNC = 0xe0;

/**
 * Samples per MPEG frame: `[mpeg1Or2][layer]`, layers ordered **III, II, I**.
 *
 * Layer I is 384 samples regardless of version; layer III is 1152 on MPEG-1 and
 * 576 on MPEG-2/2.5 (halved, because the psychoacoustic model changed). Layer II
 * is 1152 on both.
 */
const SAMPLES_PER_FRAME: ReadonlyArray<ReadonlyArray<number>> = [
  // MPEG-1: layer III, II, I
  [1152, 1152, 384],
  // MPEG-2 / 2.5: layer III, II, I
  [576, 1152, 384],
];

interface MpegHeader {
  versionIndex: 0 | 1 | 2;
  layerIndex: 0 | 1 | 2;
  bitrateKbps: number;
  sampleRate: number;
  samplesPerFrame: number;
  channels: number;
  padding: boolean;
  offset: number;
}

/** Locate and decode the first MPEG audio frame header. */
function findFrameHeader(bytes: Uint8Array, from: number): MpegHeader | null {
  // A frame header is 4 bytes with 11 sync bits. Real files carry up to a few
  // bytes of junk before the first frame, so a short window is scanned; beyond
  // that a "frame" is more likely a false positive inside a tag.
  const limit = Math.min(bytes.length - 4, from + 4096);
  for (let offset = from; offset <= limit; offset += 1) {
    if (bytes[offset]! !== 0xff || (bytes[offset + 1]! & 0xe0) !== MPEG_FRAME_SYNC) continue;

    const versionBits = (bytes[offset + 1]! >> 3) & 0x03;
    const layerBits = (bytes[offset + 1]! >> 1) & 0x03;
    // `versionBits === 1` is reserved, and `layerBits === 0` is reserved.
    if (versionBits === 1 || layerBits === 0) continue;

    // Layer bits are `01`=III, `10`=II, `11`=I. Every table in this file is
    // ordered **III, II, I**, so the index is `layerBits - 1`. Inverting this —
    // the obvious `3 - layerBits` — silently reads a layer III file's sample
    // rate out of the layer I row and reports 11025 Hz for a 44100 Hz track.
    const versionIndex = (versionBits === 3 ? 0 : 1) as 0 | 1 | 2;
    const layerIndex = (layerBits - 1) as 0 | 1 | 2;
    const bitrateIndex = (bytes[offset + 2]! >> 4) & 0x0f;
    const sampleRateIndex = (bytes[offset + 2]! >> 2) & 0x03;
    // Both 0 and 15 are "free"/"bad" bitrates, and 3 is a reserved sample rate.
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue;

    // MPEG-2/2.5 share one bitrate table; MPEG-1 has its own. Sample rate
    // depends on the version only, never on the layer.
    const bitrateTable = MPEG_BITRATES[versionIndex === 0 ? 0 : 1]?.[layerIndex];
    const rateTable = MPEG_SAMPLE_RATES[versionIndex];
    const bitrateKbps = bitrateTable?.[bitrateIndex] ?? 0;
    const sampleRate = rateTable?.[sampleRateIndex] ?? 0;
    const samplesPerFrame = SAMPLES_PER_FRAME[versionIndex === 0 ? 0 : 1]?.[layerIndex] ?? 0;
    if (bitrateKbps === 0 || sampleRate === 0 || samplesPerFrame === 0) continue;

    // Channel mode: 11 is mono, everything else is two channels.
    const mode = (bytes[offset + 3]! >> 6) & 0x03;

    return {
      versionIndex,
      layerIndex,
      bitrateKbps,
      sampleRate,
      samplesPerFrame,
      channels: mode === 3 ? 1 : 2,
      padding: ((bytes[offset + 2]! >> 1) & 0x01) === 1,
      offset,
    };
  }
  return null;
}

/** ID3v2 sizes are "syncsafe": 7 bits per byte, so a tag cannot exceed 256 MB. */
function readSyncsafe(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! & 0x7f) << 21) | ((bytes[offset + 1]! & 0x7f) << 14) | ((bytes[offset + 2]! & 0x7f) << 7) | (bytes[offset + 3]! & 0x7f);
}

/** ID3v2.3 frame sizes are plain 32-bit; v2.4 made them syncsafe. */
function readFrameSize(bytes: Uint8Array, offset: number, majorVersion: number): number {
  if (majorVersion >= 4) return readSyncsafe(bytes, offset);
  return readUintBE(bytes, offset, 4) ?? 0;
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
  const encoding = bytes[start]!;
  const body = bytes.subarray(start + 1, start + length);

  let decoded: string;
  if (encoding === 0) {
    // Latin-1: each byte is a code point, unlike every other encoding here.
    let latin = '';
    for (const byte of body) latin += String.fromCharCode(byte);
    decoded = latin;
  } else if (encoding === 1) {
    if (body.length < 2) return null;
    const littleEndian = body[0] === 0xff && body[1] === 0xfe;
    const bigEndian = body[0] === 0xfe && body[1] === 0xff;
    const payload = littleEndian || bigEndian ? body.subarray(2) : body;
    decoded = new TextDecoder(littleEndian ? 'utf-16le' : bigEndian ? 'utf-16be' : 'utf-16le').decode(payload);
  } else if (encoding === 2) {
    decoded = new TextDecoder('utf-16be').decode(body);
  } else {
    decoded = new TextDecoder('utf-8').decode(body);
  }

  // Text frames are null-terminated, and multi-value frames are
  // null-separated — the first value is the one to show.
  const [first = ''] = decoded.split('\0');
  const cleaned = first.replaceAll(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** `3/12` or `3` → 3. */
function parseIndex(value: string | null): number | null {
  if (value === null) return null;
  const head = value.split('/')[0]?.trim() ?? '';
  return /^\d+$/.test(head) ? Number.parseInt(head, 10) : null;
}

function parseYear(value: string | null): number | null {
  if (value === null) return null;
  const match = /(\d{4})/.exec(value);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function readId3v2(bytes: Uint8Array, fileSize: number | null, audioStart: number): AudioTags {
  const majorVersion = bytes[3] ?? 4;
  const tagSize = readSyncsafe(bytes, 6);
  const frameStart = 10;

  let title: string | null = null;
  let artist: string | null = null;
  let album: string | null = null;
  let albumArtist: string | null = null;
  let genre: string | null = null;
  let year: number | null = null;
  let track: number | null = null;
  let disc: number | null = null;

  // v2.3 stores the year in `TYER`; v2.4 prefers `TDRC` and deprecates `TYER`.
  const textFrame = (id: string): string | null => {
    // Walk frames until the id matches. Tags have tens of frames, so this is
    // cheap, and it avoids trusting a hand-rolled per-frame offset table.
    let cursor = frameStart;
    const end = Math.min(frameStart + tagSize, bytes.length);
    while (cursor + 10 <= end) {
      const frameId = String.fromCharCode(...bytes.subarray(cursor, cursor + 4));
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break; // padding or corruption
      const size = readFrameSize(bytes, cursor + 4, majorVersion);
      if (size <= 0 || cursor + 10 + size > end) break;
      if (frameId === id) {
        return decodeTextFrame(bytes, cursor + 10, size);
      }
      cursor += 10 + size;
    }
    return null;
  };

  title = textFrame('TIT2');
  artist = textFrame('TPE1');
  album = textFrame('TALB');
  albumArtist = textFrame('TPE2');
  const genreCode = textFrame('TCON');
  year = parseYear(textFrame('TDRC')) ?? parseYear(textFrame('TYER'));
  track = parseIndex(textFrame('TRCK'));
  disc = parseIndex(textFrame('TPOS'));

  // A numeric `TCON` is an ID3v1 genre index, not a name. Resolving the full
  // 192-entry table is not worth it here; the raw number is more misleading
  // than a missing genre, so only named genres pass through.
  if (genreCode !== null && !/^\d+$/.test(genreCode)) genre = genreCode;

  const header = findFrameHeader(bytes, audioStart);
  if (header === null) {
    return { ...EMPTY_TAGS, container: 'mp3', title, artist, album, albumArtist, genre, year, track, disc };
  }
  // `Xing`/`Info` sits in the first frame's payload, after a side-info block
  // whose size depends on version and channel mode.
  const sideInfoLength = header.versionIndex === 0 ? (header.layerIndex === 0 ? 32 : 17) : header.layerIndex === 0 ? 17 : 9;
  const xingOffset = header.offset + 4 + sideInfoLength;
  const isVbr = readUintBE(bytes, xingOffset, 4);

  let frameCount: number | null = null;
  if (isVbr !== null && (bytes[xingOffset] === 0x58 || bytes[xingOffset] === 0x49)) {
    // 0x58 = 'X' (VBR), 0x49 = 'I' (info/CBR). After the 4-byte tag come flags,
    // then the frame count only when the corresponding flag bit is set.
    const flags = readUintBE(bytes, xingOffset + 4, 4) ?? 0;
    if ((flags & 0x0001) !== 0) {
      frameCount = readUintBE(bytes, xingOffset + 8, 4);
    }
  }

  let duration: number | null = null;
  if (frameCount !== null && frameCount > 0) {
    duration = (frameCount * header.samplesPerFrame) / header.sampleRate;
  }

  let bitrate = header.bitrateKbps;
  if (duration === null && fileSize !== null && header.bitrateKbps > 0) {
    // Subtract what is known not to be audio: the ID3v2 tag already measured,
    // and the 128-byte ID3v1 trailer, which only some files carry. Assuming it
    // exists costs 0.1% of the duration; assuming it does not costs a
    // consistent drift on every tagged file.
    const audioBytes = Math.max(0, fileSize - (10 + tagSize) - 128);
    duration = (audioBytes * 8) / (header.bitrateKbps * 1000);
    // Only downgrade to the estimate's imprecision by flagging VBR, not the
    // bitrate: a CBR-declared bitrate is the file's own claim.
    if (isVbr !== null && (bytes[xingOffset] === 0x58 || bytes[xingOffset] === 0x49)) bitrate = header.bitrateKbps;
  }

  // `padding` is decoded for completeness but does not affect the estimate: the CBR
  // path divides total bytes by the *declared* bitrate, and the 1/1152-byte
  // per-frame padding is already inside that byte count.
  void header.padding;

  return {
    ...EMPTY_TAGS,
    container: 'mp3',
    durationSeconds: duration,
    bitrateKbps: bitrate > 0 ? bitrate : null,
    sampleRate: header.sampleRate,
    channels: header.channels,
    ...(title !== null ? { title } : {}),
    ...(artist !== null ? { artist } : {}),
    ...(album !== null ? { album } : {}),
    ...(albumArtist !== null ? { albumArtist } : {}),
    ...(genre !== null ? { genre } : {}),
    ...(year !== null ? { year } : {}),
    ...(track !== null ? { track } : {}),
    ...(disc !== null ? { disc } : {}),
  };
}

function hasId3Magic(bytes: Uint8Array): boolean {
  return ID3_MAGIC.every((byte, index) => bytes[index] === byte);
}

export { readId3v2, hasId3Magic, findFrameHeader, decodeTextFrame, readSyncsafe };
