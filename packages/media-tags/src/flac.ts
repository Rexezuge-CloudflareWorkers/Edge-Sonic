/**
 * FLAC: exact duration from `STREAMINFO`, and a Vorbis comment for the text
 * fields.
 *
 * `STREAMINFO` is a fixed 34-byte block immediately after the 4-byte `fLaC`
 * magic, holding the total sample count. That makes FLAC the one format here
 * where the duration is *exact* rather than estimated.
 */
import { parseVorbisComments, readBitsBE, readUintBE } from './bits';
import { EMPTY_TAGS } from './types';
import type { AudioTags } from './types';

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]; // "fLaC"
const STREAMINFO_BLOCK_TYPE = 0;
const VORBIS_COMMENT_BLOCK_TYPE = 4;

/**
Block type 6 is a picture; skipping it needs its length even though the data is unused.
*/
function blockLength(bytes: Uint8Array, offset: number): number | null {
  return readUintBE(bytes, offset + 1, 3);
}

function readFlac(bytes: Uint8Array, fileSize: number | null): AudioTags {
  let cursor = 4;
  let streamInfo: { sampleRate: number; channels: number; bitDepth: number; totalSamples: number } | null = null;
  let comments: ReturnType<typeof parseVorbisComments> | null = null;
  let lastBlockSeen = false;

  // Metadata blocks are at most 8 KiB each per the format, so a bounded loop is
  // safe even on a hostile file that claims a huge last-block length.
  for (let guard = 0; guard < 64 && !lastBlockSeen; guard += 1) {
    const header = readUintBE(bytes, cursor, 1);
    if (header === null) break;
    const length = blockLength(bytes, cursor);
    if (length === null) break;

    const type = header & 0x7f;
    const body = cursor + 4;

    if (type === STREAMINFO_BLOCK_TYPE && length >= 18 && streamInfo === null) {
      // `STREAMINFO` is: min block size u16, max block size u16, min frame size u24,
      // max frame size u24, then one 64-bit big-endian run — 20 bits sample rate,
      // 3 bits (channels - 1), 5 bits (bits per sample - 1), 36 bits total samples —
      // then a 128-bit MD5.
      //
      // The run therefore starts at byte **10**, after 16+16+24+24 = 80 bits. Reading
      // it at byte 8 lands in the middle of the frame-size fields: the sample rate
      // comes out as a plausible large number, the channel count as another, and the
      // duration as a large positive value rather than an error — so every FLAC file
      // reports a wrong length and nothing anywhere looks broken.
      const packed = (body + 10) * 8;
      const sampleRate = readBitsBE(bytes, packed, 20);
      const channelBits = readBitsBE(bytes, packed + 20, 3);
      const depthBits = readBitsBE(bytes, packed + 23, 5);
      const totalSamples = readBitsBE(bytes, packed + 28, 36);
      if (sampleRate !== null && channelBits !== null && depthBits !== null && totalSamples !== null) {
        streamInfo = { sampleRate, channels: channelBits + 1, bitDepth: depthBits + 1, totalSamples };
      }
    } else if (type === VORBIS_COMMENT_BLOCK_TYPE && comments === null) {
      comments = parseVorbisComments(bytes, body);
    }

    cursor = body + length;
    lastBlockSeen = (header & 0x80) !== 0;
  }

  if (streamInfo === null) {
    return { ...EMPTY_TAGS, container: 'flac' };
  }

  const duration = streamInfo.sampleRate > 0 ? streamInfo.totalSamples / streamInfo.sampleRate : null;
  // FLAC is variable bitrate by definition, so the only way to report a bitrate
  // is size over duration. `fileSize` is what makes that possible from a prefix.
  const bitrate =
    duration !== null && duration > 0 && fileSize !== null ? Math.round((fileSize * 8) / duration / 1000) : null;

  return {
    ...EMPTY_TAGS,
    container: 'flac',
    durationSeconds: duration,
    bitrateKbps: bitrate,
    sampleRate: streamInfo.sampleRate,
    channels: streamInfo.channels,
    bitDepth: streamInfo.bitDepth,
    ...comments,
  };
}

function hasFlacMagic(bytes: Uint8Array): boolean {
  return FLAC_MAGIC.every((byte, index) => bytes[index] === byte);
}

export { readFlac, hasFlacMagic };
