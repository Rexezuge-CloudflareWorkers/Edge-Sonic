/**
 * Tag reading from real byte fixtures.
 *
 * These are hand-built containers rather than mocked readers, because the bugs this
 * module is prone to are *layout* bugs — a misread bit offset reports a plausible
 * wrong number rather than failing. Two of them were caught by exactly this
 * approach while writing it: an inverted MPEG layer index, which reported 11025 Hz
 * for a 44100 Hz file, and a Layer II bitrate table used for Layer III, which
 * reported 288 kbps for a 128 kbps file and put every duration out by 2.25×.
 *
 * Both produced a *number*. Neither produced an error. That is the whole reason
 * these tests assert exact values.
 */
import { describe, expect, it } from 'vitest';
import { readAudioTags } from '@edge-sonic/media-tags';

const encoder = new TextEncoder();

/**
ID3v2 sizes are syncsafe: 7 bits per byte.
*/
function syncsafe(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function utf8TextFrame(id: string, text: string): number[] {
  const payload = encoder.encode(text);
  // The declared size covers the **whole** frame body, which begins with the
  // one-byte encoding marker. Excluding it truncates the last character and, worse,
  // leaves the cursor one byte short so every later frame is missed.
  const bodyLength = 1 + payload.length;
  return [
    ...encoder.encode(id),
    // ID3v2.3: frame sizes are plain 32-bit, not syncsafe. Getting this wrong for
    // the version under test is the classic tag-parser bug.
    (bodyLength >>> 24) & 0xff,
    (bodyLength >>> 16) & 0xff,
    (bodyLength >>> 8) & 0xff,
    bodyLength & 0xff,
    0,
    0,
    0x03, // UTF-8
    ...payload,
  ];
}

interface Mp3Options {
  majorVersion?: 2 | 3 | 4;
  bitrateIndex?: number;
  sampleRateIndex?: number;
  layerBits?: number;
  fileSize?: number;
  frames?: Record<string, string>;
}

function buildMp3(options: Mp3Options = {}): Uint8Array {
  const { majorVersion = 3, bitrateIndex = 9, sampleRateIndex = 0, frames = {} } = options;
  const frameBytes: number[] = [];
  for (const [id, text] of Object.entries(frames)) frameBytes.push(...utf8TextFrame(id, text));

  const out: number[] = [];
  if (frameBytes.length > 0) {
    out.push(0x49, 0x44, 0x33, majorVersion, 0, 0, ...syncsafe(frameBytes.length), ...frameBytes);
  }
  // MPEG-1 Layer III, no CRC, no padding.
  out.push(0xff, 0xfb, (bitrateIndex << 4) | (sampleRateIndex << 2), 0x00);
  return new Uint8Array(out);
}

/**
Expected size of the audio payload for a CBR file, so the estimate can be checked.
*/
function mp3FileSize(tagBytes: number, bitrateKbps: number, seconds: number): number {
  return Math.round((bitrateKbps * 1000 * seconds) / 8) + tagBytes + 128;
}

interface FlacOptions {
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  totalSamples?: number;
  fileSize?: number;
  comments?: Record<string, string>;
  /**
   * Raw `KEY=value` comment entries appended after `comments`, in order.
   *
   * A record cannot hold a repeated key, and the reader's duplicate-key rule is
   * exactly what this exists to stage.
   */
  extraComments?: string[];
}

function buildFlac(options: FlacOptions = {}): Uint8Array {
  const { sampleRate = 44_100, channels = 2, bitDepth = 16, totalSamples = 44_100 * 180, fileSize, comments = {}, extraComments = [] } = options;

  // STREAMINFO is 34 bytes: min block size u16, max block size u16, min frame size
  // u24, max frame size u24, then one 64-bit run packing 20/3/5/36 bits, then a
  // 128-bit MD5. The run therefore starts at byte **10**, after 16+16+24+24 = 80 bits.
  //
  // This fixture used to write the run at byte 8, which matched a reader that also read
  // it at byte 8 — so the pair agreed and every FLAC duration was wrong by roughly a
  // factor of 2^16 without a single test failing. That is the failure mode this project
  // keeps a test double honest against: when a fixture and a reader share a wrong
  // assumption, only the spec can break the tie, so the offsets are spelled out here.
  const streamInfo = new Uint8Array(34);
  const view = new DataView(streamInfo.buffer);
  view.setUint16(0, 4096); // min block size
  view.setUint16(2, 4096); // max block size
  // min/max frame size left at 0, which the format defines as "unknown".

  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let index = width - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  };
  push(sampleRate, 20);
  push(channels - 1, 3);
  push(bitDepth - 1, 5);
  push(totalSamples, 36);
  for (let index = 0; index < 64; index += 1) {
    if (bits[index]) streamInfo[10 + (index >> 3)]! |= 1 << (7 - (index & 7));
  }

  // Vorbis comment block: vendor string, count, then length-prefixed pairs.
  const vendor = encoder.encode('edge-sonic-test');
  const entries = [...Object.entries(comments).map(([key, value]) => encoder.encode(`${key}=${value}`)), ...extraComments.map((entry) => encoder.encode(entry))];
  let commentLength = 4 + vendor.length + 4;
  for (const entry of entries) commentLength += 4 + entry.length;
  const comment = new Uint8Array(commentLength);
  const commentView = new DataView(comment.buffer);
  let cursor = 0;
  commentView.setUint32(cursor, vendor.length, true);
  cursor += 4;
  comment.set(vendor, cursor);
  cursor += vendor.length;
  commentView.setUint32(cursor, entries.length, true);
  cursor += 4;
  for (const entry of entries) {
    commentView.setUint32(cursor, entry.length, true);
    cursor += 4;
    comment.set(entry, cursor);
    cursor += entry.length;
  }

  const out = new Uint8Array(4 + 4 + 34 + 4 + comment.length);
  out.set(encoder.encode('fLaC'), 0);
  out[4] = 0x00; // STREAMINFO, not the last block
  out[5] = 0;
  out[6] = 0;
  out[7] = 34;
  out.set(streamInfo, 8);
  const at = 8 + 34;
  out[at] = 0x84; // VORBIS_COMMENT, last block
  out[at + 1] = (comment.length >> 16) & 0xff;
  out[at + 2] = (comment.length >> 8) & 0xff;
  out[at + 3] = comment.length & 0xff;
  out.set(comment, at + 4);
  void fileSize;
  return out;
}

describe('FLAC', () => {
  it('reads an exact duration from STREAMINFO', () => {
    const tags = readAudioTags(buildFlac({ totalSamples: 44_100 * 180 }), 30_000_000);
    expect(tags.container).toBe('flac');
    expect(tags.durationSeconds).toBe(180);
    expect(tags.sampleRate).toBe(44_100);
    expect(tags.channels).toBe(2);
    expect(tags.bitDepth).toBe(16);
  });

  it('derives a bitrate from the total size, not the prefix length', () => {
    // A prefix read knows the header but not the length; the bitrate is only
    // computable as size x 8 / duration.
    const tags = readAudioTags(buildFlac({ totalSamples: 44_100 * 180 }), 30_000_000);
    expect(tags.bitrateKbps).toBe(1333);
  });

  it('reports no bitrate when the total size is unknown', () => {
    // Better to omit than to divide by the prefix length and report nonsense.
    const tags = readAudioTags(buildFlac(), null);
    expect(tags.bitrateKbps).toBeNull();
    expect(tags.durationSeconds).toBe(180);
  });

  it('reads a Vorbis comment block', () => {
    const tags = readAudioTags(
      buildFlac({
        comments: {
          TITLE: 'Holocene',
          ARTIST: 'Bon Iver',
          ALBUM: 'For Emma, Forever Ago',
          ALBUMARTIST: 'Bon Iver',
          DATE: '2007-02-20',
          TRACKNUMBER: '4/9',
          DISCNUMBER: '1/2',
          GENRE: 'Indie Rock',
        },
      }),
      30_000_000,
    );
    expect(tags.title).toBe('Holocene');
    expect(tags.artist).toBe('Bon Iver');
    expect(tags.album).toBe('For Emma, Forever Ago');
    expect(tags.albumArtist).toBe('Bon Iver');
    expect(tags.year).toBe(2007);
    // `4/9` is the near-universal spelling of a track number.
    expect(tags.track).toBe(4);
    expect(tags.disc).toBe(1);
    expect(tags.genre).toBe('Indie Rock');
  });

  it('handles a 48 kHz 24-bit file without shifting the packed fields', () => {
    const tags = readAudioTags(buildFlac({ sampleRate: 48_000, channels: 1, bitDepth: 24, totalSamples: 48_000 * 60 }), 20_000_000);
    expect(tags.sampleRate).toBe(48_000);
    expect(tags.channels).toBe(1);
    expect(tags.bitDepth).toBe(24);
    expect(tags.durationSeconds).toBe(60);
  });

  it('drops whitespace-only values but keeps edge whitespace byte-identical', () => {
    // `GENRE= ` is a real tag this library's files carry, and a blank genre with a
    // song count beside it is worse than an absent one. Edge whitespace is kept as
    // read: the reference server preserves it in place (`Holiday Holiday / Tragic
    // Drops `), so trimming would trade agreement for tidiness.
    const tags = readAudioTags(buildFlac({ comments: { TITLE: 'Holocene', ARTIST: 'Bon Iver ', ALBUM: 'For Emma ', GENRE: ' ' } }), 30_000_000);
    expect(tags.artist).toBe('Bon Iver ');
    expect(tags.album).toBe('For Emma ');
    expect(tags.genre).toBeNull();
  });

  it('resolves a repeated key to its last value', () => {
    // `Stella☆` carries `album artist=SILENT SIREN` ahead of `ALBUMARTIST=Silent
    // Siren`. First-wins publishes the stale all-caps spelling against the file's own
    // `ARTIST`; the reference server reads the canonical later write.
    const tags = readAudioTags(
      buildFlac({ comments: { ARTIST: 'Silent Siren' }, extraComments: ['ALBUMARTIST=SILENT SIREN', 'ALBUMARTIST=Silent Siren'] }),
      30_000_000,
    );
    expect(tags.albumArtist).toBe('Silent Siren');
  });
});

describe('MP3', () => {
  // The real ID3v2.3 frame identifiers. `TITLE` is the *Subsonic* name for the same
  // concept and is five characters, so a fixture using it silently misaligns every
  // frame header — which is a good illustration of why tag fixtures are built from
  // bytes rather than from the field names a protocol happens to use.
  const tags = {
    TIT2: 'Skinny Love',
    TPE1: 'Bon Iver',
    TALB: 'For Emma, Forever Ago',
    TPE2: 'Bon Iver',
    TYER: '2007',
    TRCK: '4/9',
    TPOS: '1/2',
    TCON: 'Indie Rock',
  };

  it('reads ID3v2.3 text frames and a CBR duration', () => {
    const bytes = buildMp3({ frames: tags });
    const fileSize = mp3FileSize(bytes.length, 128, 200);
    const result = readAudioTags(bytes, fileSize);
    expect(result.container).toBe('mp3');
    expect(result.title).toBe('Skinny Love');
    expect(result.artist).toBe('Bon Iver');
    expect(result.album).toBe('For Emma, Forever Ago');
    expect(result.albumArtist).toBe('Bon Iver');
    expect(result.year).toBe(2007);
    expect(result.track).toBe(4);
    // `TPOS` is the disc number; without it the disc column is always null, which a
    // multi-disc client shows as "Disc ?".
    expect(result.disc).toBe(1);
    expect(result.genre).toBe('Indie Rock');
    expect(result.durationSeconds).toBeCloseTo(200, 0);
  });

  it('reads the correct bitrate and sample rate for the declared index', () => {
    // The two bugs this module actually had. Both produced a plausible number, so
    // the assertion is on the exact value rather than on "something reasonable".
    //   - index 9 in MPEG-1 Layer III is 128 kbps, not 288 (that is the Layer II row)
    //   - the sample rate depends on the MPEG *version* only, never on the layer
    const result = readAudioTags(buildMp3({ bitrateIndex: 9, sampleRateIndex: 0, frames: tags }), mp3FileSize(200, 128, 200));
    expect(result.bitrateKbps).toBe(128);
    expect(result.sampleRate).toBe(44_100);
    expect(result.channels).toBe(2);
  });

  it('maps a different bitrate index to the Layer III value', () => {
    // 320 kbps is index 14 in the Layer III table.
    const result = readAudioTags(buildMp3({ bitrateIndex: 14, frames: tags }), mp3FileSize(200, 320, 100));
    expect(result.bitrateKbps).toBe(320);
  });

  it('maps 48 kHz and 32 kHz sample-rate indices', () => {
    expect(readAudioTags(buildMp3({ sampleRateIndex: 1 }), 1000).sampleRate).toBe(48_000);
    expect(readAudioTags(buildMp3({ sampleRateIndex: 2 }), 1000).sampleRate).toBe(32_000);
  });

  it('reads a v2.4 tag, whose frame sizes are syncsafe', () => {
    // v2.4 changed the frame-size encoding. Reading a v2.4 tag as v2.3 walks off the
    // end of the tag and finds no frames at all.
    const bytes = buildMp3({ majorVersion: 4, frames: tags });
    expect(readAudioTags(bytes, mp3FileSize(bytes.length, 128, 200)).title).toBe('Skinny Love');
  });

  it('reads a v2.2 tag with three-character frame ids', () => {
    const bytes = buildMp3({ majorVersion: 2, frames: { TT2: 'Holocene', TP1: 'Bon Iver' } });
    const result = readAudioTags(bytes, mp3FileSize(bytes.length, 128, 100));
    // v2.2 uses TT2/TP1 rather than TIT2/TPE1, and this reader does not translate
    // them. The documented consequence is asserted rather than hidden: the container
    // is still identified, so the enrichment is recorded as attempted and not retried.
    expect(result.container).toBe('mp3');
    expect(result.title).toBeNull();
  });

  it('ignores a numeric TCON rather than reporting a genre index', () => {
    // ID3v1 genre 17 is "Rock", but reporting the number is more misleading than
    // reporting nothing.
    const result = readAudioTags(buildMp3({ frames: { TCON: '17' } }), 1000);
    expect(result.genre).toBeNull();
  });

  it('survives a file with no tag at all', () => {
    const bare = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]);
    const result = readAudioTags(bare, 1000);
    expect(result.container).toBe('mp3');
    expect(result.sampleRate).toBe(44_100);
  });
});

describe('readAudioTags on input it cannot handle', () => {
  it('returns empty tags for a short buffer rather than throwing', () => {
    // A truncated read must not become a 500 on a getSong call.
    for (const bytes of [new Uint8Array(0), new Uint8Array(4), new Uint8Array(11)]) {
      const result = readAudioTags(bytes, null);
      expect(result.container).toBe('unknown');
      expect(result.durationSeconds).toBeNull();
    }
  });

  it('does not guess a container from a file extension', () => {
    // The extension is client-supplied and routinely wrong; the magic bytes are not.
    // There is no extension input here at all, precisely so a caller cannot pass one.
    expect(readAudioTags(encoder.encode('this is not audio at all'), 100).container).toBe('unknown');
  });

  it('returns empty tags for a truncated FLAC header', () => {
    // Cut off inside STREAMINFO: the packed fields cannot be read, so no duration.
    const truncated = buildFlac().subarray(0, 12);
    const result = readAudioTags(truncated, 30_000_000);
    expect(result.container).toBe('flac');
    expect(result.durationSeconds).toBeNull();
  });
});
