/**
 * Scan cost invariants.
 *
 * ### Asserted on counts, not statuses
 *
 * A response-code assertion cannot see a quota being spent. The reference project
 * spent a whole day of KV writes on a `delete`-then-`put` pattern that answered
 * every request correctly, and the only symptom was a quota counter nobody was
 * watching. So everything here counts **WebDAV requests** and **D1 rows written**.
 *
 * ### The three numbers that matter
 *
 * 1. A cold scan of a small library: one request per folder, one row per entry.
 * 2. An **unchanged** rescan: **one** request (the root probe) and **zero** rows.
 *    This is the whole point of storing `mtime_ms` in `nodes`.
 * 3. A one-album change: requests proportional to the *change*, not the library.
 *
 * ### Why `clientFor` here forwards the caller's meter
 *
 * `webdavRequests` is counted inside `WebDavClient.request()`, so a `clientFor` that
 * drops the `onRequest` callback reports **zero** for a chunk that did real work. That
 * is not a service defect: it is this double being structurally unable to observe the
 * thing, which is the failure the testing guide warns about — and it is exactly how the
 * under-counting survived for so long. The budget itself is exercised in
 * `test/scan-budget.test.ts`; this file is about the walk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_CONSECUTIVE_FAILURES, ScanService } from '@edge-sonic/backend-services/index';
import { SCAN_DERIVE_MAX_ROWS_PER_CHUNK, WORKER_SUBSREQUEST_CEILING } from '@edge-sonic/backend-runtime/config';
import { SubrequestBudgetExhaustedError } from '@edge-sonic/backend-errors';
import { SubrequestCounter } from '@edge-sonic/shared';
import { DERIVED_VERSION, GROUPING_SOURCE_DERIVED, billedRowsForTable, deriveFromPath } from '@edge-sonic/backend-data/dao';
import type { NodeInput, SongUpsertInput } from '@edge-sonic/backend-data/dao';
import type { LibraryRow, NodeRow, ScanStateRow, SongRow } from '@edge-sonic/backend-data/dao';
import type { ScanDeps } from '@edge-sonic/backend-services/index';
import { fakeDav } from './helpers/fakeDav';
import type { DavEntry } from './helpers/fakeDav';
import { DERIVED_MARKER } from './helpers/harness';

const LIBRARY_ID = 'L1';
const ROOT = '/dav/music';

/**
An in-memory index that records how many rows each write touched.
*/
function createIndex() {
  const nodes = new Map<string, NodeRow>();
  const songs = new Map<string, SongRow>();
  let state: ScanStateRow = {
    library_id: LIBRARY_ID,
    status: 'idle',
    cursor_path: null,
    scanned_count: 0,
    total_count: 0,
    index_version: 1,
    last_error: null,
    started_at: null,
    consecutive_failures: 0,
    // The per-scan "did this change anything" flag. Modelled because `complete` reads it
    // in its decision about `index_version`, so a double that omitted it would answer every
    // `complete` from a default of "nothing changed" and no test here could see a scan that
    // genuinely changed the index.
    changed: 0,
    updated_at: 0,
  };
  const writes = { nodes: 0, songs: 0, state: 0 };

  const nodeKey = (path: string): string => `${LIBRARY_ID}\n${path}`;

  // The invocation's counter, handed to the service so the store below and the walk are
  // counted by one thing. At the platform ceiling rather than unlimited: a suite whose double
  // cannot exhaust a budget cannot see a scan that exceeds one.
  const subrequests = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);

  /**
   * One D1 statement, charged to the counter the scan budgets against.
   *
   * `statements` rather than always one, because a DAO's write batch costs one subrequest per
   * statement. Counting every call as one is how a double under-reports: this suite's
   * predecessor counted nothing at all, which is why the scan's budget could be `40` while a
   * chunk spent ~200 and every test here stayed green.
   *
   * The batch is issued **whole** regardless of what is left — this suite is about which rows
   * change, its fixtures are two folders wide, and truncation is modelled where the budget is
   * measured (`test/scan-budget.test.ts`). One suite per question.
   */
  const db = <T>(fn: () => T, statements = 1): T => {
    subrequests.charge(statements, 'd1');
    return fn();
  };

  return {
    nodes,
    songs,
    state: () => state,
    writes,
    deps: {
      subrequests,
      nodes: {
        find: async (_libraryId: string, path: string) => db(() => nodes.get(nodeKey(path)) ?? null),
        listChildren: async (_libraryId: string, parentPath: string) =>
          db(() => [...nodes.values()].filter((node) => node.parent_path === parentPath).sort((a, b) => a.name_ci.localeCompare(b.name_ci))),
        // `path !== ''` excludes the library root's own row, which is
        // `path === parentPath === ''` and so matches `parent_path === ''` exactly as a
        // top-level folder does. This double had that filter while `NodeDAO.listRoots`
        // did not — the DAO shipped a blank-named entry at the top of `getIndexes` whose
        // id failed with `code 70`, and this suite stayed green, because a double that
        // compensates for a bug hides it. `test/schema.int.test.ts` now asserts the
        // predicate against a real SQLite, where a wrong query and a double cannot
        // disagree.
        listRoots: async () => db(() => [...nodes.values()].filter((node) => node.parent_path === '' && node.path !== '')),
        // The scan frontier: unscanned folders, shallowest first. This ordering is
        // what makes a partial scan produce a browsable top of the tree.
        listFrontier: async (_libraryId: string, limit: number) =>
          db(() => [...nodes.values()].filter((node) => node.is_scanned === 0).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)).slice(0, limit)),
        upsertMany: async (inputs: readonly NodeInput[]) =>
          db(() => {
          let changed = 0;
          for (const raw of inputs) {
            const input = raw as {
              libraryId: string;
              path: string;
              parentPath: string;
              name: string;
              mtimeMs: number | null;
              etag: string | null;
              depth: number;
              isScanned?: boolean;
            };
            const key = nodeKey(input.path);
            const existing = nodes.get(key);
            // An unchanged row is not counted as a write, because the whole point is
            // that an unchanged folder costs nothing.
            if (
              existing !== undefined &&
              existing.mtime_ms === input.mtimeMs &&
              existing.etag === input.etag &&
              existing.is_scanned === (input.isScanned ? 1 : 0)
            ) {
              continue;
            }
            nodes.set(key, {
              library_id: LIBRARY_ID,
              path: input.path,
              parent_path: input.parentPath,
              name: input.name,
              name_ci: input.name.toLowerCase(),
              mtime_ms: input.mtimeMs,
              etag: input.etag,
              depth: input.depth,
              is_scanned: input.isScanned ? 1 : 0,
              created_at: existing?.created_at ?? 0,
              updated_at: 0,
            });
            changed += 1;
          }
          writes.nodes += changed;
          // `billedRows` is the *measurement*, not a copy of `changes`: D1 charges the table row
          // plus every index entry it rewrote, and `nodes` carries three, so one row is four
          // rows of allowance. The daily budget is denominated in these. Deriving it here from
          // the same constant the DAO uses (`billedRowsForTable`) is what keeps this double from
          // being a *second* implementation of the schema — the class of defect this file has
          // already recorded twice on this column.
          return { changes: changed, written: inputs.length, truncated: false, billedRows: billedRowsForTable('nodes', changed) };
        }, inputs.length),
        patch: async (_libraryId: string, path: string, patch: Record<string, unknown>) => {
          const node = nodes.get(nodeKey(path));
          if (!node) return;
          if (patch.mtimeMs !== undefined) node.mtime_ms = patch.mtimeMs as number | null;
          if (patch.etag !== undefined) node.etag = patch.etag as string | null;
          if (patch.isScanned !== undefined) node.is_scanned = patch.isScanned ? 1 : 0;
          writes.nodes += 1;
        },
        deleteChildrenNotIn: async (_libraryId: string, parentPath: string, keep: readonly string[]) => {
          const keepSet = new Set(keep);
          // The folder's own row is never a child. For the library root,
          // `path === parentPath === ''`, so omitting this clause deletes the root
          // during its own reconciliation — the bug this double exists to not hide.
          const doomed = [...nodes.values()].filter((node) => node.parent_path === parentPath && node.path !== parentPath && !keepSet.has(node.path));
          for (const node of doomed) nodes.delete(nodeKey(node.path));
          writes.nodes += doomed.length;
          return doomed.length;
        },
        deleteSubtree: async (_libraryId: string, path: string) => {
          const doomed = [...nodes.values()].filter((node) => node.path === path || node.path.startsWith(`${path}/`));
          for (const node of doomed) nodes.delete(nodeKey(node.path));
          writes.nodes += doomed.length;
          return { changes: doomed.length, written: doomed.length, truncated: false, billedRows: billedRowsForTable('nodes', doomed.length) };
        },
        countByLibrary: async () => db(() => nodes.size),
      },
      songs: {
        upsertFileFacts: async (inputs: readonly SongUpsertInput[]) =>
          db(() => {
          let changed = 0;
          for (const raw of inputs) {
            const input = raw as { id: string; path: string; size: number; mtimeMs: number; name: string; contentType: string | null; suffix: string; dirPath: string };
            const existing = songs.get(input.id);
            if (existing !== undefined && existing.size === input.size && existing.mtime_ms === input.mtimeMs) continue;
            const derived = deriveFromPath(input.dirPath, DERIVED_MARKER);
            songs.set(input.id, {
              id: input.id,
              library_id: LIBRARY_ID,
              path: input.path,
              dir_path: input.dirPath,
              name: input.name,
              name_ci: input.name.toLowerCase(),
              size: input.size,
              mtime_ms: input.mtimeMs,
              content_type: input.contentType,
              suffix: input.suffix,
              title: null,
              title_ci: null,
              // Derived from `dir_path`, because the real `UPSERT_FILE_FACTS` derives them
              // — this double had `null` here while the statement filled the columns, and
              // that disagreement is the reason the first attempt at the grouping fix was
              // invisible: the suite agreed with itself and with neither production. A
              // double must model the platform, and the platform derives.
              artist: derived.artist,
              artist_ci: derived.artist?.toLowerCase() ?? null,
              album: derived.album,
              album_ci: derived.album?.toLowerCase() ?? null,
              album_artist: derived.artist,
              album_artist_ci: derived.artist?.toLowerCase() ?? null,
              track: null,
              disc: null,
              year: null,
              genre: null,
              genre_ci: null,
              duration: 0,
              bitrate: 0,
              sample_rate: null,
              channels: null,
              enriched_at: null,
              // 0, which is what the real upsert writes for a row whose bytes moved. A
              // non-zero value here would make this double disagree with the statement
              // about which rows need re-reading — and that disagreement is invisible
              // until a reader changes.
              reader_version: 0,
              // The real `UPSERT_FILE_FACTS` stamps `DERIVED_VERSION` on both the `INSERT`
              // and the `ON CONFLICT` clause, so a row the indexer just wrote is not also
              // owed to the backfill. It did not, once: the statement left the column at the
              // migration's `DEFAULT 0`, and because the backfill's selection is
              // `derived_version < 1`, *every row this double wrote* was permanently owed —
              // which is the failure `test/schema.int.test.ts` now runs the real statement
              // over real SQLite to catch. This double agreeing with production about the
              // very column under repair is therefore not cosmetic: it is the only reason
              // this file stayed green through it.
              derived_version: DERIVED_VERSION,
              // The real `UPSERT_FILE_FACTS` stamps `'derived'` on the `INSERT`: a row it
              // created cannot hold a value any tag supplied. The backfill's guard reads this
              // column, so a double that omits it produces a row nothing may ever correct —
              // the "a double may disagree with production about the very column under
              // repair" defect, on the third such column.
              grouping_source: GROUPING_SOURCE_DERIVED,
              created_at: 0,
              updated_at: 0,
            });
            changed += 1;
          }
          writes.songs += changed;
          return { changes: changed, written: inputs.length, truncated: false, billedRows: billedRowsForTable('songs', changed) };
        }, inputs.length),
        deleteInDirectoryNotIn: async (_libraryId: string, dirPath: string, keep: readonly string[]) => {
          const keepSet = new Set(keep);
          const doomed = db(() => [...songs.values()].filter((song) => song.dir_path === dirPath && !keepSet.has(song.path)));
          // The deletes are a batch of their own, so they are a second statement group.
          for (const song of doomed) songs.delete(song.id);
          writes.songs += doomed.length;
          subrequests.charge(doomed.length, 'd1');
          return { changes: doomed.length, written: doomed.length, truncated: false, billedRows: billedRowsForTable('songs', doomed.length) };
        },
        // Recursive, like the real one: a vanished folder takes its songs with it,
        // and their `dir_path` is deeper than the folder itself.
        deleteSubtree: async (_libraryId: string, dirPath: string) => {
          const doomed = [...songs.values()].filter((song) => song.dir_path === dirPath || song.dir_path.startsWith(`${dirPath}/`));
          for (const song of doomed) songs.delete(song.id);
          writes.songs += doomed.length;
          return { changes: doomed.length, written: doomed.length, truncated: false, billedRows: billedRowsForTable('songs', doomed.length) };
        },
        countByLibrary: async () => db(() => songs.size),
      },
      scanState: {
        find: async () => state,
        ensure: async () => state,
        // `consecutive_failures` is cleared on both, matching the DAO: a scan that has
        // been explicitly started, and a chunk that made progress, have both
        // demonstrated they are not stuck — and a double that kept the count would make
        // the retry bound unobservable here.
        markScanning: async (_libraryId: string, total: number) => {
          // `changed: 0`, because the flag is per-scan and a new scan is a new question.
          // Carrying the previous scan's answer forward would bump on the first no-op
          // rescan and never again — the DAO zeroes it here for that reason.
          state = { ...state, status: 'scanning', total_count: total, scanned_count: 0, cursor_path: null, last_error: null, consecutive_failures: 0, changed: 0 };
          writes.state += 1;
        },
        // A **delta**, like the DAO. This double assigned it, which is the DAO's own
        // documented pre-fix shape: `fail` incremented in its statement while this
        // overwrote, so an overlapped chunk published the smaller of the two and the
        // counter went backwards. A double that disagrees with production about the
        // argument's meaning cannot observe the lost update.
        saveProgress: async (_libraryId: string, scannedDelta: number, cursor: string | null, indexChanged: boolean) => {
          state = {
            ...state,
            status: 'scanning',
            scanned_count: state.scanned_count + scannedDelta,
            cursor_path: cursor,
            consecutive_failures: 0,
            // OR-ed, not assigned: a chunk that changed nothing must not clear a sibling's
            // answer, which is the same reason `scanned_count` takes a delta.
            changed: indexChanged ? 1 : (state.changed ?? 0),
          };
          writes.state += 1;
        },
        complete: async (_libraryId: string, scanned: number, changed = false) => {
          // The bump is what invalidates every cached aggregate for this library, by
          // making the old keys unreachable rather than by deleting them — so it is
          // conditional on the scan having changed something. Unconditional, it fired on
          // every no-op rescan, and on an origin whose root mtime moves per observation
          // `startScan` cannot short-circuit, so every client login invalidated the whole
          // cache for a scan that wrote nothing.
          const bumped = (state.changed ?? 0) === 1 || changed;
          state = {
            ...state,
            status: 'idle',
            scanned_count: scanned,
            index_version: state.index_version + (bumped ? 1 : 0),
            consecutive_failures: 0,
            changed: 0,
          };
          writes.state += 1;
          return state.index_version;
        },
        fail: async (_libraryId: string, error: string) => {
          state = { ...state, status: 'failed', last_error: error, consecutive_failures: state.consecutive_failures + 1 };
          writes.state += 1;
          return state.consecutive_failures;
        },
      },
    },
  };
}

/**
 * A generous ceiling, so a test that is about the *walk* is never truncated by a bound.
 *
 * The shipped defaults are asserted separately, against the constants themselves, in
 * "the shipped defaults" below. A budget quietly set low enough to cut a walk short
 * would make an unrelated test pass for the wrong reason.
 */
const UNBOUNDED_CHUNK = { chunkFolders: 40, chunkMaxRequests: 10_000, chunkDeadlineMs: 60_000 };

function library(overrides: Partial<LibraryRow> = {}): LibraryRow {
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
    ...overrides,
  };
}

/**
 * A three-album library: one artist folder, three album folders, two tracks each.
 *
 * Shaped as a real directory listing per folder — each key holds the entries *in*
 * that folder, including the folder itself first — because that is what a
 * `Depth: 1` PROPFIND answers with.
 */
function sampleTree(mtimeBase = 1_000_000, albumMtimes: number[] = [2000, 3000, 4000]): Record<string, DavEntry[]> {
  const albums = ['Blur', 'Holocene', 'For Emma'];
  const tree: Record<string, DavEntry[]> = {
    [ROOT]: [
      { path: ROOT, collection: true, mtime: mtimeBase },
      { path: `${ROOT}/Blur`, collection: true, mtime: mtimeBase + 1000 },
    ],
    [`${ROOT}/Blur`]: [{ path: `${ROOT}/Blur`, collection: true, mtime: mtimeBase + 1000 }],
  };
  albums.forEach((album, index) => {
    const mtime = mtimeBase + (albumMtimes[index] ?? 5000);
    tree[`${ROOT}/Blur`]!.push({ path: `${ROOT}/Blur/${album}`, collection: true, mtime });
    tree[`${ROOT}/Blur/${album}`] = [
      { path: `${ROOT}/Blur/${album}`, collection: true, mtime },
      { path: `${ROOT}/Blur/${album}/01.flac`, size: 1000, mtime, contentType: 'audio/flac', etag: `"${album}-1"` },
      { path: `${ROOT}/Blur/${album}/02.flac`, size: 2000, mtime, contentType: 'audio/flac', etag: `"${album}-2"` },
    ];
  });
  return tree;
}


/**
 * Move a folder's `getlastmodified`, and that of every ancestor up to the root.
 *
 * A real WebDAV server propagates a child's mtime change up the chain — a file
 * removed from an album changes the album, which changes the artist folder, which
 * changes the root. Modelling that is not pedantry: the scan's incrementality
 * depends on it. A test that moves only the leaf's mtime is describing a server
 * whose ancestors lie, and the scan correctly refuses to descend.
 */
function touch(tree: Record<string, DavEntry[]>, libraryRelative: string, mtime = 9_999_999): void {
  // Paths in the tree are absolute request paths, so the library root is prepended.
  // `libraryRelative` is written library-relative because that is how the rest of the
  // product refers to a folder (`songs.dir_path`, a Subsonic id payload).
  const segments = libraryRelative.split('/');
  // Walk from the root down, bumping the entry for each folder on the way.
  for (let depth = 0; depth <= segments.length; depth += 1) {
    const folderPath = depth === 0 ? ROOT : `${ROOT}/${segments.slice(0, depth).join('/')}`;
    // `depth <= 1`, not `depth === 0`: at depth 1 the parent is the root itself,
    // and joining an empty slice would produce `/dav/music/` — a key that does not
    // exist, so the ancestor bump would silently no-op and the test would look like
    // a product bug.
    const parentPath = depth <= 1 ? ROOT : `${ROOT}/${segments.slice(0, depth - 1).join('/')}`;
    // The fake's entries are `readonly` because nothing in production mutates them. A
    // test that models a file changing has to, so the mutation is a spread that keeps
    // the type honest rather than a cast that hides it.
    for (const [directory, path] of [
      [folderPath, folderPath],
      [parentPath, folderPath],
    ] as const) {
      const listing = tree[directory];
      const at = listing?.findIndex((entry) => entry.path === path) ?? -1;
      if (listing !== undefined && at >= 0) listing[at] = { ...listing[at]!, mtime };
    }
  }
}

describe('the scan enriches the tracks it changed', () => {
  let index: ReturnType<typeof createIndex>;
  let dav: ReturnType<typeof fakeDav>;
  let row: LibraryRow;
  let enriched: Array<{ id: string; path: string; size: number; mtimeMs: number }>;

  /**
  A scan over the shared `dav`, recording what it was asked to enrich.
  */
  function scanWith(enrichMaxPerFolder: number, onEnrich?: (facts: { id: string; path: string; size: number; mtimeMs: number }) => Promise<number | void>): ScanService {
    return new ScanService({
      ...index.deps,
      clientFor: async (_library, onRequest) =>
        new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, dav.fetch, onRequest),
      timeoutMs: 1000,
      ...UNBOUNDED_CHUNK,
      enrichSong: async (_library, facts, onRequest) => {
        enriched.push(facts);
        // Charged the way the real enrichment service charges: one prefix read here,
        // and a second for a container whose length is only at the end of the file.
        // Without this the budget would never see the reads the scan causes, which is
        // the under-reporting the count assertions below exist to catch.
        onRequest?.();
        onRequest?.();
        // Rows written, which is what `rowsWritten` and the day's row-write budget are metered
        // from. `void`/`undefined` from an `onEnrich` means "asked but did not write", so a
        // caller can model a cache hit without a second mechanism.
        //
        // `billedRows` is **not** a copy of the row count, and this is the whole point of the
        // pair: the real write is an `UPDATE songs` and D1 bills ten rows for it — the row plus
        // the nine indexes it rewrote — while the daily budget is denominated in those. A double
        // returning the row count here would make this suite assert a budget ten times larger
        // than production's, which is the `fakeDav` defect one row-count away.
        const rows = (await onEnrich?.(facts)) ?? 1;
        return { rowsWritten: rows, billedRows: billedRowsForTable('songs', rows) };
      },
      enrichMaxPerFolder,
    });
  }

  async function complete(service: ScanService, limit = 50): Promise<void> {
    await service.start(row);
    for (let poll = 0; poll < limit; poll += 1) {
      if ((await service.step(row)).status !== 'scanning') return;
    }
    throw new Error('scan did not complete');
  }

  beforeEach(() => {
    index = createIndex();
    dav = fakeDav(sampleTree());
    row = library();
    enriched = [];
  });

  /**
   * Why this exists: enrichment used to be reachable only from `getSong`, so a browsing
   * client saw `duration: 0` and no artist on every track until it happened to open one —
   * and `getArtists`, `getAlbumList2`, `getGenres` and `search3` had nothing to group on,
   * so they were all empty for a library with 81 artists.
   */
  it('reads every track a cold scan indexed, so browsing needs no per-track open', async () => {
    await complete(scanWith(20));

    expect(index.songs.size).toBe(6);
    expect(enriched).toHaveLength(6);
    expect(enriched.map((fact) => fact.path).sort()).toEqual([...index.songs.values()].map((song) => song.path).sort());
  });

  it('passes the file facts a range read needs, not a fabricated row', async () => {
    await complete(scanWith(20));

    const first = enriched[0];
    expect(first).toBeDefined();
    // `size` is what makes a variable-bitrate bitrate computable, and `mtimeMs` is what
    // the KV cache entry is validated against. Nothing else is needed, and nothing else
    // is sent — a fabricated `SongRow` would be a copy of the schema that rots silently.
    expect(first?.size).toBeGreaterThan(0);
    expect(first?.mtimeMs).toBeGreaterThan(0);
    expect(Object.keys(first ?? {}).sort()).toEqual(['id', 'mtimeMs', 'path', 'size']);
  });

  it('enriches nothing on an unchanged rescan, because nothing changed', async () => {
    const service = scanWith(20);
    await complete(service);
    enriched = [];

    await service.start(row);
    await service.step(row);

    expect(enriched).toEqual([]);
  });

  it("counts an enrichment's row in both row counts, because the day's budget cannot see it", async () => {
    // `rowsWritten` is metered into `ScanWorker.pause.record` — the guard that stops a scan
    // spending the account's D1 row-write allowance — and `enrichChanged` returned `void` for the
    // whole life of that guard, so every row `applyMetadata` wrote was invisible to it while
    // `BaseDAO.withRetry` charged every one of them to the subrequest meter. On a library of
    // 113 tracks those are 113 of roughly 420 rows in a cold scan.
    //
    // Asserted as a count rather than as "the callback was called": the two differ the moment
    // the answer is *wrong*, which is the only way this class of bug shows up.
    const service = scanWith(20);
    // A **cold** library, so there is something to index: an unchanged rescan enriches nothing
    // (the case above), and a scan that indexed nothing is not a scan with an invisible term.
    await service.start(row);
    // Zeroed after `start`, so both cases measure the same window — the walk — and neither
    // inherits the root row the seed writes. `start`'s own write is a real row and is counted
    // in `start`'s result; counting it in a baseline read afterwards would make the two cases
    // differ by one for a reason that has nothing to do with enrichment.
    index.writes.nodes = 0;
    index.writes.songs = 0;

    let total = 0;
    let billed = 0;
    for (let poll = 0; poll < 50; poll += 1) {
      const result = await service.step(row);
      total += result.rowsWritten;
      billed += result.billedRows;
      if (index.state().status !== 'scanning') break;
    }
    // Read **after** the walk, not during it: the index's own rows are the baseline the
    // enrichment term is measured against, and a snapshot taken mid-scan is the first chunk's
    // worth rather than the library's.
    const indexRows = index.writes.nodes + index.writes.songs;

    expect(enriched.length).toBeGreaterThan(0);
    // This case asserts only the **margin** the enrichment term adds: `rowsWritten` exceeds the
    // index's own rows by at least the number enriched.
    //
    // Deliberately not an exact total, and deliberately not paired here with an assertion that
    // `complete` does not bump `index_version` — an exact figure would couple these two cases
    // to each other's arithmetic, so a change to one would fail the other for a reason that has
    // nothing to do with either. The two subjects are asserted apart: `rowsWritten` here, and
    // the version bump in the cases that own it.
    expect(total - indexRows).toBeGreaterThanOrEqual(enriched.length);

    // The same margin in the unit the **budget** is denominated in, and this is the assertion
    // that would have caught the real defect. `billedRows` is what D1 charges — the row plus
    // every index entry it rewrote — and the day's allowance is spent in those. A scan reporting
    // `rowsWritten` here would believe it had ten times its headroom before the platform refused
    // every query on the account until midnight UTC.
    expect(billed).toBeGreaterThan(total);
    expect(billed).toBeGreaterThanOrEqual(billedRowsForTable('songs', enriched.length));
  });

  it('does not count an enrichment that wrote nothing, and says why', async () => {
    // The pair, and without it the guard could be satisfied by counting *tracks attempted*:
    // a `songMeta` cache hit returns without touching D1, and so does a transient failure —
    // the second deliberately, since stamping `enriched_at` over a `503` is what made four
    // tracks of a live library report `duration: 0` for ever. Counting either would pace the
    // scan off writes that never happened, and would stop it *early* rather than late.
    const service = scanWith(20, async () => 0);

    await service.start(row);
    // The same window as the case above, so the only difference between them is what
    // `enrichSong` reported.
    index.writes.nodes = 0;
    index.writes.songs = 0;

    let reported = 0;
    let reportedBilled = 0;
    for (let poll = 0; poll < 50; poll += 1) {
      const result = await service.step(row);
      reported += result.rowsWritten;
      reportedBilled += result.billedRows;
      if (index.state().status !== 'scanning') break;
    }
    const indexRows = index.writes.nodes + index.writes.songs;

    expect(enriched.length).toBeGreaterThan(0);
    // The same tracks were enriched as the case above, and the index wrote the same rows — but
    // this `enrichSong` reported zero, so the enrichment term contributes **nothing** and the
    // margin is `0`. This is what proves the two cases differ because of the *reported* rows
    // rather than because of the callback having been invoked.
    expect(reported - indexRows).toBe(0);

    // And **both** counts fall to zero, not one. A zero in `rowsWritten` beside a non-zero in
    // `billedRows` would be a scan that believes it wrote nothing and a budget that believes it
    // spent something — two surfaces disagreeing about the same write, which is the defect this
    // pairing exists to make visible. The index's own writes are still there, so this is not a
    // claim that the chunk did nothing.
    expect(reportedBilled).toBe(billedRowsForTable('nodes', index.writes.nodes) + billedRowsForTable('songs', index.writes.songs));
  });

  it('enriches only the file that changed, not the album around it', async () => {
    await complete(scanWith(20));
    enriched = [];

    // One *track's* etag moves, and `touch` bumps its ancestors the way a WebDAV server
    // does. The scan descends into the album because the folder moved, but the sibling
    // track is unchanged, so it is not re-read — and therefore not re-enriched. The two
    // untouched albums are never opened at all.
    const tree = sampleTree();
    const listing = tree[`${ROOT}/Blur/Holocene`]!;
    listing[1] = { ...listing[1]!, etag: '"Holocene-1-changed"' };
    touch(tree, 'Blur/Holocene');
    dav.setTree(tree);

    await complete(scanWith(20));

    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.path).toContain('01.flac');
  });

  it('enriches at most the per-folder bound, and leaves the rest to `getSong`', async () => {
    // The bound is on subrequests, and it is what keeps a chunk inside the 1,000 limit:
    // an Ogg track costs a prefix read and a tail read.
    await complete(scanWith(1));

    // Each of the three albums holds two tracks, so a bound of 1 enriches one per album.
    expect(enriched).toHaveLength(3);
  });

  it('does not fail the chunk when a track cannot be enriched', async () => {
    // A dead origin must not cost the rows the walk already wrote. The track keeps
    // `enriched_at = null` and `getSong` retries it.
    await complete(
      scanWith(20, async () => {
        throw new Error('origin unavailable');
      }),
    );

    expect(index.songs.size).toBe(6);
  });
});

describe('ScanService', () => {
  let index: ReturnType<typeof createIndex>;
  let dav: ReturnType<typeof fakeDav>;
  let service: ScanService;
  let row: LibraryRow;

  beforeEach(() => {
    index = createIndex();
    dav = fakeDav(sampleTree());
    service = new ScanService({
      ...index.deps,
      clientFor: async (_library, onRequest) =>
        new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, dav.fetch, onRequest),
      timeoutMs: 1000,
      ...UNBOUNDED_CHUNK,
      // 0 keeps these cases about the walk: none of them supplies an `enrichSong`.
      enrichMaxPerFolder: 0,
    });
    row = library();
  });

  /**
  Run `startScan` then poll `getScanStatus` until the scan reports idle.
  */
  async function runToCompletion(limit = 50): Promise<{ requests: number; chunks: number }> {
    await service.start(row);
    let chunks = 0;
    for (let poll = 0; poll < limit; poll += 1) {
      chunks += 1;
      const result = await service.step(row);
      if (result.status !== 'scanning') return { requests: dav.propfinds.length, chunks };
    }
    throw new Error('scan did not complete');
  }

  it('indexes a whole library, one request per folder', async () => {
    const { requests } = await runToCompletion();
    // Root + 3 albums. The `Blur` artist folder is reconciled as part of the root's
    // listing and its children are the albums.
    expect(requests).toBeGreaterThan(0);
    expect(requests).toBeLessThanOrEqual(6);
    expect(index.songs.size).toBe(6);
    expect(index.nodes.size).toBeGreaterThanOrEqual(5);
  });

  it('writes nothing for an unchanged rescan: one probe, zero rows', async () => {
    // This is the invariant the whole `mtime_ms` column exists for. A cold scan of
    // the D1 free plan is 5,000 row writes/day; a rescan that re-writes unchanged
    // rows spends that budget on a library that did not move.
    await runToCompletion();
    dav.reset();
    index.writes.nodes = 0;
    index.writes.songs = 0;
    const before = { ...index.writes, songs: index.songs.size, nodes: index.nodes.size };

    dav.reset();
    index.writes.nodes = 0;
    index.writes.songs = 0;

    const started = await service.start(row);
    expect(started.subrequests.fetch).toBe(1);
    expect(started.status).toBe('idle');
    expect(index.writes.nodes).toBe(0);
    expect(index.writes.songs).toBe(0);

    // And a poll after that is a no-op too.
    const polled = await service.step(row);
    expect(polled.status).toBe('idle');
    expect(polled.subrequests.fetch).toBe(0);
    expect(index.writes.nodes).toBe(0);
    expect(index.writes.songs).toBe(0);

    expect(index.songs.size).toBe(before.songs);
    expect(index.nodes.size).toBe(before.nodes);
  });

  it('does not bump index_version when nothing changed', async () => {
    await runToCompletion();
    const version = index.state().index_version;
    await service.start(row);
    expect(index.state().index_version).toBe(version);
  });

  /**
   * The two cases below use one fixture: an origin whose **root** reports a fresh
   * `getlastmodified` on every observation.
   *
   * Measured on a live origin rather than invented: a `Depth: 1` response answered the
   * library root with `Mon, 05 Oct 2026 04:23:47 GMT` while its 83 children in the *same*
   * response carried `Sat, 26 Sep 2026`, and three bursts of probes returned 04:23:47, then
   * 04:24:39, then 04:28:13 — a value tracking the request rather than the directory.
   *
   * This is what makes `start`'s cheap path unreachable, and it is why the test above passes
   * for a reason that does not generalise: with a stable root mtime the short circuit fires,
   * `complete()` is never reached, and the question never arises. A guard that only holds
   * where the case cannot occur is a guard.
   */
  it('does not bump index_version when nothing changed, on an origin whose root mtime advances per read', async () => {
    // The invariant `start`'s cheap path was supposed to provide, asserted where the cheap
    // path cannot fire. Unconditional, `complete()` bumped here on every `startScan` — and
    // `startScan` runs on every Subsonic client login and on the operator's Rescan — so each
    // one made every cached aggregate in the deployment unreachable, against a free plan's
    // 1,000 KV writes a day, for a rescan that changed nothing.
    const tree = sampleTree();
    await service.start(row);
    for (let poll = 0; poll < 50; poll += 1) {
      if ((await service.step(row)).status !== 'scanning') break;
    }
    expect(index.songs.size).toBe(6);

    // Every subsequent probe reports a newer root than the last, and nothing below it moves.
    //
    // The root's **self entry** is found by path, not by index. `sampleTree` puts the folder's
    // own entry first in a listing and its children after — but index 0 is a positional
    // assumption about a fixture that also contains an album literally named `Blur` nested
    // under the artist folder `Blur`, so `Blur/Blur` exists as a real node here. Rewriting
    // `tree[ROOT][0]` by index was, in an earlier draft of this test, advancing the root on the
    // first pass and a *child* on the second, which desynchronised the tree and reindexed the
    // whole library — a fixture bug that read exactly like a product bug.
    let observed = 7_000_000;
    const advance = (): void => {
      observed += 60_000;
      tree[ROOT] = tree[ROOT]!.map((entry) => (entry.path === ROOT ? { ...entry, mtime: observed } : entry));
      dav.setTree(tree);
    };

    const version = index.state().index_version;
    const pfBefore = dav.propfinds.length;
    // Zeroed **here**, not at the top: `writes` is cumulative since the index was created, so
    // it carries the cold scan that just finished. Reading it without resetting measures the
    // cold scan and calls it the rescan — which is the same mistake as the earlier mid-scan
    // snapshot, and it is the reason `18` appeared where `2` was expected.
    index.writes.nodes = 0;
    index.writes.songs = 0;
    advance();
    const started = await service.start(row);
    expect(started.status).toBe('scanning');
    for (let poll = 0; poll < 50; poll += 1) {
      if ((await service.step(row)).status !== 'scanning') break;
    }

    // The short circuit **did not** fire: the root moved, so `start` seeded the frontier (one
    // node row) and the walk listed the root (one `PROPFIND`).
    //
    // Stated before the version assertion on purpose. This case exists because the old guard
    // was only ever exercised where the cheap path fires — a fixture in which the walk did not
    // run would pass `index_version` unchanged while measuring nothing at all, which is how the
    // whole invariant stayed green. If the fixture ever stops producing a real walk, this is
    // the line that says so, and the version assertion below becomes meaningless without it.
    expect(started.status).toBe('scanning');
    expect(dav.propfinds.length).toBeGreaterThan(pfBefore);
    // Exactly the root's own row, twice: the seed's `is_scanned = 0`, then the walk's `1`.
    // No child was rewritten and no song row moved — the whole claim is a real walk whose only
    // output is frontier bookkeeping, and `2` is what makes "no child moved" a measurement
    // rather than an absence.
    expect(index.writes.nodes).toBe(2);
    expect(index.writes.songs).toBe(0);
    expect(index.songs.size).toBe(6);
    expect(index.state().index_version).toBe(version);
  });

  it('still bumps index_version on that same origin once something really changed', async () => {
    // The pair, and the reason the case above is a measurement rather than a disablement: a
    // conditional bump that never fires is a cache that serves a stale library for ever, which
    // is the opposite defect. Without this the guard could be satisfied by `complete()`
    // never bumping at all.
    const tree = sampleTree();
    await service.start(row);
    for (let poll = 0; poll < 50; poll += 1) {
      if ((await service.step(row)).status !== 'scanning') break;
    }

    const version = index.state().index_version;
    // An album's own mtime moves, which is a change the scan is supposed to notice. The root
    // is advanced as well, because a real server propagates a child's change up the chain.
    touch(tree, 'Blur/Holocene');
    dav.setTree(tree);

    await service.start(row);
    for (let poll = 0; poll < 50; poll += 1) {
      if ((await service.step(row)).status !== 'scanning') break;
    }
    expect(index.state().index_version).toBeGreaterThan(version);
  });

  it('costs requests proportional to the change, not the library size', async () => {
    await runToCompletion();

    // One album's mtime moves. Its parent's mtime does not, so the scan descends
    // only into the folder that actually changed.
    const tree = sampleTree();
    {
      const listing = tree[`${ROOT}/Blur/Holocene`]!;
      listing[1] = { ...listing[1]!, etag: '"Holocene-1-changed"' };
    }
    touch(tree, 'Blur/Holocene');
    dav.setTree(tree);
    dav.reset();
    index.writes.nodes = 0;
    index.writes.songs = 0;

    await service.start(row);
    for (let poll = 0; poll < 50; poll += 1) {
      const result = await service.step(row);
      if (result.status !== 'scanning') break;
    }

    // Four requests: the root probe, the root listing, the artist folder, and the one
    // album that changed. The two untouched albums are reconciled from the artist
    // folder's listing and are never opened — which is the whole claim.
    expect(dav.propfinds).toEqual([
      '/dav/music',
      '/dav/music',
      '/dav/music/Blur',
      '/dav/music/Blur/Holocene',
    ]);
    expect(dav.propfinds).not.toContain('/dav/music/Blur/Blur');
    expect(dav.propfinds).not.toContain('/dav/music/Blur/For Emma');
    // The changed track is rewritten; the untouched ones are not.
    expect(index.writes.songs).toBeLessThanOrEqual(1);
    expect(index.songs.size).toBe(6);
  });

  it('bumps index_version when something did change', async () => {
    await runToCompletion();
    const version = index.state().index_version;
    const tree = sampleTree();
    touch(tree, 'Blur/Holocene');
    dav.setTree(tree);
    dav.reset();
    await service.start(row);
    for (let poll = 0; poll < 50; poll += 1) {
      const result = await service.step(row);
      if (result.status !== 'scanning') break;
    }
    expect(index.state().index_version).toBeGreaterThan(version);
  });

  it('prunes a track removed on the WebDAV side', async () => {
    // Without this, a deleted track haunts search3 and every album list forever.
    await runToCompletion();
    expect(index.songs.size).toBe(6);

    // A real WebDAV server bumps the collection's `getlastmodified` when a child is
    // removed, so the parent mtime moves too. Changing only the listing would test
    // a scenario no real server produces, and would pass for the wrong reason.
    const tree = sampleTree();
    tree[`${ROOT}/Blur/Holocene`] = tree[`${ROOT}/Blur/Holocene`]!.filter((entry) => !entry.path.endsWith('02.flac'));
    touch(tree, 'Blur/Holocene');
    dav.setTree(tree);
    dav.reset();

    await service.start(row);
    for (let poll = 0; poll < 50; poll += 1) {
      const result = await service.step(row);
      if (result.status !== 'scanning') break;
    }
    expect(index.songs.size).toBe(5);
  });

  it('prunes a folder removed on the WebDAV side', async () => {
    await runToCompletion();
    const tree = sampleTree();
    tree[`${ROOT}/Blur`] = tree[`${ROOT}/Blur`]!.filter((entry) => !entry.path.endsWith('For Emma'));
    touch(tree, 'Blur');
    dav.setTree(tree);
    dav.reset();

    await service.start(row);
    for (let poll = 0; poll < 50; poll += 1) {
      const result = await service.step(row);
      if (result.status !== 'scanning') break;
    }
    expect(index.songs.size).toBe(4);
  });

  it('does not treat a 401 as a deletion', async () => {
    // A credential failure must not empty somebody's library. Only 404/410 mean
    // "gone"; anything else is a failure to reconcile, and the frontier is left where
    // it is so the next poll resumes.
    await runToCompletion();
    const songs = index.songs.size;
    dav.reset();
    const failing = fakeDav({}, { status: 401 });

    const failingService = new ScanService({
      ...index.deps,
      clientFor: async (_library, onRequest) =>
        new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, failing.fetch, onRequest),
      timeoutMs: 1000,
      ...UNBOUNDED_CHUNK,
      // 0 keeps these cases about the walk: none of them supplies an `enrichSong`.
      enrichMaxPerFolder: 0,
    });

    const tree = sampleTree();
    touch(tree, 'Blur/Holocene');
    dav.setTree(tree);
    await failingService.start(row);
    const result = await failingService.step(row);

    expect(result.status).toBe('failed');
    expect(index.state().last_error).toBeTruthy();
    expect(index.songs.size).toBe(songs);
  });

  /**
   * A failed scan is retried, bounded, and never reported as finished.
   *
   * ### The defect
   *
   * `step` short-circuited on any status other than `scanning`, and `fail` sets
   * `failed` — so one bad chunk ended a scan **permanently**, with the frontier sitting
   * intact and unread in D1. The module header claimed "a failure leaves the frontier
   * where it was, so the next poll resumes", and the claim was true of the frontier and
   * false of the code that reads it.
   *
   * It was invisible because `getScanStatus` derived `scanning` from the status: `failed`
   * and a completed scan both serialize as `scanning: false`, which every client reads
   * as *stop polling*. A library of 80 albums sat at one scanned folder, reporting
   * `{"scanning": false, "count": 1}` indefinitely, and the reason was in
   * `scan_state.last_error` where only the operator API could reach it.
   */
  /**
   * A second service over the same `index`, whose origin fails with `status`.
   *
   * Deliberately a *separate* service rather than a mutable flag on the shared one:
   * `start` seeds the frontier, so a scan that fails in its own root probe has nothing to
   * resume from, and the retry path is only exercised by a scan that got past the seed
   * first. Sharing the index is what makes "it resumed" observable — the state that
   * persists across the failure is the one in `deps`.
   */
  function serviceFailingWith(status: number): ScanService {
    const failing = fakeDav(sampleTree(), { status });
    return new ScanService({
      ...index.deps,
      clientFor: async (_library, onRequest) =>
        new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, failing.fetch, onRequest),
      timeoutMs: 1000,
      ...UNBOUNDED_CHUNK,
      enrichMaxPerFolder: 0,
    });
  }

  describe('a failed scan', () => {
    /**
    Poll to completion, so a test can assert on the end state rather than a step.
    */
    async function drain(service: ScanService): Promise<string> {
      let status = (await service.step(row)).status;
      let guard = 0;
      while (status === 'scanning' && guard < 50) {
        status = (await service.step(row)).status;
        guard += 1;
      }
      return status;
    }

    it('resumes on the next poll instead of staying wedged', async () => {
      // The load-bearing assertion. A single transient fault — an origin that 500s once
      // — must not end a scan. The proof is that the scan reaches the end, which is only
      // possible if the next poll re-entered the frontier the failure left behind.
      dav.setTree(sampleTree());
      expect((await service.start(row)).status).toBe('scanning');

      const broken = serviceFailingWith(500);
      expect((await broken.step(row)).status).toBe('failed');

      // The origin recovers. The next poll must do the interrupted work — so the scan
      // ends *complete*, with every track in it. Asserting on the song count and not
      // merely on a status is what makes this a resumption test: a scan that reported
      // `idle` without walking the frontier would satisfy a status-only assertion.
      dav.setTree(sampleTree());
      expect(await drain(service)).toBe('idle');
      expect([...index.songs.values()].map((song) => song.path).sort()).toEqual(['Blur/01.flac', 'Blur/02.flac', 'For Emma/01.flac', 'For Emma/02.flac', 'Holocene/01.flac', 'Holocene/02.flac'].map((leaf) => `Blur/${leaf}`).sort());
    });

    it('gives up after a bounded number of retries, and says so', async () => {
      // The other half of the same rule. Without a bound, a permanently broken library
      // is re-attempted on every poll for ever, spending the operator's WebDAV requests
      // to reach the same conclusion each time.
      dav.setTree(sampleTree());
      await service.start(row);

      const broken = serviceFailingWith(503);
      const statuses: string[] = [];
      for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES + 2; attempt += 1) {
        statuses.push((await broken.step(row)).status);
      }

      // `failed` while the budget lasts, `stalled` once it is spent — and `stalled` is
      // the state that does *not* get retried, so a client polling to decide whether to
      // keep going is not told to keep going.
      expect(statuses).toEqual([...Array.from({ length: MAX_CONSECUTIVE_FAILURES - 1 }, () => 'failed'), ...Array.from({ length: 3 }, () => 'stalled')]);

      // And it stops touching the network, which is the point of the bound. The
      // counter is the observable: a poll that re-attempted the request would raise it
      // again, so "the same number afterwards" is "no request was issued".
      const spent = index.state().consecutive_failures;
      expect((await broken.step(row)).status).toBe('stalled');
      expect(index.state().consecutive_failures).toBe(spent);
    });

    it('resets the retry budget on an explicit startScan, which is the operator escape hatch', async () => {
      // A credential is fixed out of band, so the client's own poll cannot be what
      // un-wedges a stalled scan — `startScan` is, and it needs no surface of its own.
      dav.setTree(sampleTree());
      await service.start(row);
      const broken = serviceFailingWith(500);
      for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES; attempt += 1) {
        await broken.step(row);
      }
      expect(index.state().consecutive_failures).toBeGreaterThanOrEqual(MAX_CONSECUTIVE_FAILURES);

      dav.setTree(sampleTree());
      await service.start(row);
      expect(index.state().consecutive_failures).toBe(0);
      expect(await drain(service)).toBe('idle');
    });

    it('does not report `idle` for a scan whose very first chunk failed', async () => {
      // `start` seeds the frontier with the library root, so a failure in the root probe
      // leaves *nothing* to retry. Completing there would answer `idle` for a scan that
      // never indexed a folder — the client-is-told-it-finished symptom, reached by the
      // new retry path rather than around it.
      const broken = serviceFailingWith(500);
      await broken.start(row);
      const result = await broken.step(row);
      expect(result.status).toBe('failed');
      expect(result.lastError).toBeTruthy();
    });
  });

  /**
   * The backfill, as the service runs it.
   *
   * The placement is the fix, so it is what the first test asserts. The derivation is
   * reachable only for a *changed* file, so a library that is fully walked has nothing
   * left to change and never derives its grouping — and a fully walked library is `idle`,
   * which returns from `step` without touching the walk at all. A backfill placed after
   * the status check therefore never runs for exactly the libraries that need it, which is
   * what the first attempt at this did: deploying it changed nothing on a library where
   * nothing had changed.
   */
  describe('the derived-grouping backfill', () => {
    /**
     * A `ScanService` over the shared `index` with a `derivation` store attached.
     *
     * Built the same way the `beforeEach` service is, rather than from `index.deps` alone:
     * `deps` is the three stores, and a service without `clientFor` and `timeoutMs` is not
     * a service — it typechecks-fails, and at runtime it fails on the first walk.
     *
     * `chunk` overrides the generous default, for the case that is about a chunk too small to
     * hold a page. It has to be a *bound* rather than a pre-charged counter, because
     * `ScanBudget` resets the counter on construction — a meter filled before `step` is a
     * meter that measures nothing, which is a fixture that cannot fail.
     */
    function withDerivation(store: NonNullable<ScanDeps['derivation']>, chunk: Partial<typeof UNBOUNDED_CHUNK> = {}): ScanService {
      return new ScanService({
        ...index.deps,
        derivation: store,
        clientFor: async (_library, onRequest) =>
          new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, dav.fetch, onRequest),
        timeoutMs: 1000,
        ...UNBOUNDED_CHUNK,
        ...chunk,
        enrichMaxPerFolder: 0,
      });
    }

    /**
     * A `derivation` double over an explicit pending set, so the test controls both ends.
     *
     * ### Why it charges, and why it refuses
     *
     * Because this is the double that could not see the shipped defect. It answered
     * `applyDerivation` for any number of writes and spent nothing, while production issues
     * **one statement per row** through `runWriteBatch(..., { requireComplete: true })` —
     * which charges each one and *refuses* rather than truncating. So a backlog larger than
     * a chunk could hold was, to this double, a backlog written in one poll for free; in
     * production it was a `SubrequestBudgetExhaustedError` thrown before `listFrontier`, on
     * every poll, with the walk never running at all.
     *
     * A double is evidence only to the extent it models the platform, and here the platform
     * is `runWriteBatch`'s contract. So the refusal is modelled: the read charges one, the
     * write charges one per row, and a page that does not fit raises the error the DAO
     * raises rather than inventing a shape of its own.
     */
    function derivationOver(pending: string[], dirPaths: Record<string, string> = {}) {
      const state = { remaining: [...pending], written: 0 };
      const meter = index.deps.subrequests;
      return {
        state,
        store: {
          listNeedingDerivation: async (_libraryId: string, limit: number) => {
            meter.charge(1, 'd1');
            return state.remaining.slice(0, limit).map((id) => ({ id, dir_path: dirPaths[id] ?? '' }));
          },
          async deriveFor(rows: readonly { id: string; dir_path: string }[]) {
          return rows.map((row) => ({ id: row.id, ...deriveFromPath(row.dir_path, DERIVED_MARKER) }));
        },
          applyDerivation: async (writes: readonly { id: string }[]) => {
            // `requireComplete`, so this is a refusal and not a truncation. Nothing is
            // written — which is what leaves the rows owed for the next poll.
            if (!meter.canAfford(writes.length)) {
              throw new SubrequestBudgetExhaustedError(
                `Writing ${writes.length} rows for songs.applyDerivation needs ${writes.length} subrequests and ${meter.remaining} remain in this invocation.`,
              );
            }
            meter.charge(writes.length, 'd1');
            state.remaining = state.remaining.filter((id) => writes.every((write) => write.id !== id));
            state.written += writes.length;
            // `billedRows` from the same derivation the DAO uses. This double writes `songs`,
            // and a scan that repaired a large library spends this phase's whole output against
            // the day's allowance — so a double reporting `writes.length` billed would make this
            // suite unable to see a ten-fold overrun on the very path that spends the most.
            return { changes: writes.length, written: writes.length, truncated: false, billedRows: billedRowsForTable('songs', writes.length) };
          },
        },
      };
    }

    it('runs for a library with no scan running, which is the case that shipped broken', async () => {
      // No `startScan`, no frontier, no WebDAV. The state a fully-scanned library is in,
      // and the state the deployed instance was in when its aggregates came back empty.
      const { store, state } = derivationOver(['s1', 's2'], { s1: 'Blur/Holocene', s2: 'Blur/For Emma' });
      const idle = withDerivation(store);

      const result = await idle.step(row);

      expect(result.status).toBe('idle');
      expect(state.written).toBe(2);
      // Reported honestly. Reporting `0` would report a repair that wrote two rows as no
      // work at all, which is the kind of number an operator reads to decide nothing
      // happened.
      expect(result.rowsWritten).toBe(2);
      // And it spent no subrequests: `dir_path` is already on the row, so this is a
      // function of data D1 holds.
      expect(result.subrequests.fetch).toBe(0);
      expect(dav.propfinds).toHaveLength(0);
    });

    it('runs for a failed scan too, because a stalled library is still broken', async () => {
      // `stalled` is the terminal state of the retry budget, and it is reached by a
      // library that is *also* missing its grouping. Returning the stored failure before
      // the backfill would leave a repaired-never library looking correctly stuck.
      const { store, state } = derivationOver(['s1']);
      const stalled = withDerivation(store);
      // Drive it to the retry bound with a genuinely failing origin, so the state is
      // reached the way it is reached in production rather than written into the double.
      const broken = serviceFailingWith(500);
      await broken.start(row);
      for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES; attempt += 1) {
        await broken.step(row);
      }
      expect(index.state().consecutive_failures).toBeGreaterThanOrEqual(MAX_CONSECUTIVE_FAILURES);

      const result = await stalled.step(row);
      expect(result.status).toBe('stalled');
      expect(state.written).toBe(1);
      expect(result.rowsWritten).toBe(1);
    });

    it('costs nothing once the library is current, so a poll on a healthy library is still free', async () => {
      // The steady state, and the property that makes running this on every poll
      // acceptable. An empty selection means the write batch is never issued, so this is
      // zero rows rather than "zero rows that changed nothing" — a no-op UPDATE would still
      // spend an allowance and a round trip.
      const { store, state } = derivationOver([]);
      const current = withDerivation(store);

      const result = await current.step(row);

      expect(result.status).toBe('idle');
      expect(result.rowsWritten).toBe(0);
      expect(state.written).toBe(0);
    });

    it('leaves the remainder for the next poll rather than draining in one', async () => {
      // A poll is a request a client is waiting on. Draining a large library in one poll
      // is a poll that times out, which is the `getScanStatus` defect on a different axis.
      const { store, state } = derivationOver(['s1', 's2', 's3', 's4', 's5']);
      const bounded = withDerivation(store);

      const first = await bounded.step(row);
      expect(first.rowsWritten).toBeLessThanOrEqual(SCAN_DERIVE_MAX_ROWS_PER_CHUNK);
      expect(state.remaining).toHaveLength(5 - state.written);

      // Converges across polls, and the first poll does not do the whole job.
      for (let poll = 0; poll < 10 && state.remaining.length > 0; poll += 1) {
        await bounded.step(row);
      }
      expect(state.remaining).toEqual([]);
    });

    it('drains a backlog larger than one chunk, and reports the poll rather than refusing', async () => {
      // ### The shipped symptom
      //
      // ~100 tracks, reported as "stuck on Scanning for two hours". The page was
      // `DERIVE_MAX_ROWS_PER_CHUNK = 200` — one `UPDATE` per row, `requireComplete` — against
      // a chunk budget of `42` and a platform ceiling of `50`. It fitted on no chunk under
      // any configuration, so `applyDerivation` **refused**, the throw left `backfill`
      // before `listFrontier`, and the walk never ran a folder. `step`'s catch recorded it
      // as a scan failure; `isAdvancing('failed')` is `true`, so the alarm stayed armed and
      // `getScanStatus` answered `scanning: true` for ever, with a `count` that never moved.
      //
      // The size is the report's own: a hundred tracks is past the point where the page
      // stops fitting, and small enough that the page is the only bound in play.
      const backlog = Array.from({ length: 100 }, (_, index) => `s${index}`);
      const { store, state } = derivationOver(backlog, Object.fromEntries(backlog.map((id) => [id, 'Blur/Holocene'])));
      const service = withDerivation(store);

      let polls = 0;
      let previous = backlog.length;
      while (state.remaining.length > 0 && polls < 20) {
        const result = await service.step(row);

        // Not `failed`. A refusal here is the whole defect, and it presents as a scan that
        // looks alive, so the status is the assertion that matters most.
        expect(result.status).toBe('idle');
        expect(result.lastError).toBeNull();

        // And it made progress: strictly fewer rows owed than the poll before. A backlog
        // that does not shrink is a permanent failure wearing a `scanning` label.
        expect(state.remaining.length).toBeLessThan(previous);
        previous = state.remaining.length;
        polls += 1;
      }

      expect(state.remaining).toEqual([]);
      // More than one poll, because a page that fits in a chunk is a *bound*, not a drain —
      // and a single poll here is how the original bug was invisible.
      expect(polls).toBeGreaterThan(1);
      expect(state.written).toBe(backlog.length);
      // The counter the chunk budgets against is the one the double charged, and it never
      // crossed the platform's ceiling — which is the guard that used to be absent, so the
      // refusal could not have been observed here at all.
      expect(index.deps.subrequests.spent).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    });

    it('leaves the whole page for the next poll rather than half-writing it', async () => {
      // The refusal is correct and must survive: the selection is on `derived_version`, so a
      // partial page leaves rows stamped and rows not stamped, and the un-stamped ones are
      // re-selected on every poll for ever. What changed is the *size* of the page and the
      // check before it, never the all-or-nothing.
      //
      // Driven by a chunk **bound**, not a pre-charged meter: `ScanBudget` resets the counter
      // on construction, so a meter filled before `step` would measure nothing — a fixture
      // that cannot fail is not a fixture. Ten statements is less than `ensure` plus the
      // read plus one page of 32, so the read answers and the write does not fit.
      const backlog = Array.from({ length: 100 }, (_, index) => `s${index}`);
      const { store, state } = derivationOver(backlog);
      const service = withDerivation(store, { chunkMaxRequests: 10 });

      const result = await service.step(row);

      expect(result.status).toBe('idle');
      // Not written, and not attempted — which is the distinction between a bounded pass and
      // a chunk that throws on every poll. `derivePending` checks `canAfford` and returns 0.
      expect(state.written).toBe(0);
      expect(state.remaining).toHaveLength(backlog.length);
      expect(result.rowsWritten).toBe(0);
    });

    it('a scan without a derivation store still walks, which is the right degradation', async () => {
      // `derivation` is optional so the doubles in this file are not required to model
      // it — and `service` is built in `beforeEach` from `index.deps`, which has none, so
      // the shared service *is* this case rather than a specially-built one. A library
      // that cannot derive keeps scanning and keeps browsing; only the aggregates stay
      // empty, which is a far better failure than a scan that does not run.
      await service.start(row);
      for (let poll = 0; poll < 50; poll += 1) {
        if ((await service.step(row)).status !== 'scanning') break;
      }

      // Every track in the sample tree: three albums of two. The count rather than a
      // status, because a scan that returned `idle` without walking would satisfy a
      // status-only assertion — which is how the retry test above was initially able to
      // pass against a wedged scan.
      expect(index.songs.size).toBe(6);
    });
  });

  it('survives a poll with no scan running without touching the network', async () => {
    // A client opening the app polls `getScanStatus` before anything is configured.
    // That path must be free.
    dav.reset();
    const result = await service.step(row);
    expect(result.status).toBe('idle');
    expect(result.subrequests.fetch).toBe(0);
    expect(result.rowsWritten).toBe(0);
    expect(dav.propfinds).toHaveLength(0);
  });

  it('clears the index when the library root is gone', async () => {
    await runToCompletion();
    expect(index.nodes.size).toBeGreaterThan(0);
    dav.reset();
    const gone = fakeDav({}, { status: 404 });
    const goneService = new ScanService({
      ...index.deps,
      clientFor: async (_library, onRequest) =>
        new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, gone.fetch, onRequest),
      timeoutMs: 1000,
      ...UNBOUNDED_CHUNK,
      // 0 keeps these cases about the walk: none of them supplies an `enrichSong`.
      enrichMaxPerFolder: 0,
    });
    const result = await goneService.start(row);
    expect(result.status).toBe('idle');
    // The version still advances, so a cached aggregate built from the old index
    // becomes unreachable rather than being served.
    expect(result.indexVersion).toBeGreaterThan(1);
  });

  /**
   * `is_scanned` is written by two callers — the scan and `TreeService`'s read-through
   * browse — from the same `Depth: 1` listing, so a stored `mtime_ms` cannot say which of
   * them wrote it. These four cases are the invariant that follows from that, and each is
   * paired: the second of each pair fails if the first is "fixed" by simply always
   * descending, which is what a fix that only adds a condition tends to do.
   */
  describe('a folder materialized by a browse rather than by a scan', () => {
    /**
     * One folder per chunk.
     *
     * This is the shape the shipped failure needed, and without it the guard is
     * untestable. `step` reads the frontier **once** and walks every folder in it, so with
     * the default 40 a root chunk that wrongly closes its children still visits them in the
     * same chunk — the bug is invisible and the library indexes fine. It only shows at a
     * chunk boundary, where the next chunk finds the frontier already empty.
     *
     * One folder per chunk is also what a large library gets in practice: a root with 80
     * albums cannot be reconciled to the origin's `Depth: 1` limit in one chunk anyway.
     */
    let oneAtATime: ScanService;

    beforeEach(() => {
      oneAtATime = new ScanService({
        ...index.deps,
        clientFor: async (_library, onRequest) =>
          new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, dav.fetch, onRequest),
        timeoutMs: 1000,
        ...UNBOUNDED_CHUNK,
        chunkFolders: 1,
        // 0 keeps these cases about the walk: none of them supplies an `enrichSong`.
        enrichMaxPerFolder: 0,
      });
    });

    /**
     * Seed `nodes` the way `TreeService.getMusicDirectory` does: a live listing
     * materialized on a client's first visit, `is_scanned` left at `0`, mtimes that match
     * what the origin currently reports.
     *
     * This is the shipped state — album folders present, every one of them closed, and the
     * scan reporting the library finished.
     */
    function seedAsBrowsed(): void {
      for (const entry of sampleTree()[ROOT]!) {
        if (entry.path === ROOT) continue;
        void index.deps.nodes.upsertMany([
          {
            libraryId: LIBRARY_ID,
            path: entry.path.slice(ROOT.length + 1),
            parentPath: '',
            name: entry.path.slice(ROOT.length + 1),
            mtimeMs: entry.mtime ?? null,
            etag: null,
            depth: 1,
            // What `NodeDAO.upsertMany` binds for an omitted `isScanned`: `undefined`
            // is falsy, so the browse path writes 0.
            isScanned: undefined,
          },
        ]);
      }
    }

    it('still descends into it, because a matching mtime does not mean it was read', async () => {
      seedAsBrowsed();
      // Present, with the origin's own mtimes and not yet reconciled — so `changed` is
      // false for every one of them, which is exactly what used to close them for good.
      expect(index.nodes.size).toBe(1);
      expect(index.nodes.get(`${LIBRARY_ID}\nBlur`)?.is_scanned).toBe(0);

      await oneAtATime.start(row);
      for (let poll = 0; poll < 50; poll += 1) {
        if ((await oneAtATime.step(row)).status !== 'scanning') break;
      }

      expect(index.songs.size).toBe(6);
      expect(index.state().status).toBe('idle');
    });

    it('still closes a folder the scan itself reconciled, so the optimization survives', async () => {
      // The paired case. If the fix were "always descend", incrementality would be gone: an
      // unchanged rescan would cost one PROPFIND per folder instead of one, against a
      // 5,000-rows/day allowance. This asserts the cheap path is still cheap, so the guard
      // above cannot be satisfied by disabling it.
      await oneAtATime.start(row);
      for (let poll = 0; poll < 50; poll += 1) {
        if ((await oneAtATime.step(row)).status !== 'scanning') break;
      }
      expect(index.songs.size).toBe(6);

      dav.reset();
      index.writes.nodes = 0;
      await oneAtATime.start(row);
      const polled = await oneAtATime.step(row);
      expect(polled.status).toBe('idle');
      expect(polled.subrequests.fetch).toBe(0);
      expect(index.writes.nodes).toBe(0);
    });
  });

  describe('a listing that placed nothing', () => {
    /**
     * A root path none of the tree's paths sit under. `sampleTree` is rooted at
     * `/dav/music`, so a library configured at `/elsewhere` receives hrefs that all fail
     * containment — the shape a server anchoring `DAV:href` differently produces.
     */
    function mismatchedLibrary(): LibraryRow {
      return library({ root_path: '/elsewhere' });
    }

    it('prunes nothing and says why, rather than reading it as a mass deletion', async () => {
      // Seed a fully indexed library first, so "nothing was pruned" is a claim about a
      // populated index rather than about an empty one.
      await runToCompletion();
      expect(index.songs.size).toBe(6);

      // Put the root back on the frontier explicitly. `start` legitimately short-circuits
      // here — this library *does* have tracks and an unchanged root, so its cheap path is
      // correct — and the case under test is the chunk, not `start`. Its own floor is
      // asserted in the next `describe`.
      await index.deps.nodes.upsertMany([
        { libraryId: LIBRARY_ID, path: '', parentPath: '', name: '', mtimeMs: 1_000_000, etag: null, depth: 0, isScanned: false },
      ]);
      // And the state has to say a scan is running: `decideStep` answers from stored
      // status before it reads the frontier, so an `idle` library is never walked however
      // full its frontier is. Its own floor is asserted in the next `describe`.
      await index.deps.scanState.markScanning(LIBRARY_ID, 0);
      dav.reset();

      const mismatched = mismatchedLibrary();
      const result = await service.step(mismatched);
      // The whole point: a listing we could not place is not evidence of a deletion.
      expect(result.status).toBe('failed');
      expect(result.lastError).toMatch(/root path/i);
      expect(index.songs.size).toBe(6);
      expect(index.nodes.size).toBeGreaterThanOrEqual(5);
    });

    it('leaves the folder on the frontier, and bounds its retries', async () => {
      // A library nobody can fix must stop retrying rather than loop for ever, which is
      // what `consecutive_failures` bounds — but it must not be silently finished either.
      // The counter and the frontier are the two halves: the counter is what stops the
      // loop, and a folder still on the frontier is what lets a fixed root path be picked
      // up by the next `startScan` without an operator editing any rows.
      const mismatched = mismatchedLibrary();
      await service.start(mismatched);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await service.step(mismatched);
      }
      expect(index.state().status).toBe('failed');
      expect(index.state().consecutive_failures).toBeGreaterThanOrEqual(MAX_CONSECUTIVE_FAILURES);

      const frontier = await index.deps.nodes.listFrontier(LIBRARY_ID, 10);
      expect(frontier.map((node) => node.path)).toContain('');
    });

    it('is not triggered by an empty folder, whose listing contains only itself', async () => {
      // The over-correction, and it was a real one: the guard first read
      // `resources.length > 0 && childPaths.length === 0`, which is **true for every empty
      // leaf directory** — a `Depth: 1` listing of a folder with nothing in it is exactly
      // one entry, the folder itself. `test/scan-do.test.ts` is what caught it, through a
      // fixture whose `Bon Iver` folder holds no tracks, and it surfaced as a scan that
      // reported `stalled` instead of `idle`.
      //
      // So the count excludes the self-entry, and this asserts that directly: an empty leaf
      // is walked to completion, not failed.
      const root = sampleTree()[ROOT]!;
      const emptyLeaf = root[1]!.path;
      const emptyTree: Record<string, DavEntry[]> = {
        [ROOT]: root,
        // A folder whose listing is itself and nothing else — no tracks, no subfolders.
        [emptyLeaf]: [{ path: emptyLeaf, collection: true, mtime: 2000 }],
      };
      const emptyDav = fakeDav(emptyTree);
      const emptyService = new ScanService({
        ...index.deps,
        clientFor: async (_library, onRequest) =>
          new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, emptyDav.fetch, onRequest),
        timeoutMs: 1000,
        ...UNBOUNDED_CHUNK,
        enrichMaxPerFolder: 0,
      });

      await emptyService.start(row);
      let last = await emptyService.step(row);
      for (let poll = 0; poll < 20 && last.status === 'scanning'; poll += 1) {
        last = await emptyService.step(row);
      }
      // Not `failed` and not `stalled`: an empty folder is a folder that reconciled fine.
      expect(last.status).toBe('idle');
      expect(last.lastError).toBeNull();
    });
  });

  describe('a completed scan that indexed nothing', () => {
    /**
     * The shipped state, built directly rather than produced by a scan — because a scan
     * now indexes this tree, which is the point of the fix. It is the operator's
     * database: one root row, `scan_state` `idle`, a matching root mtime, no tracks.
     */
    async function seedFinishedButEmpty(mtime = 1_000_000): Promise<void> {
      await index.deps.nodes.upsertMany([
        { libraryId: LIBRARY_ID, path: '', parentPath: '', name: '', mtimeMs: mtime, etag: null, depth: 0, isScanned: true },
      ]);
      await index.deps.scanState.markScanning(LIBRARY_ID, 0);
      // `false`: a folder was *visited*, which is what `scanned_delta` counts, and the
      // library's content did not change — which is what the flag counts. Passing `true`
      // would be indistinguishable from a scan that indexed something.
      await index.deps.scanState.saveProgress(LIBRARY_ID, 1, null, false);
      await index.deps.scanState.complete(LIBRARY_ID, 1);
    }

    it('is re-walked by the next startScan rather than short-circuited', async () => {
      // `start`'s cheap path compares the root's mtime and reports `idle`. That is only
      // sound if the previous scan actually read something, and `scanned_count` counts
      // folders *visited* — a walk that visited the root and closed every child unread
      // leaves it at 1. Without the track-count floor this library could never be
      // re-walked: the origin's root mtime would have to change, or the library be
      // deleted, which cascades the whole index away.
      await seedFinishedButEmpty();
      expect(index.state().status).toBe('idle');
      expect(index.state().scanned_count).toBeGreaterThan(0);
      expect(index.songs.size).toBe(0);

      dav.reset();
      const restarted = await service.start(row);
      expect(restarted.status).toBe('scanning');
      for (let poll = 0; poll < 50; poll += 1) {
        if ((await service.step(row)).status !== 'scanning') break;
      }
      expect(index.songs.size).toBe(6);
      // And it really was a re-walk, not a short-circuit that happened to look like one.
      expect(dav.propfinds.length).toBeGreaterThan(0);
    });

    it('still short-circuits a library that does have tracks', async () => {
      // The paired case again, on the same guard: with tracks indexed the cheap path is
      // the whole reason a rescan costs one subrequest, and a floor that disabled it
      // would be a regression dressed as a fix.
      await runToCompletion();
      dav.reset();
      const result = await service.start(row);
      expect(result.status).toBe('idle');
      expect(result.subrequests.fetch).toBe(1);
      expect(dav.propfinds).toHaveLength(1);
    });
  });
});
