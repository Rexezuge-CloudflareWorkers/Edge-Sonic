/**
 * Lyrics parsing and extraction.
 *
 * ### Why the fixtures decode themselves back
 *
 * The rule the embedded-artwork suite records applies here for the same reason: a fixture
 * built to match the reader's assumptions passes against a reader that is wrong in exactly
 * the same place. So every container below is laid out from its specification, and the
 * comment list is walked back independently before it is handed to `readEmbeddedLyrics`.
 *
 * ### What matters is not the happy path
 *
 * A plain `LYRICS=…` that parses is the easy case. These hold the cases that shipped
 * wrong elsewhere in this repository:
 *
 * - a `USLT` frame **behind** other frames, so the frame walk has to skip by declared size
 *   rather than scan for a tag name;
 * - a UTF-16 lyric whose descriptor terminator is two bytes, where a one-byte scan cuts the
 *   descriptor in half and shifts the text;
 * - an LRC line with **two** timestamps (a repeated chorus), an `[offset:…]` that must
 *   shift every line, and a `[Chorus]` header that is text rather than a timestamp;
 * - a `.txt` with no timestamps at all, which is the unsynced case and must not be
 *   reported as `synced`.
 */
import { describe, expect, it } from 'vitest';
import { decodeLyricsText, parseLyricsText, readEmbeddedLyrics } from '@edge-sonic/media-tags';

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function syncsafe(value: number): number[] {
  return [(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f];
}

function concat(...parts: readonly (readonly number[])[]): number[] {
  return parts.flat();
}

/**
 * A Vorbis comment payload: vendor, count, then `KEY=value` entries, every length
 * little-endian (the format is LE even inside a big-endian container).
 */
function commentList(entries: readonly string[]): number[] {
  return concat(u32le(0), u32le(entries.length), ...entries.map((entry) => concat(u32le(ascii(entry).length), ascii(entry))));
}

/**
 * Walk the comment list back out, independently of the reader, and return its entries.
 *
 * The self-check. `readEmbeddedLyrics` finding nothing proves nothing about whether the
 * fixture contained anything.
 */
function decodeCommentList(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 4;
  const count = view.getUint32(at, true);
  at += 4;
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = view.getUint32(at, true);
    at += 4;
    out.push(new TextDecoder().decode(bytes.subarray(at, at + length)));
    at += length;
  }
  return out;
}

function blockHeader(type: number, length: number, last = false): number[] {
  return [last ? type | 0x80 : type, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

/**
 * A FLAC file whose `VORBIS_COMMENT` block carries `comments`, after a `STREAMINFO`.
 */
function flacFile(comments: readonly string[]): Uint8Array {
  const commentBody = commentList(comments);
  return Uint8Array.from(
    concat(
      ascii('fLaC'),
      blockHeader(0, 34),
      Array.from({ length: 34 }, () => 0),
      blockHeader(4, commentBody.length, true),
      commentBody,
      [0xff, 0xf8],
    ),
  );
}

function id3Header(tagSize: number): number[] {
  return concat(ascii('ID3'), [4, 0, 0], syncsafe(tagSize));
}

function frame(id: string, payload: readonly number[]): number[] {
  return concat(ascii(id), syncsafe(payload.length), [0, 0], payload);
}

function textFrame(id: string, text: string): number[] {
  const payload = concat([0x00], ascii(text));
  return frame(id, payload);
}

/**
 * A `USLT` payload: encoding, three-byte language, terminated descriptor, then the lyric.
 *
 * @param encoding 0 Latin-1, 3 UTF-8. The UTF-16 cases (`1`, `2`) are exercised through
 *   `utf16LyricFile` because their terminator is two bytes.
 */
function usltPayload(text: string, encoding = 0, descriptor = 'eng'): number[] {
  const body = encoding === 0 ? ascii(text) : [...new TextEncoder().encode(text)];
  return concat([encoding], ascii(descriptor), [0x00], body);
}

function utf16UsltPayload(text: string): number[] {
  // UTF-16LE with BOM, encoded by hand so the test does not depend on a TextEncoder that
  // cannot emit it.
  const encoded: number[] = [0xff, 0xfe];
  for (const char of text) {
    const code = char.charCodeAt(0);
    encoded.push(code & 0xff, (code >>> 8) & 0xff);
  }
  // The descriptor terminator is **two** zero bytes for UTF-16. A fixture that wrote one
  // would exercise a reader bug in the fixture's favour.
  return concat([0x01], ascii('eng'), [0x00, 0x00], encoded);
}

function id3File(frames: readonly (readonly number[])[]): Uint8Array {
  const body = concat(...frames);
  return Uint8Array.from(concat(id3Header(body.length), body));
}

function oggFile(packet: readonly number[]): Uint8Array {
  const lacing: number[] = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    lacing.push(255);
    remaining -= 255;
  }
  lacing.push(remaining);
  return Uint8Array.from(
    concat(
      ascii('OggS'),
      [0x00, 0x00],
      [0, 0, 0, 0, 0, 0, 0, 0], // granule
      [0, 0, 0, 0], // serial
      u32(0), // sequence
      [0, 0, 0, 0], // checksum
      [lacing.length],
      lacing,
      packet,
    ),
  );
}

function oggLyricFile(comments: readonly string[]): Uint8Array {
  return oggFile(concat(ascii('\x03vorbis'), commentList(comments)));
}

const LRC = ['[ti:Skinny Love]', '[offset:+500]', '[00:01.00]Come on skinny love', '[00:05.50][00:20.00]And I told you to be patient'];

describe('parseLyricsText', () => {
  it('reads LRC timestamps as milliseconds and applies the offset', () => {
    const parsed = parseLyricsText(LRC.join('\n'));
    expect(parsed.synced).toBe(true);
    // 1.00 s plus the [offset:+500] the file declares. Ignoring the offset puts every line
    // half a second out, which a lyric panel shows rather than hides.
    expect(parsed.lines[0]).toEqual({ startMs: 1500, text: 'Come on skinny love' });
    // Two markers on one line are one line at two times — a repeated chorus. Emitting it
    // once loses the repeat; emitting the text once per marker keeps it.
    expect(parsed.lines.filter((line) => line.text === 'And I told you to be patient')).toEqual([
      { startMs: 6000, text: 'And I told you to be patient' },
      { startMs: 20_500, text: 'And I told you to be patient' },
    ]);
  });

  it('keeps a bracket header that is not a timestamp as lyric text', () => {
    const parsed = parseLyricsText('[Chorus]\nLa la la');
    expect(parsed.synced).toBe(false);
    expect(parsed.lines.map((line) => line.text)).toEqual(['[Chorus]', 'La la la']);
  });

  it('reads a plain .txt as unsynced lines, with blank edges trimmed', () => {
    const parsed = parseLyricsText('\n\nfirst line\nsecond line\n\n');
    expect(parsed.synced).toBe(false);
    expect(parsed.lines).toEqual([
      { startMs: null, text: 'first line' },
      { startMs: null, text: 'second line' },
    ]);
  });

  it('reads one, two and three fraction digits correctly, because LRC uses all three', () => {
    // Hundredths by convention, milliseconds in the wild, tenths occasionally. Reading a
    // `.500` as hundredths puts the line five seconds late rather than half a second.
    expect(parseLyricsText('[00:01.5]a').lines[0].startMs).toBe(1500);
    expect(parseLyricsText('[00:01.50]a').lines[0].startMs).toBe(1500);
    expect(parseLyricsText('[00:01.500]a').lines[0].startMs).toBe(1500);
  });

  it('drops metadata lines, which are not lyrics', () => {
    const parsed = parseLyricsText('[ar:Bon Iver]\n[length:03:58]\n[00:01.00]real');
    expect(parsed.lines.map((line) => line.text)).toEqual(['real']);
  });
});

describe('decodeLyricsText', () => {
  it('honours a UTF-8 BOM, a UTF-16 BOM, and falls back to Latin-1', () => {
    expect(decodeLyricsText(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('café')]))).toBe('café');
    expect(decodeLyricsText(Uint8Array.from([0xff, 0xfe, 0x63, 0x00, 0x61, 0x00]))).toBe('ca');
    // `0xe9` alone is not valid UTF-8. Latin-1 decodes every byte to something, which is
    // the readable answer for a lyric file an editor wrote in the system encoding.
    expect(decodeLyricsText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
  });

  it('normalises CRLF, so a Windows file does not carry a stray carriage return per line', () => {
    expect(parseLyricsText('one\r\ntwo').lines.map((line) => line.text)).toEqual(['one', 'two']);
  });
});

describe('readEmbeddedLyrics', () => {
  it('reads LYRICS out of a FLAC VORBIS_COMMENT block', () => {
    const comments = ['TITLE=For Emma', 'LYRICS=And I told you to be patient'];
    const file = flacFile(comments);
    // The self-check: the fixture really does carry the comment list it claims to.
    expect(decodeCommentList(file.subarray(4 + 4 + 34 + 4))).toEqual(comments);
    expect(readEmbeddedLyrics(file)).toBe('And I told you to be patient');
  });

  it('tries the modern key before the legacy ones', () => {
    const file = flacFile(['UNSYNCEDLYRICS=legacy', 'LYRICS=modern']);
    // A file with both is a file Picard re-tagged without deleting the old key. The modern
    // spelling is the one the tagger currently writes.
    expect(readEmbeddedLyrics(file)).toBe('modern');
    expect(readEmbeddedLyrics(flacFile(['UNSYNCEDLYRICS=legacy']))).toBe('legacy');
    expect(readEmbeddedLyrics(flacFile(['SYNCEDLYRICS=synced']))).toBe('synced');
  });

  it('reads LYRICS out of an Ogg Vorbis comment packet', () => {
    expect(readEmbeddedLyrics(oggLyricFile(['TITLE=For Emma', 'LYRICS=Ogg lyric']))).toBe('Ogg lyric');
  });

  it('reads USLT out of an ID3v2 tag, skipping the frames before it', () => {
    // A `USLT` behind other frames is the normal case, and the frame walk has to step by
    // each frame's declared size rather than search for "USLT" in the bytes.
    const file = id3File([textFrame('TIT2', 'Skinny Love'), textFrame('TPE1', 'Bon Iver'), frame('USLT', usltPayload('ID3 lyric'))]);
    expect(readEmbeddedLyrics(file)).toBe('ID3 lyric');
  });

  it('finds the lyric when a UTF-16 descriptor terminator is two bytes', () => {
    const file = id3File([frame('USLT', utf16UsltPayload('Unicode lyric'))]);
    // A one-byte terminator scan finds `00 00` across two characters and shifts the text.
    expect(readEmbeddedLyrics(file)).toBe('Unicode lyric');
  });

  it('answers null for an audio file that carries no lyric at all', () => {
    expect(readEmbeddedLyrics(Uint8Array.from([0xff, 0xf8, 0x00, 0x00]))).toBeNull();
    expect(readEmbeddedLyrics(flacFile(['TITLE=For Emma']))).toBeNull();
  });
});
