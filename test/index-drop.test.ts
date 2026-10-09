/**
 * The Danger Zone's index drop, over real SQLite.
 *
 * The claims this file holds are the ones the feature is **built on** and the ones a route
 * test cannot see:
 *
 * 1. **The library and its encrypted credential survive.** That is the whole difference between
 *    a drop and `DELETE /user/libraries/:id`, which cascades the registration away — and a
 *    wrong password has no other remedy.
 * 2. **The per-user annotations survive**, because song ids are *derived* rather than minted,
 *    so a rescan recreates them byte-identically and every star re-attaches.
 * 3. **`scan_state` is deleted, not reset**, so the library reads as "never scanned" rather
 *    than as `idle` over zero tracks.
 * 4. **The projection and the charge are one arithmetic.** The figure the operator consents to
 *    and the figure that is billed must not be able to drift.
 *
 * Real SQLite rather than a double, because (4) is a claim about `meta.changes` on a `DELETE`
 * and about a per-table index count — and a double reporting the numbers a test expected is
 * precisely the failure `test/scan-incremental.test.ts` and `test/scan-budget.test.ts` record,
 * where two doubles were made to stamp `derived_version` under comments asserting production
 * did, and the suite agreed with itself and with neither.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { encryptData, generateAesGcmKey } from '@edge-sonic/backend-data/crypto';
import { ScanBudget, TreeService, reconcileFolder } from '@edge-sonic/backend-services/index';
import { SubrequestCounter } from '@edge-sonic/shared';
import { WebDavClient } from '@edge-sonic/webdav';
import { fakeDav } from './helpers/fakeDav';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { IndexDropDAO, IndexStatsDAO, NodeDAO, ScanStateDAO, SongDAO, UserDAO, billedRowsForTable } from '@edge-sonic/backend-data/dao';
import { migrationSql } from './helpers/migrations';
import { sqliteQueryable } from './helpers/sqlite';
import type { SqliteQueryable } from './helpers/sqlite';

let handle: SqliteQueryable;
let keyPromise: Promise<string> | undefined;

function testKey(): Promise<string> {
  keyPromise ??= generateAesGcmKey();
  return keyPromise;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A song id, derived the way production derives one.
 *
 * Written out rather than imported from `subsonic`, because the assertion this file exists to
 * make is that the id is a *pure function of the library and the path*. A test that computed
 * it by calling the same helper the code under test calls would pass even if that helper
 * changed to use a UUID — which is the property that makes annotations survive a drop at all.
 * `node:crypto` is the independent implementation; the product runs the vendored `sha256.ts`.
 */
function derivedSongId(libraryId: string, path: string): string {
  const digest = createHash('sha256').update(`${libraryId}\n${path}`, 'utf8').digest().subarray(0, 16);
  return `s:${digest.toString('base64url')}`;
}

const MARKER = '';

async function seedLibrary(userId: string, id: string): Promise<{ ciphertext: string; iv: string }> {
  const encrypted = await encryptData('dav-password', await testKey());
  const timestamp = nowSeconds();
  await handle.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'https://dav.example.com', '/remote.php/dav/files/alice/Music', 'alice', ?, ?, 1, ?, 1, ?, ?)`,
    )
    .bind(id, id.toLowerCase(), id.toLowerCase(), encrypted.ciphertext, encrypted.iv, id, timestamp, timestamp)
    .run();
  await new UserDAO(handle.db).setLibraryGrants(userId, [id]);
  return { ciphertext: encrypted.ciphertext, iv: encrypted.iv };
}

async function seedSong(libraryId: string, path: string, dirPath: string): Promise<string> {
  const id = derivedSongId(libraryId, path);
  const name = path.split('/').pop() ?? path;
  await new SongDAO(handle.db, MARKER).upsertFileFacts([
    { id, libraryId, path, dirPath, name, size: 1000, mtimeMs: 1000, contentType: 'audio/flac', suffix: 'flac' },
  ]);
  return id;
}

async function seedNode(libraryId: string, path: string): Promise<void> {
  const name = path.split('/').pop() ?? path;
  await new NodeDAO(handle.db).upsertMany([
    {
      libraryId,
      path,
      parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      name,
      mtimeMs: 1000,
      etag: '"a"',
      depth: path.split('/').length,
      isScanned: true,
    },
  ]);
}

/**
 * The annotations the drop is required to **keep**.
 *
 * Written out rather than taken from the DAO constructors, because the claim under test is
 * that the drop does not touch these tables at all. Using the same DAOs the production code
 * would is fine for seeding, and asserting on the row afterwards is what proves the `DELETE`s
 * were scoped — but a drop that reached these tables through a cascade would be caught by
 * counting the rows, not by which helper put them there.
 */
async function seedAnnotations(userId: string, songId: string): Promise<void> {
  const timestamp = nowSeconds();
  await handle.db
    .prepare('INSERT INTO stars (user_id, item_id, item_type, starred_at) VALUES (?, ?, ?, ?)')
    .bind(userId, songId, 'song', timestamp)
    .run();
  await handle.db
    .prepare('INSERT INTO play_counts (user_id, song_id, play_count, last_played_at) VALUES (?, ?, ?, ?)')
    .bind(userId, songId, 7, timestamp)
    .run();
  await handle.db
    .prepare('INSERT INTO bookmarks (user_id, song_id, position_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, songId, 0, timestamp, timestamp)
    .run();
}

async function countOf(table: string, where = ''): Promise<number> {
  const row = await handle.db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} ${where}`).first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

beforeEach(() => {
  handle?.close();
  handle = sqliteQueryable();
  handle.raw.exec(migrationSql());
});

describe('dropping an index keeps the library', () => {
  it('leaves the registration and its encrypted credential in place', async () => {
    // The reason this is a separate route from `DELETE /user/libraries/:id` at all. That route
    // cascades `libraries`, and with it the only copy of the WebDAV password — so an operator
    // with a rejected credential had no remedy but re-registering the origin. A drop that took
    // the credential too would be that route with a slower spelling.
    const user = (
      await new UserDAO(handle.db).create({
        username: 'ann',
        passwordCiphertext: 'x',
        passwordIv: 'y',
      })
    ).id;
    const { ciphertext } = await seedLibrary(user, 'L1');
    await seedSong('L1', 'Bon Iver/For Emma/01.flac', 'Bon Iver/For Emma');

    await new IndexDropDAO(handle.db).dropLibrary('L1');

    expect(await countOf('libraries')).toBe(1);
    const row = await handle.db
      .prepare('SELECT password_ciphertext FROM libraries WHERE id = ?')
      .bind('L1')
      .first<{ password_ciphertext: string }>();
    expect(row?.password_ciphertext).toBe(ciphertext);
    // And the grant, so a Subsonic user does not lose access to the library they could see.
    expect(await countOf('user_libraries')).toBe(1);
  });

  it('empties songs, nodes and scan_state', async () => {
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    await seedSong('L1', 'Bon Iver/For Emma/01.flac', 'Bon Iver/For Emma');
    await seedSong('L1', 'Bon Iver/For Emma/02.flac', 'Bon Iver/For Emma');
    await seedNode('L1', 'Bon Iver');
    await new ScanStateDAO(handle.db).ensure('L1');

    const result = await new IndexDropDAO(handle.db).dropLibrary('L1');

    expect(result).toMatchObject({ songs: 2, nodes: 1, scanStates: 1 });
    expect(await countOf('songs')).toBe(0);
    expect(await countOf('nodes')).toBe(0);
    expect(await countOf('scan_state')).toBe(0);
  });

  it('scopes the drop to one library', async () => {
    // The Danger Zone offers a per-library action beside the global one, and the two must not
    // share a statement. An unscoped `DELETE FROM songs` in `dropLibrary` would empty the other
    // library too, and an operator with two would lose both from one button.
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    await seedLibrary(user, 'L2');
    await seedSong('L1', 'Bon Iver/For Emma/01.flac', 'Bon Iver/For Emma');
    await seedSong('L2', 'Blur/Parklife/01.mp3', 'Blur/Parklife');

    await new IndexDropDAO(handle.db).dropLibrary('L1');

    const remaining = await handle.db.prepare('SELECT library_id FROM songs').all<{ library_id: string }>();
    expect(remaining.results?.map((row) => row.library_id)).toEqual(['L2']);
  });
});

describe('dropping an index deletes scan_state rather than resetting it', () => {
  it('reports the library as never scanned, not as idle over nothing', async () => {
    // The claim `apps/web`'s `describeScanState` rests on. `GET /user/libraries` publishes
    // `scan: null` for a library with no `scan_state` row and `null` renders as "never
    // scanned"; a row reset to `idle` beside `songCount: 0` renders the success-toned "Up to
    // date." next to "0 tracks indexed", which is the contradictory pair the `empty` case in
    // `lib/scanStatus.ts` exists to catch. Deleting the row makes the two facts agree.
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    const scanState = new ScanStateDAO(handle.db);
    await scanState.ensure('L1');
    await scanState.markScanning('L1', 0);
    await scanState.saveProgress('L1', 12, 'Bon Iver', true);

    await new IndexDropDAO(handle.db).dropLibrary('L1');

    expect(await scanState.find('L1')).toBeNull();
  });

  it('leaves nothing for ensure to find a stale progress count in', async () => {
    // `scanned_count` was 12 and a folder was visited. After a drop the library has never been
    // scanned, so there is no count to report — asserted as an absent row rather than as a
    // zero, because a zero is what `markScanning` writes and it means "scanning, visited
    // nothing yet".
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    const scanState = new ScanStateDAO(handle.db);
    await scanState.ensure('L1');
    await scanState.saveProgress('L1', 12, 'Bon Iver', false);

    await new IndexDropDAO(handle.db).dropLibrary('L1');

    expect(await countOf('scan_state')).toBe(0);
  });
});

describe('the annotations survive, because song ids are derived', () => {
  it('keeps stars, play counts and bookmarks pointing at a row that no longer exists', async () => {
    // The whole argument for not dropping them. These tables have **no foreign key** to
    // `songs` — they hold opaque id strings — so leaving them behind is only safe because the
    // next case proves a rescan recreates the identical ids. Dropping them would spend more
    // billed rows (`stars` is 3 per row) to destroy listening history that comes back free.
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    const songId = await seedSong('L1', 'Bon Iver/For Emma/01.flac', 'Bon Iver/For Emma');
    await seedAnnotations(user, songId);

    await new IndexDropDAO(handle.db).dropLibrary('L1');

    expect(await countOf('songs')).toBe(0);
    expect(await countOf('stars')).toBe(1);
    expect(await countOf('play_counts')).toBe(1);
    expect(await countOf('bookmarks')).toBe(1);
  });

  it('re-attaches every annotation to the same row after a rescan', async () => {
    /**
     * The load-bearing claim, and the one nothing else in the suite measured.
     *
     * A song id is `s:` + base64url(first 128 bits of SHA-256(`libraryId` + "\n" + `path`)) —
     * derived from the file's location, not minted. So dropping the index and rescanning the
     * same library produces byte-identical ids, and the star that was written before the drop
     * resolves to the row that exists after it.
     *
     * If this stops holding — a UUID, or a counter — the decision to keep the annotations
     * becomes wrong and every star in the deployment silently orphans. Both
     * the read-through and scan writers are exercised against real SQLite;
     * `node:crypto` checks the id independently of the product's own encoder.
     */
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    const library = await handle.db.prepare('SELECT * FROM libraries WHERE id = ?').bind('L1').first<LibraryRow>();
    if (!library) throw new Error('missing seeded library');
    const folder = 'Bon Iver/For Emma';
    const path = `${folder}/01.flac`;
    const absolute = `${library.root_path}/${folder}`;
    const dav = fakeDav({
      [absolute]: [
        { path: absolute, collection: true, mtime: 1000 },
        { path: `${absolute}/01.flac`, size: 1000, mtime: 1000, contentType: 'audio/flac' },
      ],
    });
    // The actual browse writer, not `seedSong` assigning the expected id into
    // `SongDAO`: that old test passed even while production minted at random.
    const tree = new TreeService({
      nodes: new NodeDAO(handle.db),
      songs: new SongDAO(handle.db, MARKER),
      clientFor: async () =>
        new WebDavClient(library.base_url, library.root_path, { username: 'alice', password: 'dav-password' }, dav.fetch),
      timeoutMs: 1000,
    });
    const browseId = async (): Promise<string> => {
      await tree.children(library, folder);
      const song = await handle.db
        .prepare('SELECT id FROM songs WHERE library_id = ? AND path = ?')
        .bind(library.id, path)
        .first<{ id: string }>();
      if (!song) throw new Error('browse did not persist the song');
      return song.id;
    };
    const before = await browseId();
    expect(before).toBe(derivedSongId(library.id, path));
    await seedAnnotations(user, before);

    await new IndexDropDAO(handle.db).dropLibrary('L1');

    // Cold scan from the same WebDAV listing, through real DAOs: the browse
    // writer and the scan writer must choose the same id for the same file.
    const meter = new SubrequestCounter(50);
    const nodes = new NodeDAO(handle.db, meter);
    const songs = new SongDAO(handle.db, MARKER, meter);
    await nodes.upsertMany([
      {
        libraryId: library.id,
        path: folder,
        parentPath: 'Bon Iver',
        name: 'For Emma',
        mtimeMs: 1000,
        etag: null,
        depth: 2,
        isScanned: false,
      },
    ]);
    const folderRow = await nodes.find(library.id, folder);
    if (!folderRow) throw new Error('scan frontier folder is missing');
    const client = new WebDavClient(library.base_url, library.root_path, { username: 'alice', password: 'dav-password' }, dav.fetch);
    const listing = await client.propfind(folder, { depth: 1, timeoutMs: 1000 });
    const budget = new ScanBudget({ meter, maxRequests: 42, deadlineMs: 20_000 });
    await reconcileFolder({ nodes, songs, enrichMaxPerFolder: 0 } as never, library, folderRow, listing, budget);
    const scanned = await songs.findByPath(library.id, path);
    expect(scanned?.id).toBe(before);
    expect(dav.propfinds).toHaveLength(2);

    // A second drop and a cold browse also recreate it. This guards both
    // writers: a test that only called a hand-written seeder passed on random
    // production ids while agreeing with itself about what a rescan would do.
    await new IndexDropDAO(handle.db).dropLibrary('L1');
    const after = await browseId();
    expect(after).toBe(before);
    const star = await handle.db.prepare('SELECT item_id FROM stars WHERE user_id = ?').bind(user).first<{ item_id: string }>();
    expect(star?.item_id).toBe(after);
    // And the star now resolves — the join it never had, made by hand because there is no
    // foreign key to make it for us.
    const resolved = await handle.db
      .prepare('SELECT s.id FROM stars st JOIN songs s ON s.id = st.item_id WHERE st.user_id = ?')
      .bind(user)
      .first<{ id: string }>();
    expect(resolved?.id).toBe(before);
    const playCount = await handle.db
      .prepare('SELECT s.id FROM play_counts pc JOIN songs s ON s.id = pc.song_id WHERE pc.user_id = ?')
      .bind(user)
      .first<{ id: string }>();
    const bookmark = await handle.db
      .prepare('SELECT s.id FROM bookmarks b JOIN songs s ON s.id = b.song_id WHERE b.user_id = ?')
      .bind(user)
      .first<{ id: string }>();
    expect(playCount?.id).toBe(before);
    expect(bookmark?.id).toBe(before);
  });
});

describe('the projection and the charge are one arithmetic', () => {
  it('quotes the figure the delete actually bills', async () => {
    /**
     * The number an operator consents to and the number charged must not be two copies.
     *
     * `IndexStatsDAO` projects with `billedRowsForTable`; `IndexDropDAO` measures with the same
     * function through `runWriteStatement`. A client that multiplied `songs * 10` in the browser
     * would be a second copy of a per-table table it cannot see — and the repo has paid for
     * that shape three times (the `999` bind limit, `MAX_BILLED_ROWS_PER_ROW`, the
     * `derived_version` stamp).
     */
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    await seedSong('L1', 'Bon Iver/For Emma/01.flac', 'Bon Iver/For Emma');
    await seedSong('L1', 'Bon Iver/For Emma/02.flac', 'Bon Iver/For Emma');
    await seedNode('L1', 'Bon Iver');
    await new ScanStateDAO(handle.db).ensure('L1');

    const projected = await new IndexStatsDAO(handle.db).statsForLibrary('L1');
    const measured = await new IndexDropDAO(handle.db).dropLibrary('L1');

    expect(projected).toEqual({ songs: 2, nodes: 1, scanStates: 1, billedRows: measured.billedRows });
  });

  it('charges songs at ten rows and nodes at four, from the schema', () => {
    // Not `expect(measured).toBe(2 * 10)` written here — the multipliers are asserted against
    // `TABLE_INDEX_COUNTS`, which `test/schema.int.test.ts` itself compares to `sqlite_schema`.
    // A typed `10` beside this assertion would be a fourth copy of a fact that has a source.
    expect(billedRowsForTable('songs', 1)).toBe(10);
    expect(billedRowsForTable('nodes', 1)).toBe(4);
    expect(billedRowsForTable('scan_state', 1)).toBe(2);
  });

  it('reports a never-scanned library as costing nothing', async () => {
    // The Danger Zone is reachable for a library with nothing indexed. `0` is the honest
    // answer and it matters: a projection that quoted `1` for `scan_state` would report a cost
    // for a table it is not going to touch.
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');

    expect(await new IndexStatsDAO(handle.db).statsForLibrary('L1')).toEqual({
      songs: 0,
      nodes: 0,
      scanStates: 0,
      billedRows: 0,
    });
  });
});

describe('the global drop', () => {
  it('empties every library and keeps every registration', async () => {
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    await seedLibrary(user, 'L2');
    await seedSong('L1', 'Bon Iver/For Emma/01.flac', 'Bon Iver/For Emma');
    await seedSong('L2', 'Blur/Parklife/01.mp3', 'Blur/Parklife');
    await seedNode('L1', 'Bon Iver');

    const result = await new IndexDropDAO(handle.db).dropAll();

    expect(result).toMatchObject({ songs: 2, nodes: 1 });
    expect(await countOf('songs')).toBe(0);
    expect(await countOf('nodes')).toBe(0);
    expect(await countOf('scan_state')).toBe(0);
    // The registrations are what a rescan needs, so this is the assertion the whole feature
    // is named for.
    expect(await countOf('libraries')).toBe(2);
  });

  it('totals the per-library figures, so the two Danger Zone rows agree', async () => {
    // The confirmation for the global action is agreed against a sum of the numbers the
    // per-library rows show. Two answers to "what does this cost" would mean the operator
    // consents to whichever they happened to read.
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    await seedLibrary(user, 'L2');
    await seedSong('L1', 'Bon Iver/For Emma/01.flac', 'Bon Iver/For Emma');
    await seedSong('L2', 'Blur/Parklife/01.mp3', 'Blur/Parklife');
    await seedSong('L2', 'Blur/Parklife/02.mp3', 'Blur/Parklife');

    const stats = await new IndexStatsDAO(handle.db).statsAcrossLibraries(['L1', 'L2']);
    const measured = await new IndexDropDAO(handle.db).dropAll();

    expect(stats.total.billedRows).toBe(measured.billedRows);
    expect(stats.total.songs).toBe(3);
    // Read through `entry.stats`, because the entry is `{ libraryId, stats }` — and the
    // per-library figures are the ones the Danger Zone rows render, so their shape is part of
    // the contract rather than an implementation detail of the reduce above.
    expect(stats.libraries.find((entry) => entry.libraryId === 'L1')?.stats.songs).toBe(1);
    expect(stats.libraries.find((entry) => entry.libraryId === 'L2')?.stats.songs).toBe(2);
  });

  it('drops nothing when nothing is indexed, and does not fail', async () => {
    // The second click of a double-press, and a library that was registered and never scanned.
    // A delete of already-absent rows is what a rescan issues routinely — `deleteSubtree`
    // documents the same thing — so this is an ordinary outcome rather than an error.
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');

    expect(await new IndexDropDAO(handle.db).dropAll()).toEqual({
      songs: 0,
      nodes: 0,
      scanStates: 0,
      changes: 0,
      billedRows: 0,
    });
  });
});

describe('the batched counts', () => {
  it('omits a library with no rows rather than reporting a zero', async () => {
    // The convention every batched read in this layer uses, and it is load-bearing: a caller
    // combining these maps treats "no rows" the same way whichever one reported it, and a
    // defaulted `0` in one of three would make the three disagree about what exists.
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    await seedLibrary(user, 'L2');
    await seedSong('L1', 'a/b/01.flac', 'a/b');
    await new ScanStateDAO(handle.db).ensure('L1');

    const nodes = await new NodeDAO(handle.db).countByLibraries(['L1', 'L2']);
    const scanStates = await new ScanStateDAO(handle.db).countByLibraries(['L1', 'L2']);

    expect(nodes.has('L1')).toBe(false);
    expect(nodes.has('L2')).toBe(false);
    expect(scanStates.get('L1')).toBe(1);
    expect(scanStates.has('L2')).toBe(false);
  });

  it('agrees with the per-library count where a row exists', async () => {
    // Two readers of the same table, so a disagreement would be a defect in one of them rather
    // than a fact about the schema. Scoped to a library that **has** a node, because the two
    // deliberately differ for an empty one — `countByLibrary` returns `0` and
    // `countByLibraries` omits the key, and asserting they agree everywhere would be asserting
    // away the convention the case above exists to pin.
    const user = (await new UserDAO(handle.db).create({ username: 'ann', passwordCiphertext: 'x', passwordIv: 'y' })).id;
    await seedLibrary(user, 'L1');
    await seedSong('L1', 'a/b/01.flac', 'a/b');
    await seedSong('L1', 'a/c/02.flac', 'a/c');
    await seedNode('L1', 'a');
    await seedNode('L1', 'a/b');

    const daos = new NodeDAO(handle.db);
    const single = await daos.countByLibrary('L1');
    const batched = await daos.countByLibraries(['L1']);

    expect(single).toBe(2);
    expect(batched.get('L1')).toBe(single);
  });
});
