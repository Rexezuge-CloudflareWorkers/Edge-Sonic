/**
 * Ogg: Vorbis and Opus.
 *
 * An Ogg file is a sequence of pages, each with a **granule position** — the
 * total number of samples decoded up to the end of that page. The duration is
 * therefore `(last granule − preskip) / sample rate`, which is exact and needs
 * no audio decode.
 *
 * The catch is that the last page is at the *end* of the file, so a prefix read
 * cannot see it. Two mitigations, in order of preference:
 *
 * 1. The **identification header** on page 0 carries a nominal bitrate for
 *    Vorbis (`bitrate_nominal`) and, for Opus, nothing usable — Opus is defined
 *    as always 48 kHz with a variable bitrate. So for Opus a prefix read yields
 *    the sample rate and channels but **not** the duration.
 * 2. The caller is expected to pass a tail range when it has one.
 *
 * Returning `null` for the Opus duration is deliberate and is why the
 * enrichment step is allowed to issue a second, tail-anchored read: reporting a
 * made-up duration would make a client seek to the wrong offset.
 */
import { parseVorbisComments, readUintLE } from './bits';
import { EMPTY_TAGS } from './types';
import type { AudioTags } from './types';
import type { CommentFields } from './bits';

const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
const OPUS_TAGS = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]; // "OpusTags"
const VORBIS_COMMENT_MAGIC = [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // "\x03vorbis"
const VORBIS_ID_MAGIC = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // "\x01vorbis"

/**
Opus always decodes at 48 kHz regardless of the original rate.
*/
const OPUS_SAMPLE_RATE = 48_000;

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  return offset + magic.length > bytes.length ? false : magic.every((byte, index) => bytes[offset + index] === byte);
}

interface OggPage {
  /**
  Absolute offset of the page's payload.
  */
  bodyOffset: number;
  bodyLength: number;
  granule: number;
  headerType: number;
}

/**
 * Parse one page header.
 *
 * The segment table is a list of 255-terminated run lengths, so the payload
 * length is the sum of the first `segmentCount` entries — it is *not* implied by
 * the header size.
 */
function readPage(bytes: Uint8Array, offset: number): OggPage | null {
  if (!startsWith(bytes, OGG_MAGIC, offset)) return null;

  const segmentCount = readUintLE(bytes, offset + 26, 1);
  if (segmentCount === null) return null;

  const tableStart = offset + 27;
  if (tableStart + segmentCount > bytes.length) return null;

  let bodyLength = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    bodyLength += bytes[tableStart + index];
  }

  const granule = readUintLE(bytes, offset + 6, 8);

  return {
    bodyOffset: tableStart + segmentCount,
    bodyLength,
    // A granule of -1 is the "no packet ends here" sentinel, written as
    // all-ones. It is legitimately absent, not an enormous sample count.
    granule: granule === null || granule === 0xff_ff_ff_ff_ff_ff_ff_ff ? 0 : granule,
    headerType: bytes[offset + 5] ?? 0,
  };
}

/**
Walk pages, calling `visit` for each, until the buffer or a bound is reached.
*/
function walkPages(bytes: Uint8Array, visit: (page: OggPage, pageIndex: number) => boolean | void): void {
  let offset = 0;
  for (let pageIndex = 0; pageIndex < 256; pageIndex += 1) {
    const page = readPage(bytes, offset);
    if (page === null) return;
    const keepGoing = visit(page, pageIndex);
    if (keepGoing === false) return;
    const next = page.bodyOffset + page.bodyLength;
    if (next <= offset) return;
    offset = next;
    if (offset >= bytes.length) return;
  }
}

function readOpus(bytes: Uint8Array, fileSize: number | null): AudioTags {
  let channels: number | null = null;
  let preskip = 0;
  let comments: CommentFields | null = null;
  let lastGranule = 0;

  walkPages(bytes, (page) => {
    if (page.bodyOffset + 8 > bytes.length) return false;

    if (startsWith(bytes, OPUS_HEAD, page.bodyOffset)) {
      channels = bytes[page.bodyOffset + 9] ?? null;
      preskip = readUintLE(bytes, page.bodyOffset + 10, 2) ?? 0;
      return;
    }
    if (startsWith(bytes, OPUS_TAGS, page.bodyOffset)) {
      // The comment block for Opus starts 8 bytes in; there is no vendor-length
      // wrapper beyond the standard one `parseVorbisComments` reads itself.
      comments = parseVorbisComments(bytes, page.bodyOffset + 8);
      return;
    }
    lastGranule = page.granule;
  });

  // Opus granule positions are always in 48 kHz samples regardless of the
  // original sample rate, and include the pre-skip.
  const decodedSamples = lastGranule > preskip ? lastGranule - preskip : 0;
  const duration = decodedSamples > 0 ? decodedSamples / OPUS_SAMPLE_RATE : null;
  const bitrate = duration !== null && duration > 0 && fileSize !== null ? Math.round((fileSize * 8) / duration / 1000) : null;

  const tags: AudioTags = {
    ...EMPTY_TAGS,
    container: 'ogg-opus',
    durationSeconds: duration,
    bitrateKbps: bitrate,
    sampleRate: OPUS_SAMPLE_RATE,
    channels,
  };
  // Merged, not spread. A nullable spread is a type error, and writing it as
  // `...(comments ?? {})` does not survive `eslint --fix` - a rule rewrites the guard
  // away, and the file stops compiling. `Object.assign` states the intent, cannot be
  // rewritten into a form that does not type-check, and says the same thing: a file with
  // no comment block has no tag fields, and the container facts above stand alone.
  if (comments !== null) Object.assign(tags, comments);
  return tags;
}

function readVorbis(bytes: Uint8Array, fileSize: number | null): AudioTags {
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let nominalBitrate: number | null = null;
  let comments: CommentFields | null = null;
  let lastGranule = 0;

  walkPages(bytes, (page) => {
    if (page.bodyOffset + 7 > bytes.length) return false;

    if (startsWith(bytes, VORBIS_ID_MAGIC, page.bodyOffset)) {
      // The identification header after `\x01vorbis` is, in order (Vorbis I spec
      // §4.2.1): vorbis_version u32, audio_channels u8, audio_sample_rate u32,
      // bitrate_maximum i32, bitrate_nominal i32, bitrate_minimum i32, blocksize u8,
      // framing u8. `at` is the version field, so the three reads are at +4, +5, +13.
      //
      // Off by even one byte this file is *silently* wrong rather than obviously
      // broken: the channels byte lands in a version byte, and the sample rate becomes
      // a number built from the channel count and one rate byte, so the duration comes
      // out as a large positive value instead of an error. A client then seeks to the
      // wrong offset and the track appears to end early.
      const at = page.bodyOffset + 7;
      channels = bytes[at + 4] ?? null;
      sampleRate = readUintLE(bytes, at + 5, 4);
      // `bitrate_nominal` is the middle of the three bitrate fields, and -1
      // means "unknown", which must not become a bitrate of -1.
      const nominal = readUintLE(bytes, at + 13, 4);
      nominalBitrate = nominal !== null && nominal > 0 ? Math.round(nominal / 1000) : null;
      return;
    }
    if (startsWith(bytes, VORBIS_COMMENT_MAGIC, page.bodyOffset)) {
      comments = parseVorbisComments(bytes, page.bodyOffset + 7);
      return;
    }
    if (page.headerType & 0x04) lastGranule = page.granule;
  });

  const duration = sampleRate !== null && sampleRate > 0 && lastGranule > 0 ? lastGranule / sampleRate : null;
  const bitrate = duration !== null && duration > 0 && fileSize !== null ? Math.round((fileSize * 8) / duration / 1000) : nominalBitrate;

  const tags: AudioTags = {
    ...EMPTY_TAGS,
    container: 'ogg-vorbis',
    durationSeconds: duration,
    bitrateKbps: bitrate,
    sampleRate,
    channels,
  };
  if (comments !== null) Object.assign(tags, comments);
  return tags;
}

function hasOggMagic(bytes: Uint8Array): boolean {
  return startsWith(bytes, OGG_MAGIC);
}

/**
Which Ogg codec this is, from the first page's payload.
*/
function detectOggCodec(bytes: Uint8Array): 'vorbis' | 'opus' {
  for (let pageIndex = 0, offset = 0; pageIndex < 8; pageIndex += 1) {
    const page = readPage(bytes, offset);
    if (page === null) break;
    if (startsWith(bytes, OPUS_HEAD, page.bodyOffset)) return 'opus';
    if (startsWith(bytes, VORBIS_ID_MAGIC, page.bodyOffset)) return 'vorbis';
    const next = page.bodyOffset + page.bodyLength;
    if (next <= offset) break;
    offset = next;
  }
  return 'vorbis';
}

export { readOpus, readVorbis, hasOggMagic, detectOggCodec, OPUS_SAMPLE_RATE };
