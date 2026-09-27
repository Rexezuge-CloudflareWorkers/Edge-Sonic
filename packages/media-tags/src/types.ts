/**
 * Audio tag and property reading, from a *prefix* of a file.
 *
 * Layer 0, zero dependencies, pure functions over bytes. It exists because
 * WebDAV cannot tell us how long a track is: `PROPFIND` gives
 * `getcontentlength`, `getlastmodified` and `getcontenttype`, and a client that
 * knows a track's duration draws a scrubber. Subsonic clients need `duration` on
 * every `song`, and `bitRate` next to it.
 *
 * ### Why a prefix and not the whole file
 *
 * Reading a whole 40 MB FLAC through a worker to learn that it is 4:11 long
 * costs egress, CPU time, and a subrequest that cannot be afforded at library
 * scale. Every format handled here has its duration in the first few kilobytes:
 * FLAC's `STREAMINFO` is a 38-byte block at a fixed offset, an Ogg file's
 * granule position is in the last page's header, and MP3 carries either a CBR
 * bitrate in the first frame header or a `Xing` frame count a few bytes later.
 *
 * `fileSize` is a required input for the same reason — a prefix read knows the
 * header but not the total length, and the bitrate of a variable-bitrate file
 * is only computable as `size × 8 ÷ duration`.
 *
 * ### What is deliberately absent
 *
 * **MP4/M4A.** Its `moov` atom — the only place the duration lives — is
 * routinely at the *end* of the file, so a prefix read cannot reach it. Rather
 * than guess, `readAudioTags` returns `null` duration and `container:
 * 'unknown'`, and a TODO marks the tail-read follow-up. A wrong duration is
 * worse than a missing one, because a client that trusts a wrong one will seek
 * to the wrong place.
 */
interface AudioTags {
  /** Seconds, or `null` when the format is unsupported or the data was short. */
  readonly durationSeconds: number | null;
  /** kbps. `null` when it cannot be derived without the whole file. */
  readonly bitrateKbps: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly bitDepth: number | null;
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly albumArtist: string | null;
  readonly genre: string | null;
  readonly year: number | null;
  readonly track: number | null;
  readonly disc: number | null;
  readonly container: AudioContainer;
}

type AudioContainer = 'mp3' | 'flac' | 'ogg-vorbis' | 'ogg-opus' | 'unknown';

const EMPTY_TAGS: AudioTags = {
  durationSeconds: null,
  bitrateKbps: null,
  sampleRate: null,
  channels: null,
  bitDepth: null,
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  genre: null,
  year: null,
  track: null,
  disc: null,
  container: 'unknown',
};

/**
 * Sample rates in Hz: `[version][bitrateIndex]`.
 *
 * Keyed by version **only** — the sample rate is a property of the MPEG version,
 * never of the layer. A three-level table here is a well-known way to end up
 * reporting 11025 Hz for a 44100 Hz layer III file, because the layer-I row sits
 * at index 2 and gets read by mistake.
 *
 * Indexed as a plain nested array: the lookup index is a computed `number`, and
 * a const tuple has no numeric index signature.
 */
const MPEG_SAMPLE_RATES: ReadonlyArray<ReadonlyArray<number>> = [
  // MPEG-1
  [44100, 48000, 32000],
  // MPEG-2
  [22050, 24000, 16000],
  // MPEG-2.5
  [11025, 12000, 8000],
];

/**
 * Bitrates in kbps: `[version][layer][bitrateIndex]`, layers **III, II, I**.
 *
 * From ISO/IEC 11172-3 tables 3-B.1 (MPEG-1) and 3-B.2 (MPEG-2/2.5). Index 0
 * is "free format" and index 15 is "bad" on the layers that have 14 defined
 * entries, and both are 0 here so the caller rejects them.
 *
 * These three rows are genuinely different from each other. Layer III and layer II
 * are frequently confused — they share no entries after the first — and
 * transposing them makes a 128 kbps file report 288 kbps, which then produces a
 * duration off by 2.25×.
 */
const MPEG_BITRATES: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>> = [
  // MPEG-1
  [
    // Layer III
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    // Layer II
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
    // Layer I
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 288, 320],
  ],
  // MPEG-2 / 2.5
  [
    // Layer III
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    // Layer II
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    // Layer I
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 288],
  ],
];

export { EMPTY_TAGS, MPEG_SAMPLE_RATES, MPEG_BITRATES };
export type { AudioTags, AudioContainer };
