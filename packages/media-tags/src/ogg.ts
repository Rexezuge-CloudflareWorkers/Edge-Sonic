/**
 * Ogg codecs: Vorbis and Opus.
 *
 * Framing — pages, packets, the granule — is in `./oggFraming`, and the reason it is
 * separate is that framing is where this went wrong silently.
 *
 * ### The duration, and the read that supplies it
 *
 * An Ogg file is a sequence of pages, each with a **granule position** — the total number
 * of samples decoded to the end of that page. The duration is therefore
 * `(last granule − preskip) / sample rate`, which is exact and needs no audio decode.
 *
 * But the page that carries a file-length granule is the last one, at the *end* of the
 * file, so a prefix read cannot see it. Two mitigations:
 *
 * 1. The **identification header** carries a nominal bitrate for Vorbis
 *    (`bitrate_nominal`) and, for Opus, nothing usable — Opus is defined as always
 *    48 kHz with a variable bitrate. So for Opus a prefix read yields the sample rate,
 *    the channels and the pre-skip, but **not** the duration.
 * 2. The caller issues a second, tail-anchored read: `readOggTailDuration`.
 *
 * Returning `null` for the Opus duration is deliberate, and it is what makes the second
 * read happen: a made-up duration makes a client seek to the wrong offset. The bug was
 * never the `null` — it was that nothing read the tail, and the reader took the last
 * granule it happened to see, so a 240.61 s track was served as 3 s and 15329 kbps
 * instead of 191.
 *
 * Both readers take their packets from `walkPackets` rather than looking at page starts.
 * The two headers of an Opus stream are separate packets and `libavformat` writes them
 * into a single page, so a page-oriented reader finds the first and never looks again —
 * which is why this library reported no artist, album, genre, track or year for any Opus
 * file, and therefore had nothing to group.
 */
import { parseVorbisCommentSource, readUintLE } from './bits';
import { EMPTY_TAGS } from './types';
import { fileGranule,  readPage, startsWith, walkPackets, walkPages, OGG_EOS_FLAG, OGG_MAGIC } from './oggFraming';
import type { AudioTags } from './types';
import type { CommentFields } from './bits';
import type { OggPage } from './oggFraming';

const OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
const OPUS_TAGS = [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]; // "OpusTags"
const VORBIS_COMMENT_MAGIC = [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // "\x03vorbis"
const VORBIS_ID_MAGIC = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // "\x01vorbis"

/**
Opus always decodes at 48 kHz regardless of the original rate.
*/
const OPUS_SAMPLE_RATE = 48_000;

function readOpus(bytes: Uint8Array, fileSize: number | null): AudioTags {
  let channels: number | null = null;
  let preskip = 0;
  let comments: CommentFields | null = null;

  walkPackets(bytes, (packet) => {
    const head = packet.read(0, OPUS_HEAD.length);
    if (head !== null && startsWith(head, OPUS_HEAD, 0)) {
      const identification = packet.read(0, 12);
      channels = identification?.[9] ?? null;
      preskip = (identification === null ? null : readUintLE(identification, 10, 2)) ?? 0;
      return;
    }
    const tags = packet.read(0, OPUS_TAGS.length);
    if (tags !== null && startsWith(tags, OPUS_TAGS, 0)) {
      // The comment block for Opus starts 8 bytes in; there is no vendor-length
      // wrapper beyond the standard one the walk reads itself.
      //
      // Read from the packet **index** rather than from a concatenated buffer, because
      // the comment packet of a real track is 1,158,339 bytes — an embedded cover, base64
      // encoded — and concatenating it (or refusing to, which is what a bound on packet
      // size means) is what left every Opus file in the live library with a null title,
      // artist, album, genre, track and year. The list is sequential, so the tags in front
      // of that cover are read and the cover itself is skipped over as an extent.
      comments = parseVorbisCommentSource(packet, OPUS_TAGS.length);
    }
  });

  // Opus granule positions are always in 48 kHz samples regardless of the
  // original sample rate, and include the pre-skip.
  const lastGranule = fileGranule(walkPages(bytes));
  const decodedSamples = lastGranule !== null && lastGranule > preskip ? lastGranule - preskip : 0;
  const duration = decodedSamples > 0 ? decodedSamples / OPUS_SAMPLE_RATE : null;
  const bitrate = duration !== null && duration > 0 && fileSize !== null ? Math.round((fileSize * 8) / duration / 1000) : null;

  const tags: AudioTags = {
    ...EMPTY_TAGS,
    container: 'ogg-opus',
    durationSeconds: duration,
    bitrateKbps: bitrate,
    sampleRate: OPUS_SAMPLE_RATE,
    channels,
    preskip,
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

  walkPackets(bytes, (packet) => {
    const id = packet.read(0, VORBIS_ID_MAGIC.length);
    if (id !== null && startsWith(id, VORBIS_ID_MAGIC, 0)) {
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
      const at = 7;
      const identification = packet.read(0, at + 17);
      if (identification === null) return;
      channels = identification[at + 4] ?? null;
      sampleRate = readUintLE(identification, at + 5, 4);
      // `bitrate_nominal` is the middle of the three bitrate fields, and -1
      // means "unknown", which must not become a bitrate of -1.
      const nominal = readUintLE(identification, at + 13, 4);
      nominalBitrate = nominal !== null && nominal > 0 ? Math.round(nominal / 1000) : null;
      return;
    }
    const comment = packet.read(0, VORBIS_COMMENT_MAGIC.length);
    if (comment !== null && startsWith(comment, VORBIS_COMMENT_MAGIC, 0)) {
      comments = parseVorbisCommentSource(packet, VORBIS_COMMENT_MAGIC.length);
    }
  });

  const lastGranule = fileGranule(walkPages(bytes));
  const duration = sampleRate !== null && sampleRate > 0 && lastGranule !== null && lastGranule > 0 ? lastGranule / sampleRate : null;
  const bitrate = duration !== null && duration > 0 && fileSize !== null ? Math.round((fileSize * 8) / duration / 1000) : nominalBitrate;

  const tags: AudioTags = {
    ...EMPTY_TAGS,
    container: 'ogg-vorbis',
    durationSeconds: duration,
    bitrateKbps: bitrate,
    sampleRate,
    channels,
    preskip: null,
  };
  if (comments !== null) Object.assign(tags, comments);
  return tags;
}

/**
Which Ogg codec this is, from the stream's first packet.
*/
function detectOggCodec(bytes: Uint8Array): 'vorbis' | 'opus' {
  // The identification header is the stream's first packet, and packets rather than
  // pages are what delimit it.
  let codec: 'vorbis' | 'opus' | null = null;
  walkPackets(bytes, (packet) => {
    const head = packet.read(0, OPUS_HEAD.length);
    if (head !== null && startsWith(head, OPUS_HEAD, 0)) {
      codec = 'opus';
      return false;
    }
    const id = packet.read(0, VORBIS_ID_MAGIC.length);
    if (id === null || !startsWith(id, VORBIS_ID_MAGIC, 0)) {
      return;
    }

    codec = 'vorbis';
    return false;
  });
  return codec ?? 'vorbis';
}

/**
 * The duration in seconds, from a **tail** read of an Ogg file.
 *
 * This is the read that supplies what a prefix read cannot, and it was documented as the
 * caller's job for as long as the reader existed without ever being written.
 *
 * @param bytes The **trailing** bytes of the file. A byte range does not begin on a page
 *   boundary, so offset 0 is not a page and every offset is a candidate for the magic
 *   rather than a walk from zero. It must be large enough to contain at least one whole
 *   page header, which for a spec-conformant file is at most 255 segments of 255 bytes
 *   plus the 27-byte header.
 * @param sampleRate From the prefix read: 48000 for Opus (always, whatever the source
 *   rate), or the stream rate for Vorbis.
 * @param preskip Opus pre-skip, which the granule includes and the duration must not. It
 *   lives in the identification header at the *front* of the file, so it comes from the
 *   prefix read rather than from here.
 *
 * @returns `null` when the buffer does not contain the file's final page — which is the
 *   honest answer, and is why a caller must not substitute a guess.
 */
function readOggTailDuration(bytes: Uint8Array, sampleRate: number, preskip = 0): number | null {
  if (sampleRate <= 0) return null;

  // Only a complete page carrying the end-of-stream flag is accepted. Both halves are
  // needed: without the flag a middle page can be mistaken for the last, and without
  // `complete` a page the buffer cut in half can be — and an `OggS` byte sequence inside
  // audio parses as a page header with an arbitrary granule.
  let found: OggPage | null = null;
  for (let offset = 0; offset + 27 <= bytes.length; offset += 1) {
    if (!startsWith(bytes, OGG_MAGIC, offset)) continue;
    const page = readPage(bytes, offset);
    if (page === null || !page.complete || (page.headerType & OGG_EOS_FLAG) === 0) continue;
    found = page;
  }

  if (found === null) return null;
  const decoded = found.granule - preskip;
  return decoded > 0 ? decoded / sampleRate : null;
}

export { readOpus, readVorbis,  detectOggCodec, readOggTailDuration, OPUS_SAMPLE_RATE };

export {hasOggMagic} from './oggFraming';