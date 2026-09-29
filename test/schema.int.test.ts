/**
 * The schema, and the DAOs, against a real SQLite engine.
 *
 * ### The assertion that matters most here is the query plan
 *
 * `WHERE username_ci = ?` and `WHERE lower(username) = ?` return identical rows. A
 * predicate can be wrong in a way that no row-comparison assertion can see, and the
 * only observable difference is the plan — which is why these run against a real
 * planner (`node:sqlite`, the same engine D1 is) instead of a double.
 *
 * The reference project this was scaffolded from shipped `lower(col) = lower(?)`
 * through a full suite for exactly this reason: its D1 double lowercased both sides in
 * JavaScript, so the predicate was wrong in SQL and the answers were right.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptData, generateAesGcmKey } from '@edge-sonic/backend-data/crypto';
import {
  AnnotationDAO,
  AuthThrottleDAO,
  LibraryDAO,
  NodeDAO,
  PlaylistDAO,
  ScanStateDAO,
  SongDAO,
  UserDAO,
} from '@edge-sonic/backend-data/dao';
import { sqliteQueryable, queryPlan } from './helpers/sqlite';
import type { SqliteQueryable } from './helpers/sqlite';

const MIGRATION = readFileSync(fileURLToPath(new URL('../migrations/0001_edge_sonic_init.sql', import.meta.url)), 'utf8');

/**
Base64 of a 32-byte key, generated once so a file's rows stay readable.
*/
let keyPromise: Promise<string> | null = null;
function testKey(): Promise<string> {
  keyPromise ??= generateAesGcmKey();
  return keyPromise;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

let handle: SqliteQueryable;

beforeEach(() => {
  handle?.close();
  handle = sqliteQueryable();
  handle.raw.exec(MIGRATION);
});

/** Encode a Subsonic id exactly as the product does, so a test cannot pass on a
 *  different scheme than the one in use. */
function songId(libraryId: string, path: string): string {
  const bytes = new TextEncoder().encode(`${libraryId}\n${path}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `s:${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

async function seedUser(username: string, password = 'sesame'): Promise<string> {
  const encrypted = await encryptData(password, await testKey());
  const users = new UserDAO(handle.db);
  return (await users.create({ username, passwordCiphertext: encrypted.ciphertext, passwordIv: encrypted.iv })).id;
}

/**
 * Insert a library under a **known** id.
 *
 * `LibraryDAO.create` mints its own id, and a test needs a stable one to encode song
 * ids against — so this writes the row directly rather than going through the DAO.
 * Everything else about the row matches what the DAO produces, because the cascade and
 * plan assertions are only meaningful if the seed is indistinguishable from a real
 * registration.
 */
async function seedLibrary(userId: string, id: string): Promise<string> {
  const encrypted = await encryptData('dav-password', await testKey());
  const timestamp = nowSeconds();
  await handle.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      id.toLowerCase(),
      id.toLowerCase(),
      'https://dav.example.com',
      '/remote.php/dav/files/alice/Music',
      'alice',
      encrypted.ciphertext,
      encrypted.iv,
      'Home',
      timestamp,
      timestamp,
    )
    .run();
  await new UserDAO(handle.db).setLibraryGrants(userId, [id]);
  return id;
}

async function seedSong(libraryId: string, path: string, dirPath: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const songs = new SongDAO(handle.db);
  const id = songId(libraryId, path);
  const name = path.split('/').pop() ?? path;
  const ci = (value: unknown): string | null => (typeof value === 'string' ? value.toLowerCase() : null);
  await songs.upsertFileFacts([
    { id, libraryId, path, dirPath, name, size: 1000, mtimeMs: 1000, contentType: 'audio/flac', suffix: 'flac' },
  ]);
  await songs.applyMetadata(id, {
    title: (metadata.title as string) ?? name,
    artist: metadata.artist as string | undefined,
    album: metadata.album as string | undefined,
    albumArtist: metadata.artist as string | undefined,
    genre: metadata.genre as string | undefined,
    track: metadata.track as number | undefined,
    year: metadata.year as number | undefined,
    duration: (metadata.duration as number) ?? 0,
    bitrate: 900,
  });
  void ci;
  return id;
}

describe('schema', () => {
  it('applies with foreign keys enforced and no violations', () => {
    // A migration that only works with FKs off is a migration that destroys data on a
    // real deployment, where they cannot be turned off mid-run.
    expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('declares every table the DAOs query', () => {
    const rows = handle.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual([
      'auth_failures',
      'bookmarks',
      'libraries',
      'nodes',
      'now_playing',
      'play_counts',
      'play_queue',
      'play_queue_entries',
      'playlist_entries',
      'playlists',
      'ratings',
      'scan_state',
      'settings',
      'songs',
      'stars',
      'user_libraries',
      'users',
    ]);
  });
});

describe('D1 predicate rule: lowercase the parameter, never the column', () => {
  it('matches a username case-insensitively, because the parameter is lowercased', async () => {
    await seedUser('Ann');
    const users = new UserDAO(handle.db);
    // Subsonic clients match usernames case-insensitively, so a client may send `ANN`.
    expect(await users.findByUsername('ANN')).not.toBeNull();
    expect(await users.findByUsername('ann')).not.toBeNull();
    expect(await users.findByUsername('nobody')).toBeNull();
  });

  it('refuses a second user differing only in case, at the schema level', async () => {
    await seedUser('Ann');
    await expect(seedUser('ANN')).rejects.toThrow();
  });

  it('indexes the username lookup', () => {
    // The plan is the ONLY observable difference between `username_ci = ?` and
    // `lower(username) = ?`. Both return the same rows.
    const indexed = queryPlan(handle, 'SELECT * FROM users WHERE username_ci = ?', ['ann']);
    expect(indexed).toContain('idx_users_username_ci');
    expect(indexed).not.toContain('SCAN users');
  });

  it('would full-scan if the predicate were written the other way round', () => {
    // This documents WHY the DAO looks the way it does, and fails if someone "fixes" it
    // to use `lower()` — which would be a silent full-table scan of the authenticated
    // hot path.
    const scanned = queryPlan(handle, 'SELECT * FROM users WHERE lower(username) = ?', ['ann']);
    expect(scanned).toContain('SCAN users');
  });
});

describe('paths compare exactly, never lowercased', () => {
  it('keeps `Album` and `album` as two folders', async () => {
    // A WebDAV origin on Linux is case-sensitive. Lowercasing the column would merge
    // two real folders and index a file that does not exist.
    const userId = await seedUser('CaseTest');
    const libraryId = await seedLibrary(userId, 'LCASE');
    const nodes = new NodeDAO(handle.db);

    await nodes.upsertMany([
      { libraryId, path: 'Album', parentPath: '', name: 'Album', mtimeMs: 1, etag: null, depth: 1 },
      { libraryId, path: 'album', parentPath: '', name: 'album', mtimeMs: 1, etag: null, depth: 1 },
    ]);

    expect((await nodes.find(libraryId, 'Album'))?.name).toBe('Album');
    expect((await nodes.find(libraryId, 'album'))?.name).toBe('album');
    // Both rows exist, and both carry the same `_ci` form: the display value keeps its
    // case while the sort key is normalized.
    expect(await nodes.countByLibrary(libraryId)).toBe(2);
    expect((await nodes.find(libraryId, 'Album'))?.name_ci).toBe((await nodes.find(libraryId, 'album'))?.name_ci);
  });

  it('indexes the (library, path) lookup the index is keyed on', () => {
    const plan = queryPlan(handle, 'SELECT * FROM nodes WHERE library_id = ? AND path = ?', ['L', 'A']);
    expect(plan).toContain('SEARCH nodes');
    expect(plan).not.toContain('SCAN nodes');
  });
});

describe("listRoots does not return the library root's own row", () => {
  /**
   * Seed a library whose root row exists alongside its top-level folders.
   *
   * The root row is `path === parentPath === ''`, which is what the scan writes for the
   * collection itself. It is a real row and `listChildren` is right to return it for the
   * parent `''` — but `listRoots` answers "what is at the top level for `getIndexes`",
   * and the root is not a top-level entry, it is the thing they are all inside.
   */
  async function seedLibraryWithRoot(): Promise<{ userId: string; libraryId: string; nodes: NodeDAO }> {
    const userId = await seedUser('RootsTest');
    const libraryId = await seedLibrary(userId, 'LROOTS');
    const nodes = new NodeDAO(handle.db);
    await nodes.upsertMany([
      { libraryId, path: '', parentPath: '', name: '', mtimeMs: 1, etag: null, depth: 0 },
      { libraryId, path: 'Bon Iver', parentPath: '', name: 'Bon Iver', mtimeMs: 1, etag: null, depth: 1 },
      { libraryId, path: 'Blur', parentPath: '', name: 'Blur', mtimeMs: 1, etag: null, depth: 1 },
      { libraryId, path: 'Blur/Bubbley', parentPath: 'Blur', name: 'Bubbley', mtimeMs: 1, etag: null, depth: 2 },
    ]);
    return { userId, libraryId, nodes };
  }

  it('lists the top-level folders and not the root', async () => {
    const { libraryId, nodes } = await seedLibraryWithRoot();
    const roots = await nodes.listRoots(libraryId);

    expect(roots.map((row) => row.name)).toEqual(['Blur', 'Bon Iver']);
    // The row is still there — this is a filter on what "root" means, not a delete.
    expect(await nodes.countByLibrary(libraryId)).toBe(4);
  });

  it('gives every returned row a name, because a blank one is what a client renders', async () => {
    // `getIndexes` groups by first letter and emits each row as a `shortcut`. A row
    // with an empty name sorts to the top of the `#` group and is rendered as an
    // unlabelled entry, so this asserts the property the endpoint depends on rather
    // than the predicate that happens to produce it.
    const { libraryId, nodes } = await seedLibraryWithRoot();
    for (const row of await nodes.listRoots(libraryId)) {
      expect(row.name).not.toBe('');
      expect(row.path).not.toBe('');
    }
  });

  it('still lists the root row as a child of the root, where it belongs', async () => {
    // `listChildren('')` is how `getMusicDirectory` reaches the library root, and the
    // root row is legitimately a child of the parent `''`. Filtering it out of the
    // child listing as well would make the root unreachable.
    const { libraryId, nodes } = await seedLibraryWithRoot();
    const children = await nodes.listChildren(libraryId, '');
    expect(children.map((row) => row.path)).toContain('');
  });
});

describe('cascades', () => {
  it('takes the whole index with a deleted library, and leaves users alone', async () => {
    // This is the failure a `DROP TABLE <parent>` migration causes: D1 runs every
    // statement in an implicit transaction, so `PRAGMA foreign_keys = OFF` is
    // unavailable and the drop becomes a `DELETE FROM parent` that fires every
    // `ON DELETE CASCADE` beneath it.
    const userId = await seedUser('CascadeUser');
    const libraryId = await seedLibrary(userId, 'LCASC');
    const nodes = new NodeDAO(handle.db);
    const songs = new SongDAO(handle.db);
    const scanState = new ScanStateDAO(handle.db);

    await nodes.upsertMany([{ libraryId, path: 'Artist', parentPath: '', name: 'Artist', mtimeMs: 1, etag: null, depth: 1 }]);
    await seedSong(libraryId, 'Artist/Album/01.flac', 'Artist/Album');
    await scanState.ensure(libraryId);
    await new UserDAO(handle.db).setLibraryGrants(userId, [libraryId]);

    await new LibraryDAO(handle.db).delete(libraryId);

    expect(await nodes.countByLibrary(libraryId)).toBe(0);
    expect(await songs.countByLibrary(libraryId)).toBe(0);
    expect(await scanState.find(libraryId)).toBeNull();
    expect((await handle.db.prepare('SELECT COUNT(*) AS cnt FROM user_libraries WHERE library_id = ?').bind(libraryId).first()) as { cnt: number }).toEqual({
      cnt: 0,
    });
    // The parent survives, which is the whole point of never rebuilding it.
    expect(await new UserDAO(handle.db).findById(userId)).not.toBeNull();
  });

  it("takes a user's playlists, stars, and bookmarks with the user", async () => {
    const userId = await seedUser('CascadePlaylistUser');
    const libraryId = await seedLibrary(userId, 'LPL');
    const id = await seedSong(libraryId, 'A/01.flac', 'A', { title: 'One' });

    const playlists = new PlaylistDAO(handle.db);
    const annotations = new AnnotationDAO(handle.db);
    const playlist = await playlists.create({ ownerUserId: userId, name: 'Mix' });
    await playlists.replaceEntries(playlist.id, [id], 0);
    await annotations.star(userId, id, 'song');
    await annotations.createBookmark(userId, id, 1000, 'here');

    await new UserDAO(handle.db).delete(userId);

    expect(await playlists.findById(playlist.id)).toBeNull();
    expect(await annotations.listStarred(userId, 'song')).toEqual([]);
    expect(await annotations.listBookmarks(userId)).toEqual([]);
  });
});

describe('every hot lookup uses an index', () => {
  const PLANS: ReadonlyArray<readonly [string, string, unknown[]]> = [
    ['user by username', 'SELECT * FROM users WHERE username_ci = ?', ['ann']],
    ['library by slug', 'SELECT * FROM libraries WHERE slug_ci = ?', ['home']],
    ['song by id', 'SELECT * FROM songs WHERE id = ?', ['s:x']],
    ['song by library+path', 'SELECT * FROM songs WHERE library_id = ? AND path = ?', ['L', 'A/1.flac']],
    ['songs in a directory', 'SELECT * FROM songs WHERE library_id = ? AND dir_path = ? ORDER BY disc ASC, track ASC', ['L', 'A']],
    ['songs in an album', 'SELECT * FROM songs WHERE library_id = ? AND album_artist_ci = ? AND album_ci = ?', ['L', 'a', 'b']],
    ['songs by genre', 'SELECT * FROM songs WHERE library_id = ? AND genre_ci = ?', ['L', 'indie']],
    ['prefix search', String.raw`SELECT * FROM songs WHERE library_id = ? AND title_ci LIKE ? ESCAPE '\'`, ['L', 'ab%']],
    ['starred items', 'SELECT item_id FROM stars WHERE user_id = ? AND item_type = ? ORDER BY starred_at DESC', ['u', 'song']],
    ['play counts', 'SELECT song_id, play_count FROM play_counts WHERE user_id = ?', ['u']],
    ['auth failures in window', 'SELECT COALESCE(SUM(failures), 0) AS cnt FROM auth_failures WHERE identity = ? AND bucket >= ? AND bucket <= ?', ['x', 1, 2]],
    ['scan frontier', 'SELECT * FROM nodes WHERE library_id = ? AND is_scanned = 0 ORDER BY depth ASC, path ASC LIMIT ?', ['L', 40]],
    ['play queue', 'SELECT song_id FROM play_queue_entries WHERE user_id = ? ORDER BY position ASC', ['u']],
    ['granted libraries', 'SELECT l.id AS id FROM libraries l INNER JOIN user_libraries ul ON ul.library_id = l.id WHERE ul.user_id = ? ORDER BY l.slug_ci ASC', ['u']],
  ];

  for (const [label, sql, args] of PLANS) {
    it(`indexes: ${label}`, () => {
      const plan = queryPlan(handle, sql, args);
      // `SCAN x USING COVERING INDEX` is an index scan, not a table scan. The only
      // thing that costs a full table pass is a bare `SCAN x` with no index.
      const isFullScan = plan.includes('SCAN') && !plan.includes('USING');
      expect(isFullScan, `${label}: ${plan}`).toBe(false);
    });
  }

  it('scans now_playing in full, deliberately', () => {
    // One row per user, so the scan is bounded by the user count, and the query needs
    // every row anyway to compute `minutes_ago`. An index here would cost more than it
    // saves and would need maintaining on every scrobble.
    expect(queryPlan(handle, 'SELECT username, CAST((? - updated_at) / 60 AS INTEGER) AS minutes_ago FROM now_playing ORDER BY updated_at DESC', [0])).toContain(
      'SCAN now_playing',
    );
  });

  it('scans the library for an infix search, which is the documented limit', () => {
    // A leading `%` makes the pattern's start unknown, so no index can serve the term.
    // The leading `library_id = ?` does use one, so the cost is a scan of THIS library's
    // rows rather than of every library. FTS5 is the named fix, in the migration.
    // Which of the two candidate indexes the planner picks is its business; what
    // matters is that it picks one, so the scan is bounded to this library.
    const plan = queryPlan(handle, String.raw`SELECT * FROM songs WHERE library_id = ? AND title_ci LIKE ? ESCAPE '\'`, ['L', '%ab%']);
    expect(plan).toMatch(/SEARCH songs USING (?:COVERING )?INDEX idx_songs_(title_ci|album_title_ci)/);
    expect(plan).not.toMatch(/SCAN songs/);
  });
});

describe('DAO round-trips', () => {
  it("re-running a scan's upsert does not blank derived metadata", async () => {
    // The reason `upsertFileFacts` is a separate statement from `applyMetadata`: a
    // rescan must not destroy the duration an enrichment pass already filled in. A
    // client showing a 0:00 scrubber is a bug nobody reports, so it has to be tested.
    const userId = await seedUser('RoundTrip');
    const libraryId = await seedLibrary(userId, 'LRT');
    const songs = new SongDAO(handle.db);
    const id = songId(libraryId, 'A/01.flac');
    const facts = { id, libraryId, path: 'A/01.flac', dirPath: 'A', name: '01.flac', size: 100, mtimeMs: 1, contentType: 'audio/flac', suffix: 'flac' };

    await songs.upsertFileFacts([facts]);
    await songs.applyMetadata(id, { title: 'Holocene', duration: 251, bitrate: 900, genre: 'Indie' });
    // A second scan sees the same file, unchanged.
    await songs.upsertFileFacts([facts]);

    const row = await songs.findById(id);
    expect(row?.title).toBe('Holocene');
    expect(row?.duration).toBe(251);
    expect(row?.bitrate).toBe(900);
    // Each `_ci` twin is written in the same statement as its counterpart, so search
    // and the ORDER BY clauses can never drift from the display value.
    expect(row?.title_ci).toBe('holocene');
    expect(row?.genre_ci).toBe('indie');
  });

  it('invalidates the derived values when a file changes, and keeps them when it does not', async () => {
    // The silent one. A rescan that updates `mtime_ms` but leaves `duration` alone
    // produces a row whose length is wrong, which no error anywhere reports and which
    // `EnrichmentService` then refuses to fix, because it short-circuits on
    // `enriched_at`. The two cases are asserted together so the reset cannot be
    // "fixed" by simply always clearing — that would re-read every file on every scan.
    const userId = await seedUser('MtimeChange');
    const libraryId = await seedLibrary(userId, 'LMT');
    const songs = new SongDAO(handle.db);
    const id = songId(libraryId, 'A/01.flac');
    const facts = (mtimeMs: number, size: number) => ({
      id,
      libraryId,
      path: 'A/01.flac',
      dirPath: 'A',
      name: '01.flac',
      size,
      mtimeMs,
      contentType: 'audio/flac',
      suffix: 'flac',
    });

    await songs.upsertFileFacts([facts(1000, 100)]);
    await songs.applyMetadata(id, { title: 'Holocene', artist: 'Bon Iver', duration: 251, bitrate: 900, sampleRate: 44_100, channels: 2 });

    // The same bytes seen again: the scan runs on every pass, and a rescan must not
    // throw away a duration it would then have to re-read from the origin.
    await songs.upsertFileFacts([facts(1000, 100)]);
    const unchanged = await songs.findById(id);
    expect(unchanged?.duration).toBe(251);
    expect(unchanged?.enriched_at).not.toBeNull();

    // Different bytes: the length and the format facts are gone, so the next read
    // re-fetches them. The text tags stay, because `getArtists` groups by them and a
    // cleared artist would drop the track out of every group.
    await songs.upsertFileFacts([facts(2000, 150)]);
    const changed = await songs.findById(id);
    expect(changed?.mtime_ms).toBe(2000);
    expect(changed?.size).toBe(150);
    expect(changed?.duration).toBe(0);
    expect(changed?.bitrate).toBe(0);
    expect(changed?.sample_rate).toBeNull();
    expect(changed?.channels).toBeNull();
    // `enriched_at` is the flag that makes `enrich` re-read, so clearing it is what
    // turns the fix from cosmetic into effective.
    expect(changed?.enriched_at).toBeNull();
    expect(changed?.title).toBe('Holocene');
  });

  it('removes playlist entries by index, highest first', async () => {
    // `songIndexToRemove` addresses positions, and the protocol does not say in which
    // order a client sends multiple removals — so the result must not depend on it.
    const userId = await seedUser('PlaylistIndex');
    const libraryId = await seedLibrary(userId, 'LPI');
    // Sequential on purpose: each `seedSong` awaits D1, and the D1 subrequest budget is
    // the scarce resource. `Promise.all` here would be faster and wrong.
    const ids: string[] = [];
    for (const stem of ['a', 'b', 'c', 'd']) {
      ids.push(await seedSong(libraryId, `A/${stem}.flac`, 'A', { title: stem }));
    }

    const playlists = new PlaylistDAO(handle.db);
    const playlist = await playlists.create({ ownerUserId: userId, name: 'Mix' });
    await playlists.replaceEntries(playlist.id, ids, 0);
    await playlists.removeEntriesAt(playlist.id, [1, 2]);

    const entries = await playlists.listEntries(playlist.id);
    // The surviving *songs* are what matter, and they are the ones a highest-first
    // delete preserves: a, then d. An ascending delete would remove a's neighbours
    // instead and leave b and c.
    expect(entries.map((entry) => entry.song_id)).toEqual([ids[0], ids[3]]);
    // The position gap is deliberate, not drift. Positions are the protocol's
    // addressing scheme, so renumbering after a delete would invalidate any index a
    // client is still holding; `appendEntries` uses `MAX(position) + 1`, so a gap costs
    // nothing.
    expect(entries.map((entry) => entry.position)).toEqual([0, 3]);
    // The denormalized total is the count a client renders a progress bar from, so it
    // has to be the number of entries rather than the highest position.
    expect((await playlists.findById(playlist.id))?.song_count).toBe(2);
  });

  it('bumps token_epoch on a password change, invalidating issued tokens', async () => {
    // A Subsonic token is valid forever, so without the bump there is no way to revoke
    // one: a client's saved credential keeps working after a password change.
    const userId = await seedUser('EpochUser');
    const users = new UserDAO(handle.db);
    const before = await users.findById(userId);

    const rotated = await encryptData('new-password', await testKey());
    await users.updatePassword(userId, rotated.ciphertext, rotated.iv, 2);

    const after = await users.findById(userId);
    expect(after?.token_epoch).toBe((before?.token_epoch ?? 1) + 1);
    expect(after?.key_version).toBe(2);
  });

  it('counts auth failures inside a window and clears them on success', async () => {
    // D1-backed and fail-closed, so this is the one piece of state where losing the
    // cache would be a security regression rather than a latency change.
    const throttle = new AuthThrottleDAO(handle.db);
    for (let attempt = 0; attempt < 3; attempt += 1) await throttle.recordFailure('identity', 10);

    expect(await throttle.countRecentFailures('identity', 10, 10)).toBe(3);
    // An older or newer bucket is outside the window and must not count.
    expect(await throttle.countRecentFailures('identity', 11, 11)).toBe(0);
    expect(await throttle.countRecentFailures('identity', 0, 9)).toBe(0);

    await throttle.clearFailures('identity');
    expect(await throttle.countRecentFailures('identity', 0, 100)).toBe(0);
  });

  it('prunes a deleted folder and everything beneath it', async () => {
    const userId = await seedUser('Prune');
    const libraryId = await seedLibrary(userId, 'LPR');
    const songs = new SongDAO(handle.db);
    await seedSong(libraryId, 'Album/01.flac', 'Album');
    await seedSong(libraryId, 'Album/Disc 2/01.flac', 'Album/Disc 2');
    expect(await songs.countByLibrary(libraryId)).toBe(2);

    // A one-level delete would leave the `Disc 2` row indexed, pointing at a folder
    // that no longer exists — which is the entire failure this prune exists to prevent.
    expect(await songs.deleteSubtree(libraryId, 'Album')).toBe(2);
    expect(await songs.countByLibrary(libraryId)).toBe(0);
  });

  it('does not let `Blur` match `Blurberry` when pruning', async () => {
    // The LIKE prefix carries a trailing `/`. Without it, deleting one album takes out
    // every folder whose name merely starts with the same characters.
    const userId = await seedUser('PrefixPrune');
    const libraryId = await seedLibrary(userId, 'LPP');
    const songs = new SongDAO(handle.db);
    await seedSong(libraryId, 'Blur/01.flac', 'Blur');
    await seedSong(libraryId, 'Blurberry/01.flac', 'Blurberry');

    await songs.deleteSubtree(libraryId, 'Blur');
    expect(await songs.listByDirectory(libraryId, 'Blurberry')).toHaveLength(1);
    expect(await songs.listByDirectory(libraryId, 'Blur')).toHaveLength(0);
  });

  it('deletes a node subtree without taking a sibling whose name extends it', async () => {
    const userId = await seedUser('NodePrefixPrune');
    const libraryId = await seedLibrary(userId, 'LNP');
    const nodes = new NodeDAO(handle.db);
    await nodes.upsertMany([
      { libraryId, path: 'Blur', parentPath: '', name: 'Blur', mtimeMs: 1, etag: null, depth: 1 },
      { libraryId, path: 'Blur/Disc 1', parentPath: 'Blur', name: 'Disc 1', mtimeMs: 1, etag: null, depth: 2 },
      { libraryId, path: 'Blurberry', parentPath: '', name: 'Blurberry', mtimeMs: 1, etag: null, depth: 1 },
    ]);

    expect(await nodes.deleteSubtree(libraryId, 'Blur')).toBe(2);
    expect(await nodes.find(libraryId, 'Blur')).toBeNull();
    expect(await nodes.find(libraryId, 'Blurberry')).not.toBeNull();
  });
});
