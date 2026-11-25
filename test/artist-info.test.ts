/**
 * `getArtistInfo` and `getArtistInfo2`, through the real worker.
 *
 * Three shapes are under test, and all three answer `200` when wrong: the wrapper name, the
 * `similarArtist` array at 0/1/2 items, and the two **different element types** the two
 * spellings publish for a similar artist. A v1 `artist` carries no `coverArt`/`albumCount`;
 * an `ArtistID3` does. One builder serving both puts one element's fields on the other, which
 * a lenient client drops and a strict client rejects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, subsonicId } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';
import { addHiddenLibrary, addSong, originWithComments } from './helpers/infoFixtures';

const COMMENTS = [
  'TITLE=Skinny Love',
  'DESCRIPTION=From a cabin in Wisconsin',
  'MUSICBRAINZARTISTID=artist-mbid-456',
  'MUSICBRAINZALBUMID=album-mbid-123',
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

const similarOf = (info: Record<string, unknown>): Record<string, unknown>[] => {
  const value = info.similarArtist;
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
};

describe('getArtistInfo / getArtistInfo2', () => {
  it('answers under its own wrapper with a biography and the artist MusicBrainz id', async () => {
    const first = await harness.rest('getArtistInfo', { id: harness.ids.artist });
    expect(payload(first.body, 'artistInfo')).toEqual({
      biography: 'From a cabin in Wisconsin',
      musicBrainzId: 'artist-mbid-456',
    });
    expect(payload(first.body, 'getArtistInfo')).toBeUndefined();

    const second = await harness.rest('getArtistInfo2', { id: harness.ids.artist });
    expect(payload(second.body, 'artistInfo2').biography).toBe('From a cabin in Wisconsin');
    expect(payload(second.body, 'albumInfo')).toBeUndefined();
  });

  it('publishes no image or last.fm urls and no field it did not measure', async () => {
    const { body } = await harness.rest('getArtistInfo2', { id: harness.ids.artist });
    const info = payload(body, 'artistInfo2');
    for (const key of ['smallImageUrl', 'mediumImageUrl', 'largeImageUrl', 'lastFmUrl', 'albumCount']) {
      expect(info[key]).toBeUndefined();
    }
  });

  it('ranks similar artists from shared genres and uses the v1 / ID3 element shapes', async () => {
    await addSong(harness, 'Other/Band/01.flac', { artist: 'Other Band', album: 'Band', genre: 'Indie' });
    await addSong(harness, 'Unrelated/Band/01.flac', { artist: 'Unrelated', album: 'Band', genre: 'Rock' });

    const first = await harness.rest('getArtistInfo', { id: harness.ids.artist });
    const v1 = similarOf(payload(first.body, 'artistInfo'));
    expect(v1.map((artist) => artist.name)).toContain('Other Band');
    expect(v1.map((artist) => artist.name)).not.toContain('Unrelated');
    expect(v1.map((artist) => artist.name)).not.toContain('Bon Iver');
    expect(v1.length).toBeGreaterThan(0);
    expect(Object.keys(v1[0]!)).toEqual(['id', 'name']);
    expect(typeof v1[0]!.id).toBe('string');

    const second = await harness.rest('getArtistInfo2', { id: harness.ids.artist });
    const v2 = similarOf(payload(second.body, 'artistInfo2'));
    expect(Object.keys(v2[0]!)).toEqual(['id', 'name', 'coverArt']);
    expect(v2[0]!.coverArt).toBe(v2[0]!.id);
  });

  it('defaults count to 20 and keeps a single similar artist an array', async () => {
    for (let index = 0; index < 3; index += 1) {
      await addSong(harness, `Other${index}/Band/01.flac`, { artist: `Other ${index}`, album: 'Band', genre: 'Indie' });
    }
    const all = await harness.rest('getArtistInfo', { id: harness.ids.artist });
    const one = await harness.rest('getArtistInfo', { id: harness.ids.artist, count: '1' });
    expect(similarOf(payload(all.body, 'artistInfo')).length).toBe(3);
    expect(similarOf(payload(one.body, 'artistInfo')).length).toBe(1);
    // The serializer's collapse is invisible at n≥2; this is the case that catches it.
    expect(Array.isArray(payload(one.body, 'artistInfo').similarArtist)).toBe(true);
  });

  it('omits similarArtist entirely when there are no similar artists', async () => {
    const { body } = await harness.rest('getArtistInfo', { id: harness.ids.artist });
    expect(payload(body, 'artistInfo')).toEqual({
      biography: 'From a cabin in Wisconsin',
      musicBrainzId: 'artist-mbid-456',
    });
    expect(payload(body, 'artistInfo').similarArtist).toBeUndefined();
  });

  it('resolves album and song ids, and accepts includeNotPresent as a documented no-op', async () => {
    for (const id of [harness.ids.album, harness.ids.skinnyLove]) {
      const { body } = await harness.rest('getArtistInfo2', { id, includeNotPresent: 'true' });
      expect(body['subsonic-response'].error).toBeUndefined();
      expect(payload(body, 'artistInfo2').biography).toBe('From a cabin in Wisconsin');
    }
  });

  it('answers code=70 for an absent, undecodable or invisible-library id', async () => {
    expect((await harness.rest('getArtistInfo')).body['subsonic-response'].error?.code).toBe(70);
    expect((await harness.rest('getArtistInfo', { id: 'nonsense' })).body['subsonic-response'].error?.code).toBe(70);
    await addHiddenLibrary(harness, 'L2');
    const { body } = await harness.rest('getArtistInfo2', { id: subsonicId('ar', 'Secret Artist', 'L2') });
    expect(body['subsonic-response'].error?.code).toBe(70);
  });
});
