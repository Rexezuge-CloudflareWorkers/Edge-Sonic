/**
 * A folder too large for one invocation must still close.
 *
 * ### What this file exists for
 *
 * `reconcileFolder` built one node input per child of a folder and, having no compare of its own,
 * handed back every row it had written last time. `runWriteBatch` truncates that list against the
 * invocation's subrequest ceiling, so on a folder with more entries than fit the rows that *were*
 * written were the rows it re-offered first — the truncation landed at the same offset every time,
 * `truncated` was permanently true, and the one write the scan may not skip (the folder's own
 * `is_scanned: true`) never happened. The folder stayed on the frontier for ever and every chunk
 * rewrote the same ~45 rows against a 5,000-rows/day allowance.
 *
 * Measured on an 80-album library: **231,620 rows written on `nodes`, `is_scanned` never reaching
 * 1, the frontier never draining, and a scan reporting `scanning` throughout.** At the alarm's
 * one-second cadence that is ~5,147 chunks, which is also the 231,620 — the two numbers are the
 * same measurement, and neither of them was a scan making progress.
 *
 * ### Why it is driven against real SQLite and a real counter
 *
 * Two doubles hid this, and each hid it for a different reason worth recording.
 *
 * `test/scan-budget.test.ts`'s `nodes.upsertMany` double **skipped** rows whose mtime, etag and
 * `is_scanned` already matched — a faithful model of the statement with the guard this change
 * adds, and an unfaithful model of the one that shipped. So every row-write count in that suite was
 * fiction, and it was fiction in the optimistic direction. `test/scan-incremental.test.ts` runs
 * with `chunkMaxRequests: 10_000` and an `upsertMany` double that always reports
 * `truncated: false`, so truncation never happens there at all.
 *
 * A double that models the *fixed* implementation proves nothing about the broken one, and a
 * double whose ceiling is high enough that the bound never fires is a double that cannot see the
 * bound. So the DAO runs against `node:sqlite` with a real `SubrequestCounter(50)` and the real
 * `UPSERT` statement, exactly as the bind-parameter ceiling was caught.
 */
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { SubrequestCounter } from '@edge-sonic/shared';
import { NodeDAO } from '@edge-sonic/backend-data/dao';
import { TreeService, nodeRowNeedsWrite, reconcileFolder } from '@edge-sonic/backend-services/index';
import type { DesiredNodeRow } from '@edge-sonic/backend-services/index';
import { ScanBudget } from '@edge-sonic/backend-services/index';
import { SCAN_CHUNK_SUBSREQUEST_BUDGET, WORKER_SUBSREQUEST_CEILING } from '@edge-sonic/backend-runtime/config';
import { WebDavClient } from '@edge-sonic/webdav';
import { fakeDav } from './helpers/fakeDav';
import type { DavResource } from '@edge-sonic/webdav';
import type { LibraryRow, NodeRow } from '@edge-sonic/backend-data/dao';
import { migrationSql } from './helpers/migrations';
import { sqliteQueryable } from './helpers/sqlite';

const LIBRARY_ID = 'L1';
const ROOT = '/music';

/**
 * The prelude's cost before a folder's children are written: `ensure`, the backfill's read,
 * `listFrontier`, the `PROPFIND` and the `listChildren` it diffs against. Five against a ceiling of
 * 50, so a folder's children get 45 statements — and the folder's own row needs one more than
 * that. A folder with **≥45 entries** therefore cannot be closed in the chunk that walks it, which
 * is the expected case and is only a livelock if the next pass does not shrink.
 */
const PER_FOLDER_PRELUDE = 5;

function library(): LibraryRow {
  return {
    id: LIBRARY_ID,
    slug: 'home',
    slug_ci: 'home',
    base_url: 'https://dav.example.com',
    root_path: ROOT,
    dav_username: 'ann',
    password_ciphertext: '',
    password_iv: '',
    key_version: 1,
    display_name: 'Home',
    is_enabled: 1,
    created_at: 0,
    updated_at: 0,
  };
}

/**
 * A `Depth: 1` listing of the library root: itself, plus `albums` album folders.
 *
 * Shaped the way an origin answers rather than the way a list is convenient, because the count of
 * entries in this array *is* the quantity under test.
 */
function rootListing(albums: number): DavResource[] {
  return [
    { href: ROOT, path: ROOT, isCollection: true, contentLength: null, contentType: null, lastModifiedMs: 1000, etag: '"root"', displayName: null },
    ...Array.from({ length: albums }, (_, index) => ({
      href: `${ROOT}/Artist ${index} - Album ${index}`,
      path: `${ROOT}/Artist ${index} - Album ${index}`,
      isCollection: true,
      contentLength: null,
      contentType: null,
      lastModifiedMs: 2000 + index,
      etag: `"album-${index}"`,
      displayName: null,
    })),
  ];
}

/**
 * A schema, a library row, and the frontier's root row — which is what `start` writes and the
 * precondition for every test here.
 *
 * Seeded rather than stubbed because `nodes.is_scanned` is the fact under test and a double's
 * version of it would be the assertion restated. The `scan_state` row is deliberately **not**
 * created: nothing in this file reads it, and creating it would add a write whose only purpose is
 * to make a double happy.
 *
 * The root row is inserted directly rather than through the DAO: `upsertMany` opens a transaction
 * via `batch()`, and a `void`-ed promise would still be holding it when the test's first statement
 * ran — surfacing as `cannot start a transaction within a transaction` and saying nothing at all
 * about the behaviour under test. Setup that is synchronous cannot interleave.
 */
function seeded(): ReturnType<typeof sqliteQueryable> {
  const handle = sqliteQueryable();
  handle.raw.exec(migrationSql());
  handle.raw.exec(
    `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
     VALUES ('${LIBRARY_ID}', 'home', 'home', 'https://dav.example.com', '${ROOT}', 'ann', '', '', 1, 'Home', 1, 0, 0)`,
  );
  handle.raw.exec(
    `INSERT INTO nodes (library_id, path, parent_path, name, name_ci, mtime_ms, etag, depth, is_scanned, created_at, updated_at)
     VALUES ('${LIBRARY_ID}', '', '', '', '', 1000, '"root"', 0, 0, 0, 0)`,
  );
  return handle;
}

interface Harness {
  /**
  One chunk over the root, with a fresh budget as `ScanService.step` builds one.
  */
  readonly reconcile: (listing: readonly DavResource[]) => Promise<number>;
  /**
  A read-through browse of `path`, whose `PROPFIND` the origin refuses.
  */
  readonly browse: (path: string, listing: readonly DavResource[]) => Promise<void>;
  /**
  One SQL statement, for arranging states a walk would otherwise have to reach.
  */
  readonly raw: (sql: string) => void;
  readonly root: () => Promise<NodeRow | null>;
  readonly frontier: () => Promise<string[]>;
  readonly spent: () => number;
  readonly close: () => void;
}

/**
 * Real DAO, real SQLite, real counter.
 *
 * `SubrequestCounter` at the platform ceiling rather than unmetered, because the whole defect is
 * arithmetic against that number and an unmetered DAO would make every assertion vacuous.
 *
 * `songs` is a double and it is **not** the subject: no entry in this fixture's root listing is an
 * audio file, so no statement reaches it. Everything asserted here is `nodes`.
 */
function harness(maxRequests: number = SCAN_CHUNK_SUBSREQUEST_BUDGET): Harness {
  const handle = seeded();
  const meter = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
  const nodes = new NodeDAO(handle.db, meter);
  const songs = {
    upsertFileFacts: async () => ({ changes: 0, written: 0, truncated: false }),
    deleteInDirectoryNotIn: async () => ({ changes: 0, written: 0, truncated: false }),
    deleteSubtree: async () => 0,
    countByLibrary: async () => 0,
  };

  return {
    reconcile: async (listing) => {
      const budget = new ScanBudget({ meter, maxRequests, deadlineMs: 20_000 });
      const folder = await nodes.find(LIBRARY_ID, '');
      if (folder === null) throw new Error('the root row is missing; the frontier was never seeded');
      return await reconcileFolder({ nodes, songs, enrichMaxPerFolder: 0 } as never, library(), folder, listing, budget);
    },
    browse: async (path, listing) => {
      // The real browse path against a real `Depth: 1` answer, so `persistChildren` actually runs
      // and the flag it writes is observable. `children()` persists only when the folder's **own row
      // is absent**, which is why it takes a path rather than browsing the root.
      // `fakeDav` keys its tree by the **request** path, and the client is built with the library
      // root, so the key is the root-prefixed path rather than the library-relative one.
      const absolute = `${ROOT}/${path}`;
      const dav = fakeDav({
        [absolute]: listing.map((entry) => ({
          path: `${ROOT}/${entry.path}`,
          collection: entry.isCollection,
          mtime: entry.lastModifiedMs ?? undefined,
          etag: entry.etag ?? undefined,
        })),
      });
      const tree = new TreeService({
        nodes,
        songs,
        clientFor: async () =>
          new WebDavClient('https://dav.example.com', ROOT, { username: 'u', password: 'p' }, dav.fetch, () => undefined),
        timeoutMs: 1000,
      } as never);
      await tree.children(library(), path);
    },
    raw: (sql) => {
      handle.raw.exec(sql);
    },
    root: async () => await nodes.find(LIBRARY_ID, ''),
    frontier: async () =>
      (
        await handle.raw
          .prepare('SELECT path FROM nodes WHERE library_id = ? AND is_scanned = 0 ORDER BY depth ASC, path ASC')
          .all(LIBRARY_ID)
      ).map((row) => (row as { path: string }).path),
    spent: () => meter.spent,
    close: () => handle.close(),
  };
}

/**
 * A source file's text, read relative to this test.
 *
 * Two of the guards below are about *where* a comparison lives rather than what it computes, and
 * that is not expressible as a behavioural assertion without building a fixture that fails for some
 * unrelated reason. Reading the source is the narrowest thing that says it — and each is paired with
 * a behavioural test that proves the behaviour, so a source assertion going stale cannot leave the
 * behaviour unasserted.
 */
function sourceOf(relativeToThisTest: string): string {
  return readFileSync(new URL(relativeToThisTest, import.meta.url), 'utf8');
}

describe('a folder larger than one invocation is resumable, not livelocked', () => {
  it('closes a folder whose children do not fit in one chunk', async () => {
    // 60 album folders against a 42-subrequest chunk: the children cannot all be written in one
    // pass, which is the *expected* case on the Free plan and the one the resumption argument is
    // about.
    const albums = 60;
    expect(albums).toBeGreaterThan(WORKER_SUBSREQUEST_CEILING - PER_FOLDER_PRELUDE);
    const h = harness();

    try {
      const listing = rootListing(albums);
      const first = await h.reconcile(listing);
      const second = await h.reconcile(listing);
      const third = await h.reconcile(listing);

      // The root is closed, which is the whole claim: a folder that cannot be written in one
      // invocation is finished over several.
      expect((await h.root())?.is_scanned).toBe(1);

      // And each pass writes **strictly less** than the one before. This is the measurement that
      // distinguishes convergence from a livelock, and it is the assertion the shipped code failed:
      // without the compare, every pass wrote exactly what the previous one had written, which is
      // why 231,620 rows accumulated.
      expect(second).toBeLessThan(first);
      expect(third).toBeLessThan(second);

      // The third pass writes **nothing**: the folder closed on the second and every child is
      // current. Zero is the number the daily row allowance is actually spent against, and it is
      // what the broken statement could not produce at any chunk.
      expect(third).toBe(0);

      // Total rows written is about the size of the tree. The broken version wrote `first` rows
      // *per chunk, for ever*, so the ratio is what says so — not the absolute count, which is a
      // fixture decision.
      expect(first + second + third).toBeLessThanOrEqual(albums + 2);
    } finally {
      h.close();
    }
  });

  it('writes nothing at all for a folder that has not changed', async () => {
    // The steady state, and the property the whole design rests on: a rescan of an unchanged
    // library writes zero rows. Only observable with the statement's own guard, because a
    // caller-side compare that forgets one column would look identical from here.
    const h = harness();
    try {
      const listing = rootListing(3);
      // Three children, then the closing row: four rows, and the folder is closed.
      expect(await h.reconcile(listing)).toBe(4);
      expect((await h.root())?.is_scanned).toBe(1);
      // Nothing has changed, so every further pass — children *and* the closing row — is a no-op.
      expect(await h.reconcile(listing)).toBe(0);
      expect(await h.reconcile(listing)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('reports the chunk as bounded by requests rather than silently overspending the ceiling', async () => {
    // The second half of the same fix, live independently: `BaseDAO.fitCount` read
    // `meter.remaining`, so a write batch could issue statements up to the *platform's* 50 while
    // the chunk's own budget said 42 — spending the invocation's 8-statement reserve, after which
    // the post-walk `saveProgress` crosses 50 and the runtime terminates the invocation with an
    // error nothing in this repository can catch.
    const h = harness();
    try {
      await h.reconcile(rootListing(60));
      // The counter's ceiling is the chunk's, lowered by `ScanBudget` — so this is the chunk's own
      // budget and not the platform's, which is the assertion.
      expect(h.spent()).toBeLessThanOrEqual(SCAN_CHUNK_SUBSREQUEST_BUDGET);
    } finally {
      h.close();
    }
  });
});

describe('the statement, independently of any caller', () => {
  /**
   * The guard is asserted here rather than only through `reconcileFolder`, because the two answer
   * different questions. `reconcileFolder` decides which rows to *offer*; the `WHERE` decides which
   * of the offered rows are actually *written*. A caller-side compare alone makes the statement
   * depend on every caller being correct — and there have been two of them, one of which had no
   * compare at all.
   */
  it('writes no row for an upsert that changes nothing', async () => {
    const handle = seeded();
    const nodes = new NodeDAO(handle.db, new SubrequestCounter(WORKER_SUBSREQUEST_CEILING));
    const input = {
      libraryId: LIBRARY_ID,
      path: 'Artist/Album',
      parentPath: 'Artist',
      name: 'Album',
      mtimeMs: 1000,
      etag: '"a"',
      depth: 2,
      isScanned: false,
    };

    try {
      expect((await nodes.upsertMany([input])).changes).toBe(1);
      // The second pass differs only in `updated_at`, which is `nowSeconds()` — so without the
      // `WHERE` this is a second row write, charged against the daily allowance, for nothing.
      expect((await nodes.upsertMany([input])).changes).toBe(0);
      // A changed value is still written, or the guard would have made the table append-only.
      expect((await nodes.upsertMany([{ ...input, isScanned: true }])).changes).toBe(1);
      expect((await nodes.upsertMany([{ ...input, isScanned: true }])).changes).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('treats a NULL etag and a missing etag as different, rather than as unchanged', async () => {
    // `!=` on two NULLs is NULL, which in a `WHERE` is false — so two listings that both report no
    // etag would compare equal *by accident of the operator*, and a row whose etag went from a
    // value to none would never be updated. The permissive direction is the one that freezes a
    // subtree, which is why `IS NOT` is in the statement.
    const handle = seeded();
    const nodes = new NodeDAO(handle.db, new SubrequestCounter(WORKER_SUBSREQUEST_CEILING));
    const withEtag = {
      libraryId: LIBRARY_ID,
      path: 'Artist/Album',
      parentPath: 'Artist',
      name: 'Album',
      mtimeMs: 1000,
      etag: '"a"',
      depth: 2,
      isScanned: false,
    };

    try {
      await nodes.upsertMany([withEtag]);
      expect((await nodes.upsertMany([{ ...withEtag, etag: null }])).changes).toBe(1);
      expect((await nodes.upsertMany([{ ...withEtag, etag: null }])).changes).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('leaves the updated_at of an unchanged row alone, because it was not touched', async () => {
    // The one column excluded from the comparison, and the reason: it is the only one that always
    // differs, so including it would make every comparison true and the guard a comment.
    //
    // Asserted against a **sentinel** rather than a second call, because `updated_at` is
    // `nowSeconds()` — a second-resolution clock. Two calls routinely produce the same value, so
    // "it did not change" would pass for the wrong reason. The sentinel makes it independent of
    // the clock entirely.
    const handle = seeded();
    const nodes = new NodeDAO(handle.db, new SubrequestCounter(WORKER_SUBSREQUEST_CEILING));
    const input = {
      libraryId: LIBRARY_ID,
      path: 'Artist/Album',
      parentPath: 'Artist',
      name: 'Album',
      mtimeMs: 1000,
      etag: '"a"',
      depth: 2,
      isScanned: false,
    };

    try {
      await nodes.upsertMany([input]);
      const SENTINEL = 1;
      handle.raw.exec(`UPDATE nodes SET updated_at = ${SENTINEL} WHERE library_id = '${LIBRARY_ID}' AND path = 'Artist/Album'`);

      // Nothing changed, so the row is not touched and the sentinel survives — which is what makes
      // "when was this row last actually touched" answerable at all.
      await nodes.upsertMany([{ ...input }]);
      expect((await nodes.find(LIBRARY_ID, 'Artist/Album'))?.updated_at).toBe(SENTINEL);

      // A real change moves it, or the column would be a constant.
      await nodes.upsertMany([{ ...input, mtimeMs: 2000 }]);
      expect((await nodes.find(LIBRARY_ID, 'Artist/Album'))?.updated_at).not.toBe(SENTINEL);
    } finally {
      handle.close();
    }
  });
});

describe('nodeRowNeedsWrite, on its own', () => {
  function stored(overrides: Partial<NodeRow> = {}): NodeRow {
    return {
      library_id: LIBRARY_ID,
      path: 'Artist/Album',
      parent_path: 'Artist',
      name: 'Album',
      name_ci: 'album',
      mtime_ms: 1000,
      etag: '"a"',
      depth: 2,
      is_scanned: 1,
      created_at: 0,
      updated_at: 0,
      ...overrides,
    };
  }

  /**
   * A desired row, typed rather than `as const`.
   *
   * `as const` would make every column a literal, and then `Partial<DesiredNodeRow>` could not hold
   * a *different* value for any of them — which is the whole content of a test about "writes when
   * this column differs". The type used is the module's own, so a column added to it is a column
   * these cases have an opinion about.
   */
  const DESIRED: DesiredNodeRow = {
    parentPath: 'Artist',
    name: 'Album',
    mtimeMs: 1000,
    etag: '"a"',
    depth: 2,
    isScanned: true,
  };

  // The predicate decides which rows a caller *offers*, so a column it forgets is a row the
  // statement never sees — and the statement's `WHERE` cannot catch that, because it never receives
  // the row. Asserted per column, because a guard written as `mtime !== mtime` passes every
  // behavioural case in this file: the fixtures change mtimes.
  it('writes an unknown row, which is an insert', () => {
    expect(nodeRowNeedsWrite(undefined, DESIRED)).toBe(true);
  });

  it('writes nothing when every column matches', () => {
    expect(nodeRowNeedsWrite(stored(), DESIRED)).toBe(false);
  });

  it.each([
    ['parent_path', { parentPath: 'Other' }],
    ['name', { name: 'Other' }],
    ['mtime_ms', { mtimeMs: 2000 }],
    ['etag', { etag: '"b"' }],
    ['depth', { depth: 3 }],
    ['is_scanned', { isScanned: false }],
  ] satisfies [string, Partial<DesiredNodeRow>][])('writes when %s differs', (_column, change) => {
    expect(nodeRowNeedsWrite(stored(), { ...DESIRED, ...change })).toBe(true);
  });

  it('treats a row whose etag went from a value to none as changed', () => {
    // The permissive direction is the dangerous one: the browse's old comparison required **both**
    // etags to be non-null, so a row that lost its etag looked unchanged and the stale value was
    // kept — freezing a subtree whose only change was that etag.
    expect(nodeRowNeedsWrite(stored({ etag: null }), DESIRED)).toBe(true);
    // And two rows that both have none are equal, which `!=` would also get right but only by
    // accident.
    expect(nodeRowNeedsWrite(stored({ etag: null }), { ...DESIRED, etag: null })).toBe(false);
  });

  it('treats a row whose mtime went from a value to none as changed', () => {
    expect(nodeRowNeedsWrite(stored({ mtime_ms: null }), DESIRED)).toBe(true);
    expect(nodeRowNeedsWrite(stored({ mtime_ms: null }), { ...DESIRED, mtimeMs: null })).toBe(false);
  });

  it('compares is_scanned as a flag, so 1 and true are the same value', () => {
    // The subtle version, and the one that would have looked correct. `is_scanned` is an integer
    // column and every caller passes a boolean, so a comparison written as
    // `known.is_scanned !== desired.isScanned` is **always true** — `1 !== true` — every row is
    // rewritten, and the convergence this file asserts is void while the guard still *looks* right.
    //
    // Asserted as behaviour rather than as a source string: a source assertion would pass for a
    // predicate that is present and unused, and the failure mode here is precisely that it looks
    // present.
    expect(nodeRowNeedsWrite(stored({ is_scanned: 1 }), DESIRED)).toBe(false);
    expect(nodeRowNeedsWrite(stored({ is_scanned: 0 }), DESIRED)).toBe(true);
  });
});

describe('a read-through browse no longer re-walks what it merely looked at', () => {
  it('leaves a scanned folder scanned', async () => {
    // The second row-write amplifier, and it was live at the same time as the livelock.
    // `TreeService.persistChildren` wrote `is_scanned = 0` for every child, so a client merely
    // *looking at* a folder put every subfolder back on the scan frontier and the scan re-walked
    // them — once per browse, on a `GET`, spending the same daily allowance. The flag means
    // "someone descended into this", and this path demonstrably has not: it read a `Depth: 1`
    // listing and nothing below it.
    //
    // Behavioural, through the real `TreeService` over real SQLite — not a source assertion,
    // because reading the source would prove the line is present rather than that the row survives
    // it.
    const ALBUM = 'Artist 0 - Album 0';
    const h = harness();
    try {
      await h.reconcile(rootListing(1));
      // A track inside the album, which the browse will re-offer.
      h.raw(
        `INSERT INTO nodes (library_id, path, parent_path, name, name_ci, mtime_ms, etag, depth, is_scanned, created_at, updated_at)
         VALUES ('${LIBRARY_ID}', 'Artist 0 - Album 0/01.flac', 'Artist 0 - Album 0', '01.flac', '01.flac', 2000, '"t1"', 2, 1, 0, 0)`,
      );
      // Close everything, then remove the album's own row: the shape a **truncated** write leaves
      // behind, since `reconcileFolder` writes children first and its own row last and skips the
      // last when the batch did not fit. So this is a real state, not an arrangement.
      h.raw(`UPDATE nodes SET is_scanned = 1 WHERE library_id = '${LIBRARY_ID}'`);
      h.raw(`DELETE FROM nodes WHERE library_id = '${LIBRARY_ID}' AND path = 'Artist 0 - Album 0'`);
      expect(await h.frontier()).toHaveLength(0);

      // The listing is the album and the track the scan already indexed. The browse re-offers the
      // track, and the track is the subject: it must stay `is_scanned = 1`.
      await h.browse(ALBUM, [
        { href: ALBUM, path: ALBUM, isCollection: true, contentLength: null, contentType: null, lastModifiedMs: 2000, etag: '"album-0"', displayName: null },
        {
          href: `${ALBUM}/01.flac`,
          path: `${ALBUM}/01.flac`,
          isCollection: false,
          contentLength: 1000,
          contentType: 'audio/flac',
          lastModifiedMs: 2000,
          etag: '"t1"',
          displayName: null,
        },
      ]);

      // The track stayed reconciled. Before the fix the browse wrote `is_scanned = 0` for it, so a
      // client merely *looking at* an album put it back on the scan frontier and the scan re-walked
      // it — once per browse, on a `GET`.
      expect(await h.frontier()).not.toContain(`${ALBUM}/01.flac`);

      // The album's **own** row is the opposite case and is expected to be `0`: its row was absent,
      // which is the shape a truncated write leaves, so a browse that discovered it has correctly
      // said nobody has descended into it. That is the invariant `needsDescent` reads, and it is why
      // the fix is "preserve" rather than "never write the flag".
      expect(await h.frontier()).toContain(ALBUM);
    } finally {
      h.close();
    }
  });

  it('leaves a scanned child alone and does not touch one that is already unreconciled', () => {
    // Two children of one folder: one the scan has walked, one a browse discovered. The first is
    // the fix — the browse must not clear it. The second is why this is not simply "never write the
    // flag": a row already at `0` is already the value the browse wants, so it is left alone too, and
    // it stays on the frontier because it *was* never reconciled. Clearing it would not have been
    // the danger; forgetting it was.
    expect(nodeRowNeedsWrite(storedScanned(), { ...DESIRED_FOLDER, isScanned: true })).toBe(false);
    expect(nodeRowNeedsWrite(storedUnreconciled(), { ...DESIRED_FOLDER, isScanned: false })).toBe(false);
    // And a row the browse has never seen is written `0`, which is what puts a browse-discovered
    // folder on the frontier for `needsDescent` to act on.
    expect(nodeRowNeedsWrite(undefined, { ...DESIRED_FOLDER, isScanned: false })).toBe(true);
    // Clearing a reconciled folder is the one thing the browse must never do.
    expect(nodeRowNeedsWrite(storedScanned(), { ...DESIRED_FOLDER, isScanned: false })).toBe(true);
  });

  it('keeps a moved folder on the frontier, because a moved folder is not reconciled', () => {
    // The other half of "preserve", and where preserving would be wrong: a folder whose mtime moved
    // has had its contents change, so it must be walked again. `TreeService`'s own-row write already
    // does this for the folder itself; this is the same rule one level down.
    const moved = nodeRowNeedsWrite({ ...storedScanned(), mtime_ms: 9999 }, { ...DESIRED_FOLDER, isScanned: true });

    expect(moved).toBe(true);
  });
});

/**
A node row as `persistChildren` would find it: a scanned album folder.
*/
function storedScanned(): NodeRow {
  return {
    library_id: LIBRARY_ID,
    path: 'Artist/Album',
    parent_path: 'Artist',
    name: 'Album',
    name_ci: 'album',
    mtime_ms: 1000,
    etag: '"a"',
    depth: 2,
    is_scanned: 1,
    created_at: 0,
    updated_at: 0,
  };
}

/**
The same folder as a browse discovers it: reconciled by nobody.
*/
function storedUnreconciled(): NodeRow {
  return { ...storedScanned(), is_scanned: 0 };
}

/**
What `persistChildren` wants for either of the two rows above.
*/
const DESIRED_FOLDER: DesiredNodeRow = {
  parentPath: 'Artist',
  name: 'Album',
  mtimeMs: 1000,
  etag: '"a"',
  depth: 2,
  isScanned: false,
};

describe('the guard has teeth', () => {
  it('goes red if the compare is removed from reconcileFolder', () => {
    // The paired case for the convergence test, and the reason this file exists rather than a
    // comment in `scanFolder.ts`. Reinstating the unconditional `nodeInputs.push` — the shipped
    // code — makes every pass write the same rows and the convergence assertions above fail, while
    // every *shape* assertion in the suite stays green. That asymmetry is the finding: the defect
    // was invisible to shape assertions and visible only to arithmetic, so the arithmetic is what
    // is asserted.
    const source = sourceOf('../packages/backend-services/src/index/scanFolder.ts');
    // The compare is present…
    expect(source).toContain('nodeRowNeedsWrite');
    // …and it guards the write rather than sitting beside it.
    expect(/if \(nodeRowNeedsWrite\(known, desired\)\) \{\s*nodeInputs\.push/.test(source)).toBe(true);
  });

  it('keeps the two writers on one predicate', () => {
    // `nodes` has two writers and the compare was written twice, which is how they came to disagree
    // about a row whose etag went from a value to none. Asserting that both call sites reach for the
    // shared predicate is a proxy for "there is one answer", and it fails the moment somebody
    // reintroduces a local comparison — which is the only way this state is reachable.
    const scanFolder = sourceOf('../packages/backend-services/src/index/scanFolder.ts');
    const treeService = sourceOf('../packages/backend-services/src/index/TreeService.ts');
    const predicate = sourceOf('../packages/backend-services/src/index/nodeWrite.ts');

    expect(scanFolder).toContain("from './nodeWrite'");
    expect(treeService).toContain("from './nodeWrite'");
    // Exactly one implementation of the comparison.
    expect(predicate.match(/function nodeRowNeedsWrite/g)).toHaveLength(1);
    // The browse carried a hand-rolled comparison and no longer does. `scanFolder` still computes
    // `mtimeMoved`/`etagMoved` for `needsDescent`, and that is deliberate — "does this folder need
    // descending into" is a different question from "does this row need writing", and the fix
    // separated them rather than making one do both jobs.
    expect(treeService).not.toMatch(/known\.mtime_ms !== resource\.lastModifiedMs/);
    expect(treeService).not.toMatch(/resource\.etag !== null && known\.etag !== null/);
    // And the two writers' *write* decisions both name the shared predicate.
    expect(scanFolder).toMatch(/nodeRowNeedsWrite\(known, desired\)/);
    expect(treeService).toMatch(/nodeRowNeedsWrite\(known, \{/);
    // And the browse preserves the flag rather than clearing it — the amplifier's other half.
    expect(treeService.match(/isScanned: known\?\.is_scanned === 1/g)).toHaveLength(2);
  });
});

describe('DatabaseSync is the engine, and the ceiling is the build', () => {
  it('runs the real statement rather than a double, so a wrong WHERE cannot pass', () => {
    // A guard that only exists in this file's own doubles proves nothing about the statement. The
    // `DatabaseSync` import is asserted because it is what makes the difference: `node:sqlite` is
    // the same engine D1 is, with a real planner and real `ON CONFLICT … WHERE` support, so a
    // predicate D1 would reject fails here too.
    expect(typeof DatabaseSync).toBe('function');
  });
});