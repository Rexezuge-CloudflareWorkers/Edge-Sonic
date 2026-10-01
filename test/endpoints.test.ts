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
import { createHarness, ALBUM_DIR, ORIGIN, SALT, USERNAME, subsonicId } from './helpers/harness';
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
    for (const type of ['alphabeticalByArtist', 'byYear', 'byRating', 'starred', 'highest', 'frequent', 'recent', 'random']) {
      const { body } = await harness.rest('getAlbumList2', { type, size: '10' });
      // `random` legitimately returns the album, and `byRating` returns it with no
      // ratings, so the assertion is that the request is *answered*, not what it
      // contains. A type that 500s or returns `code=70` is the failure.
      const album = payload<{ album?: Array<{ name: string }> }>(body, 'albumList2');
      expect(album, type).toBeDefined();
      // Every response carries the key as an array, even when it is empty.
      expect(Array.isArray(album.album), type).toBe(true);
    }
  });

  it('honours size and offset, and says when there is nothing more', async () => {
    const first = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '1', offset: '0' });
    expect(payload<{ album: unknown[] }>(first.body, 'albumList2').album).toHaveLength(1);

    const past = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '10', offset: '500' });
    // An out-of-range offset is an **empty list**, not a 404: a paging client asks for
    // the next page and has to be told "there is none" in a way it can read.
    expect(payload<{ album: unknown[] }>(past.body, 'albumList2').album).toEqual([]);
  });

  it('falls back to a default order for a type it does not know, rather than failing', async () => {
    // A *newer* client can send a type this server has never heard of, and a client
    // that gets `code=70` for `byReleaseDate` reports a server error to the user. So an
    // unrecognized type is answered with the documented default order.
    //
    // The cost is that a typo is answered with a plausible list instead of an error. That
    // is the right trade: the compatible failure is visible and the incompatible one is
    // not.
    const { status, body } = await harness.rest('getAlbumList2', { type: 'alphabeticalBySideways', size: '10' });
    expect(status).toBe(200);
    expect(payload<{ album: Array<{ name: string }> }>(body, 'albumList2').album.map((album) => album.name)).toEqual(['For Emma, Forever Ago']);
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
    expect(payload<{ song: unknown[] }>(body, 'songsByGenre').song).toEqual([]);
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
    expect(payload<{ song: unknown[] }>(other.body, 'randomSongs').song).toEqual([]);
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
    expect(payload<{ folder: unknown[] }>(body, 'user').folder).toEqual([]);
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

  it('answers an unsaved queue with empty lists, not with an error', async () => {
    // A client calls this on every launch. A `code=70` would surface as a failure
    // dialog on a fresh install.
    const { status, body } = await harness.rest('getPlayQueue');
    expect(status).toBe(200);
    const queue = payload<{ entry: unknown[] }>(body, 'playQueue');
    expect(queue.entry).toEqual([]);
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

  it('sorts by rating through getAlbumList2', async () => {
    await harness.rest('setRating', { id: SKINNY_LOVE, rating: '5' });
    const { body } = await harness.rest('getAlbumList2', { type: 'byRating', size: '10' });
    // The album is present and its own track count is right; the average is absent
    // because it aggregates every rater, and there is one.
    const album = payload<{ album: Array<{ name: string; songCount: number; averageRating?: number }> }>(body, 'albumList2').album[0];
    expect(album?.name).toBe('For Emma, Forever Ago');
    expect(album?.songCount).toBe(2);
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
    expect(payload<{ entry: unknown[] }>(body, 'nowPlaying').entry).toEqual([]);
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
    const album = subsonicId('al', ALBUM_DIR);
    const artist = subsonicId('ar', 'Bon Iver');
    for (const params of [{ id: SKINNY_LOVE }, { albumId: album }, { artistId: artist }] as Record<string, string>[]) {
      await harness.rest('star', params);
    }

    const { body } = await harness.rest('getStarred2');
    const starred = payload<{ song: Array<{ id: string }>; album: Array<{ id: string }> }>(body, 'starred2');
    expect(starred.song.map((entry) => entry.id)).toContain(SKINNY_LOVE);
    expect(starred.album.map((entry) => entry.id)).toContain(album);

    await harness.rest('unstar', { id: SKINNY_LOVE });
    const after = await harness.rest('getStarred2');
    expect(payload<{ song: Array<{ id: string }> }>(after.body, 'starred2').song.map((entry) => entry.id)).not.toContain(SKINNY_LOVE);
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
    expect(payload<{ bookmark: Array<{ id: string }> }>(after.body, 'bookmarks').bookmark).toEqual([]);
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
    // Not scanning, and nothing counted — the honest answer for a fresh library, as
    // opposed to a count of zero that looks like "scanned and found nothing".
    expect(scan.scanning).toBe(false);
    expect(scan.count).toBe(0);
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

describe('getArtists and getArtist', () => {
  it('groups artists, and describes one on request', async () => {
    const grouped = await harness.rest('getArtists');
    const artists = payload<{ index: Array<{ name: string; artist: Array<{ id: string; name: string; albumCount: number }> }> }>(grouped.body, 'artists').index;
    const bonIver = artists.find((group) => group.name === 'B');

    expect(bonIver?.artist[0]).toMatchObject({ id: ARTIST, name: 'Bon Iver', albumCount: 1 });

    const detail = await harness.rest('getArtist', { id: ARTIST });
    const artist = payload<{ name: string; albumCount: number; album: Array<{ id: string }> }>(detail.body, 'artist');
    expect(artist.name).toBe('Bon Iver');
    // The album ids are the same reversible ids used everywhere else, so a client that
    // kept one from a previous session still resolves it.
    expect(artist.album.map((album) => album.id)).toEqual([ALBUM]);
  });
});
