/**
 * `getTopSongs` over the real worker and a real D1.
 *
 * The ranking is the smaller half of this file. The shape assertions are why it exists:
 * a wrapper named after the endpoint, a `song` key that collapses to an object for one
 * result, an empty answer that emits `song: []`, or a name lowercased in SQL and served
 * from an ungranted library all answer `200` with a document that parses — and a client
 * following the schema reads nothing or the wrong thing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlayCountDAO, SongDAO, topSongsQuery } from '@edge-sonic/backend-data/dao';
import { READER_VERSION } from '@edge-sonic/media-tags';
import { createHarness, DERIVED_MARKER, LIBRARY_ID, USERNAME, subsonicId } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';
import { queryPlan } from './helpers/sqlite';

let harness: Harness;
let userId: string;

beforeEach(async () => {
  harness = await createHarness();
  const found = await harness.db.db.prepare('SELECT id FROM users WHERE username = ?').bind(USERNAME).first<{ id: string }>();
  userId = found!.id;
});

afterEach(() => harness.close());

function payload<T>(body: SubsonicBody, key: string): T {
  return (body['subsonic-response'] as Record<string, unknown>)[key] as T;
}

function songsOf(value: { song?: unknown }): Array<{ id: string; artist: string; title: string }> {
  const song = value.song;
  if (song === undefined) return [];
  return (Array.isArray(song) ? song : [song]) as Array<{ id: string; artist: string; title: string }>;
}

interface SongSeed {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
}

/**
 * A tagged row in a library, written through the production DAO so the `_ci` twins and
 * the enrichment stamp are what a real scan would have left behind.
 */
async function addSong(path: string, seed: SongSeed, libraryId = LIBRARY_ID): Promise<string> {
  const songs = new SongDAO(harness.db.db, DERIVED_MARKER);
  const id = subsonicId('s', path, libraryId);
  const directory = path.slice(0, path.lastIndexOf('/'));
  const name = path.slice(path.lastIndexOf('/') + 1);
  await songs.upsertFileFacts([
    { id, libraryId, path, dirPath: directory, name, size: 4096, mtimeMs: 1000, contentType: 'audio/flac', suffix: 'flac' },
  ]);
  await songs.applyMetadata(id, {
    title: seed.title,
    artist: seed.artist,
    album: seed.album,
    albumArtist: seed.artist,
    duration: 120,
    bitrate: 900,
    readerVersion: READER_VERSION,
  });
  return id;
}

/**
 * Absolute counts, written by the import's writer: a scrobble would increment from zero
 * and make a 5/2 ranking take four test calls instead of one.
 */
async function plays(counts: ReadonlyArray<readonly [string, number]>): Promise<void> {
  await new PlayCountDAO(harness.db.db).setPlayCounts(
    userId,
    counts.map(([songId, playCount]) => ({ songId, playCount })),
  );
}

async function addLibrary(id: string, slug: string, grant: boolean): Promise<void> {
  await harness.db.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv,
        key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'https://dav.example.com', '/music', 'alice', 'cipher', 'iv', 1, ?, 1, 1, 1)`,
    )
    .bind(id, slug, slug, slug)
    .run();
  if (!grant) return;
  await harness.db.db.prepare('INSERT INTO user_libraries (user_id, library_id, created_at) VALUES (?, ?, 1)').bind(userId, id).run();
}

describe('getTopSongs', () => {
  it('answers under topSongs with song children, never under a wrapper named after the endpoint', async () => {
    await plays([
      [harness.ids.skinnyLove, 5],
      [harness.ids.holocene, 2],
    ]);
    const { body } = await harness.rest('getTopSongs', { artist: 'Bon Iver' });
    const wrapper = payload<{ song: unknown }>(body, 'topSongs');
    expect(wrapper).toBeDefined();
    expect(Object.keys(wrapper)).toEqual(['song']);
    expect(Array.isArray(wrapper.song)).toBe(true);
    expect(payload<unknown>(body, 'getTopSongs')).toBeUndefined();
    expect(payload<unknown>(body, 'similarSongs')).toBeUndefined();
  });

  it('ranks by this user’s play count, excludes other artists, and breaks ties by path', async () => {
    const extra = await addSong('Bon Iver/For Emma/03.flac', { title: 'Flume', artist: 'Bon Iver', album: 'For Emma' });
    const other = await addSong('Other Band/Album/01.flac', { title: 'Louder', artist: 'Other Band', album: 'Album' });
    await plays([
      [harness.ids.skinnyLove, 2],
      [harness.ids.holocene, 5],
      [extra, 2],
      [other, 100],
    ]);

    const { body } = await harness.rest('getTopSongs', { artist: 'Bon Iver' });
    const ids = songsOf(payload<{ song?: unknown }>(body, 'topSongs')).map((song) => song.id);
    expect(ids).toEqual([harness.ids.holocene, harness.ids.skinnyLove, extra]);
    expect(ids).not.toContain(other);

    const again = await harness.rest('getTopSongs', { artist: 'Bon Iver' });
    expect(songsOf(payload<{ song?: unknown }>(again.body, 'topSongs')).map((song) => song.id)).toEqual(ids);
  });

  it('matches the artist name case-insensitively without lowercasing a column', async () => {
    await plays([[harness.ids.skinnyLove, 1]]);
    const upper = await harness.rest('getTopSongs', { artist: 'BON IVER' });
    expect(songsOf(payload<{ song?: unknown }>(upper.body, 'topSongs')).map((song) => song.id)).toEqual([harness.ids.skinnyLove]);
    const mixed = await harness.rest('getTopSongs', { artist: 'bOn IvEr' });
    expect(songsOf(payload<{ song?: unknown }>(mixed.body, 'topSongs')).map((song) => song.id)).toEqual([harness.ids.skinnyLove]);
  });

  it('uses the protocol default of 50 when count is omitted, and one item is still an array', async () => {
    await plays([
      [harness.ids.skinnyLove, 3],
      [harness.ids.holocene, 2],
    ]);
    const all = await harness.rest('getTopSongs', { artist: 'Bon Iver' });
    const one = await harness.rest('getTopSongs', { artist: 'Bon Iver', count: '1' });
    expect(songsOf(payload<{ song?: unknown }>(all.body, 'topSongs'))).toHaveLength(2);
    expect(songsOf(payload<{ song?: unknown }>(one.body, 'topSongs'))).toHaveLength(1);
    expect(Array.isArray(payload<{ song?: unknown }>(one.body, 'topSongs').song)).toBe(true);
  });

  it('answers an absent artist with code=10, and a present empty wrapper when nobody has played', async () => {
    const missing = await harness.rest('getTopSongs');
    expect(missing.body['subsonic-response'].error?.code).toBe(10);
    const blank = await harness.rest('getTopSongs', { artist: '' });
    expect(blank.body['subsonic-response'].error?.code).toBe(10);

    const { body } = await harness.rest('getTopSongs', { artist: 'Bon Iver' });
    expect(Object.keys(payload<Record<string, unknown>>(body, 'topSongs'))).toEqual([]);
  });

  it('unions granted libraries, honours musicFolderId, and never reads an ungranted one', async () => {
    await addLibrary('L2', 'hidden', false);
    await addLibrary('L3', 'second', true);
    const hidden = await addSong('Bon Iver/Hidden/01.flac', { title: 'Hidden', artist: 'Bon Iver', album: 'Hidden' }, 'L2');
    const second = await addSong('Bon Iver/Second/01.flac', { title: 'Second', artist: 'Bon Iver', album: 'Second' }, 'L3');
    await plays([
      [harness.ids.skinnyLove, 1],
      [hidden, 999],
      [second, 2],
    ]);

    const all = await harness.rest('getTopSongs', { artist: 'Bon Iver' });
    const ids = songsOf(payload<{ song?: unknown }>(all.body, 'topSongs')).map((song) => song.id);
    expect(ids).toContain(second);
    expect(ids).not.toContain(hidden);

    const narrow = await harness.rest('getTopSongs', { artist: 'Bon Iver', musicFolderId: '1' });
    expect(songsOf(payload<{ song?: unknown }>(narrow.body, 'topSongs')).map((song) => song.id)).toEqual([second]);
  });

  it('drives the ranking from indexed columns, not a bare table scan', () => {
    const query = topSongsQuery([LIBRARY_ID], userId, 'bon iver', 50);
    const plan = queryPlan(harness.db, query.sql, [...query.values]);
    expect(plan).not.toMatch(/SCAN songs/);
    expect(plan).not.toMatch(/SCAN play_counts/);
    // The planner drives from this user's play counts and reaches each song by its primary
    // key. Both are index seeks; the temporary B-tree sorts a bounded set of played rows.
    expect(plan).toMatch(/SEARCH p USING (?:COVERING )?INDEX/);
    expect(plan).toMatch(/SEARCH s USING (?:COVERING )?INDEX/);

    const union = topSongsQuery([LIBRARY_ID, 'L3'], userId, 'bon iver', 50);
    expect(queryPlan(harness.db, union.sql, [...union.values])).not.toMatch(/SCAN songs/);
  });
});
