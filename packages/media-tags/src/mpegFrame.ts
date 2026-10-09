/**
 * The MPEG audio frame header: where the first frame is, and what it declares.
 *
 * Split out of [`mp3.ts`](./mp3.ts) because an MP3 file carries **two** formats, not one — an
 * ID3v2 tag and then MPEG audio — and they share no tables, no frame layout and no failure mode.
 * `mp3.ts` reads the tag; this reads the audio. While they shared a file, a change to the
 * side-info arithmetic that only matters for the duration estimate sat beside the frame-id table
 * that decides every published field.
 *
 * Every table here is indexed by the header's own version and layer bits, so the lookups are
 * guarded rather than trusted: a reserved combination reads as "not a frame" and the scan moves
 * on, because a false positive would report a wrong duration for a real file.
 */
import { MPEG_BITRATES, MPEG_SAMPLE_RATES } from './types';

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

/**
Locate and decode the first MPEG audio frame header.
*/
function findFrameHeader(bytes: Uint8Array, from: number): MpegHeader | null {
  // A frame header is 4 bytes with 11 sync bits. Real files carry up to a few
  // bytes of junk before the first frame, so a short window is scanned; beyond
  // that a "frame" is more likely a false positive inside a tag.
  const limit = Math.min(bytes.length - 4, from + 4096);
  for (let offset = from; offset <= limit; offset += 1) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== MPEG_FRAME_SYNC) continue;

    const versionBits = (bytes[offset + 1] >> 3) & 0x03;
    const layerBits = (bytes[offset + 1] >> 1) & 0x03;
    // `versionBits === 1` is reserved, and `layerBits === 0` is reserved.
    if (versionBits === 1 || layerBits === 0) continue;

    // Layer bits are `01`=III, `10`=II, `11`=I. Every table in this file is
    // ordered **III, II, I**, so the index is `layerBits - 1`. Inverting this —
    // the obvious `3 - layerBits` — silently reads a layer III file's sample
    // rate out of the layer I row and reports 11025 Hz for a 44100 Hz track.
    const versionIndex = (versionBits === 3 ? 0 : 1) as 0 | 1 | 2;
    const layerIndex = (layerBits - 1) as 0 | 1 | 2;
    const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
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
    const mode = (bytes[offset + 3] >> 6) & 0x03;

    return {
      versionIndex,
      layerIndex,
      bitrateKbps,
      sampleRate,
      samplesPerFrame,
      channels: mode === 3 ? 1 : 2,
      padding: ((bytes[offset + 2] >> 1) & 0x01) === 1,
      offset,
    };
  }
  return null;
}

export { findFrameHeader };
export type { MpegHeader };
