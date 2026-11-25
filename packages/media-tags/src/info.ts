/**
 * Album and artist info, from a track's own tags.
 *
 * ### Why this is a reader of its own
 *
 * Subsonic asks last.fm for `notes`/`biography` and a MusicBrainz id. This server has no
 * external integration, so the honest local answer is what the tagger wrote into the file:
 * a `DESCRIPTION`/`COMMENT` for prose and a `MUSICBRAINZ_ALBUMID`/`MUSICBRAINZ_ARTISTID`
 * for the identifier. Both album endpoints and both artist endpoints read the same fields;
 * the caller picks the identifier that matches what it named.
 *
 * ### Layer 0
 *
 * Pure functions over a bounded prefix. FLAC and Ogg keep their comment block at the front;
 * an ID3 `COMM`/`TXXX` frame is walked from the tag header. A frame past the read reports
 * no info rather than a partial sentence — the same rule the lyrics reader lives under.
 *
 * ### A reader version of its own
 *
 * `READER_VERSION` stamps `songs` rows, and bumping it re-reads every file in the library.
 * Info is never written to D1 — it is cached in KV under a key that carries this counter —
 * so a corrected extractor only has to make its own entries unreachable.
 */
import { readUintBE } from './bits';
import { hasFlacMagic } from './flac';
import { id3TagSize } from './id3Picture';
import { decodeDescribedFrame, id3FrameSize } from './id3Text';
import { hasId3Magic } from './mp3';
import { hasOggMagic, walkPackets } from './oggFraming';
import { oggCommentBase } from './oggPicture';
import { contiguousSource, walkVorbisCommentSource } from './vorbisComment';

/**
 * Which version of the info extractor produced a cached answer.
 *
 * Bumped whenever a change makes a previously cached value wrong — a newly supported tag,
 * a corrected frame walk, a fixed terminator rule. KV entries are keyed on this value, so a
 * bump makes them structurally unreachable without touching a single song row.
 */
const INFO_READER_VERSION = 1;

/**
 * The prose tags, in precedence order.
 *
 * `DESCRIPTION` is what Picard and beets write; `COMMENT` is the older and more common
 * spelling; `NOTES` appears on files tagged by other tools. The last value a key carries wins
 * within one spelling, matching the commentFields rule for the metadata tags.
 */
const NOTE_TAGS = ['DESCRIPTION', 'COMMENT', 'NOTES'] as const;

interface EmbeddedInfo {
  readonly notes: string | null;
  readonly albumMusicBrainzId: string | null;
  readonly artistMusicBrainzId: string | null;
}

/**
 * The info carried by a track's tags, or `null` for an unreadable container.
 */
function readEmbeddedInfo(bytes: Uint8Array): EmbeddedInfo | null {
  if (hasFlacMagic(bytes)) return flacInfo(bytes);
  if (hasOggMagic(bytes)) return oggInfo(bytes);
  if (hasId3Magic(bytes)) return id3Info(bytes);
  return null;
}

function fromCommentList(walk: (visit: (key: string, value: string | null) => void) => void): EmbeddedInfo {
  const values = new Map<string, string>();
  walk((key, value) => {
    if (value === null || value.trim().length === 0) return;
    values.set(key, value);
  });
  const notes = NOTE_TAGS.map((tag) => values.get(tag)).find((value) => value !== undefined) ?? null;
  return {
    notes,
    albumMusicBrainzId: values.get('MUSICBRAINZALBUMID') ?? null,
    artistMusicBrainzId: values.get('MUSICBRAINZARTISTID') ?? null,
  };
}

function flacInfo(bytes: Uint8Array): EmbeddedInfo | null {
  let cursor = 4;
  let lastBlockSeen = false;
  for (let guard = 0; guard < 64 && !lastBlockSeen; guard += 1) {
    const header = readUintBE(bytes, cursor, 1);
    const length = readUintBE(bytes, cursor + 1, 3);
    if (header === null || length === null) break;
    const type = header & 0x7f;
    const body = cursor + 4;
    if (type === 4) {
      return fromCommentList((visit) => {
        walkVorbisCommentSource(contiguousSource(bytes), body, (key, value) => {
          visit(key, value);
        });
      });
    }
    cursor = body + length;
    lastBlockSeen = (header & 0x80) !== 0;
  }
  return null;
}

function oggInfo(bytes: Uint8Array): EmbeddedInfo | null {
  let result: EmbeddedInfo | null = null;
  walkPackets(bytes, (packet) => {
    if (result !== null) return;
    const base = oggCommentBase(packet);
    if (base === -1) return;
    result = fromCommentList((visit) => {
      walkVorbisCommentSource(packet, base, (key, value) => {
        visit(key, value);
      });
    });
  });
  return result;
}

/**
 * ID3 `TXXX` descriptors that carry prose or an identifier.
 *
 * Keys are uppercased and stripped of separators so `MusicBrainz Album Id` and
 * `MUSICBRAINZ_ALBUM_ID` are one spelling — the same normalization the Vorbis walker uses.
 */
function normalizeDescriptor(text: string): string {
  return text.toUpperCase().replaceAll(/[^A-Z0-9]/g, '');
}

function isNoteKey(key: string): boolean {
  return NOTE_TAGS.some((tag) => normalizeDescriptor(tag) === key);
}

/**
 * One `TXXX` frame: prose notes or one of the two identifiers, decided by its descriptor.
 */
function collectTxxx(descriptor: string, value: string, notes: string[], ids: Map<string, string>): void {
  const key = normalizeDescriptor(descriptor);
  if (isNoteKey(key)) notes.push(value);
  else if (key === 'MUSICBRAINZALBUMID') ids.set('album', value);
  else if (key === 'MUSICBRAINZARTISTID') ids.set('artist', value);
}

/**
 * Walk the ID3 frame list, skipping each frame by its declared size.
 *
 * The two frame families are separated from the walk itself: the walk decides only where
 * the next frame begins, and a second function decides what a frame means. That split keeps
 * one small function responsible for the byte arithmetic the reader has to get right.
 */
function collectId3Frames(bytes: Uint8Array, end: number, majorVersion: number): { notes: string[]; ids: Map<string, string> } {
  const notes: string[] = [];
  const ids = new Map<string, string>();
  let cursor = 10;
  while (cursor + 10 <= end) {
    const frameId = String.fromCharCode(...bytes.subarray(cursor, cursor + 4));
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    const size = id3FrameSize(bytes, cursor + 4, majorVersion) ?? 0;
    if (size <= 0 || cursor + 10 + size > end) break;
    const start = cursor + 10;
    if (frameId === 'COMM' || frameId === 'COM') {
      const content = decodeDescribedFrame(bytes, start, size, 3);
      const descriptor = normalizeDescriptor(content?.descriptor ?? '');
      // A descriptor naming something else (a karaoke marker, language notes) is not
      // album prose. An empty descriptor is the common "plain comment" form.
      if (content?.value !== undefined && content.value !== null && (descriptor.length === 0 || isNoteKey(descriptor))) {
        notes.push(content.value);
      }
    } else if (frameId === 'TXXX' || frameId === 'TXX') {
      const content = decodeDescribedFrame(bytes, start, size, 0);
      if (content?.value === null || content?.value === undefined) break;
      collectTxxx(content.descriptor, content.value, notes, ids);
    }
    cursor += 10 + size;
  }
  return { notes, ids };
}

function id3Info(bytes: Uint8Array): EmbeddedInfo | null {
  const tagSize = id3TagSize(bytes);
  if (tagSize === null) return null;
  const majorVersion = bytes[3] ?? 0;
  if (majorVersion < 3 || majorVersion > 4) return null;

  const { notes, ids } = collectId3Frames(bytes, Math.min(10 + tagSize, bytes.length), majorVersion);
  const firstNote = notes[0] ?? null;
  if (firstNote === null && ids.size === 0) return null;
  return {
    notes: firstNote,
    albumMusicBrainzId: ids.get('album') ?? null,
    artistMusicBrainzId: ids.get('artist') ?? null,
  };
}

export { INFO_READER_VERSION, NOTE_TAGS, readEmbeddedInfo };
export type { EmbeddedInfo };
