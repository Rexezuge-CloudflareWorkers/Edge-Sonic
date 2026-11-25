/**
 * The two `getSimilarSongs` spellings, over the real worker and a real D1.
 *
 * The shape assertions are the point as much as the ranking is. A wrapper named after
 * the endpoint, a `song` key that collapses to an object for one result, or an empty
 * answer that emits `song: []` all return `200` with a document that parses — and a
 * client following the schema reads nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SongDAO } from '@edge-sonic/backend-data/dao';
import { READER_VERSION } from '@edge-sonic/media-tags';
import { createHarness, DERIVED_MARKER, LIBRARY_ID, subsonicId } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.close());

function payload<T>(body: SubsonicBody, key: string): T {
  return (body['subsonic-response'] as Record<string, unknown>)[key] as T;
}

interface SongSeed {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly genre?: string;
}

/**
 * A tagged row in a library. The metadata is written through the production DAO so the
 * `_ci` twins and the enrichment stamp are what a real scan would have left behind.
 */
async function addSong(path: string, seed: SongSeed, libraryId = LIBRARY_ID): Promise<string> {
  const songs = new SongDAO(harness.db.db, DERIVED_MARKER);
  const id = subsonicId('s', path, libraryId);
  const directory = path.slice(0, path.lastIndexOf('/'));
  const name = path.slice(path.lastIndexOf('/') + 1);
  await songs.upsertFileFacts([
    {
      id,
      libraryId,
      path,
      dirPath: directory,
      name,
      size: 4096,
      mtimeMs: 1000,
      contentType: 'audio/flac',
      suffix: 'flac',
    },
  ]);
  await songs.applyMetadata(id, {
    title: seed.title,
    artist: seed.artist,
    album: seed.album,
    albumArtist: seed.artist,
    genre: seed.genre ?? null,
    duration: 120,
    bitrate: 900,
    readerVersion: READER_VERSION,
  });
  return id;
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
  const user = await harness.db.db.prepare("SELECT id FROM users WHERE username = 'ann'").first<{ id: string }>();
  await harness.db.db.prepare('INSERT INTO user_libraries (user_id, library_id, created_at) VALUES (?, ?, 1)').bind(user!.id, id).run();
}

function songsOf(value: { song?: unknown }): Array<{ id: string; artist: string }> {
  const song = value.song;
  if (song === undefined) return [];
  return (Array.isArray(song) ? song : [song]) as Array<{ id: string; artist: string }>;
}

describe('getSimilarSongs', () => {
  it('answers under similarSongs with song children, and getSimilarSongs2 under its own wrapper', async () => {
    const first = await harness.rest('getSimilarSongs', { id: harness.ids.artist });
    const wrapper = payload<{ song: Array<{ id: string }> }>(first.body, 'similarSongs');
    expect(wrapper).toBeDefined();
    expect(Object.keys(wrapper)).toEqual(['song']);
    // A two-item list is an array. The one-item case is asserted separately below — a
    // fixture with two items cannot see the collapse that breaks a single result.
    expect(Array.isArray(wrapper.song)).toBe(true);
    expect(wrapper.song.map((song) => song.id).sort()).toEqual([harness.ids.holocene, harness.ids.skinnyLove].sort());

    const second = await harness.rest('getSimilarSongs2', { id: harness.ids.artist });
    expect(Object.keys(payload<Record<string, unknown>>(second.body, 'similarSongs2'))).toEqual(['song']);
    expect(payload<unknown>(first.body, 'similarSongs2')).toBeUndefined();
  });

  it('ranks the seed artist first, then artists sharing a genre, and never the seed song', async () => {
    const bonIver = await addSong('Mystery/Bon Iver/For Emma/03.flac', {
      title: 'Flume',
      artist: 'Bon Iver',
      album: 'For Emma, Forever Ago',
      genre: 'Indie',
    });
    await addSong('Mystery/Other Band/Album/01.flac', {
      title: 'Same genre',
      artist: 'Other Band',
      album: 'Album',
      genre: 'Indie',
    });
    await addSong('Mystery/Unrelated/Album/01.flac', {
      title: 'Different genre',
      artist: 'Unrelated',
      album: 'Album',
      genre: 'Rock',
    });

    const { body } = await harness.rest('getSimilarSongs', { id: harness.ids.skinnyLove });
    const songs = songsOf(payload<{ song?: unknown }>(body, 'similarSongs'));
    expect(songs.map((song) => song.id)).not.toContain(harness.ids.skinnyLove);
    expect(songs.map((song) => song.id)).toContain(bonIver);
    expect(songs[0]?.artist).toBe('Bon Iver');
    expect(songs.map((song) => song.artist)).toContain('Other Band');
    expect(songs.map((song) => song.artist)).not.toContain('Unrelated');
  });

  it('uses the protocol default of 50, not one, when count is omitted', async () => {
    for (let index = 0; index < 4; index++) {
      await addSong(`Mystery/Bon Iver/For Emma/0${index + 3}.flac`, {
        title: `Extra ${index}`,
        artist: 'Bon Iver',
        album: 'For Emma, Forever Ago',
        genre: 'Indie',
      });
    }
    const all = await harness.rest('getSimilarSongs', { id: harness.ids.artist });
    const one = await harness.rest('getSimilarSongs', { id: harness.ids.artist, count: '1' });
    expect(songsOf(payload<{ song?: unknown }>(all.body, 'similarSongs')).length).toBe(6);
    expect(songsOf(payload<{ song?: unknown }>(one.body, 'similarSongs')).length).toBe(1);
    // One item is still an array — the serializer's collapse is the defect this guards.
    expect(Array.isArray(payload<{ song?: unknown }>(one.body, 'similarSongs').song)).toBe(true);
  });

  it('resolves both album id spellings and rejects an artist id for getSimilarSongs2', async () => {
    const list = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '10' });
    const albums = payload<{ album: Array<{ id: string }> }>(list.body, 'albumList2').album;
    expect(albums).toHaveLength(1);

    for (const id of [albums[0]!.id, harness.ids.album]) {
      const { body } = await harness.rest('getSimilarSongs', { id });
      expect(body['subsonic-response'].error).toBeUndefined();
      expect(songsOf(payload<{ song?: unknown }>(body, 'similarSongs')).length).toBe(2);
    }

    const wrong = await harness.rest('getSimilarSongs2', { id: harness.ids.album });
    expect(wrong.body['subsonic-response'].error?.code).toBe(70);
  });

  it('returns a present, empty wrapper when neither genres nor other songs exist', async () => {
    const solo = await addSong('Mystery/Solo/Album/01.flac', { title: 'Only', artist: 'Solo', album: 'Album' });
    const { body } = await harness.rest('getSimilarSongs', { id: solo });
    expect(Object.keys(payload<Record<string, unknown>>(body, 'similarSongs'))).toEqual([]);
  });

  it('answers code=70 for an id it cannot resolve, and for one in a library the caller cannot see', async () => {
    const missing = await harness.rest('getSimilarSongs', { id: subsonicId('s', 'Nowhere/01.flac') });
    expect(missing.body['subsonic-response'].error?.code).toBe(70);
    const absent = await harness.rest('getSimilarSongs');
    expect(absent.body['subsonic-response'].error?.code).toBe(70);

    await addLibrary('L2', 'hidden', false);
    const hidden = await addSong(
      'Mystery/Hidden/Album/01.flac',
      {
        title: 'Hidden',
        artist: 'Hidden',
        album: 'Album',
        genre: 'Indie',
      },
      'L2',
    );
    const foreign = await harness.rest('getSimilarSongs', { id: hidden });
    expect(foreign.body['subsonic-response'].error?.code).toBe(70);
    expect(foreign.body['subsonic-response'].error?.code).not.toBe(50);
  });

  it('unions granted libraries, and keeps an invisible library out of the candidates', async () => {
    await addLibrary('L2', 'second', true);
    const other = await addSong(
      'Mystery/Second Band/Album/01.flac',
      {
        title: 'Second library',
        artist: 'Second Band',
        album: 'Album',
        genre: 'Indie',
      },
      'L2',
    );

    const { body } = await harness.rest('getSimilarSongs', { id: harness.ids.artist });
    expect(songsOf(payload<{ song?: unknown }>(body, 'similarSongs')).map((song) => song.id)).toContain(other);
  });
});
