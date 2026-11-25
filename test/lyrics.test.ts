/**
 * Lyrics, end to end, through both endpoints.
 *
 * ### The precedence is the feature
 *
 * A track can carry lyrics in three places: an `.lrc` sidecar, a `.txt` sidecar, and its
 * own tags. Which one a client gets is not cosmetic — an `.lrc` is the only one that
 * carries offsets, so a library that has both a synced sidecar and unsynced tags should
 * show a scrolling panel, not a block of text. These tests put all three in front of the
 * service at once and assert which one answered, by content.
 *
 * ### And the cache is where this would silently break
 *
 * The key carries the song's revision, the chosen sidecar's revision and the lyrics
 * reader's version. That is what makes replacing `01.txt` with `01.lrc` move the key —
 * a key built from the song alone would serve the old lyric for the entry's 30-day life.
 * The paired assertion is the one that matters: a *transient* read failure must cache
 * nothing, because a `503` recorded as "no lyrics" survives every retry until the file
 * moves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, ALBUM_DIR, LIBRARY_ID, subsonicId } from './helpers/harness';
import { NodeDAO } from '@edge-sonic/backend-data/dao';
import type { Harness, SubsonicBody } from './helpers/harness';
import type { DavEntry } from './helpers/fakeDav';

const ROOT = '/remote.php/dav/files/alice/Music';
const ALBUM_PATH = `${ROOT}/${ALBUM_DIR}`;

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function concat(...parts: readonly (readonly number[])[]): number[] {
  return parts.flat();
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function commentList(entries: readonly string[]): number[] {
  return concat(u32le(0), u32le(entries.length), ...entries.map((entry) => concat(u32le(ascii(entry).length), ascii(entry))));
}

function blockHeader(type: number, length: number, last = false): number[] {
  return [last ? type | 0x80 : type, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

/**
 * A FLAC file whose `VORBIS_COMMENT` carries `comments`.
 *
 * A real block table, so the reader that finds `LYRICS` here is the one that has to skip
 * `STREAMINFO` by its declared length rather than by a cursor offset typed into a fixture.
 */
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

const LRC_TEXT = '[00:01.00]Come on skinny love\n[00:05.50]And I told you to be patient';
const TXT_TEXT = 'Plain lyric line one\nPlain lyric line two';
const TAG_TEXT = 'Embedded lyric line';

const TRACK_MTIME = 1000;

/**
 * The fixture album's origin, with a sidecar layout and a track that may carry tags.
 *
 * @param sidecars The sidecar files to place beside the tracks, by name.
 * @param trackComments The track's own `VORBIS_COMMENT` entries; `LYRICS=` is what the
 *   embedded reader looks for.
 */
function originTree(
  options: { sidecars?: Record<string, string>; trackComments?: readonly string[]; mtime?: number } = {},
): Record<string, DavEntry[]> {
  const mtime = options.mtime ?? TRACK_MTIME;
  const track = flacFile(options.trackComments ?? ['TITLE=Skinny Love']);
  const entries: DavEntry[] = [
    { path: ALBUM_PATH, collection: true, mtime, etag: '"b"' },
    { path: `${ALBUM_PATH}/01.flac`, size: track.length, contentType: 'audio/flac', mtime, etag: '"c"', body: track },
    { path: `${ALBUM_PATH}/02.flac`, size: track.length, contentType: 'audio/flac', mtime, etag: '"d"', body: track },
  ];
  for (const [name, text] of Object.entries(options.sidecars ?? {})) {
    const body = new TextEncoder().encode(text);
    entries.push({ path: `${ALBUM_PATH}/${name}`, size: body.length, contentType: 'text/plain', mtime, etag: `"${name}"`, body });
  }
  return { [ALBUM_PATH]: entries };
}

/**
 * Put a sidecar's **node** row in, so the folder listing finds it.
 *
 * Through the DAO rather than hand-written SQL: every name in `nodes` has a `_ci` twin,
 * and a hand-inserted row that omits one fails a `NOT NULL` constraint.
 */
async function addSidecarNode(name: string): Promise<void> {
  await new NodeDAO(harness.db.db).upsertMany([
    {
      libraryId: LIBRARY_ID,
      path: `${ALBUM_DIR}/${name}`,
      parentPath: ALBUM_DIR,
      name,
      mtimeMs: TRACK_MTIME,
      etag: `"${name}"`,
      depth: 3,
      isScanned: true,
    },
  ]);
}

async function removeSidecarNode(name: string): Promise<void> {
  await harness.db.db.prepare('DELETE FROM nodes WHERE path = ?').bind(`${ALBUM_DIR}/${name}`).run();
}

let harness: Harness;
let originalFetch: typeof fetch;

beforeEach(async () => {
  harness = await createHarness(originTree());
  originalFetch = fetch;
  globalThis.fetch = harness.dav.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  harness.close();
});

/**
 * The envelope's payload as an untyped record.
 *
 * A cast to `unknown` first, because `SubsonicBody` has no index signature: it types the
 * one key every envelope carries and nothing else, which is what makes a typo in a key
 * name a compile error rather than `undefined` at the assertion.
 */
const envelope = (body: SubsonicBody): Record<string, unknown> => body['subsonic-response'] as unknown as Record<string, unknown>;

const lyricsBySong = (id: string) => harness.rest('getLyricsBySongId', { id });

/**
The `structuredLyrics` entries of a `getLyricsBySongId` answer, or `[]`.
*/
const structured = (body: SubsonicBody): Array<Record<string, unknown>> => {
  const list = envelope(body).lyricsList as { structuredLyrics?: Array<Record<string, unknown>> } | undefined;
  return list?.structuredLyrics ?? [];
};

describe('getLyricsBySongId', () => {
  it('prefers a .lrc sidecar over the track tags, because only it carries offsets', async () => {
    harness.dav.setTree(originTree({ sidecars: { '01.lrc': LRC_TEXT }, trackComments: [`LYRICS=${TAG_TEXT}`] }));
    await addSidecarNode('01.lrc');

    const { status, body } = await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    expect(status).toBe(200);
    const [entry] = structured(body);
    expect(entry).toMatchObject({ lang: 'und', synced: true, displayTitle: 'Skinny Love', displayArtist: 'Bon Iver' });
    // Milliseconds, not seconds — the schema types `start` as an integer of ms.
    expect(entry.line).toEqual([
      { start: 1000, value: 'Come on skinny love' },
      { start: 5500, value: 'And I told you to be patient' },
    ]);
  });

  it('prefers a .txt sidecar over the tags, and .lrc over .txt', async () => {
    harness.dav.setTree(originTree({ sidecars: { '01.txt': TXT_TEXT, '01.lrc': LRC_TEXT }, trackComments: [`LYRICS=${TAG_TEXT}`] }));
    await addSidecarNode('01.txt');
    await addSidecarNode('01.lrc');

    const { body } = await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    expect(structured(body)[0]).toMatchObject({ synced: true });
    expect((structured(body)[0].line as Array<{ value: string }>)[0].value).toBe('Come on skinny love');

    // Remove the .lrc: the .txt is now the best answer, and it is unsynced.
    await removeSidecarNode('01.lrc');
    harness.dav.setTree(originTree({ sidecars: { '01.txt': TXT_TEXT }, trackComments: [`LYRICS=${TAG_TEXT}`] }));
    // A different revision, so the previous entry's key does not answer this request.
    await new NodeDAO(harness.db.db).upsertMany([
      {
        libraryId: LIBRARY_ID,
        path: `${ALBUM_DIR}/01.txt`,
        parentPath: ALBUM_DIR,
        name: '01.txt',
        mtimeMs: 2000,
        etag: '"01.txt"',
        depth: 3,
        isScanned: true,
      },
    ]);
    const second = await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    expect((structured(second.body)[0].line as Array<{ value: string }>)[0].value).toBe('Plain lyric line one');
    expect(structured(second.body)[0].synced).toBe(false);
  });

  it('falls back to the track tags when the folder has no sidecar', async () => {
    harness.dav.setTree(originTree({ trackComments: [`LYRICS=${TAG_TEXT}`] }));
    const { body } = await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    const [entry] = structured(body);
    expect(entry).toMatchObject({ synced: false });
    expect((entry.line as Array<{ value: string }>).map((line) => line.value)).toEqual([TAG_TEXT]);
  });

  it('answers an empty list, not an error, for a track with no lyrics anywhere', async () => {
    const { status, body } = await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    expect(status).toBe(200);
    expect(envelope(body).error).toBeUndefined();
    expect(envelope(body).lyricsList).toEqual({});
  });

  it('answers `code=70` for a song that does not exist, rather than an empty list', async () => {
    const { status, body } = await lyricsBySong(subsonicId('s', 'does/not/exist.flac'));
    expect(status).toBe(200);
    expect(envelope(body).error).toMatchObject({ code: 70 });
  });
});

describe('getLyrics', () => {
  it('answers the plain text under `value`, with timestamps stripped', async () => {
    harness.dav.setTree(originTree({ sidecars: { '01.lrc': LRC_TEXT } }));
    await addSidecarNode('01.lrc');

    const { status, body } = await harness.rest('getLyrics', { artist: 'Bon Iver', title: 'Skinny Love' });
    expect(status).toBe(200);
    expect(envelope(body).lyrics).toEqual({
      value: 'Come on skinny love\nAnd I told you to be patient',
    });
  });

  it('answers the empty value for a title it cannot resolve, not `code=70`', async () => {
    // The legacy endpoint's contract: a client calls it on every track and reads `value`.
    // "No lyric" and "no such track" are the same thing to this call, and neither is a
    // failure — the caller has nothing to retry.
    const { status, body } = await harness.rest('getLyrics', { artist: 'Nobody', title: 'Nothing' });
    expect(status).toBe(200);
    expect(envelope(body).lyrics).toEqual({ value: '' });
  });

  it('answers the empty value for a request that named no title at all', async () => {
    // `artist` and `title` are optional in the protocol, so a bare call is legal.
    const { status, body } = await harness.rest('getLyrics');
    expect(status).toBe(200);
    expect(envelope(body).lyrics).toEqual({ value: '' });
  });
});

describe('the lyrics cache', () => {
  it('serves a second request for one song from KV, without re-reading the origin', async () => {
    harness.dav.setTree(originTree({ sidecars: { '01.lrc': LRC_TEXT } }));
    await addSidecarNode('01.lrc');

    await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    const afterFirst = harness.dav.requestCount();
    expect(afterFirst).toBeGreaterThan(0);

    await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    expect(harness.dav.requestCount()).toBe(afterFirst);
  });

  it('caches the absence of lyrics, so an instrumental is not re-read on every play', async () => {
    await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    const afterFirst = harness.dav.requestCount();

    const { body } = await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    expect(envelope(body).lyricsList).toEqual({});
    expect(harness.dav.requestCount()).toBe(afterFirst);
  });

  it('caches nothing when the sidecar read fails, so a recovered origin is asked again', async () => {
    // A `503` is not an observation about the file. Recording it as "no lyrics" would
    // survive every retry for the entry's 30-day life, which is the same defect the
    // enrichment path shipped and had to undo.
    harness.dav.setTree(originTree({ sidecars: { '01.lrc': LRC_TEXT } }));
    await addSidecarNode('01.lrc');
    harness.dav.setGetStatus(503);

    const failed = await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    // The endpoint answers empty rather than failing: a lyric panel with nothing in it is
    // better than a play that errors.
    expect(failed.status).toBe(200);
    expect(envelope(failed.body).lyricsList).toEqual({});

    harness.dav.setGetStatus(null);
    const recovered = await lyricsBySong(subsonicId('s', `${ALBUM_DIR}/01.flac`));
    expect((structured(recovered.body)[0].line as Array<{ value: string }>)[0].value).toBe('Come on skinny love');
  });
});
