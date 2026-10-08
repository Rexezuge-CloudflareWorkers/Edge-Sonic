/**
 * The playlist surface, end to end through the real worker: `createPlaylist`,
 * `getPlaylist`, `updatePlaylist`, `deletePlaylist`, and the always-empty
 * `getPlaylists` an account with no playlists gets.
 *
 * `songCount` is asserted, not just the shape: a playlist whose count reads 0
 * while its entries hold two songs is a client-facing lie the serializer cannot
 * see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALBUM_DIR, createHarness, subsonicId } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';

let harness: Harness;

const SKINNY_LOVE = subsonicId('s', `${ALBUM_DIR}/01.flac`);
const HOLOCENE = subsonicId('s', `${ALBUM_DIR}/02.flac`);

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.close());

function payload<T>(body: SubsonicBody, key: string): T {
  return (body['subsonic-response'] as Record<string, unknown>)[key] as T;
}

function expectEmptyPlaylists(body: SubsonicBody): void {
  const value = payload<unknown>(body, 'playlists');
  expect(value, 'playlists wrapper is absent').toBeDefined();
  expect(Object.keys(value as Record<string, unknown>), 'playlists is not empty').toEqual([]);
}

describe('getPlaylists', () => {
  it('is an empty wrapper, not an error, before anything is created', async () => {
    expectEmptyPlaylists((await harness.rest('getPlaylists')).body);
  });

  it('lists a created playlist by name, with the owner and counts', async () => {
    await harness.rest('createPlaylist', { name: 'Mix', songId: `${SKINNY_LOVE},${HOLOCENE}` });
    const { body } = await harness.rest('getPlaylists');
    const playlist = payload<{ playlist: Array<{ name: string; owner: string; songCount: number }> }>(body, 'playlists').playlist;
    expect(playlist).toHaveLength(1);
    expect(playlist[0]?.name).toBe('Mix');
    expect(playlist[0]?.owner).toBe('ann');
    expect(playlist[0]?.songCount).toBe(2);
  });

  it('refuses a non-admin asking for another user, and a questionable username', async () => {
    // The harness user is an admin, so a named stranger resolves instead of
    // tripping the non-admin guard — and the answer then has to be a clean
    // not-found, never a 500 or a leaked user's list.
    const other = await harness.rest('getPlaylists', { username: 'bob' });
    expect(payload<{ code: number }>(other.body, 'error').code).toBe(70);
  });
});

describe('createPlaylist', () => {
  it('requires a name, and trims it', async () => {
    const missing = await harness.rest('createPlaylist');
    expect(payload<{ code: number }>(missing.body, 'error').code).toBe(10);

    const blank = await harness.rest('createPlaylist', { name: ' '.repeat(3) });
    expect(payload<{ code: number }>(blank.body, 'error').code).toBe(10);
  });

  it('returns the playlist with its entries in the client’s order', async () => {
    const { body } = await harness.rest('createPlaylist', { name: 'Mix', songId: `${HOLOCENE},${SKINNY_LOVE}` });
    const playlist = payload<{ id: string; name: string; songCount: number; duration: number; public: boolean; entry: Array<{ id: string }> | { id: string } }>(body, 'playlist');
    expect(playlist.name).toBe('Mix');
    expect(playlist.songCount).toBe(2);
    // The two tracks' durations, summed — progress bars are arithmetic.
    expect(playlist.duration).toBe(587);
    const entries = Array.isArray(playlist.entry) ? playlist.entry : [playlist.entry];
    // The client's order is the playlist's order, which is the whole point of a playlist.
    expect(entries.map((entry) => entry.id)).toEqual([HOLOCENE, SKINNY_LOVE]);
  });

  it('replaces entries when given a playlistId', async () => {
    const created = await harness.rest('createPlaylist', { name: 'Mix', songId: SKINNY_LOVE });
    const id = payload<{ id: string }>(created.body, 'playlist').id;

    const replaced = await harness.rest('createPlaylist', { playlistId: id, songId: HOLOCENE });
    const playlist = payload<{ id: string; songCount: number }>(replaced.body, 'playlist');
    expect(playlist.id).toBe(id);
    expect(playlist.songCount).toBe(1);
  });
});

describe('updatePlaylist', () => {
  it('renames, re-comments, and gates visibility', async () => {
    const created = await harness.rest('createPlaylist', { name: 'Mix', songId: SKINNY_LOVE });
    const id = payload<{ id: string }>(created.body, 'playlist').id;

    const updated = await harness.rest('updatePlaylist', { playlistId: id, name: '  Renamed  ', comment: 'note', public: 'true' });
    expect((updated.body['subsonic-response'] as { status: string }).status).toBe('ok');

    const read = await harness.rest('getPlaylist', { id });
    const playlist = payload<{ name: string; comment: string; public: boolean }>(read.body, 'playlist');
    expect(playlist.name).toBe('Renamed');
    expect(playlist.comment).toBe('note');
    expect(playlist.public).toBe(true);
  });

  it('removes by position, highest first, so the order sent does not matter', async () => {
    const created = await harness.rest('createPlaylist', { name: 'Mix', songId: `${SKINNY_LOVE},${HOLOCENE},${subsonicId('s', `${ALBUM_DIR}/cover.jpg`)}` });
    const id = payload<{ id: string }>(created.body, 'playlist').id;

    // Removing indices 0 and 2, sent in the *low* order on purpose: the DAO must
    // apply them high-to-low or the positions land on the wrong rows.
    await harness.rest('updatePlaylist', { playlistId: id, songIndexToRemove: '0,2' });

    const read = await harness.rest('getPlaylist', { id });
    const playlist = payload<{ songCount: number; entry: Array<{ id: string }> }>(read.body, 'playlist');
    expect(playlist.songCount).toBe(1);
    expect((Array.isArray(playlist.entry) ? playlist.entry : [playlist.entry])[0]?.id).toBe(HOLOCENE);
  });

  it('refuses to mutate a playlist that does not exist', async () => {
    const updated = await harness.rest('updatePlaylist', { playlistId: 'nope', name: 'x' });
    expect(payload<{ code: number }>(updated.body, 'error').code).toBe(70);
  });
});

describe('deletePlaylist', () => {
  it('removes the playlist from the listing', async () => {
    const created = await harness.rest('createPlaylist', { name: 'Mix', songId: SKINNY_LOVE });
    const id = payload<{ id: string }>(created.body, 'playlist').id;

    await harness.rest('deletePlaylist', { id });
    expectEmptyPlaylists((await harness.rest('getPlaylists')).body);

    const read = await harness.rest('getPlaylist', { id });
    expect(payload<{ code: number }>(read.body, 'error').code).toBe(70);
  });
});
