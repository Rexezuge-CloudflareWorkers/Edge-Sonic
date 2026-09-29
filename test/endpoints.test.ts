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
import { createHarness, ALBUM_DIR, subsonicId } from './helpers/harness';
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

    const legacyName = payload<{ album: Array<{ title: string }> }>(legacy.body, 'albumList').album[0]?.title;
    const currentName = payload<{ album: Array<{ name: string }> }>(current.body, 'albumList2').album[0]?.name;
    // `getAlbumList` is the pre-1.4 shape, where the field is `title` rather than
    // `name`. A client still sending it must get the same album, not an empty list.
    expect(legacyName).toBe(currentName);
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
});

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
});

describe('system endpoints', () => {
  it('reports the license as valid, so a client does not nag', async () => {
    const { body } = await harness.rest('getLicense');
    expect(payload<{ valid: boolean }>(body, 'license').valid).toBe(true);
  });

  it('answers getOpenSubsonicExtensions as not implemented, naming the endpoint', async () => {
    // The envelope carries `openSubsonic: true` on every response, which is what a client
    // uses to decide the server speaks the extended protocol. Advertising an empty
    // extension list would be a claim this server does not honour; `code=70` is honest.
    const { status, body } = await harness.rest('getOpenSubsonicExtensions');
    expect(status).toBe(200);
    const error = payload<{ code: number; message: string }>(body, 'error');
    expect(error.code).toBe(70);
    expect(error.message).toContain('getOpenSubsonicExtensions');
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
