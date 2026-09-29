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
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptData, generateAesGcmKey } from '@edge-sonic/backend-data/crypto';
import {
  AnnotationDAO,
  AuthThrottleDAO,
  DERIVED_MARKER,
  LibraryDAO,
  NodeDAO,
  PlaylistDAO,
  ScanStateDAO,
  SongDAO,
  SongIndexDAO,
  UserDAO,
  deriveFromPath,
} from '@edge-sonic/backend-data/dao';
import { sqliteQueryable, queryPlan } from './helpers/sqlite';
import type { SqliteQueryable } from './helpers/sqlite';
import { migrationDrift, migrationFiles, migrationSql, readLock, sha256 } from './helpers/migrations';

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
  // Every migration, in order — see `helpers/migrations.ts`. Naming one file here
  // would make a new migration and an edit to an old one indistinguishable.
  handle.raw.exec(migrationSql());
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
    const tables = rows.map((row) => row.name);

    // Everything `backend-data` queries, which is what this assertion is for. The
    // assertion is a *subset* check plus an explicit list of what else is here, so a
    // missing table is caught without the test going blind to a new one.
    for (const required of [
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
    ]) {
      expect(tables, `${required} is missing`).toContain(required);
    }
  });

  it('leaves no dead table behind, and no foreign key that does not resolve', () => {
    // The full-directory read (0003) is what makes the two visible. Both were invisible
    // while this suite applied one hardcoded file, so neither could ever be reported.
    const tables = (handle.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);

    // The reference project's `router_backends`/`namespaces`, inherited from
    // Durable-DAV-Router. Dead code here, and `router_backends` referenced
    // `users(email)` — a nullable, non-unique column — so `PRAGMA foreign_key_check`
    // failed outright with a foreign key mismatch. D1 enforces foreign keys, so that
    // is a landmine in the live schema, not a cosmetic leftover.
    expect(tables).not.toContain('router_backends');
    expect(tables).not.toContain('namespaces');

    // The assertion that matters: it must not merely return rows, it must not throw.
    expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('builds the SAME `users` table production has, from the same migration set', () => {
    // `migrations/0001_router_init.sql` is inherited from the reference project and
    // also declares `users` — with an incompatible shape (`email TEXT PRIMARY KEY`,
    // no `username_ci`, no credential columns). Both files use
    // `CREATE TABLE IF NOT EXISTS`, so whichever runs first wins, silently.
    //
    // This suite used to `exec` only `0001_edge_sonic_init.sql`, so it asserted a
    // table list that no real database has: it never saw the router's tables, and it
    // never saw the collision. Applying the whole directory in Wrangler's order
    // exposes both — which is the argument for reading the directory.
    //
    // Production is correct today, and only because of the filename sort:
    // `0001_edge_sonic_init.sql` < `0001_router_init.sql`, so Edge-Sonic's `users`
    // is created first and the router's is a no-op. That is a load-bearing
    // alphabetical accident between two projects' migrations, and this assertion is
    // what stops it from being a silent outage the day either file is renamed.
    const columns = (handle.raw.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toContain('username_ci');
    expect(columns).toContain('password_ciphertext');
    expect(columns).toContain('token_epoch');

    // And the two files that collide are ordered the way the database needs.
    expect(migrationFiles().indexOf('0001_edge_sonic_init.sql')).toBeLessThan(migrationFiles().indexOf('0001_router_init.sql'));
  });
});

/**
 * An applied migration is immutable, and nothing in a `.sql` file says so.
 *
 * D1 records applied migrations by *filename*, so a migration that has run is skipped
 * by every later `wrangler d1 migrations apply` — silently, with no warning and no
 * error. Editing a shipped migration therefore changes the repository without changing
 * the database, and the code starts naming a column the database has never heard of.
 *
 * It shipped. `songs.reader_version` was added to `0001` after `0001` had been applied
 * to the live database, so the column never existed there: `applyMetadata` and
 * `upsertFileFacts` both named it and both failed, enrichment wrote nothing, and
 * `getArtists` / `getAlbumList2` / `getGenres` / `search3` answered `[]` for a library
 * of 80 albums whose rows sat in D1 with every derived column NULL. `getSong` answered
 * a masked 500, the scan wedged in `failed`, and `getScanStatus` reported that as a
 * finished scan. 489 tests passed throughout, because a suite that hardcodes one
 * migration filename cannot tell a new migration from an edit to an old one.
 *
 * So the fact the deployment actually depends on is recorded and asserted.
 */
describe('the migration lock', () => {
  it('records a migration file that has been applied and not changed since', () => {
    const { added, changed } = migrationDrift();
    // Adding a schema change means adding a numbered file *and* an entry here, in the
    // same commit. A new migration with no entry is a migration nobody has applied.
    expect(added).toEqual([]);
    // A changed hash is the defect above: the bytes moved, so the database did not.
    expect(changed).toEqual([]);
  });

  it('has a hash for every migration on disk, and every hash is a real digest', () => {
    // Asserted separately from the drift check so a failure names which direction
    // broke: an unreadable lock otherwise surfaces as "no migrations recorded".
    const lock = readLock().migrations;
    for (const name of migrationFiles()) {
      expect(lock[name], `${name} is not recorded in applied.lock.json`).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const [name, hash] of Object.entries(lock)) {
      expect(hash, `${name} has a malformed hash`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('detects an edit to a shipped migration rather than trusting the absence of one', () => {
    // The guard is worthless if it cannot fail, and a test that only asserts "no drift"
    // is exactly the shape that would pass forever with the check removed. So this
    // computes the comparison the guard performs, against a value that is wrong.
    const lock = readLock().migrations;
    const real = sha256('0001_edge_sonic_init.sql');
    expect(lock['0001_edge_sonic_init.sql']).toBe(real);
    expect(lock['0001_edge_sonic_init.sql']).not.toBe(sha256('0002_songs_reader_version.sql'));
  });

  it('ships every column the DAOs name, because a migration is a promise about the schema', () => {
    // The defect this whole block exists for was a *column* that existed in the
    // repository and not in the database. So the check is not "the files are tidy" —
    // it is that every column the write statements actually reference is present after
    // the migrations have run. A DAO naming a column no migration creates fails here,
    // in a suite, rather than on a request against a live database.
    const columns = (handle.raw.prepare('PRAGMA table_info(songs)').all() as Array<{ name: string }>).map((row) => row.name);
    for (const column of [
      // `applyMetadata` and `UPSERT_FILE_FACTS` both name these. `reader_version` is
      // the one that shipped missing: 0001 had already been applied, so the edit that
      // added it never ran, and every enrichment write raised "no such column".
      'id',
      'library_id',
      'path',
      'dir_path',
      'name',
      'name_ci',
      'size',
      'mtime_ms',
      'content_type',
      'suffix',
      'title',
      'artist',
      'artist_ci',
      'album',
      'album_ci',
      'album_artist',
      'album_artist_ci',
      'genre',
      'genre_ci',
      'track',
      'disc',
      'year',
      'duration',
      'bitrate',
      'sample_rate',
      'channels',
      'enriched_at',
      'reader_version',
    ]) {
      expect(columns, `songs.${column} is named by a DAO but created by no migration`).toContain(column);
    }

    // Same for the column the scan's retry bound reads. Asserted here rather than
    // only in a service test because the failure mode is the identical one: a column
    // that is real to the code and absent from the database.
    const scanColumns = (handle.raw.prepare('PRAGMA table_info(scan_state)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(scanColumns).toContain('consecutive_failures');
  });

  it('orders migrations the way Wrangler does, which is by filename', () => {
    // A test that builds the schema in a different order than production is a test
    // that can pass on a schema production never had.
    const files = migrationFiles();
    expect(files).toEqual([...files].sort());
    expect(files[0]).toBe('0001_edge_sonic_init.sql');
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

/**
 * The path-derived grouping, and the `COALESCE` that makes it safe.
 *
 * ### The defect
 *
 * `listAlbums` filters `album_ci IS NOT NULL AND album_ci <> ''`, `listArtists` filters
 * `artist_ci IS NOT NULL`, and `listGenres` filters `genre_ci IS NOT NULL`. Those
 * columns are written *only* by a tag read — one ranged WebDAV request per track,
 * bounded twice over, so for a library of any size most rows are unenriched for a long
 * time. A row with them NULL is not rendered with a blank name; it is **absent from
 * every aggregate**, and `search3` cannot match it.
 *
 * It shipped. A client authenticated against 80 albums and saw empty artists, albums,
 * genres and search, while `getRandomSongs` — which does not group — returned rows
 * with `duration: 0` and no artist at all. The `songs` table was full the whole time.
 *
 * ### The fix, and the property that makes it safe
 *
 * The WebDAV path already names the artist and the album, so the indexer writes them.
 * `COALESCE` is the safety argument: a derived value fills a NULL and *only* a NULL, so
 * a real tag is never rolled back to a guess, and a rescan rewrites nothing.
 */
describe('path-derived grouping', () => {
  async function indexSong(libraryId: string, path: string): Promise<void> {
    const songs = new SongDAO(handle.db);
    await songs.upsertFileFacts([
      {
        id: songId(libraryId, path),
        libraryId,
        path,
        dirPath: path.split('/').slice(0, -1).join('/'),
        name: path.split('/').pop() ?? path,
        size: 1000,
        mtimeMs: 1000,
        contentType: 'audio/ogg',
        suffix: 'ogg',
      },
    ]);
  }

  it('groups an unenriched track, so the aggregates are not empty before any tag read', async () => {
    // The whole point. `Artist/Album/01 Track.opus` names both, and nothing had ever
    // written them down.
    const userId = await seedUser('DerivedNested');
    const libraryId = await seedLibrary(userId, 'LDN');
    await indexSong(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');

    const row = await new SongDAO(handle.db).findById(songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'));
    expect(row?.album).toBe('Black Sands');
    expect(row?.artist).toBe('Bonobo (derived)');
    expect(row?.album_artist).toBe('Bonobo (derived)');

    // Every `_ci` twin moves with its counterpart, in the same statement. Asserted
    // separately from the display values because the two are *independently* breakable:
    // a `_ci` column that drifts from its source is an ungroupable row, and the drift
    // is invisible until somebody browses by artist — the display name looks perfect the
    // whole time. Removing `COALESCE` from only the `_ci` assignments, leaving the
    // display ones intact, passes every other assertion in this file.
    expect(row?.album_ci).toBe('black sands');
    expect(row?.artist_ci).toBe('bonobo (derived)');
    expect(row?.album_artist_ci).toBe('bonobo (derived)');

    // And the aggregate that filters on those columns now answers.
    const albums = await new SongIndexDAO(handle.db).listAlbums(libraryId, { limit: 10, offset: 0, orderBy: 'album_ci ASC' });
    expect(albums.map((song) => song.album)).toEqual(['Black Sands']);
    const artists = await new SongIndexDAO(handle.db).listArtists(libraryId, 10, 0);
    expect(artists.map((song) => song.artist)).toEqual(['Bonobo (derived)']);
  });

  it('groups a flat "Artist - Album" folder, which is a whole library layout', async () => {
    // The layout this product's live library uses: one folder per album, named
    // `Artist - Album`, with the tracks inside. Without this, every album groups under
    // an artist literally named "Artist - Album" — browsable albums, no artists.
    const userId = await seedUser('DerivedFlat');
    const libraryId = await seedLibrary(userId, 'LDF');
    await indexSong(libraryId, 'Radiohead - OK Computer/01 Airbag.opus');

    const row = await new SongDAO(handle.db).findById(songId(libraryId, 'Radiohead - OK Computer/01 Airbag.opus'));
    expect(row?.album).toBe('OK Computer');
    expect(row?.artist).toBe('Radiohead (derived)');
  });

  it('splits on the FIRST separator only, so an album title with a dash survives', async () => {
    const userId = await seedUser('DerivedDash');
    const libraryId = await seedLibrary(userId, 'LDD');
    await indexSong(libraryId, 'Mahler - Symphony No. 5 - 1949 Recording/01 I.opus');

    const row = await new SongDAO(handle.db).findById(songId(libraryId, 'Mahler - Symphony No. 5 - 1949 Recording/01 I.opus'));
    expect(row?.album).toBe('Symphony No. 5 - 1949 Recording');
    expect(row?.artist).toBe('Mahler (derived)');
  });

  it('never overwrites a real tag, on a rescan or otherwise', async () => {
    // The `COALESCE` is the entire safety argument for deriving on *every* index
    // rather than only on first sight. If this were a plain assignment in the SET list,
    // a rescan would roll every tagged row back to a path guess — and the symptom
    // would be a library that loses its tags every time a file's mtime moves.
    const userId = await seedUser('DerivedNoClobber');
    const libraryId = await seedLibrary(userId, 'LDN2');
    const path = 'Bonobo/Black Sands/01 Kerala.opus';
    const songs = new SongDAO(handle.db);
    const id = songId(libraryId, path);

    await indexSong(libraryId, path);
    await songs.applyMetadata(id, { artist: 'Bonobo', album: 'Black Sands (Remastered)', albumArtist: 'Bonobo', genre: 'Electronic' });

    // Re-index the same file with a changed mtime, which is what a rescan does.
    await songs.upsertFileFacts([
      { id, libraryId, path, dirPath: 'Bonobo/Black Sands', name: '01 Kerala.opus', size: 2000, mtimeMs: 2000, contentType: 'audio/ogg', suffix: 'ogg' },
    ]);

    const row = await songs.findById(id);
    expect(row?.artist).toBe('Bonobo');
    expect(row?.album).toBe('Black Sands (Remastered)');

    // The `_ci` twins too, and separately: they are independent assignments in the same
    // statement, so a guard on the display column proves nothing about them. A drifted
    // twin makes the row invisible to `getArtists` while `getAlbum` still names it.
    expect(row?.artist_ci).toBe('bonobo');
    expect(row?.album_ci).toBe('black sands (remastered)');

    // Provenance is not lost either: the mtime change cleared `enriched_at`, so the
    // row is re-read and the real values are written back on top of the derived ones.
    expect(row?.enriched_at).toBeNull();
  });

  it('derives nothing for a track at the library root, rather than grouping under a blank name', async () => {
    // A NULL column is a row that is absent from the aggregates. An *empty* column is
    // a row grouped under "", which `getArtists` renders as an unlabelled entry at the
    // top of the `#` group — the same defect `NodeDAO.listRoots` had with the library
    // root. So an uninformative path yields NULL, not ''.
    const userId = await seedUser('DerivedRoot');
    const libraryId = await seedLibrary(userId, 'LDR');
    await indexSong(libraryId, 'loose-track.opus');

    const row = await new SongDAO(handle.db).findById(songId(libraryId, 'loose-track.opus'));
    expect(row?.album).toBeNull();
    expect(row?.artist).toBeNull();
    expect(row?.album_ci).toBeNull();
  });

  it('does not derive a genre, because a guessed genre is worse than an absent one', async () => {
    // `getGenres` publishes a song count beside the name, so a derived value would be
    // offered to the user as fact. There is no path convention for genre, track or
    // year that is not a guess, so none is derived.
    const userId = await seedUser('DerivedNoGenre');
    const libraryId = await seedLibrary(userId, 'LDG');
    await indexSong(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');

    const row = await new SongDAO(handle.db).findById(songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'));
    expect(row?.genre).toBeNull();
    expect(row?.genre_ci).toBeNull();
    expect(row?.track).toBeNull();
    expect(row?.year).toBeNull();
    expect(await new SongIndexDAO(handle.db).listGenres(libraryId)).toEqual([]);
  });

  it('is stable, so a rescan of an unchanged folder writes no different value', async () => {
    // Incrementality depends on this: the same path must always derive the same
    // string, or every scan would rewrite every grouping column and the "unchanged
    // rescan costs zero rows" guarantee would be a comment rather than a fact.
    const first = deriveFromPath('Bonobo/Black Sands');
    const second = deriveFromPath('Bonobo/Black Sands');
    expect(first).toEqual(second);
    // And the marker is part of the value, so a client can tell derived from tagged.
    expect(first.artist).toContain(DERIVED_MARKER);
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
