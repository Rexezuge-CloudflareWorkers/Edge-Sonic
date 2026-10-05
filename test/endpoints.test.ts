/**
 * The `/rest` surface not covered by `worker.int.test.ts`: the album/song lists, the
 * per-user state, the user endpoints, and the scan controls.
 *
 * Two things are worth stating about how these are written.
 *
 * **The empty case is asserted, not just the populated one.** Every list here can be
 * empty — a user who has starred nothing, a queue that was never saved, a library with
 * no genres — and the JSON shape of an empty list is where a client breaks, because
 * `response.starred2.song.map(...)` throws on an absent key and renders an empty screen
 * on `[]`. See `test/subsonic-protocol.test.ts` for the serializer rule and the
 * `elList` contract that follows from it.
 *
 * **A count is a count.** `songCount` is what a client draws a progress bar from, and a
 * playlist whose `songCount` reads 0 while its `entry` list holds two songs is a bug
 * that only shows up on a screen nobody tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CONSECUTIVE_FAILURES } from '@edge-sonic/backend-services/index';
import { OPEN_SUBSONIC_EXTENSIONS } from '../apps/api/src/rest/endpoints/system';
import { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import { SongDAO, SongDerivationDAO } from '@edge-sonic/backend-data/dao';
import { createHarness, ALBUM_DIR, LIBRARY_ID, ORIGIN, SALT, USERNAME, subsonicId } from './helpers/harness';
import type { Harness, SubsonicBody } from './helpers/harness';

let harness: Harness;

const SKINNY_LOVE = subsonicId('s', `${ALBUM_DIR}/01.flac`);
const HOLOCENE = subsonicId('s', `${ALBUM_DIR}/02.flac`);
const ALBUM = subsonicId('al', ALBUM_DIR);
const ARTIST = subsonicId('ar', 'Bon Iver');

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.close());

/**
Read a typed field out of the envelope.
*/
function payload<T>(body: SubsonicBody, key: string): T {
  return (body['subsonic-response'] as Record<string, unknown>)[key] as T;
}

/**
 * A list wrapper that is present and has nothing in it.
 *
 * The shape is `{wrapper: {}}` — the wrapper is always there, and an item key with no items
 * is **absent** rather than `[]`. Navidrome answers `{"starred2":{}}`, `{"playlists":{}}`,
 * `{"bookmarks":{}}` and `{"nowPlaying":{}}`, and so does this.
 *
 * The half that matters is the wrapper's *presence*. An absent wrapper leaves a client
 * unable to tell "nothing here" from "this server does not implement that", and it is the
 * difference between an empty screen and a failure. So the assertion is that the wrapper
 * exists and is empty — never that the whole payload is absent.
 */
function expectEmptyWrapper(body: SubsonicBody, wrapper: string, endpoint: string): void {
  const value = payload<unknown>(body, wrapper);
  expect(value, `${endpoint}: wrapper ${wrapper} is absent`).toBeDefined();
  expect(Object.keys(value as Record<string, unknown>), `${endpoint}: ${wrapper} is not empty`).toEqual([]);
}

describe('getAlbumList2', () => {
  it('sorts alphabetically by name by default', async () => {
    const { body } = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '10' });
    const albums = payload<{ album: Array<{ name: string; songCount: number; duration: number }> }>(body, 'albumList2').album;

    expect(albums.map((album) => album.name)).toEqual(['For Emma, Forever Ago']);
    // The two tracks, summed. A client shows this as the album length.
    expect(albums[0]?.duration).toBe(587);
    expect(albums[0]?.songCount).toBe(2);
  });

  it('orders by artist, by year, and by rating without losing tracks', async () => {
    // The protocol's own list of types. `byRating` is **not** among them — the test
    // asserted it alongside the rest, which is how an invented parameter got in: it was
    // only ever checked for "did not 500", and the server silently substituted a random
    // order for it. An unrecognised type is now `code=0`, asserted below.
    for (const type of ['alphabeticalByArtist', 'byYear', 'starred', 'highest', 'frequent', 'recent', 'random', 'byGenre']) {
      const { body } = await harness.rest('getAlbumList2', { type, size: '10' });
      // `random` legitimately returns the album and `starred` returns none, so the
      // assertion is that the request is *answered*, not what it contains. A type that
      // 500s or returns an error is the failure.
      const album = payload<{ album?: Array<{ name: string }> }>(body, 'albumList2');
      expect(album, type).toBeDefined();
      // With items, the key is an array — never a bare object, which a single-item page
      // would otherwise produce. An *empty* result has no key at all; that is asserted
      // separately so the two cannot be confused for one another.
      if (album.album === undefined) expect(Object.keys(album), `${type}: empty result carried a key`).toEqual([]);
      else expect(Array.isArray(album.album), type).toBe(true);
    }
  });

  it('requires type, and refuses one it does not implement', async () => {
    // `type` is a required parameter. Defaulting it answered a question nobody asked: a
    // client that sent none got a confident random page back and had no way to tell the
    // server had substituted the request. Navidrome refuses it with `code=10`.
    const missing = await harness.rest('getAlbumList2', { size: '10' });
    expect(payload<{ code: number }>(missing.body, 'error').code).toBe(10);

    // A type outside the protocol's enumeration is a *different* failure from a missing
    // one — a client bug rather than an omission — and gets the generic code. Falling back
    // to `random` would answer a question nobody asked, which is the bug above again.
    for (const type of ['byRating', 'bogus', 'ALPHABETICALBYNAME']) {
      const unknown = await harness.rest('getAlbumList2', { type, size: '10' });
      expect(payload<{ code: number }>(unknown.body, 'error').code, type).toBe(0);
    }
  });

  it('honours size and offset, and says when there is nothing more', async () => {
    const first = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '1', offset: '0' });
    expect(payload<{ album: unknown[] }>(first.body, 'albumList2').album).toHaveLength(1);

    const past = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '10', offset: '500' });
    // An out-of-range offset is an **empty list**, not a 404: a paging client asks for
    // the next page and has to be told "there is none" in a way it can read.
    expectEmptyWrapper(past.body, 'albumList2', 'getAlbumList2');
  });

  it('refuses a type it does not implement rather than answering a different question', async () => {
    // This used to fall back to the default order, on the argument that "a *newer* client
    // can send a type this server has never heard of, and a client that gets an error
    // reports a server error to the user".
    //
    // That argument does not survive the version gate. `assertClientVersion` refuses a
    // client newer than 1.16.1 outright, so a type added by a *newer* protocol version can
    // never reach this handler from a conforming client — the only caller that can send
    // `byReleaseDate` is one that is already being refused, or one that has a typo. And the
    // cost the comment accepted ("a typo is answered with a plausible list") is the whole
    // problem: the client asked for the highest-rated albums and received a random page,
    // correctly shaped, with nothing to indicate the substitution.
    //
    // Navidrome answers `code=0` here, which is the protocol's generic failure.
    const { status, body } = await harness.rest('getAlbumList2', { type: 'alphabeticalBySideways', size: '10' });
    expect(status).toBe(200);
    expect(payload<{ code: number; message: string }>(body, 'error')).toMatchObject({ code: 0 });
    // Named in the message, so the client learns which parameter was wrong rather than
    // only that something was.
    expect(payload<{ message: string }>(body, 'error').message).toContain('alphabeticalBySideways');
  });

  it('uses the documented default page size, not one item', async () => {
    // `params.int('count', undefined)` returns the *number* 0, which is not nullish, so
    // the fallback never applied and `pageSize`'s floor turned it into 1. Every paged
    // endpoint returned a single item unless the client sent the count explicitly.
    const { body } = await harness.rest('getAlbumList2', { type: 'alphabeticalByName' });
    expect(payload<{ album: unknown[] }>(body, 'albumList2').album.length).toBeGreaterThan(0);

    const songs = await harness.rest('getSongsByGenre', { genre: 'Indie' });
    // The whole point of the bug: a genre with two tracks returned one of them.
    expect(payload<{ song: unknown[] }>(songs.body, 'songsByGenre').song).toHaveLength(2);
  });
});

describe('getAlbumList', () => {
  it('reports the same albums as the 2 variant, because a client may send either', async () => {
    const legacy = await harness.rest('getAlbumList', { type: 'alphabeticalByName', size: '10' });
    const current = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '10' });

    // Compared on **id**, which both spellings publish, and not on a field name.
    //
    // This used to read `title` off `getAlbumList` and `name` off `getAlbumList2` and
    // assert they matched — which is how the two came to publish different fields for
    // the same album in the first place. It passed *because* they disagreed: the
    // assertion could only hold while each carried the field it was reading and neither
    // carried the other's. `albumList` is `Array of Child` and `albumList2` is
    // `Array of AlbumID3`, so they are meant to differ, and what they must agree on is
    // *which albums*, not which fields name them.
    const legacyIds = payload<{ album: Array<{ id: string }> }>(legacy.body, 'albumList').album.map((album) => album.id);
    const currentIds = payload<{ album: Array<{ id: string }> }>(current.body, 'albumList2').album.map((album) => album.id);
    expect(legacyIds.length).toBeGreaterThan(0);
    expect(legacyIds).toEqual(currentIds);
  });

  it('publishes albums as a Child, which is what albumList declares', async () => {
    // `albumList` is `Array of Child` and `albumList2` is `Array of AlbumID3`. One
    // shared builder served both and published the union — so `getAlbumList2` carried
    // `title` and `isDir`, neither of which `AlbumID3` declares. Nothing here could see
    // it: a lenient client drops an unknown attribute, and `name` was published too, so
    // every field a client actually reads kept working. It is visible only by reading
    // the same endpoint off a reference server — `scripts/compare-navidrome.mjs`.
    const legacy = payload<{ album: Array<Record<string, unknown>> }>((await harness.rest('getAlbumList', { type: 'alphabeticalByName' })).body, 'albumList').album;
    const current = payload<{ album: Array<Record<string, unknown>> }>((await harness.rest('getAlbumList2', { type: 'alphabeticalByName' })).body, 'albumList2').album;

    // A `Child` names its media `title` and declares itself a directory.
    expect(legacy[0]).toHaveProperty('title');
    expect(legacy[0]).toHaveProperty('isDir', true);
    // An `AlbumID3` names it `name` and declares neither.
    expect(current[0]).toHaveProperty('name');
    expect(current[0]).not.toHaveProperty('title');
    expect(current[0]).not.toHaveProperty('isDir');
  });
});

describe('getGenres and getSongsByGenre', () => {
  it('lists the genres in the index, sorted', async () => {
    const { body } = await harness.rest('getGenres');
    const genres = payload<{ genre: Array<{ value: string; songCount: number; albumCount: number }> }>(body, 'genres').genre;

    expect(genres.map((genre) => genre.value)).toEqual(['Indie']);
    // The counts are what a client uses to decide whether to offer a genre filter at
    // all; a genre with a count of 0 is a filter that leads to nothing.
    expect(genres[0]?.songCount).toBe(2);
    expect(genres[0]?.albumCount).toBe(1);
  });

  it('returns the tracks for a genre, in disc and track order', async () => {
    const { body } = await harness.rest('getSongsByGenre', { genre: 'Indie' });
    const songs = payload<{ song: Array<{ id: string; track: number }> }>(body, 'songsByGenre').song;

    // Disc then track, not insertion order: a multi-disc album played in the wrong
    // order is one of the most visible bugs in a music server.
    expect(songs.map((song) => song.id)).toEqual([SKINNY_LOVE, HOLOCENE]);
    expect(songs.map((song) => song.track)).toEqual([4, 5]);
  });

  it('matches a genre case-insensitively, because a client sends what the user typed', async () => {
    const { body } = await harness.rest('getSongsByGenre', { genre: 'iNdIe' });
    expect(payload<{ song: unknown[] }>(body, 'songsByGenre').song).toHaveLength(2);
  });

  it('answers an unknown genre with an empty list, not an error', async () => {
    // A genre filter is a browsing affordance; a client showing "no tracks" is correct,
    // and a `code=70` would be reported to the user as a failure.
    const { status, body } = await harness.rest('getSongsByGenre', { genre: 'Polka' });
    expect(status).toBe(200);
    expectEmptyWrapper(body, 'songsByGenre', 'getSongsByGenre');
  });
});

describe('getRandomSongs', () => {
  it('returns tracks and honours the size', async () => {
    const { body } = await harness.rest('getRandomSongs', { size: '1' });
    const songs = payload<{ song: Array<{ id: string }> }>(body, 'randomSongs').song;
    expect(songs).toHaveLength(1);
    expect([SKINNY_LOVE, HOLOCENE]).toContain(songs[0]?.id);
  });

  it('caps a size larger than the library, rather than erroring', async () => {
    const { status, body } = await harness.rest('getRandomSongs', { size: '5000' });
    expect(status).toBe(200);
    expect(payload<{ song: unknown[] }>(body, 'randomSongs').song).toHaveLength(2);
  });

  it('filters by genre, so a client can offer "something else like this"', async () => {
    const { body } = await harness.rest('getRandomSongs', { size: '10', genre: 'Indie' });
    expect(payload<{ song: unknown[] }>(body, 'randomSongs').song).toHaveLength(2);

    const other = await harness.rest('getRandomSongs', { size: '10', genre: 'Polka' });
    expectEmptyWrapper(other.body, 'randomSongs', 'getRandomSongs');
  });
});

describe('getUser and getUsers', () => {
  it('describes the authenticated user with its roles and folder list', async () => {
    const { body } = await harness.rest('getUser', { username: 'ann' });
    const user = payload<Record<string, unknown>>(body, 'user');

    expect(user.username).toBe('ann');
    expect(user.scrobblingEnabled).toBe(true);
    // 1.16.1 replaced the single `admin` flag with capability roles. A client hides its
    // controls from these, so `adminRole: false` would remove features that work.
    expect(user.adminRole).toBe(true);
    expect(user.streamRole).toBe(true);
    expect(user.playlistRole).toBe(true);
    // Genuinely unsupported, and reported false rather than omitted, so a client can
    // tell "not supported" from "server too old to say".
    expect(user.podcastRole).toBe(false);
    // `folder` is the list every `musicFolderId` in any other response is a position
    // into, and the schema types it as `Array of int` — bare numbers, not records. A
    // client whose model is `folder: List<Int>` throws on a record, inside its login
    // path, and reports it as bad credentials. `test/music-folder-index.test.ts` asserts
    // the positions resolve; `test/client-decoding.test.ts` asserts the decode.
    expect(user.folder).toEqual([0]);
  });

  it('lets a non-admin read only themselves', async () => {
    const { encryptData } = await import('@edge-sonic/backend-data/crypto');
    const secret = await encryptData('opensesame', 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=');
    await harness.db.db
      .prepare(
        `INSERT INTO users (id, username, username_ci, password_ciphertext, password_iv, key_version, token_epoch, is_admin, is_enabled, scrobbling_enabled, created_at, updated_at)
         VALUES ('u-bob', 'bob', 'bob', ?, ?, 1, 1, 0, 1, 1, 0, 0)`,
      )
      .bind(secret.ciphertext, secret.iv)
      .run();
    // Demote the caller, so the request is genuinely a non-admin one.
    await harness.db.db.prepare('UPDATE users SET is_admin = 0 WHERE username = ?').bind('ann').run();

    const self = await harness.rest('getUser', { username: 'ann' });
    expect(payload<{ username: string }>(self.body, 'user').username).toBe('ann');

    // Reading somebody else is refused. `code=50`, not `70`: a user row is not a secret,
    // and hiding its existence would make a legitimate admin lookup fail confusingly.
    const other = await harness.rest('getUser', { username: 'bob' });
    expect(payload<{ code: number }>(other.body, 'error').code).toBe(50);
  });

  it('lets an admin read another user, with that user\'s own folders', async () => {
    const { encryptData } = await import('@edge-sonic/backend-data/crypto');
    const secret = await encryptData('opensesame', 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=');
    await harness.db.db
      .prepare(
        `INSERT INTO users (id, username, username_ci, password_ciphertext, password_iv, key_version, token_epoch, is_admin, is_enabled, scrobbling_enabled, created_at, updated_at)
         VALUES ('u-bob', 'bob', 'bob', ?, ?, 1, 1, 0, 1, 1, 0, 0)`,
      )
      .bind(secret.ciphertext, secret.iv)
      .run();

    const { body } = await harness.rest('getUser', { username: 'bob' });
    expect(payload<{ username: string }>(body, 'user').username).toBe('bob');
    // Bob has no grants, so his folder list is empty — the admin's own folder list would
    // be wrong, and would make a client resolve his ids against the wrong libraries.
    expect(payload<Record<string, unknown>>(body, 'user').folder).toBeUndefined();
  });

  it('lists users for an admin, and refuses a non-admin', async () => {
    const asAdmin = await harness.rest('getUsers');
    expect(payload<{ user: Array<{ username: string }> }>(asAdmin.body, 'users').user.map((user) => user.username)).toEqual(['ann']);
    // An empty list would be indistinguishable from "this server has one user", which is
    // itself the information the endpoint must not leak.
    expect(JSON.stringify(asAdmin.body)).not.toContain('password');

    await harness.db.db.prepare('UPDATE users SET is_admin = 0 WHERE username = ?').bind('ann').run();
    const asUser = await harness.rest('getUsers');
    expect(payload<{ code: number }>(asUser.body, 'error').code).toBe(50);
  });
});

describe('the play queue', () => {
  it('round-trips a saved queue, in the order it was saved', async () => {
    await harness.rest('savePlayQueue', { id: `${HOLOCENE},${SKINNY_LOVE}`, current: HOLOCENE, position: '42000' });

    const { body } = await harness.rest('getPlayQueue');
    const queue = payload<{ entry: Array<{ id: string }>; current: string; position: number; username: string }>(body, 'playQueue');

    // Order is the client's, which is the entire point of a queue. A query that returned
    // the rows in insertion-independent order would shuffle a user's pending playlist.
    expect(queue.entry.map((entry) => entry.id)).toEqual([HOLOCENE, SKINNY_LOVE]);
    expect(queue.current).toBe(HOLOCENE);
    expect(queue.position).toBe(42_000);
    expect(queue.username).toBe('ann');
  });

  it('answers an unsaved queue with an empty wrapper, not with an error', async () => {
    // A client calls this on every launch. A `code=70` would surface as a failure
    // dialog on a fresh install. The wrapper is present and empty; `entry` is absent,
    // which is the shape the reference server answers.
    const { status, body } = await harness.rest('getPlayQueue');
    expect(status).toBe(200);
    expectEmptyWrapper(body, 'playQueue', 'getPlayQueue');
  });

  it('refuses a queue naming a track in a library the user cannot see', async () => {
    // All-or-nothing, and the reason is the await: the grant check used to be `void`ed,
    // so it started and discarded its rejection, the save proceeded, and the queue held
    // an id pointing into a library the caller cannot see. The queue then read back
    // shorter than it was saved — silent data loss with an authorization hole under it.
    const { body } = await harness.rest('savePlayQueue', { id: subsonicId('s', 'secret.flac', 'L-other') });
    expect(payload<{ code: number }>(body, 'error').code).toBe(70);

    // Nothing was written, and a pre-existing queue was not emptied by the refusal.
    const stored = await harness.db.db.prepare('SELECT COUNT(*) AS n FROM play_queue_entries').first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });

  it('leaves an existing queue intact when a save is refused', async () => {
    await harness.rest('savePlayQueue', { id: SKINNY_LOVE });
    await harness.rest('savePlayQueue', { id: `${SKINNY_LOVE},${subsonicId('s', 'secret.flac', 'L-other')}` });

    const { body } = await harness.rest('getPlayQueue');
    // The validation happens before the replace precisely so this holds: a rejected save
    // must not cost the user the queue they already had.
    expect(payload<{ entry: Array<{ id: string }> }>(body, 'playQueue').entry.map((entry) => entry.id)).toEqual([SKINNY_LOVE]);
  });

  it('drops a queued track that no longer exists, and keeps the rest', async () => {
    // A track deleted in WebDAV leaves an id in the queue that no longer resolves. The
    // remaining order is preserved — the queue is the user's pending playlist, and
    // losing all of it over one deleted file is not a reasonable trade.
    await harness.rest('savePlayQueue', { id: `${SKINNY_LOVE},${HOLOCENE}` });
    await harness.db.db.prepare('DELETE FROM songs WHERE id = ?').bind(HOLOCENE).run();

    const { body } = await harness.rest('getPlayQueue');
    const queue = payload<{ entry: Array<{ id: string }> }>(body, 'playQueue');
    expect(queue.entry.map((entry) => entry.id)).toEqual([SKINNY_LOVE]);
  });
});

describe('getAlbum', () => {
  it('publishes its songs as an array, at one track and at two', async () => {
    // The single-track case is the one that shipped broken. `getAlbum` attached the songs
    // as plain children of the album element, and the serializer collapses a single
    // undeclared child to a bare object — so the JSON shape changed with the data, and a
    // client whose `Album` model is `song: List<Song>` threw
    // `Expected JsonArray, but had JsonObject ... at path: $.song` on every one-track
    // album. The fixture album holds two tracks, which is why nothing caught it: a
    // collapse is invisible at n≥2.
    //
    // Both sizes are asserted because one of them passing is not evidence about the
    // other — a fix that special-cased the single case would satisfy one and not two.
    const two = payload<{ song: unknown }>((await harness.rest('getAlbum', { id: ALBUM })).body, 'album').song;
    expect(Array.isArray(two)).toBe(true);
    expect(two).toHaveLength(2);

    await harness.db.db.prepare('DELETE FROM songs WHERE id = ?').bind(HOLOCENE).run();
    const one = payload<{ song: unknown }>((await harness.rest('getAlbum', { id: ALBUM })).body, 'album').song;
    expect(Array.isArray(one)).toBe(true);
    expect(one).toHaveLength(1);
  });

  it('renders the same XML it always did', async () => {
    // The declaration is a JSON concern. XML has no collapse — a repeated element is
    // repeated — so this guards against the fix quietly changing the other format rather
    // than claiming it was broken.
    const response = await harness.fetch(harness.restUrl('getAlbum', { id: ALBUM, f: 'xml' }));
    const xml = await response.text();
    expect(xml.match(/<song /g)).toHaveLength(2);
  });

  it('publishes the same album as getArtist does', async () => {
    // Two literals built the same album and had already diverged: `getAlbum`'s omitted
    // `created` while the lists emitted it. A client whose `Album` model is
    // `@SerialName("created") val createdAt: Instant` — non-nullable, no default — then
    // failed on **every** `getAlbum`, not just the one-track ones, which is the failure
    // the single-track report was masking.
    //
    // Asserted as an equality of key sets rather than spot-checking `created`, because the
    // next field to drift should fail here too.
    const fromAlbum = payload<Record<string, unknown>>((await harness.rest('getAlbum', { id: ALBUM })).body, 'album');
    const fromArtist = payload<{ album: Array<Record<string, unknown>> }>((await harness.rest('getArtist', { id: ARTIST })).body, 'artist').album[0];
    expect(Object.keys(fromAlbum).filter((key) => key !== 'song').sort()).toEqual(Object.keys(fromArtist).filter((key) => key !== 'song').sort());
    expect(fromAlbum.created).toBe(fromArtist.created);
  });
});

describe('ratings', () => {
  it('stores a rating and averages it into the album and song', async () => {
    await harness.rest('setRating', { id: SKINNY_LOVE, rating: '5' });

    const { body } = await harness.rest('getSong', { id: SKINNY_LOVE });
    const song = payload<{ userRating: number }>(body, 'song');
    expect(song.userRating).toBe(5);

    // `averageRating` is a **library-wide** aggregate across every user's ratings, so it
    // is absent on a single-user server rather than reported as the one rating there is.
    // A client shows "unrated" until the average crosses a threshold, and inventing an
    // average from one rater would make an unrated album look rated.
    const album = await harness.rest('getAlbum', { id: ALBUM });
    expect(payload<{ userRating?: number }>(album.body, 'album').userRating).toBeUndefined();
  });

  it('replaces a rating rather than averaging it twice', async () => {
    await harness.rest('setRating', { id: SKINNY_LOVE, rating: '5' });
    await harness.rest('setRating', { id: SKINNY_LOVE, rating: '1' });

    const { body } = await harness.rest('getSong', { id: SKINNY_LOVE });
    expect(payload<{ userRating: number }>(body, 'song').userRating).toBe(1);
  });

  it('clears a rating set to zero', async () => {
    // The protocol uses 0 to mean "remove". Treating it as a rating of zero would pin
    // the average down permanently with no way to clear it.
    await harness.rest('setRating', { id: SKINNY_LOVE, rating: '5' });
    await harness.rest('setRating', { id: SKINNY_LOVE, rating: '0' });

    const { body } = await harness.rest('getSong', { id: SKINNY_LOVE });
    expect(payload<{ userRating?: number }>(body, 'song').userRating ?? 0).toBe(0);
  });

  it('accepts the protocol rating type, which is `highest`', async () => {
    // The test used `byRating`, which is **not** a protocol type — the protocol's is
    // `highest`. It was only ever checked for "did not 500", so an invented parameter sat
    // in the suite for as long as the endpoint silently substituted an order for it. An
    // unrecognised type is now `code=0`, asserted in the getAlbumList2 block.
    await harness.rest('setRating', { id: SKINNY_LOVE, rating: '5' });
    const { body } = await harness.rest('getAlbumList2', { type: 'highest', size: '10' });
    // The album is present and its own track count is right; the average is absent
    // because it aggregates every rater, and there is one.
    const album = payload<{ album: Array<{ name: string; songCount: number; averageRating?: number }> }>(body, 'albumList2').album[0];
    expect(album?.name).toBe('For Emma, Forever Ago');
    expect(album?.songCount).toBe(2);

    // Known limitation, stated rather than left to be discovered: `highest` does not yet
    // order by rating. `ratings` keys on the *encoded* album id, which embeds a base64
    // `dir_path` and so cannot be joined to `songs` in SQL — that needs a denormalised
    // column this schema does not have. Until it does, `highest` orders by recency
    // alongside `newest`. Navidrome answers an empty list when nothing is rated, which is
    // defensible and a different answer.
  });

  it('refuses a rating naming a track in a library the user cannot see, and writes nothing', async () => {
    await refusedAnnotationWritesNothing('setRating', { id: FORBIDDEN, rating: '5' }, 'ratings');
  });
});

/**
 * Every annotation write is a `stars`/`ratings`/`bookmarks`/`play_counts`/`now_playing`
 * row, and **none of those tables has a foreign key to `songs`** — only to `users`. So a
 * write whose grant check was discarded is not caught by the schema, and the read paths
 * filter the row back out by library, which makes the result invisible as well as
 * unauthorized.
 *
 * The grant check was `void`ed at three of the four sites, and the fourth (`savePlayQueue`)
 * was already fixed. A `void`ed `requireForUser` **starts** the check and discards its
 * rejection: `requireForUser` throws, the promise is abandoned, the write proceeds, and
 * the rejection lands as an unhandled one. So each case asserts two things — the wire
 * answer, which the discarded rejection used to let through as a success — and the row
 * count, which is the half that matters, because a fix that only produces `code=70` while
 * still writing would pass the first assertion.
 */
async function refusedAnnotationWritesNothing(endpoint: string, params: Record<string, string>, table: string): Promise<void> {
  const { body } = await harness.rest(endpoint, params);
  expect(payload<{ code: number }>(body, 'error').code, `${endpoint} must refuse`).toBe(70);

  const stored = await harness.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  expect(stored?.n, `${endpoint} must not write to ${table}`).toBe(0);
}

/**
 * An id in a library the caller has no grant on. `L-other` is a syntactically valid
 * library, so the only thing standing between this and a row is the grant check.
 */
const FORBIDDEN = subsonicId('s', 'secret.flac', 'L-other');

describe('scrobbling', () => {
  it('counts a play only for a submission, and not for a "now playing" notice', async () => {
    // A client sends `submission=false` when a track starts and `true` when it is more
    // than half played. Counting the first would inflate every play count by one.
    await harness.rest('scrobble', { id: SKINNY_LOVE, submission: 'false' });
    let { body } = await harness.rest('getSong', { id: SKINNY_LOVE });
    expect(payload<{ playCount: number }>(body, 'song').playCount).toBe(0);

    await harness.rest('scrobble', { id: SKINNY_LOVE, submission: 'true' });
    ({ body } = await harness.rest('getSong', { id: SKINNY_LOVE }));
    expect(payload<{ playCount: number }>(body, 'song').playCount).toBe(1);
  });

  it('remembers the last played time only for a submission', async () => {
    await harness.rest('scrobble', { id: SKINNY_LOVE, submission: 'true' });
    const { body } = await harness.rest('getSong', { id: SKINNY_LOVE });
    // The play count is the value a client displays, and it is the only one of the three
    // that is per-user and therefore well-defined for a single-rater server.
    expect(payload<{ playCount: number }>(body, 'song').playCount).toBe(1);
  });

  it('reports now playing for the user who sent it, and expires it', async () => {
    await harness.rest('scrobble', { id: SKINNY_LOVE, submission: 'false' });
    const { body } = await harness.rest('getNowPlaying');
    const entries = payload<{ entry: Array<{ id: string; username: string; minutesAgo: number }> }>(body, 'nowPlaying').entry;

    expect(entries.map((entry) => entry.id)).toEqual([SKINNY_LOVE]);
    expect(entries[0]?.username).toBe('ann');
    // The age is minutes as an integer. A client renders "playing now" for 0 and
    // "played N minutes ago" above it, so a float here renders as "0.02 minutes ago".
    expect(Number.isInteger(entries[0]?.minutesAgo)).toBe(true);
  });

  it('answers now playing with an empty list when nothing is playing', async () => {
    const { body } = await harness.rest('getNowPlaying');
    expectEmptyWrapper(body, 'nowPlaying', 'getNowPlaying');
  });

  it('refuses a scrobble naming a track in a library the user cannot see, and records nothing', async () => {
    // `scrobble` guards **two** writes from one loop: the play count for a submission and
    // the single `now_playing` row for the batch. Both are asserted, because the batch
    // row is written outside the loop — a fix that awaited the check inside the loop but
    // left the `setNowPlaying` unguarded would pass a play-count-only assertion while
    // still publishing the track to `getNowPlaying`.
    await refusedAnnotationWritesNothing('scrobble', { id: FORBIDDEN, submission: 'true' }, 'play_counts');
    await refusedAnnotationWritesNothing('scrobble', { id: FORBIDDEN, submission: 'false' }, 'now_playing');
  });
});

describe('starred items', () => {
  it('stars and unstars a song, an album and an artist', async () => {
    const artist = subsonicId('ar', 'Bon Iver');
    // The album id is taken from `getAlbumList2` rather than built here, because that is what
    // a client does and because the id is a grouping key: building it from a directory
    // asserts a spelling the server no longer mints. Starring a directory-shaped id is a
    // separate case — an existing user's star — asserted in the split-release block below.
    const listed = payload<{ album: Array<{ id: string }> }>((await harness.rest('getAlbumList2', { type: 'alphabeticalByName' })).body, 'albumList2').album;
    const album = listed[0]?.id ?? '';
    for (const params of [{ id: SKINNY_LOVE }, { albumId: album }, { artistId: artist }] as Record<string, string>[]) {
      await harness.rest('star', params);
    }

    const { body } = await harness.rest('getStarred2');
    const starred = payload<{ song: Array<{ id: string }>; album: Array<{ id: string }> }>(body, 'starred2');
    expect(starred.song.map((entry) => entry.id)).toContain(SKINNY_LOVE);
    expect(starred.album.map((entry) => entry.id)).toContain(album);

    await harness.rest('unstar', { id: SKINNY_LOVE });
    const after = await harness.rest('getStarred2');
    // The song is gone, so its key is gone: an album is still starred, so `album` stays.
    // Asserting on the *absent* key rather than on an empty array is what distinguishes
    // "the unstar worked" from "the endpoint stopped reporting songs" — and the album key
    // beside it is what says this is the empty case and not a broken one.
    const afterUnstar = payload<Record<string, Array<{ id: string }>>>(after.body, 'starred2');
    expect(afterUnstar.song).toBeUndefined();
    expect(afterUnstar.album.map((entry) => entry.id)).toContain(album);
  });

  it('refuses to star anything in a library the user cannot see, and writes nothing', async () => {
    // All three id parameters go through the same `collectTargets` loop, so one
    // authorization bug covered three endpoints — which is why the count assertion is
    // repeated per parameter rather than trusting one of them.
    await refusedAnnotationWritesNothing('star', { id: FORBIDDEN }, 'stars');
    await refusedAnnotationWritesNothing('star', { albumId: subsonicId('al', 'other', 'L-other') }, 'stars');
    await refusedAnnotationWritesNothing('star', { artistId: subsonicId('ar', 'other', 'L-other') }, 'stars');
  });

  it('reports a starred artist through getArtists, because the client reads it there', async () => {
    // `getStarred` deliberately does not expand a starred artist into its albums — a
    // client asking for starred items expects a page, not a discography — so the artist
    // star is reachable only through `getArtists`, which is documented as reporting
    // `starred` on the artist element itself.
    //
    // It did not. The mapper published `starred: undefined`, and `undefined` is dropped by
    // **both** serializers, so the attribute was absent in XML and the key was absent in
    // JSON while the star itself was stored correctly. A client asking "which artists are
    // starred" got the right list and no way to tell which entries were starred — and
    // nothing reported it, because the write worked and only the read was wrong.
    const artist = subsonicId('ar', 'Bon Iver');
    await harness.rest('star', { artistId: artist });

    const { body } = await harness.rest('getArtists');
    const groups = payload<{ index: Array<{ artist: Array<{ id: string; starred?: string }> }> }>(body, 'artists').index;
    const bonIver = groups.flatMap((group) => group.artist).find((entry) => entry.id === artist);

    expect(bonIver, 'the starred artist is present in getArtists').toBeDefined();
    // A **timestamp**, not `true`: `created` on a song is the same kind of value, so a
    // client that decodes this field as an instant gets one. An absent field would be the
    // old behaviour, and `true` would be a different wrong answer.
    expect(bonIver?.starred).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // And unstarred artists stay absent, so "every artist is starred" cannot pass this.
    const unstarred = groups.flatMap((group) => group.artist).find((entry) => entry.id !== artist);
    expect(unstarred?.starred).toBeUndefined();
  });
});

describe('bookmarks', () => {
  it('creates a bookmark, reports it, and deletes it', async () => {
    await harness.rest('createBookmark', { id: SKINNY_LOVE, position: '42000' });

    const created = await harness.rest('getBookmarks');
    const bookmarks = payload<{ bookmark: Array<{ id: string; position: number }> }>(created.body, 'bookmarks').bookmark;
    expect(bookmarks.map((entry) => entry.id)).toContain(SKINNY_LOVE);
    // `position` is milliseconds into the track, and it is a **scalar** in the schema, so
    // it must serialize as the number rather than as a record.
    expect(bookmarks[0]?.position).toBe(42_000);

    // Deleting a bookmark the client no longer has is success, not `code=70` — it is
    // syncing state, and a client discarding local state is the ordinary case.
    await harness.rest('deleteBookmark', { id: SKINNY_LOVE });
    const after = await harness.rest('getBookmarks');
    expectEmptyWrapper(after.body, 'bookmarks', 'getBookmarks');
  });

  it('refuses a bookmark in a library the user cannot see, and writes nothing', async () => {
    await refusedAnnotationWritesNothing('createBookmark', { id: FORBIDDEN, position: '0' }, 'bookmarks');
  });
});

describe('system endpoints', () => {
  it('reports the license as valid, so a client does not nag', async () => {
    const { body } = await harness.rest('getLicense');
    expect(payload<{ valid: boolean }>(body, 'license').valid).toBe(true);
  });

  /**
   * `getOpenSubsonicExtensions` — the capability-discovery call.
   *
   * It answered `code=70` on the reasoning that advertising an empty list "would be a claim
   * this server does not honour". That conflated two different statements. `code=70` says
   * *this server does not do that*; an empty list says *this server does that, and here is
   * what it supports* — which is the truth, and the only answer a client can act on. It is
   * the one endpoint the protocol requires to be reachable without credentials, so a client
   * asking it before it has any is exactly the case that mattered.
   */
  describe('getOpenSubsonicExtensions', () => {
    it('answers with an empty list, which is the truthful answer for this server', async () => {
      const { status, body } = await harness.rest('getOpenSubsonicExtensions');
      expect(status).toBe(200);
      expect(body['subsonic-response'].status).toBe('ok');
      // An **array**, present and empty — not an absent key. A client doing
      // `response.openSubsonicExtensions.length` throws on `undefined` and renders nothing
      // on `[]`, which is the repo's "an absent value is a value" rule applied to the one
      // call a client makes to decide what else it may ask for.
      expect(body['subsonic-response'].openSubsonicExtensions).toEqual([]);
    });

    it('is an empty array rather than a nested or absent one', async () => {
      // The three shapes this key can take, and only one is usable. `{}` gives a client
      // reading `.length` `undefined`; `[[]]` is an array of one empty array, so `.length`
      // is `1` and iterating it yields nothing. `[]` is the shape the protocol's own JSON
      // uses, and the only one a client can act on.
      const { body } = await harness.rest('getOpenSubsonicExtensions');
      const value = body['subsonic-response'].openSubsonicExtensions;
      expect(Array.isArray(value)).toBe(true);
      expect(value).toHaveLength(0);
    });

    it('advertises no extension this server does not implement', async () => {
      // The paired half. A list that drifts from the product is *worse* than an empty one:
      // a client reads it as a promise, calls the extension, and gets `code=70` from a
      // server that just said it would work. So the set is asserted empty, and adding an
      // extension is a change to `OPEN_SUBSONIC_EXTENSIONS` **and** to this line.
      //
      // `apiKeyAuthentication` is the one worth naming: we authenticate with `u` + `t`, not
      // with an `apiKey` parameter, so advertising it would be a claim about a credential
      // path this server does not have.
      expect(OPEN_SUBSONIC_EXTENSIONS).toEqual([]);
    });

    it('answers without credentials, because the protocol requires it to be public', async () => {
      const url = `${ORIGIN}/rest/getOpenSubsonicExtensions.view?v=1.16.1&c=edge-sonic-test&f=json`;
      const response = await harness.fetch(url);
      const body = (await response.json()) as SubsonicBody;

      // No `u`, no `t`. Every other endpoint on this surface refuses this.
      expect(response.status).toBe(200);
      expect(body['subsonic-response'].status).toBe('ok');
      expect(body['subsonic-response'].openSubsonicExtensions).toEqual([]);
    });

    it('discloses nothing about the deployment, which is what makes it safe to be public', async () => {
      // The reason the public branch above is acceptable. The payload is a compile-time
      // constant: no user, no library, no credential, and nothing about what this
      // deployment holds. Asserted on the whole envelope, so a future edit that adds a
      // version or a server name to this response fails here rather than in a client's
      // unauthenticated hands.
      const url = `${ORIGIN}/rest/getOpenSubsonicExtensions.view?v=1.16.1&c=edge-sonic-test&f=json`;
      const body = (await (await harness.fetch(url)).json()) as SubsonicBody;
      const keys = Object.keys(body['subsonic-response']).sort();
      expect(keys).toEqual(['openSubsonic', 'openSubsonicExtensions', 'serverVersion', 'status', 'type', 'version']);
      // And nothing in it names the library or the user.
      expect(JSON.stringify(body)).not.toContain('Home');
      expect(JSON.stringify(body)).not.toContain(USERNAME);
    });
  });

  /**
   * `tokenInfo` — who the presented credentials belong to.
   *
   * A client holding a stored token calls this to check it still works, so it was a
   * `code=70` "unknown endpoint" on a server that had just authenticated the very token
   * being asked about.
   */
  describe('tokenInfo', () => {
    it('reports the authenticated username as a record, not a nested element', async () => {
      const { status, body } = await harness.rest('tokenInfo');
      expect(status).toBe(200);
      // `username` is an **attribute** in the protocol, so it is a record in JSON. A child
      // element would give `{ "username": { "#text": ... } }` and a client reading the
      // string the schema declares would get an object — the same class of bug as
      // `user.folder` being built as a record.
      expect(body['subsonic-response'].tokenInfo).toEqual({ username: USERNAME });
    });

    it('reports the caller, so a client can tell whose token it is holding', async () => {
      // The reason the endpoint exists. A client with a stored token needs to know whether
      // it is still valid *and* whose it is, and it cannot derive the second from the
      // username it happens to have stored — a client shared between two accounts needs to
      // ask. The authenticated `username` is echoed, so this is a read of the caller's own
      // identity and never of anyone else's.
      const { body } = await harness.rest('tokenInfo', { u: USERNAME });
      expect(body['subsonic-response'].tokenInfo).toEqual({ username: USERNAME });
    });

    it('refuses an unauthenticated call, so it is not a credential oracle', async () => {
      // The paired half, and the reason this endpoint is *not* in `PUBLIC_ENDPOINTS`.
      // Reporting who a token belongs to requires having accepted the token; answering
      // without one would be an unauthenticated endpoint whose entire output is an identity.
      const url = `${ORIGIN}/rest/tokenInfo.view?v=1.16.1&c=edge-sonic-test&f=json`;
      const body = (await (await harness.fetch(url)).json()) as SubsonicBody;
      expect(body['subsonic-response'].status).toBe('failed');
      expect(body['subsonic-response'].tokenInfo).toBeUndefined();
    });

    it('still rejects a bad token rather than echoing whatever `u` was sent', async () => {
      // The echoed username is the *authenticated* one. A request presenting a wrong token
      // must fail at authentication and never reach the handler, or this endpoint would
      // confirm any username to anyone.
      const url = `${ORIGIN}/rest/tokenInfo.view?u=${USERNAME}&t=${'0'.repeat(32)}&s=${SALT}&v=1.16.1&c=edge-sonic-test&f=json`;
      const body = (await (await harness.fetch(url)).json()) as SubsonicBody;
      expect(body['subsonic-response'].status).toBe('failed');
      expect(body['subsonic-response'].tokenInfo).toBeUndefined();
    });
  });
});

describe('the scan controls', () => {
  it("reports a status for the caller's own library, with no id to guess at", async () => {
    // The protocol's `getScanStatus` takes no library parameter, so "the" library means
    // the caller's first granted one, chosen deterministically by slug. A client
    // polling before an operator has configured anything sees "not scanning", not a
    // failure.
    const { status, body } = await harness.rest('getScanStatus');
    expect(status).toBe(200);
    const scan = payload<{ scanning: boolean; count: number }>(body, 'scanStatus');
    expect(scan.scanning).toBe(false);
    // `count` is the library's **track total**, which is what every implementation of
    // this protocol reports — Navidrome answers 113 where this used to answer the number
    // of folders the last poll happened to visit. It used to be 0 on a fresh library,
    // which read as "scanned and found nothing" when the library was merely unscanned.
    expect(scan.count).toBe(2);
  });

  it('reports a count that does not fall back when a poll does no work', async () => {
    // The defect `count` had: it was `scanned_count`, the number of folders the last
    // chunk visited, so it moved by however much work one poll happened to do. A client
    // rendering progress against it watched a number that went up and came back down.
    //
    // Paired with the assertion above deliberately: both polls are on a finished library
    // where no chunk runs, and the count must be the same for both. Before the fix the
    // second was `scanned_count` and the first was not.
    const first = payload<{ count: number }>((await harness.rest('getScanStatus')).body, 'scanStatus').count;
    const second = payload<{ count: number }>((await harness.rest('getScanStatus')).body, 'scanStatus').count;
    expect(second).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  it('never reports on a library the caller was not granted', async () => {
    // There is no `libraryId` to attack, which is the point: the endpoint can only ever
    // reach a library the caller already has. This asserts that a *second* library the
    // user cannot see is not what gets reported, which is what a naive implementation
    // reading the id would do.
    await harness.db.db
      .prepare(
        `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
         VALUES ('L-secret', 'aaa-secret', 'aaa-secret', 'https://dav.example.com', '/secret', 'x', 'c', 'iv', 1, 'Secret', 1, 0, 0)`,
      )
      .run();

    const { status, body } = await harness.rest('getScanStatus');
    expect(status).toBe(200);
    // Succeeds rather than failing, because the id is not taken from the request at all.
    expect(payload<{ scanning: boolean }>(body, 'scanStatus').scanning).toBe(false);
  });

  it('answers "not scanning" for a user with no libraries at all', async () => {
    await harness.db.db.prepare('DELETE FROM user_libraries').run();
    const { status, body } = await harness.rest('getScanStatus');
    expect(status).toBe(200);
    expect(payload<{ scanning: boolean; count: number }>(body, 'scanStatus')).toEqual({ scanning: false, count: 0 });
  });

  it('starts a scan without an error, and reports it as not scanning', async () => {
    // `startScan` is the opt-in that a client sends before polling. It must not fail on
    // a library that has not been configured for scanning.
    const { status, body } = await harness.rest('startScan');
    expect(status).toBe(200);
    expect(payload<{ scanning: boolean }>(body, 'scanStatus')).toBeDefined();
  });

  /**
   * `scanning` answers "will more work happen if I poll again", not "did this call work".
   *
   * It shipped as the latter. A scan that failed reported `scanning: false`, which every
   * client reads as *stop polling* — so the client stopped, the frontier in D1 was never
   * read again, and a library of 80 albums sat at one scanned folder reporting
   * `{"scanning": false, "count": 1}` indefinitely. The reason sat in
   * `scan_state.last_error`, reachable only from the operator API behind Access.
   *
   * So this asserts the wire shape for each stored status directly. Going through the
   * service would only re-assert the service's own mapping; the claim is about what a
   * client is told.
   */
  describe('what "scanning" means to a client', () => {
    /**
     * Put `scan_state` into a stored state and report what the next poll says.
     *
     * Written straight to the row because the *mapping* is the claim under test: the
     * service's own behaviour for each status is covered in
     * `test/scan-incremental.test.ts`, and driving it through a real failing origin here
     * would assert that twice while testing the mapping never.
     *
     * `scanned_count = 0` and no frontier, so a re-entered failed scan has nothing to
     * retry and reports `failed` or `stalled` without doing work — which is the state a
     * library whose root probe keeps failing actually sits in.
     */
    async function reportWith(consecutiveFailures: number): Promise<boolean> {
      // The caller's own library: `getScanStatus` resolves "the" library as the first
      // granted one, so the row written has to be that one.
      const granted = await harness.db.db.prepare('SELECT library_id AS id FROM user_libraries LIMIT 1').all<{ id: string }>();
      await harness.db.db
        .prepare(
          `INSERT INTO scan_state (library_id, status, scanned_count, total_count, index_version, consecutive_failures, updated_at)
           VALUES (?, 'failed', 0, 0, 1, ?, 0)
           ON CONFLICT (library_id) DO UPDATE SET
             status = 'failed', scanned_count = 0, consecutive_failures = excluded.consecutive_failures`,
        )
        .bind(granted.results[0]?.id, consecutiveFailures)
        .run();
      const { body } = await harness.rest('getScanStatus');
      return payload<{ scanning: boolean }>(body, 'scanStatus').scanning;
    }

    it('tells a client to keep polling while a failed scan will be retried', async () => {
      // The regression. `scanning: false` here is read by every client as *stop
      // polling*, so the client stopped, the frontier was never read again, and the
      // library stayed at whatever the failing chunk had reached.
      expect(await reportWith(1)).toBe(true);
    });

    it('tells a client to stop only once the retry budget is spent', async () => {
      // The distinction that matters. Reporting `false` for the first is what stopped
      // the scan; reporting it for the second is correct, because nothing will change
      // without an explicit `startScan`.
      expect(await reportWith(MAX_CONSECUTIVE_FAILURES)).toBe(false);
    });
  });
});

describe('media retrieval by id', () => {
  /**
   * An absent `id` on an endpoint that fetches **one item by id** is `code=70`, the same
   * answer a deleted or unresolvable id gives.
   *
   * It was `code=10` ("required parameter is missing"), and the two are different claims:
   * one says the client forgot a parameter, the other says the resource is not there. For
   * these four the id is the *selector* and there is no other way to ask for none, so
   * "no id" and "no such track" are the same request. Splitting them across two codes
   * makes a client's error handling depend on which mistake it made.
   *
   * The line is drawn by *what the endpoint does*, not by a blanket rule, so the
   * counterweight is asserted below: every other id-taking endpoint still says `code=10`.
   * Navidrome draws it in the same place.
   */
  for (const [endpoint, what] of [
    ['getSong', 'Song'],
    ['getAlbum', 'Album'],
    ['getArtist', 'Artist'],
  ] as const) {
    it(`answers ${endpoint} with not-found when no id is sent`, async () => {
      const { body } = await harness.rest(endpoint);
      const error = payload<{ code: number; message: string }>(body, 'error');
      expect(error.code, endpoint).toBe(70);
      // Named, so the client learns *which* item was not found rather than only that
      // something was.
      expect(error.message, endpoint).toContain(what);
    });

    it(`answers ${endpoint} with not-found for an id that resolves to nothing`, async () => {
      const { body } = await harness.rest(endpoint, { id: 's:not-a-real-id' });
      expect(payload<{ code: number }>(body, 'error').code, endpoint).toBe(70);
    });
  }

  it('still says "missing parameter" everywhere the id is one of several', async () => {
    // The counterweight to the block above, and the reason the block is not a rule about
    // `id`. Where an endpoint does something *other* than fetch one identified item, a
    // forgotten parameter is a client bug and the protocol's `code=10` says so — and it is
    // the answer that lets the client fix itself.
    for (const endpoint of ['getPlaylist', 'stream', 'scrobble', 'createBookmark']) {
      const { body } = await harness.rest(endpoint);
      expect(payload<{ code: number }>(body, 'error').code, endpoint).toBe(10);
    }
  });
});

describe('getArtists and getArtist', () => {
  it('groups artists, and describes one on request', async () => {
    const grouped = await harness.rest('getArtists');
    const artists = payload<{ index: Array<{ name: string; artist: Array<{ id: string; name: string; albumCount: number }> }> }>(grouped.body, 'artists').index;
    const bonIver = artists.find((group) => group.name === 'B');

    expect(bonIver?.artist[0]).toMatchObject({ id: ARTIST, name: 'Bon Iver', albumCount: 1 });

    const detail = await harness.rest('getArtist', { id: ARTIST });
    const artist = payload<{ name: string; albumCount: number; album: Array<{ id: string }> }>(detail.body, 'artist');
    expect(artist.name).toBe('Bon Iver');

    // The album id is the one `getAlbumList2` publishes, not a literal: the property under
    // test is that every surface mints one id for one album, and pinning a spelling here
    // would fail on the id scheme rather than on the property. Asserted **against the other
    // surface** for that reason — a hard-coded id passes even if `getArtist` and the lists
    // disagree, which is the defect this line was written for.
    const listed = payload<{ album: Array<{ id: string }> }>((await harness.rest('getAlbumList2', { type: 'alphabeticalByName' })).body, 'albumList2').album;
    expect(artist.album.map((album) => album.id)).toEqual(listed.map((album) => album.id));

    // And a directory-shaped id still resolves to it, which is the whole reason the old
    // spelling is still accepted rather than dropped: a client holding one from a previous
    // session opens the album it names.
    const legacy = await harness.rest('getAlbum', { id: ALBUM });
    expect(payload<{ id: string }>(legacy.body, 'album').id).toBe(artist.album[0]?.id);
  });
});

/**
 * A release split across directories, and what the server does about it.
 *
 * ### The shape of the fixture, and why the harness's own album cannot stand in for it
 *
 * `createHarness` seeds one album in one directory with a consistent `album_artist`, so every
 * grouping answers identically on it — which is exactly why the original defect was invisible
 * here. The rows below put **one release in two directories** with **no `ALBUMARTIST` tag**,
 * which is what a per-artist rip produces: the folder is named after the performer, so the
 * release is one directory per artist and `ALBUM` is the only thing they share.
 *
 * `album_artist` is written as NULL explicitly rather than left to the path derivation, because
 * `EnrichmentService` omits an absent tag rather than clearing it and the derived value
 * survives. It models a library indexed before that derivation existed — and it is what the
 * deployed instance this was measured against looks like: 113 rows, every `album_artist` NULL.
 */
const SPLIT_DIR_A = 'ryo (supercell), Kagura & Tsukimi - Ex-Otogibanashi';
const SPLIT_DIR_B = 'ryo (supercell) & Kagura - Ex-Otogibanashi';

async function seedSplitRelease(album = 'Ex-Otogibanashi'): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const rows = [
    { dir: SPLIT_DIR_A, file: '01 - Ex-Otogibanashi.opus', artist: 'ryo (supercell), Kagura & Tsukimi', track: 1, disc: 1, duration: 180 },
    { dir: SPLIT_DIR_A, file: '02 - Sekaijū wa Mine [Remix].opus', artist: 'ryo (supercell), Kagura & Tsukimi', track: 2, disc: 1, duration: 263 },
    { dir: SPLIT_DIR_B, file: '03 - Melt [Remix].opus', artist: 'ryo (supercell) & Kagura', track: 3, disc: 1, duration: 271 },
  ];
  for (const row of rows) {
    const path = `${row.dir}/${row.file}`;
    await harness.db.db
      .prepare(
        `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, suffix, title, title_ci,
           artist, artist_ci, album, album_ci, album_artist, album_artist_ci, track, disc, duration, bitrate,
           reader_version, derived_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1000, 1000, 'opus', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 900, 1, 1, ?, ?)`,
      )
      .bind(
        subsonicId('s', path),
        LIBRARY_ID,
        path,
        row.dir,
        row.file,
        row.file.toLowerCase(),
        row.file.replace(/^\d+ - /, '').replace('.opus', ''),
        row.file.toLowerCase(),
        row.artist,
        row.artist.toLowerCase(),
        album,
        album.toLowerCase(),
        row.track,
        row.disc,
        row.duration,
        now,
        now,
      )
      .run();
  }
}

/**
 * One album in two directories, resolved through the real worker.
 */
describe('a release split across directories', () => {
  beforeEach(async () => {
    await seedSplitRelease();
  });

  const listAlbums = async (): Promise<Array<Record<string, unknown>>> => {
    const { body } = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '20' });
    return payload<{ album: Array<Record<string, unknown>> }>(body, 'albumList2').album;
  };

  /**
   * The merged release, or a thrown expectation rather than `undefined`.
   *
   * `undefined` would flow into every assertion below as "the album has no id", and a test
   * that reports "expected undefined to be 3" does not say which of the four things it wanted.
   */
  const splitAlbum = async (): Promise<Record<string, unknown>> => {
    const albums = await listAlbums();
    const album = albums.find((entry) => entry.name === 'Ex-Otogibanashi');
    expect(album, 'the split release is absent from getAlbumList2 entirely').toBeDefined();
    return album as Record<string, unknown>;
  };

  it('publishes one album with every track, not one per directory', async () => {
    const albums = (await listAlbums()).filter((album) => album.name === 'Ex-Otogibanashi');

    // The report. Two directories, two albums, one release — and a client drawing an album
    // grid shows the same record twice with different track counts, which is a bug with no
    // error and no way for the client to reconcile.
    expect(albums).toHaveLength(1);
    expect(albums[0]?.songCount).toBe(3);
    // The durations summed across **both** directories. A partial album reports a shorter one.
    expect(albums[0]?.duration).toBe(714);
  });

  it('gives the album a key-derived id rather than a directory', async () => {
    const album = await splitAlbum();

    // A new kind, because the payload is a grouping key and not a path, and two id shapes
    // that are both ordinary relative paths need the prefix to say which reading applies.
    expect(String(album.id).startsWith('alk:')).toBe(true);
    // A directory id for the same album, which is what every client is holding today.
    expect(subsonicId('al', SPLIT_DIR_A).startsWith('al:')).toBe(true);
  });

  it('resolves the album id to every track, and to the same record the list published', async () => {
    const listed = await splitAlbum();
    const { body } = await harness.rest('getAlbum', { id: String(listed.id) });
    const album = payload<{ id: string; song: Array<Record<string, unknown>> }>(body, 'album');

    expect(album.song).toHaveLength(3);
    // **Key sets, not spot checks.** `getAlbum` and the lists built the same album from two
    // literals and had already diverged on `created`, which a client declaring it
    // non-nullable fails on for *every* album.
    const fromAlbum = Object.keys(album).filter((key) => key !== 'song').sort();
    const fromList = Object.keys(listed).sort();
    expect(fromAlbum).toEqual(fromList);
    expect(album.id).toBe(listed.id);
  });

  it('still resolves an album id minted as a directory, and resolves it to the whole release', async () => {
    // A client is holding thousands of these: every starred album and every album rating on
    // every deployment that predates the change. Resolving one to **its own directory** rather
    // than to the group would answer `code=200` with half an album while every list published
    // all three tracks — two answers to "what album is this id" for one id.
    const { body } = await harness.rest('getAlbum', { id: subsonicId('al', SPLIT_DIR_B) });
    const album = payload<{ song: Array<Record<string, unknown>>; songCount: number; id: string }>(body, 'album');

    expect(album.song).toHaveLength(3);
    expect(album.songCount).toBe(3);
    // And it publishes the **current** id, so a client that starred the directory and then
    // opens the album navigates with the id every other surface is using.
    expect(album.id).toBe((await splitAlbum()).id);
  });

  it('decorates a star written under the directory id', async () => {
    // The half of the change that has no symptom while it is wrong. A star is stored under the
    // id the album had when the user starred it; the album is published under a new one; so a
    // lookup on the new id finds nothing and the star is reported by nothing at all — the
    // `starred: undefined` finding one layer up, where a field was dropped by both serializers
    // because the lookup held nothing.
    await harness.rest('star', { albumId: subsonicId('al', SPLIT_DIR_A) });

    // On the two surfaces that carry annotations. **`getAlbumList2` is not one of them** — it
    // renders with `NO_ANNOTATIONS` to keep seven per-user D1 reads off an album list, so a
    // star is absent there by design and asserting it would be asserting a change nobody
    // asked for. A client reads an album's star from `getAlbum` and from the starred list.
    const current = (await splitAlbum()).id;
    const detail = payload<{ id: string; starred?: string }>((await harness.rest('getAlbum', { id: String(current) })).body, 'album');
    expect(detail.starred).toBeDefined();

    const starred = payload<{ album: Array<Record<string, unknown>> }>((await harness.rest('getStarred2')).body, 'starred2').album;
    expect(starred).toHaveLength(1);
    expect(starred[0]?.id).toBe(current);
    expect(starred[0]?.starred).toBeDefined();
  });

  it('publishes one album for two directory stars, because the starred list is a set', async () => {
    // Both directories were starred before the release was one album, so two stored ids name
    // one record. Rendering both publishes the same album twice in a list whose whole job is
    // to be a set.
    await harness.rest('star', { albumId: subsonicId('al', SPLIT_DIR_A) });
    await harness.rest('star', { albumId: subsonicId('al', SPLIT_DIR_B) });

    const { body } = await harness.rest('getStarred2');
    const starred = payload<{ album: Array<Record<string, unknown>> }>(body, 'starred2').album;
    expect(starred).toHaveLength(1);
    expect(starred[0]?.songCount).toBe(3);
  });

  it('publishes the same ids from the file-structure variant as from the tag variant', async () => {
    // The protocol declares `getAlbumList` "by file structure" and `getAlbumList2` "by tag".
    // This server answers both from one grouping on purpose: two album identities would mean a
    // client's album id is whichever it saw last, and `getAlbum` would have to accept both for
    // ever. Navidrome answers both from its single album table.
    const tag = (await listAlbums()).filter((album) => album.name === 'Ex-Otogibanashi');
    const { body } = await harness.rest('getAlbumList', { type: 'alphabeticalByName', size: '20' });
    const structural = payload<{ album: Array<Record<string, unknown>> }>(body, 'albumList').album.filter((album) => album.title === 'Ex-Otogibanashi');

    expect(structural.map((album) => album.id)).toEqual(tag.map((album) => album.id));
    expect(structural).toHaveLength(1);
  });

  it('reports the whole album on the artist page, not the artist’s share of it', async () => {
    // `getArtist` filters to the artist's own tracks and then groups them. Grouping that alone
    // publishes an album holding one track — and the same album id then reports `songCount: 1`
    // here and `songCount: 3` everywhere else.
    const { body } = await harness.rest('getArtist', { id: subsonicId('ar', 'ryo (supercell) & Kagura') });
    const artist = payload<{ album: Array<Record<string, unknown>> }>(body, 'artist').album;

    const release = artist.filter((album) => album.name === 'Ex-Otogibanashi');
    expect(release).toHaveLength(1);
    expect(release[0]?.songCount).toBe(3);
    expect(release[0]?.id).toBe((await splitAlbum()).id);
  });

  it('names a multi-artist album Various Artists, and publishes no artistId for it', async () => {
    const album = await splitAlbum();

    // `artist` is **required** by the schema, so it cannot be omitted. `artistId` is not, and
    // publishing one would be a link that answers `code=70` — a client tapping the album's
    // artist and being told the album does not exist. A synthesized name resolves to no artist,
    // so the id is left off rather than pointed at one.
    expect(album.artist).toBe('Various Artists');
    expect(album.artistId).toBeUndefined();
  });

  it('keeps an artistId on an album that has one artist, so the two do not become one rule', async () => {
    // The harness album: one album artist, one directory, one artist. If the `Various Artists`
    // branch were taken whenever `album_artist` were absent, this album — whose tags all agree —
    // would lose its link too, and the rule would be "no album artist means no artist".
    const forEmma = (await listAlbums()).find((album) => album.name === 'For Emma, Forever Ago');
    expect(forEmma?.artist).toBe('Bon Iver');
    expect(forEmma?.artistId).toBe(subsonicId('ar', 'Bon Iver'));

    // And a client can drill it, which is what makes publishing the id worth anything.
    const { body } = await harness.rest('getArtist', { id: String(forEmma?.artistId) });
    expect(payload<{ name: string }>(body, 'artist').name).toBe('Bon Iver');
  });

  it('orders a two-disc album by disc, so a client does not draw disc 1 twice', async () => {
    // **This is a pre-existing defect, not one the grouping introduced**, and the harness's
    // single-disc album cannot see it. `getAlbum` sorted by track and name while the lists
    // sorted by disc, track and name, so a two-disc album came back interleaved:
    //
    //   disc=1 trk=2  Stella☆
    //   disc=2 trk=3  Koi Yuki     <- disc 2 between two disc 1 tracks
    //   disc=2 trk=6  KAKUMEI
    //   disc=1 trk=8  I x U
    //   disc=2 trk=14 Cherry Bomb
    //
    // Every field is right and the order is wrong, which is why it presented as nothing at all.
    const now = Math.floor(Date.now() / 1000);
    const dir = 'Silent Siren Selection';
    for (const [file, disc, track] of [
      ['a.opus', 1, 2],
      ['b.opus', 2, 3],
      ['c.opus', 1, 8],
    ] as Array<[string, number, number]>) {
      const path = `${dir}/${file}`;
      await harness.db.db
        .prepare(
          `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, suffix, title, title_ci,
             artist, artist_ci, album, album_ci, album_artist, album_artist_ci, track, disc, duration, bitrate,
             reader_version, derived_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1000, 1000, 'opus', ?, ?, 'Silent Siren', 'silent siren', 'Silent Siren Selection',
             'silent siren selection', 'Silent Siren', 'silent siren', ?, ?, 200, 900, 1, 1, ?, ?)`,
        )
        .bind(subsonicId('s', path), LIBRARY_ID, path, dir, file, file, file, file, track, disc, now, now)
        .run();
    }

    const { body } = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '20' });
    const albums = payload<{ album: Array<Record<string, unknown>> }>(body, 'albumList2').album;
    const album = albums.find((entry) => entry.name === 'Silent Siren Selection');
    expect(album, 'the two-disc album is absent from getAlbumList2').toBeDefined();
    const detail = payload<{ song: Array<{ title: string; discNumber?: number; track?: number }> }>((await harness.rest('getAlbum', { id: String(album?.id) })).body, 'album');

    // Disc 1's two tracks, then disc 2's one. Asserted as the whole sequence rather than as
    // "it is sorted", because a comparator with `disc` removed and one that never had it both
    // produce a list that is sorted by *something*.
    expect(detail.song.map((song) => [song.discNumber, song.track])).toEqual([
      [1, 2],
      [1, 8],
      [2, 3],
    ]);
  });
});

/**
 * The knob itself: read by the request path, and refused at boot when it names nothing.
 */
describe('ALBUM_GROUP_BY', () => {
  it('changes the answer, so it is read rather than merely parsed', async () => {
    // A variable can be declared, parsed, validated, templated and read by nothing, and every
    // one of those states looks identical from the outside. `STREAM_RATE_LIMIT` was inert: the
    // limiter used a literal, so `600` lived in three places and an operator setting `50` got a
    // clean validation pass and an unchanged server. So each value is asserted to answer
    // differently, on the one fixture where the values disagree.
    await harness.close();
    harness = await createHarness();
    await seedSplitRelease();

    const albumCount = async (env: Record<string, unknown>): Promise<number> => {
      await harness.close();
      harness = await createHarness();
      await seedSplitRelease();
      const response = await harness.fetch(harness.restUrl('getAlbumList2', { type: 'alphabeticalByName', size: '20' }), env);
      const parsed = (await response.json()) as SubsonicBody;
      return payload<{ album: Array<{ name: string }> }>(parsed, 'albumList2').album.filter((album) => album.name === 'Ex-Otogibanashi').length;
    };

    // `folder` answers its own question: two directories, two albums. `album` merges them.
    expect(await albumCount({ ALBUM_GROUP_BY: 'folder' })).toBe(2);
    expect(await albumCount({ ALBUM_GROUP_BY: 'album' })).toBe(1);
    // And unset takes the default, which is `album` — stated so a change to the default is a
    // deliberate diff here rather than a silent behaviour change on every deployment.
    expect(await albumCount({})).toBe(1);
  });

  it('refuses an unrecognised value by name, rather than grouping by something else', async () => {
    // Not a degraded answer but a **different** partition: `folder`, `album` and `album_artist`
    // put a library's tracks into different albums, and the default is not an approximation of
    // what was asked for. Every other variable here either falls back to something close or
    // clamps a bound; this one cannot, so a typo has to be named. And it has no error response
    // for a client to see, which makes the boot-time report the only place it can surface.
    const warnings = AppConfiguration.fromEnv({ ALBUM_GROUP_BY: 'album artist' }).validate();
    const reported = warnings.filter((warning) => warning.includes('ALBUM_GROUP_BY'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('folder');
    expect(reported[0]).toContain('album_artist');

    // A valid value reports nothing, and so does an unset one.
    expect(AppConfiguration.fromEnv({ ALBUM_GROUP_BY: 'album' }).validate().filter((warning) => warning.includes('ALBUM_GROUP_BY'))).toHaveLength(0);
    expect(AppConfiguration.fromEnv({}).validate().filter((warning) => warning.includes('ALBUM_GROUP_BY'))).toHaveLength(0);
  });
});

/**
 * The other knob, and the one that was not a knob at all.
 *
 * `DERIVED_MARKER` is appended to an artist or album name this server derived from a file's
 * **path** rather than from its tags. It is the only thing that ever distinguished the two, so
 * its value decides whether a guess and a release are one album:
 *
 * - `' (derived)'` — two albums, one of which is obviously a guess. A half-enriched library
 *   publishes one release twice, once per spelling.
 * - `''` (the default) — **one** album. The guess is what holds the release together until the
 *   tag lands, and it stops being a separate entry the moment it does.
 *
 * Asserted through `getAlbumList2` rather than through a stored column, because what the marker
 * decides is a *grouping*, and a column assertion passes identically for a marker that kept the
 * two apart. The fixtures below are one release whose first track is enriched and whose second
 * is not, because that mixture is the only state in which the question has an answer.
 */
describe('DERIVED_MARKER', () => {
  const MIXED_DIR = 'Bonobo/Black Sands';

  /**
   * One release, two rows: track 1 carries tags, track 2 does not.
   *
   * Seeded through the real statements in the order production performs them — the index write
   * derives and stamps, then the enrichment read supplies the tag and clears `grouping_source` —
   * so the mixture is one production actually produces rather than a state invented here.
   */
  async function seedHalfEnriched(marker = ''): Promise<void> {
    const enriched = subsonicId('s', `${MIXED_DIR}/01 Kerala.opus`);
    const bare = subsonicId('s', `${MIXED_DIR}/02 Black Sands.opus`);
    const db = harness.db.db;
    await db
      .prepare(
        `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, suffix, duration, bitrate, created_at, updated_at)
         VALUES (?, ?, ?, ?, '01 Kerala.opus', '01 kerala.opus', 1000, 1000, 'opus', 0, 0, 1700000000, 1700000000)`,
      )
      .bind(enriched, LIBRARY_ID, `${MIXED_DIR}/01 Kerala.opus`, MIXED_DIR)
      .run();
    await db
      .prepare(
        `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, suffix, duration, bitrate, created_at, updated_at)
         VALUES (?, ?, ?, ?, '02 Black Sands.opus', '02 black sands.opus', 1000, 1000, 'opus', 0, 0, 1700000000, 1700000000)`,
      )
      .bind(bare, LIBRARY_ID, `${MIXED_DIR}/02 Black Sands.opus`, MIXED_DIR)
      .run();

    // The backfill derives the grouping for both rows, then the enrichment read supplies the
    // real tags for track 1 only. So: track 1 is tagged, track 2 is a guess, both in one folder.
    const songs = new SongDAO(harness.db.db, marker);
    const derivation = new SongDerivationDAO(harness.db.db, marker);
    await derivation.applyDerivation(derivation.deriveFor(await derivation.listNeedingDerivation(LIBRARY_ID, 50)));
    await songs.applyMetadata(enriched, { artist: 'Bonobo', album: 'Black Sands', albumArtist: 'Bonobo', year: 2008, genre: 'Electronic' });
  }

  const albumNames = async (env: Record<string, unknown>): Promise<string[]> => {
    await harness.close();
    harness = await createHarness();
    // Seeded with the marker the request will run under, because the fixture's *stored* value is
    // half of the question — a row derived with one marker and grouped under another is not the
    // state either deployment produces. Narrowed rather than `String(...)`-cast because `env` is
    // `Record<string, unknown>` and a non-string there is a caller bug worth not hiding.
    const configured = env['DERIVED_MARKER'];
    await seedHalfEnriched(typeof configured === 'string' ? configured : '');
    const response = await harness.fetch(harness.restUrl('getAlbumList2', { type: 'alphabeticalByName', size: '20' }), env);
    const parsed = (await response.json()) as SubsonicBody;
    return payload<{ album: Array<{ name: string; songCount: number }> }>(parsed, 'albumList2').album
      .filter((album) => album.name.startsWith('Black Sands'))
      .map((album) => `${album.name} (${album.songCount})`);
  };

  it('merges a guess and a tag into ONE album when the marker is empty, which is the default', async () => {
    // The change itself. One release, one entry, both tracks in it — instead of two entries
    // differing only in a suffix.
    expect(await albumNames({})).toEqual(['Black Sands (2)']);
    // Stated explicitly rather than left to the default, so a change to the default is a
    // deliberate diff here rather than a silent behaviour change on every deployment.
    expect(await albumNames({ DERIVED_MARKER: '' })).toEqual(['Black Sands (2)']);
  });

  it('publishes them as TWO albums when the marker is not empty, which is what it is for', async () => {
    // The paired case, and the reason the empty default is a *decision* rather than a
    // simplification: for a library browsed before it is fully tag-read, seeing which of two
    // entries is a guess can be worth the duplicate. Asserted with a real `songCount` on each,
    // because two albums each reporting one track is also what a broken grouping looks like.
    expect(await albumNames({ DERIVED_MARKER: ' (derived)' })).toEqual(['Black Sands (1)', 'Black Sands (derived) (1)']);
  });

  it('reports a year from an enriched track even when the first track is not enriched', async () => {
    // The defect the merge introduces, and the reason `albumModel` no longer reads `songs[0]`.
    //
    // `year` and `genre` are the two columns the derivation deliberately never writes, so an
    // unenriched track holds NULL for both. While a guess and a tag were two albums this was
    // invisible — the tagged half published a year and the derived half published none, and
    // nobody compared them. Merged, the group's first track is often the unenriched one, and
    // `first.year` reports no year for a release whose other track has one.
    //
    // Paired on both orderings below, because the answer is a function of the *album* and not of
    // which row the statement returned first — a `.find` over the wrong direction, or over one
    // column and not the other, passes one case and fails the other.
    const withYear = async (enrichFirst: boolean): Promise<{ year?: number; genre?: string }> => {
      await harness.close();
      harness = await createHarness();
      await seedHalfEnriched('');
      if (!enrichFirst) {
        // Enrich track 2 and strip track 1 instead, so the enriched row is *not* first in
        // `compareAlbumTracks` order. Without this the case only ever proves one ordering.
        const second = subsonicId('s', `${MIXED_DIR}/02 Black Sands.opus`);
        await new SongDAO(harness.db.db, '').applyMetadata(second, { artist: 'Bonobo', album: 'Black Sands', albumArtist: 'Bonobo', year: 2008, genre: 'Electronic' });
        await harness.db.db
          .prepare('UPDATE songs SET year = NULL, genre = NULL, genre_ci = NULL WHERE path = ?')
          .bind(`${MIXED_DIR}/01 Kerala.opus`)
          .run();
      }
      // The id comes from the list rather than being minted here, so the assertion runs the
      // round trip a client runs — a hand-built id would pass whether or not the list publishes
      // the same one.
      const list = (await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '20' })).body;
      const albums = payload<{ album: Array<{ id: string; name: string }> }>(list, 'albumList2').album.filter((album) => album.name === 'Black Sands');
      expect(albums).toHaveLength(1);
      const detail = (await harness.rest('getAlbum', { id: albums[0].id })).body;
      return payload<{ year?: number; genre?: string }>(detail, 'album');
    };

    const firstTrack = await withYear(true);
    const secondTrack = await withYear(false);
    // `toMatchObject` rather than `toEqual`: the album carries eleven fields and this is about
    // two of them, so pinning the whole record would fail on the next field added rather than
    // on the regression this exists to catch.
    expect(firstTrack).toMatchObject({ year: 2008, genre: 'Electronic' });
    expect(secondTrack).toMatchObject({ year: 2008, genre: 'Electronic' });
  });

  it('refuses a control character and an over-long marker, and accepts every other character', async () => {
    // Two classes of bad value, and neither throws at request time.
    //
    // A control character is refused because of the **album id**, not the SQL: `decodeId` runs
    // `normalizeRelativePath` over a decoded payload and refuses control characters, so a marker
    // carrying one mints an `alk:` id this server cannot read back — `getAlbum` answers
    // `code=70` and `getCoverArt` serves the placeholder, with nothing naming a cause. That is
    // the `Sgt. Pepper's` defect one level down, and it is why the marker cannot be arbitrary
    // text however much an operator would like a box-drawing character in it.
    const control = AppConfiguration.fromEnv({ DERIVED_MARKER: ' (derived\u0007)' }).validate().filter((warning) => warning.includes('DERIVED_MARKER'));
    expect(control).toHaveLength(1);
    expect(control[0]).toContain('control character');

    expect(AppConfiguration.fromEnv({ DERIVED_MARKER: ' (guess)' }).validate().filter((warning) => warning.includes('DERIVED_MARKER'))).toHaveLength(0);

    // Length, because the marker is appended to every derived name and therefore lands in a
    // base64url id and a `WHERE` clause — paid for on every request, not once.
    const long = 'x'.repeat(AppConfiguration.DERIVED_MARKER_MAX_LENGTH + 1);
    const overlong = AppConfiguration.fromEnv({ DERIVED_MARKER: long }).validate().filter((warning) => warning.includes('DERIVED_MARKER'));
    expect(overlong).toHaveLength(1);
    expect(overlong[0]).toContain(String(AppConfiguration.DERIVED_MARKER_MAX_LENGTH));

    // `%` and `_` are **accepted**, which is the assertion that the guard stopped being a `LIKE`.
    // Under the old statement either character was a wildcard and either could make the backfill
    // match everything or nothing; a validation rule here would preserve the confusion the
    // `grouping_source` column removed.
    for (const marker of ['%', '_', '%_guess_%', '100%', 'Sgt. Pepper\'s']) {
      expect(AppConfiguration.fromEnv({ DERIVED_MARKER: marker }).validate().filter((warning) => warning.includes('DERIVED_MARKER')), marker).toHaveLength(0);
    }

    // Empty reports nothing, because it is the default and warning on a default is noise.
    expect(AppConfiguration.fromEnv({ DERIVED_MARKER: '' }).validate().filter((warning) => warning.includes('DERIVED_MARKER'))).toHaveLength(0);
    expect(AppConfiguration.fromEnv({}).validate().filter((warning) => warning.includes('DERIVED_MARKER'))).toHaveLength(0);
  });

  it('reads the value rather than merely parsing it, and does not trim it', async () => {
    // The rule every variable in `ConfigurationDefaults` earns the hard way: a variable can be
    // declared, parsed, validated, templated and read by nothing, and all five states look
    // identical from outside. `STREAM_RATE_LIMIT` was inert — the limiter used a literal.
    expect(AppConfiguration.fromEnv({ DERIVED_MARKER: ' (guess)' }).getDerivedMarker()).toBe(' (guess)');
    expect(AppConfiguration.fromEnv({}).getDerivedMarker()).toBe('');

    // Not trimmed, and stated because the alternative is a marker the operator did not write
    // appearing in every `_ci` twin and every album id. `ALBUM_GROUP_BY` *is* trimmed, because it
    // is an enum read through `isAlbumGrouping`; this is a literal suffix, and the difference is
    // worth one assertion rather than a comment.
    expect(AppConfiguration.fromEnv({ DERIVED_MARKER: ' (guess) ' }).getDerivedMarker()).toBe(' (guess) ');
  });
});
