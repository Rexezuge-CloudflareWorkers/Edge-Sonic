/**
 * The album/artist info reader, from byte layouts written to the specification.
 *
 * A fixture built to match the reader's assumptions would pass against a reader wrong in
 * exactly the same place — the failure this repo has already paid for on Ogg packets, FLAC
 * block tables and ID3 frame lists. So every container here is decoded back independently
 * before the reader sees it, and the cases that matter are the ones that ship wrong:
 *
 * - a `TXXX` behind other frames, so the walk skips by declared size rather than scanning;
 * - a UTF-16 descriptor whose terminator is **two** bytes, where a one-byte scan shifts the
 *   value by one code unit;
 * - a `COMM` whose descriptor names something other than prose, which must not become a
 *   biography;
 * - a frame lying past a bounded prefix, which reports no info rather than half a sentence.
 */
import { describe, expect, it } from 'vitest';
import { INFO_READER_VERSION, readEmbeddedInfo } from '@edge-sonic/media-tags';

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

function commentList(entries: readonly string[]): number[] {
  return concat(u32le(0), u32le(entries.length), ...entries.map((entry) => concat(u32le(ascii(entry).length), ascii(entry))));
}

/**
Independently walk a Vorbis comment list back out, so a reader and fixture cannot agree on a wrong layout.
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

function flacFile(comments: readonly string[]): Uint8Array {
  const body = commentList(comments);
  return Uint8Array.from(
    concat(
      ascii('fLaC'),
      blockHeader(0, 34),
      Array.from({ length: 34 }, () => 0),
      blockHeader(4, body.length, true),
      body,
      [0xff, 0xf8],
    ),
  );
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
    concat(ascii('OggS'), [0, 0], [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0], u32(0), [0, 0, 0, 0], [lacing.length], lacing, packet),
  );
}

function id3Header(tagSize: number): number[] {
  return concat(ascii('ID3'), [4, 0, 0], syncsafe(tagSize));
}

function frame(id: string, payload: readonly number[]): number[] {
  return concat(ascii(id), syncsafe(payload.length), [0, 0], payload);
}

function txxx(descriptor: string, value: string, encoding = 0): number[] {
  const encoded = encoding === 0 ? ascii(value) : [...new TextEncoder().encode(value)];
  return frame('TXXX', concat([encoding], ascii(descriptor), [0], encoded));
}

function utf16Txxx(descriptor: string, value: string): number[] {
  const encoded: number[] = [0xff, 0xfe];
  for (const char of value) {
    const code = char.charCodeAt(0);
    encoded.push(code & 0xff, (code >>> 8) & 0xff);
  }
  // Two zero bytes: the encoding is UTF-16 with a BOM (1), so a one-byte terminator scan
  // would cut the descriptor in half and shift the value.
  return frame('TXXX', concat([1], ascii(descriptor), [0, 0], encoded));
}

function comm(value: string, descriptor = ''): number[] {
  return frame('COMM', concat([0], ascii('eng'), ascii(descriptor), [0], ascii(value)));
}

function id3File(frames: readonly (readonly number[])[]): Uint8Array {
  const body = concat(...frames);
  return Uint8Array.from(concat(id3Header(body.length), body));
}

describe('readEmbeddedInfo', () => {
  it('publishes its own reader version, separated from the row reader', () => {
    expect(INFO_READER_VERSION).toBe(1);
  });

  it('reads notes and a MusicBrainz album id from a FLAC VORBIS_COMMENT', () => {
    const comments = ['TITLE=A', 'DESCRIPTION=Recorded in a cabin', 'MUSICBRAINZALBUMID=album-123'];
    const bytes = flacFile(comments);
    expect(decodeCommentList(bytes.subarray(4 + 4 + 34 + 4))).toEqual(comments);
    expect(readEmbeddedInfo(bytes)).toEqual({
      notes: 'Recorded in a cabin',
      albumMusicBrainzId: 'album-123',
      artistMusicBrainzId: null,
    });
  });

  it('prefers DESCRIPTION over COMMENT and keeps a MusicBrainz artist id', () => {
    const bytes = flacFile(['COMMENT=older note', 'DESCRIPTION=new note', 'MUSICBRAINZARTISTID=artist-456']);
    expect(readEmbeddedInfo(bytes)).toEqual({
      notes: 'new note',
      albumMusicBrainzId: null,
      artistMusicBrainzId: 'artist-456',
    });
  });

  it('reads the same fields from an Ogg comment packet', () => {
    const bytes = oggFile(concat(ascii('\x03vorbis'), commentList(['DESCRIPTION=Ogg prose', 'MUSICBRAINZALBUMID=ogg-album'])));
    expect(readEmbeddedInfo(bytes)).toEqual({
      notes: 'Ogg prose',
      albumMusicBrainzId: 'ogg-album',
      artistMusicBrainzId: null,
    });
  });

  it('walks past other ID3 frames to a TXXX behind them', () => {
    const bytes = id3File([
      frame('TIT2', concat([0], ascii('Track'))),
      txxx('MusicBrainz Album Id', 'mb-album'),
      txxx('MusicBrainz Artist Id', 'mb-artist'),
    ]);
    expect(readEmbeddedInfo(bytes)).toEqual({
      notes: null,
      albumMusicBrainzId: 'mb-album',
      artistMusicBrainzId: 'mb-artist',
    });
  });

  it('takes prose from a TXXX description and an empty-descriptor COMM', () => {
    const bytes = id3File([txxx('DESCRIPTION', 'Tag prose'), comm('Plain comment')]);
    expect(readEmbeddedInfo(bytes)?.notes).toBe('Tag prose');
  });

  it('handles a UTF-16 descriptor whose terminator is two bytes', () => {
    const bytes = id3File([utf16Txxx('DESCRIPTION', 'Wide prose')]);
    expect(readEmbeddedInfo(bytes)?.notes).toBe('Wide prose');
  });

  it('does not turn a COMM naming something else into a biography', () => {
    const bytes = id3File([comm('karaoke marker', 'Karaoke')]);
    // No prose and no identifier: the service normalizes null to "all fields absent", so
    // a karaoke descriptor cannot become somebody's biography.
    expect(readEmbeddedInfo(bytes)).toBe(null);
  });

  it('reports no info for a frame past the read rather than a truncated sentence', () => {
    const full = id3File([frame('TIT2', concat([0], ascii('X'.repeat(600)))), txxx('DESCRIPTION', 'Too far')]);
    expect(readEmbeddedInfo(full.subarray(0, 40))).toBe(null);
  });

  it('reports all fields absent for an unreadable container', () => {
    expect(readEmbeddedInfo(Uint8Array.from(ascii('not audio at all')))).toBe(null);
  });
});
