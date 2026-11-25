/**
 * `getAlbumInfo` and `getAlbumInfo2`, end to end through the worker and a real D1.
 *
 * Both spellings answer under `albumInfo` — naming the wrapper after the endpoint would
 * answer `200` with a field no client reads. Fields this server cannot answer honestly
 * (last.fm urls, cover-art urls that would 401 without credentials) are absent, not empty
 * defaults; an absent key is the only client-readable "no such field".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, subsonicId } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';
import { addHiddenLibrary, originWithComments } from './helpers/infoFixtures';

const COMMENTS = [
  'TITLE=Skinny Love',
  'DESCRIPTION=Recorded in a cabin',
  'MUSICBRAINZALBUMID=album-mbid-123',
  'MUSICBRAINZARTISTID=artist-mbid-456',
];

let harness: Harness;
let originalFetch: typeof fetch;

beforeEach(async () => {
  harness = await createHarness(originWithComments(COMMENTS));
  originalFetch = fetch;
  globalThis.fetch = harness.dav.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  harness.close();
});

const payload = (body: SubsonicBody, key: string): Record<string, unknown> =>
  (body['subsonic-response'] as Record<string, unknown>)[key] as Record<string, unknown>;

describe('getAlbumInfo / getAlbumInfo2', () => {
  it('answers under albumInfo from both spellings, with notes and the album MusicBrainz id', async () => {
    for (const endpoint of ['getAlbumInfo', 'getAlbumInfo2']) {
      const { body } = await harness.rest(endpoint, { id: harness.ids.album });
      expect(payload(body, 'albumInfo')).toEqual({
        notes: 'Recorded in a cabin',
        musicBrainzId: 'album-mbid-123',
      });
      expect(payload(body, 'getAlbumInfo')).toBeUndefined();
      expect(payload(body, endpoint)).toBeUndefined();
    }
  });

  it('never publishes image or last.fm urls that this server cannot serve', async () => {
    const { body } = await harness.rest('getAlbumInfo2', { id: harness.ids.album });
    const info = payload(body, 'albumInfo');
    for (const key of ['smallImageUrl', 'mediumImageUrl', 'largeImageUrl', 'lastFmUrl']) {
      expect(info[key]).toBeUndefined();
    }
  });

  it('resolves a song id to the album its row belongs to', async () => {
    const { body } = await harness.rest('getAlbumInfo', { id: harness.ids.skinnyLove });
    expect(payload(body, 'albumInfo').notes).toBe('Recorded in a cabin');
  });

  it('answers code=70 for an absent, undecodable or unresolvable id', async () => {
    expect((await harness.rest('getAlbumInfo')).body['subsonic-response'].error?.code).toBe(70);
    expect((await harness.rest('getAlbumInfo', { id: 'not-an-id' })).body['subsonic-response'].error?.code).toBe(70);
    expect((await harness.rest('getAlbumInfo', { id: subsonicId('al', 'Nowhere') })).body['subsonic-response'].error?.code).toBe(70);
  });

  it('answers code=70 for an album in a library the caller cannot see, not code=50', async () => {
    await addHiddenLibrary(harness, 'L2');
    const { body } = await harness.rest('getAlbumInfo', { id: subsonicId('al', 'Bon Iver/Secret', 'L2') });
    expect(body['subsonic-response'].error?.code).toBe(70);
  });

  it('answers an empty albumInfo for an album whose track carries no prose', async () => {
    harness.dav.setTree(originWithComments(['TITLE=Skinny Love']));
    // The first call caches the absence, so the second one proves it is stable and not a
    // transient read being mistaken for "no notes".
    for (let index = 0; index < 2; index += 1) {
      const { body } = await harness.rest('getAlbumInfo', { id: harness.ids.album });
      expect(payload(body, 'albumInfo')).toEqual({});
    }
  });
});
