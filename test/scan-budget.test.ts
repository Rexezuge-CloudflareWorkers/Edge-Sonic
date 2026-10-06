/**
 * A scan chunk is bounded work, and both bounds are observable.
 *
 * ### What this file is for
 *
 * `getScanStatus` was "however many folders `SCAN_CHUNK_FOLDERS` names", walked
 * sequentially with nothing checked. On an origin answering a ranged `GET` in 2.2 s
 * that is ~88 seconds, clients gave up at ~45, and the work finished server-side where
 * nobody was watching — so a client that backed off stopped advancing the scan, because
 * polling *is* the scan. Enrichment then moved per-track range reads inside that same
 * loop, taking a chunk from 40 subrequests to 1,640 against a ceiling of 50 external
 * subrequests (Free plan) — a chunk that *fails* rather than one that is slow.
 *
 * ### Why none of this was caught
 *
 * `webdavRequests` was incremented once per `PROPFIND` by the loop and never for the
 * range reads its own enrichment made, so it under-reported by up to 40x while its own
 * comment described it as instrumented "so the write/subrequest budget is testable".
 * And `fakeDav` answered instantly, so neither the subrequest count nor the wall clock
 * was ever observed. That is this repository's own rule about a double that cannot see
 * a failure: the budget lived in a comment and in the choice of default numbers, and a
 * comment is not a measurement.
 *
 * So the assertions here compare three independent observations:
 *
 * - `dav.requestCount()` — what the origin actually received,
 * - `ChunkResult.webdavRequests` — what the service reports,
 * - the frontier's contents — what the next poll will do.
 *
 * The first two must be equal, and that equality is the standing guard: it is red on
 * the branch as committed, and it goes red again the moment a WebDAV call path stops
 * being counted.
 *
 * ### Why the fixture is wide rather than deep
 *
 * A chunk reads the frontier **once**, and a folder joins it only after its parent has
 * been absorbed — so the frontier is a *level*, and a chunk walks one level per poll.
 * A narrow tree would make every bound here pass without any bound doing anything,
 * because there would never be more work than a chunk could finish. `readyFullFrontier`
 * puts twelve albums on the frontier, which is the shape a real library's album level
 * has and the case `SCAN_CHUNK_FOLDERS` was written for.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ScanService } from '@edge-sonic/backend-services/index';
import type { ScanDeps } from '@edge-sonic/backend-services/index';
import { WebDavClient } from '@edge-sonic/webdav';
import {
  DEFAULT_SCAN_CHUNK_DEADLINE_MS,
  DEFAULT_SCAN_CHUNK_FOLDERS,
  DEFAULT_SCAN_CHUNK_MAX_REQUESTS,
  DEFAULT_SCAN_ENRICH_MAX_PER_FOLDER,
  SCAN_CHUNK_FOLDER_LIMIT,
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SCAN_ENRICH_MAX_PER_FOLDER,
  SUBSREQUESTS_PER_ENRICHED_TRACK,
  SUBSREQUESTS_PER_FOLDER_BASE,
  WORKER_SUBSREQUEST_CEILING,
} from '@edge-sonic/backend-runtime/config';
import { SubrequestCounter } from '@edge-sonic/shared';
import { SubrequestBudgetExhaustedError } from '@edge-sonic/backend-errors';
import { DERIVED_VERSION, billedRowsForTable, deriveFromPath, deriveTitleFromFileName } from '@edge-sonic/backend-data/dao';
import type { ChildNodeRow, LibraryRow, NodeRow, ScanStateRow, SongRow } from '@edge-sonic/backend-data/dao';
import { fakeDav } from './helpers/fakeDav';
import { DERIVED_MARKER } from './helpers/harness';
import type { DavEntry, FakeDav } from './helpers/fakeDav';

const LIBRARY_ID = 'L1';
const ROOT = '/dav/music';
const ALBUMS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12'];
const TRACKS_PER_ALBUM = 3;

/**
 * What one of this fixture's album folders costs, in subrequests.
 *
 * Spelled out rather than imported, because `SUBSREQUESTS_PER_FOLDER_BASE` is deliberately only
 * the *base* — the part a folder costs whatever it holds — and a test that used it as the whole
 * cost would be asserting against a constant chosen to be an underestimate. This is the real
 * figure, and a ceiling built from it is a ceiling that means something:
 *
 * | Step                                   | Subrequests |
 * | -------------------------------------- | ----------- |
 * | the `PROPFIND`                         | 1           |
 * | `listChildren` to diff against         | 1           |
 * | `upsertMany` — one per child           | 3           |
 * | `upsertFileFacts` — one per track      | 3           |
 * | `upsertMany` — the folder's own row    | 1           |
 * | `listChildren` for the prune           | 1           |
 * | `deleteInDirectoryNotIn` — its read    | 1           |
 */
const FIXTURE_FOLDER_COST = 1 + 1 + TRACKS_PER_ALBUM + TRACKS_PER_ALBUM + 1 + 1 + 1;

/**
 * The same folder, up to the point enrichment starts — which is two fewer, because the prune's
 * read and its (empty) delete run *after* the tracks.
 *
 * A ceiling that decides how many tracks get enriched has to be computed against this figure
 * rather than the folder's total: adding the prune's two statements to the estimate makes the
 * ceiling look smaller than it is, admits a third track, and produces a test that passes for
 * the wrong reason while documenting a bound nobody has.
 */
const FIXTURE_FOLDER_COST_BEFORE_ENRICHMENT = FIXTURE_FOLDER_COST - 2;

/**
 * An index that records writes and holds the frontier, in memory.
 *
 * The scan's view rather than a `node:sqlite` one: these cases are about how much work
 * a chunk chooses to do, which is decided above the SQL. `test/schema.int.test.ts`
 * covers the SQL against a real planner, where a wrong query and a double cannot
 * disagree.
 */
interface IndexOptions {
  /**
   * Milliseconds every D1 call costs.
   *
   * The whole point. `scanPrelude`'s derivation is documented as "charged only against the
   * chunk's wall-clock deadline, because D1 latency is real and the subrequest ceiling is a
   * resource it cannot spend" — and this double answered every store call on the next
   * microtask, so **D1 was free**. The deadline assertion below was therefore made in the one
   * world where a deadline does nothing and looks like one that works: a chunk could only be
   * slow through the origin, which is the half `fakeDav`'s `latencyMs` already models.
   *
   * So the store is given a latency of its own, and one test asserts the deadline fires
   * with the origin answering instantly. Without it the bound is asserted but only half
   * measured, and the half that is missing is the half D1 actually causes in production.
   */
  d1LatencyMs?: number;
  /**
   * The counter the double charges, standing in for the one the DAOs hold in production.
   *
   * ### Why this is the most important line in the file
   *
   * Because it is what makes this double model **D1** rather than a database in general. It
   * used to model a database whose statements were free, because nothing said otherwise — the
   * scan's budget metered `fetch`, and this store sat beside it charging nothing. So the
   * suite could see the WebDAV half of a chunk precisely and the half that actually killed the
   * invocation not at all, and reported the product as comfortably inside a ceiling of 50
   * while a chunk spent ~240.
   *
   * One subrequest per statement, matching `BaseDAO.withRetry` and `BaseDAO.runWriteBatch` —
   * pessimistic about `batch()`, because the platform does not say which reading is right and
   * over-counting a budget only makes a scan slower.
   */
  meter?: SubrequestCounter;
}

function createIndex(options: IndexOptions = {}) {
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
    updated_at: 0,
  };

  const nodeKey = (path: string): string => `${LIBRARY_ID}\n${path}`;

  // Charged per call rather than per statement, because that is the granularity a DAO's
  // `withRetry` sees and the one the deadline is measured against. `d1Calls` is exposed so a
  // test can assert the deadline fired *without* spending a subrequest — the two bounds
  // guard different resources and a test that cannot tell them apart proves neither.
  let d1Calls = 0;
  let d1Statements = 0;
  // Settable rather than fixed, so a test can leave the **setup** fast and make only the
  // chunk under test slow. A fixed latency applies to `readyFullFrontier`'s own drain and
  // re-seed as well, which changes the fixture rather than the case.
  let latencyMs = options.d1LatencyMs ?? 0;
  //
  // The **platform** ceiling, not an unlimited one — which is the whole point of this double
  // modelling D1 rather than a database. An unmetered store let every write batch be issued
  // whole, so the cases below measured a chunk that could never happen: one that never ran out
  // of anything. With the real ceiling, a batch that does not fit truncates exactly as
  // `BaseDAO.runWriteBatch` truncates, and a folder too large for one chunk stays on the
  // frontier — which is the behaviour the shipped defaults depend on.
  const meter = options.meter ?? new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);

  /**
   * One D1 statement: charged, counted and optionally slow.
   *
   * `statements` rather than always 1, because a DAO's write batch costs one subrequest per
   * statement — `runWriteBatch` charges the group's length — and a folder of three tracks
   * upserts four rows. Counting every store call as one is how a double under-reports by the
   * same factor the product over-spent by.
   */
  const charge = async <T>(value: () => T, statements = 1): Promise<T> => {
    d1Calls += 1;
    d1Statements += statements;
    meter.charge(statements, 'd1');
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return value();
  };

  /**
   * How many of `statements` fit what is left, and how many were written.
   *
   * `runWriteBatch`'s own rule, so the truncation this models is the truncation production
   * does rather than an invention of the test.
   */
  const writeBatch = (statements: number): { written: number; truncated: boolean } => {
    const fits = Number.isFinite(meter.ceiling) ? Math.max(0, Math.min(statements, Math.floor(meter.remaining))) : statements;
    return { written: fits, truncated: fits < statements };
  };

  return {
    d1Calls: () => d1Calls,
    d1Statements: () => d1Statements,
    meter,
    setD1Latency: (ms: number) => {
      latencyMs = ms;
    },
    nodes,
    songs,
    state: () => state,
    /**
    Folders still to be opened, in the order `listFrontier` returns them.
    */
    frontier: (): string[] =>
      [...nodes.values()]
        .filter((node) => node.is_scanned === 0)
        .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
        .map((node) => node.path),
    deps: {
      nodes: {
        find: async (_libraryId: string, path: string) => await charge(() => nodes.get(nodeKey(path)) ?? null),
        listChildren: async (_libraryId: string, parentPath: string) =>
          await charge(() => [...nodes.values()].filter((node) => node.parent_path === parentPath).sort((a, b) => a.name_ci.localeCompare(b.name_ci))),
        // Reports both planes, and `has_song` is read from `songs` rather than inferred from
        // `nodes` — which is the whole point of the method. Deriving it from the node row would
        // model the shipped defect, where a node row current meant "nothing to write" for a song
        // row that had never been written, and the folder closed on that answer.
        listChildrenWithSongPresence: async (_libraryId: string, parentPath: string) =>
          await charge(() =>
            [...nodes.values()]
              .filter((node) => node.parent_path === parentPath)
              .sort((a, b) => a.name_ci.localeCompare(b.name_ci))
              // Matched by **path**, not by the song id: `songs` is keyed by the encoded id while
              // `nodes` is keyed by path, and the real statement joins on `(library_id, path)`.
              // A double that looked the id up in a path-keyed map — or vice versa — would report
              // every child as having no song row, which is the defect's own symptom and would
              // make this suite re-enrich every track on every pass.
              .map((node) => ({ ...node, has_song: [...songs.values()].some((song) => song.path === node.path) ? 1 : 0 }) as ChildNodeRow),
          ),
        listRoots: async () => await charge(() => [...nodes.values()].filter((node) => node.parent_path === '' && node.path !== '')),
        listFrontier: async (_libraryId: string, limit: number) =>
          await charge(() =>
            [...nodes.values()]
              .filter((node) => node.is_scanned === 0)
              .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
              .slice(0, limit),
          ),
        /**
         * Models the statement, including the `WHERE` it now carries.
         *
         * The skip below used to be the whole model of "an unchanged row costs nothing" — and it
         * was **more generous than the statement was**. The real `UPSERT` had no `WHERE`, so it
         * rewrote every row it was offered and reported a change for each, because `updated_at` is
         * `nowSeconds()` and therefore always differed. So this double reported the row writes that
         * *would* happen after the fix while the chunk-cost arithmetic around it measured a world
         * where they already did not — which is how a scan that wrote 231,620 rows to one
         * 80-album library measured as though it were writing nothing.
         *
         * The comparison is written out rather than imported from `nodeRowNeedsWrite`, and that is a
         * deliberate exception worth naming. An earlier version of this comment claimed it imported
         * the shared predicate "so the double and the caller agree by construction" — which would
         * have been the right instinct and the wrong implementation: the double is checking what
         * the *statement* does to a row, while `nodeRowNeedsWrite` decides what the *caller* offers
         * it. Using the caller's predicate here would let a caller bug and a statement bug cancel
         * out into a passing test. So the columns are listed against the statement's own `WHERE`,
         * and `test/scan-convergence.test.ts` asserts that list against real SQLite — which is what
         * keeps the two copies from drifting.
         */
        upsertMany: async (inputs: readonly { libraryId: string; path: string; parentPath: string; name: string; mtimeMs: number | null; etag: string | null; depth: number; isScanned?: boolean }[]) => {
          const { written } = writeBatch(inputs.length);
          const result = await charge(() => {
          let changed = 0;
          for (const input of inputs.slice(0, written)) {
            const key = nodeKey(input.path);
            const existing = nodes.get(key);
            // Every column the statement's `WHERE` compares, and `updated_at` deliberately not —
            // so an unchanged row is *not* touched, which is what makes `updated_at` answerable.
            if (
              existing !== undefined &&
              existing.parent_path === input.parentPath &&
              existing.name === input.name &&
              existing.name_ci === input.name.toLowerCase() &&
              existing.mtime_ms === input.mtimeMs &&
              existing.etag === input.etag &&
              existing.depth === input.depth &&
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
          return changed;
        }, inputs.length);
          return { changes: result, written, truncated: written < inputs.length, billedRows: billedRowsForTable('nodes', result) };
        },
        deleteSubtree: async (_libraryId: string, path: string) => {
          const doomed = [...nodes.values()].filter((node) => node.path === path || node.path.startsWith(`${path}/`));
          for (const node of doomed) nodes.delete(nodeKey(node.path));
          return { changes: doomed.length, written: doomed.length, truncated: false, billedRows: billedRowsForTable('nodes', doomed.length) };
        },
        countByLibrary: async () => nodes.size,
      },
      songs: {
        // Derives the grouping, because the real `UPSERT_FILE_FACTS` does.
        //
        // This double wrote `album: null, album_ci: null, artist: null` with no
        // `derived_version` — *verbatim* the defect `AGENTS.md` records as shipped and then
        // fixed in `test/scan-incremental.test.ts`, which imports `deriveFromPath` and
        // `DERIVED_VERSION` for exactly this reason. The suite that measures a chunk's
        // cost was therefore running against a world in which no row is ever derived: a
        // double disagreeing with production about the very column under repair, which is
        // the failure mode the rule about doubles names.
        //
        // Which is what `derived_version` below used to get *wrong in the other direction*.
        // Adding it here was recorded as agreeing with `UPSERT_FILE_FACTS` — and the
        // statement did not stamp it, so both doubles were corrected to match a statement
        // that did not exist and the real defect stood. `test/schema.int.test.ts` runs the
        // statement itself now; that is what makes this line an assertion rather than a
        // second copy of the claim.
        upsertFileFacts: async (inputs: readonly { id: string; path: string; size: number; mtimeMs: number }[]) => {
          const { written } = writeBatch(inputs.length);
          const result = await charge(() => {
          for (const input of inputs.slice(0, written)) {
            const dirPath = input.path.split('/').slice(0, -1).join('/');
            const derived = deriveFromPath(dirPath, DERIVED_MARKER);
            songs.set(input.id, {
              id: input.id,
              library_id: LIBRARY_ID,
              path: input.path,
              dir_path: dirPath,
              name: input.path.split('/').pop() ?? input.path,
              name_ci: input.path.toLowerCase(),
              size: input.size,
              mtime_ms: input.mtimeMs,
              content_type: null,
              suffix: 'flac',
              // Derived from the file's name, which is what the statement does. `null` here
              // is this repository's recorded double defect on this pair of columns: the
              // suite agreed with itself and with neither production, and 113 of 118
              // imported stars reported `not-found` on a library indexed under exactly the
              // titles it was displaying. `test/schema.int.test.ts` runs the statement over
              // real SQLite; this line is the double agreeing with it.
              title: deriveTitleFromFileName(input.path.split('/').pop() ?? input.path),
              title_ci: deriveTitleFromFileName(input.path.split('/').pop() ?? input.path).toLowerCase(),
              artist: derived.artist,
              artist_ci: derived.artist === null ? null : derived.artist.toLowerCase(),
              album: derived.album,
              album_ci: derived.album === null ? null : derived.album.toLowerCase(),
              // `album_artist` takes the derived **artist**, per `UPSERT_FILE_FACTS`:
              // "`getArtist` groups on it, and an album whose album-artist column is NULL
              // does not appear under the artist a client navigated to". Copying that
              // comment rather than the rule is how the two drift.
              album_artist: derived.artist,
              album_artist_ci: derived.artist === null ? null : derived.artist.toLowerCase(),
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
              reader_version: 0,
              derived_version: DERIVED_VERSION,
              created_at: 0,
              updated_at: 0,
            } as SongRow);
          }
          return inputs.length;
        }, inputs.length);
          return { changes: result, written, truncated: written < inputs.length, billedRows: billedRowsForTable('songs', result) };
        },
        // The prune path, made **visible**. It returned 0 unconditionally, so the largest
        // row-write cost in a cold scan — a folder of deleted files — was free in every
        // budget measurement here. Now it costs rows and removes them, so a chunk that
        // prunes is measurable the way a chunk that indexes is.
        // The prune path, made **visible**. It returned 0 unconditionally, so the largest
        // row-write cost in a cold scan — a folder of deleted files — was free in every
        // budget measurement in this file. It now costs rows and removes them, so a chunk
        // that prunes is measurable the way a chunk that indexes is.
        deleteInDirectoryNotIn: async (_libraryId: string, dirPath: string, keepPaths: readonly string[]) => {
          const keep = new Set(keepPaths);
          const doomed = await charge(() => [...songs.values()].filter((song) => song.dir_path === dirPath && !keep.has(song.path)), 1);
          // The deletes are a batch of their own, so they are charged as one — which is the
          // case that makes the scan's prune a budget item at all.
          const { written } = writeBatch(doomed.length);
          for (const song of doomed.slice(0, written)) songs.delete(song.id);
          if (doomed.length > 0) meter.charge(doomed.length, 'd1');
          return { changes: written, written, truncated: written < doomed.length, billedRows: billedRowsForTable('songs', written) };
        },
        deleteSubtree: async (_libraryId: string, dirPath: string) => {
          const doomed = [...songs.values()].filter((song) => song.dir_path === dirPath);
          for (const song of doomed) songs.delete(song.id);
          return { changes: doomed.length, written: doomed.length, truncated: false, billedRows: billedRowsForTable('songs', doomed.length) };
        },
        countByLibrary: async () => songs.size,
      },
      scanState: {
        find: async () => state,
        ensure: async () => state,
        markScanning: async (_libraryId: string, total: number) => {
          state = { ...state, status: 'scanning', total_count: total, scanned_count: 0, last_error: null };
        },
        saveProgress: async (_libraryId: string, scanned: number) => {
          state = { ...state, status: 'scanning', scanned_count: scanned };
        },
        complete: async (_libraryId: string, scanned: number) => {
          state = { ...state, status: 'idle', scanned_count: scanned, index_version: state.index_version + 1 };
          return state.index_version;
        },
        fail: async (_libraryId: string, error: string) => {
          // Incremented, because the returned count is what bounds the retry: a
          // double that always returned 1 would let a broken scan retry for ever
          // and a test asserting the bound would pass for the wrong reason.
          state = { ...state, status: 'failed', last_error: error, consecutive_failures: state.consecutive_failures + 1 };
          return state.consecutive_failures;
        },
      },
    },
  };
}

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
 * `count` albums of three tracks directly under the root.
 *
 * The root listing holds the root itself first, which is exactly the shape a real
 * `Depth: 1` response has — see `fakeDav`.
 */
function albumTree(count: number): Record<string, DavEntry[]> {
  const tree: Record<string, DavEntry[]> = {
    [ROOT]: [{ path: ROOT, collection: true, mtime: 1_000_000 }],
  };
  for (let index = 0; index < count; index += 1) {
    const album = ALBUMS[index]!;
    const mtime = 1_002_000 + index;
    tree[ROOT]!.push({ path: `${ROOT}/${album}`, collection: true, mtime });
    tree[`${ROOT}/${album}`] = [{ path: `${ROOT}/${album}`, collection: true, mtime }];
    for (let track = 1; track <= TRACKS_PER_ALBUM; track += 1) {
      tree[`${ROOT}/${album}`]!.push({
        path: `${ROOT}/${album}/${String(track).padStart(2, '0')}.flac`,
        size: 1000 * track,
        mtime,
        contentType: 'audio/flac',
        etag: `"${album}-${track}"`,
      });
    }
  }
  return tree;
}

interface ChunkOverrides {
  maxRequests?: number;
  deadlineMs?: number;
  folders?: number;
  /**
   * Whether the scan enriches what it changed.
   *
   * Off for the cases whose point is a legible per-folder cost — one `PROPFIND` a
   * folder — so "a ceiling of 3 admits 3 folders" is a statement about the ceiling
   * rather than about how many range reads an album happened to need.
   */
  enrich?: boolean;
  /**
   * The derivation backfill, when a case is about the backfill and the walk sharing one
   * budget.
   *
   * `undefined` — the default — is a harness with **no** derivation store, which is what
   * every case in this file had until the one below. So the file that measures a chunk's
   * cost never ran the phase that runs first on every poll and shares that cost. `backfill`
   * answers `0` without it, which is a correct degradation and an invisible one.
   */
  derivation?: NonNullable<ScanDeps['derivation']>;
}

interface Harness {
  index: ReturnType<typeof createIndex>;
  dav: FakeDav;
  row: LibraryRow;
  /**
  What the origin received — an observation, not the service's own arithmetic.
  */
  issued: () => number;
  makeService: (overrides?: ChunkOverrides) => ScanService;
  /**
  Poll to completion, so the index holds the whole library.
  */
  drain: (service: ScanService) => Promise<void>;
  /**
   * Index the library, move every entry, and descend back to the album level.
   *
   * Leaves `count` albums on the frontier with the scan `scanning` and the origin's
   * counters zeroed, which is the state a chunk's bounds have to work in. A *second*
   * service takes the chunk under test: the setup deliberately runs with generous
   * bounds, or a `deadlineMs: 0` chunk would never reach the wide level at all.
   */
  readyFullFrontier: (count?: number) => Promise<void>;
}

/**
 * Not `createHarness`: `test/helpers/harness.ts` exports a `createHarness` too, and it
 * builds something quite different — a real `EdgeSonicWorker` over a real D1. Two functions
 * with one name and two contracts means the next reader who greps `createHarness` gets
 * whichever they expected.
 */
/**
 * An enrichment that wrote nothing, which is a different answer from one that was not asked.
 *
 * A value rather than an inline `{ rowsWritten: 0, billedRows: 0 }` at the one site that needs
 * it, for the `NO_FOLDER_WRITES` reason: an object literal there is where a third count would be
 * added to the type and not to the value.
 */
const NO_ENRICHMENT_WRITE = { rowsWritten: 0, billedRows: 0 } as const;

function createScanHarness(tree: Record<string, DavEntry[]>, latencyMs?: number, d1LatencyMs?: number, meterCeiling?: number): Harness {
  const index = createIndex({
    ...(d1LatencyMs !== undefined && { d1LatencyMs }),
    ...(meterCeiling !== undefined && { meter: new SubrequestCounter(meterCeiling) }),
  });
  const dav = fakeDav(tree, latencyMs === undefined ? {} : { latencyMs });
  const row = library();

  const harness: Harness = {
    index,
    dav,
    row,
    issued: () => dav.requestCount(),
    makeService: (overrides = {}) =>
      new ScanService({
        ...index.deps,
        // The counter the store double above charges. Without it the scan would budget against
        // a counter of its own and the D1 half of every chunk would be invisible to the
        // assertions below — which is the defect this file exists to catch, reproduced by the
        // fix.
        subrequests: index.meter,
        // The real client, so the charge happens inside `WebDavClient.request()` —
        // the same place production charges it. A `clientFor` that ignored `onRequest`
        // would make every count assertion below pass vacuously.
        clientFor: async (libraryRow, onRequest) =>
          new WebDavClient(libraryRow.base_url, libraryRow.root_path, { username: 'u', password: 'p' }, dav.fetch, onRequest),
        timeoutMs: 1000,
        chunkFolders: overrides.folders ?? 40,
        chunkMaxRequests: overrides.maxRequests ?? 10_000,
        chunkDeadlineMs: overrides.deadlineMs ?? 60_000,
        // Enrichment issues **real** range reads through a real client, the way
        // `EnrichmentService` does. A stub that merely called `onRequest()` would
        // charge the budget without the origin ever seeing a request, and the
        // `webdavRequests === issued()` assertions would compare two different numbers
        // and agree about nothing.
        //
        // Two reads a track — a prefix, plus a tail for a container whose length is
        // only recorded at the end of the file. The Ogg case is what took a chunk from
        // 40 subrequests to 1,640, so it is the cost modelled here.
        //
        // `enrich: false` is a per-folder bound of **zero** rather than an absent
        // callback, because a bound of zero is what "enrich nothing" is, and
        // `enrichMaxPerFolder` is required — so omitting it would make this a different
        // shape of service rather than a differently configured one.
        enrichMaxPerFolder: overrides.enrich === false ? 0 : 20,
        ...(overrides.derivation !== undefined && { derivation: overrides.derivation }),
        ...(overrides.enrich !== false && {
          enrichSong: async (libraryRow, facts, onRequest) => {
            const client = new WebDavClient(libraryRow.base_url, libraryRow.root_path, { username: 'u', password: 'p' }, dav.fetch, onRequest);
            // The three charges `EnrichmentService` makes that are not WebDAV: a `songMeta` KV
            // read on the way in, an `applyMetadata` and a `songMeta` KV write on the way out.
            // Modelled explicitly rather than by standing up the real service, because what
            // these cases measure is the cost of a track — and that cost is 5, which is the
            // number the chunk's per-track reservation was wrong about by 3.
            index.meter.charge(1, 'kv');
            try {
              await client.readPrefix(facts.path, 4096, 1000);
              await client.readTail(facts.path, 4096, facts.size, 1000);
              index.meter.charge(1, 'd1');
              index.meter.charge(1, 'kv');
              // One `applyMetadata` is one row, and the scan's day-row budget is metered
              // from this return value — so a double that modelled the cost of a track but
              // not its row write would leave the budget untested. Paired with the failure
              // below, because "wrote a row" and "was asked to" are different answers.
              // `billedRows` is the `songs` figure, not the row count: an `UPDATE songs`
              // rewrites nine index entries, and the day budget is denominated in that.
              // A double returning `1` for both would make every budget here ten times
              // larger than production's, which is the failure this suite exists to catch
              // in the *opposite* direction.
              return { rowsWritten: 1, billedRows: billedRowsForTable('songs', 1) };
            } catch {
              // The scan swallows a failed enrichment and leaves the track for
              // `getSong`; these cases are about cost, not decoding. And it wrote
              // nothing, so it contributes nothing to either count — which is the whole
              // reason it is a pair: "asked to" and "wrote" are different answers, and a
              // swallowed exception is the second one.
              return NO_ENRICHMENT_WRITE;
            }
          },
        }),
      }),
    drain: async (service) => {
      await service.start(row);
      for (let poll = 0; poll < 50; poll += 1) {
        if ((await service.step(row)).status !== 'scanning') return;
      }
      throw new Error('scan did not complete');
    },
    readyFullFrontier: async (count = ALBUMS.length) => {
      // Generous bounds throughout: this is the *setup*, and a bound applied here
      // would be the thing under test rather than its precondition.
      const setup = harness.makeService();
      await harness.drain(setup);

      // Every entry moves, so the root probe re-seeds the tree. Built as a **new**
      // tree through `setTree`, because the fake reads whatever tree it was last
      // handed: a test that mutates an object the fake no longer holds makes the scan
      // look like it is ignoring every change, and the failure reads as a product bug
      // rather than a fixture bug.
      let mtime = 9_000_000;
      const next: Record<string, DavEntry[]> = {};
      for (const [directory, entries] of Object.entries(tree)) {
        next[directory] = entries.map((entry) => ({
          ...entry,
          mtime: (mtime += 1000),
          etag: entry.collection ? entry.etag : `"${entry.path}-${mtime}"`,
        }));
      }
      dav.setTree(next);
      dav.reset();

      const descend = harness.makeService();
      await descend.start(row);
      // One chunk to re-absorb the root, which is what puts the albums back on the
      // frontier. The chunk under test is the one *after* this.
      await descend.step(row);
      // Zeroed again, so `issued()` counts the chunk under test and nothing else.
      dav.reset();
      expect(index.frontier()).toHaveLength(count);
    },
  };
  return harness;
}

describe('a scan chunk is bounded work', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createScanHarness(albumTree(ALBUMS.length));
  });

  it('reports the subrequests the origin actually received, including enrichment', async () => {
    // THE regression test. On the branch as committed this was the folder count and
    // nothing else — one per `PROPFIND`, with the range reads the scan's own
    // enrichment caused charged to nothing. The field's comment claimed it was
    // instrumented "so the write/subrequest budget is testable"; it was an undercount
    // by up to 40x.
    await harness.readyFullFrontier();
    const result = await harness.makeService().step(harness.row);

    expect(result.subrequests.fetch).toBe(harness.issued());
    // And not the walk-only number, which is what it used to report.
    expect(result.subrequests.fetch).toBeGreaterThan(result.foldersVisited);
  });

  it('leaves the frontier when the request ceiling is reached, and names the bound', async () => {
    // Two folders' worth of ceiling, so two folders are indexed and the rest are left. The
    // budget is now a folder's whole cost rather than its `PROPFIND`, so "three requests" no
    // longer means "three folders" — and that is the change that keeps a chunk from starting
    // work it cannot finish, which on this platform is not slow work.
    await harness.readyFullFrontier();
    const result = await harness.makeService({ maxRequests: FIXTURE_FOLDER_COST * 2, enrich: false }).step(harness.row);

    expect(result.status).toBe('scanning');
    expect(result.foldersVisited).toBe(2);
    // The chunk budget says when to *stop starting* work; the platform ceiling says how much
    // may be spent. A chunk can overshoot its own budget by the tail of the folder it was
    // already inside — that is what `SUBSREQUEST_INVOCATION_RESERVE` pays for — and by no more
    // than one folder, because the walk checks before each folder rather than after.
    expect(result.subrequests.total).toBeLessThanOrEqual(FIXTURE_FOLDER_COST * 2 + FIXTURE_FOLDER_COST);
    expect(result.subrequests.total).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    expect(result.stoppedBy).toBe('requests');
    // Folders left on the frontier for the next poll, rather than lost.
    expect(harness.index.frontier()).toHaveLength(ALBUMS.length - 2);
  });

  it('leaves the frontier when the deadline is reached, and names that bound instead', async () => {
    // `deadlineMs: 0` is the deterministic form of a slow origin: no request is
    // started, so no fake clock is needed to prove the check runs at all. Paired with
    // the generous-deadline case below, because a deadline that silently did nothing
    // would pass this and fail nothing.
    await harness.readyFullFrontier();
    const result = await harness.makeService({ deadlineMs: 0, enrich: false }).step(harness.row);

    expect(result.status).toBe('scanning');
    expect(result.foldersVisited).toBe(0);
    // Nothing at all this time — not even the probe, which `start` already spent.
    expect(harness.issued()).toBe(0);
    expect(result.stoppedBy).toBe('deadline');
    // The whole frontier is still there.
    expect(harness.index.frontier()).toHaveLength(ALBUMS.length);
  });

  it('stops on the deadline when only D1 is slow, and the origin pays almost nothing for it', async () => {
    // ### The half of the deadline this file could not previously see
    //
    // `scanPrelude`'s backfill is documented as "charged only against the chunk's
    // wall-clock deadline, because D1 latency is real and the subrequest ceiling is a
    // resource it cannot spend" — and every store call in this double answered on the
    // next microtask. So **D1 was free**, and every deadline assertion here was made in
    // the one world where a deadline does nothing and looks like one that works: the only
    // way a chunk could be slow was the origin, which `fakeDav`'s `latencyMs` already
    // modelled. The bound was asserted; half of what it bounds was unmeasured.
    //
    // So the origin here answers instantly and the store is the slow part. The two bounds
    // guard different resources and this is the case that tells them apart: the chunk must
    // stop on time while spending **zero** subrequests, because a deadline that fired
    // because of WebDAV would have spent at least one.
    const slowStore = createScanHarness(albumTree(ALBUMS.length));
    await slowStore.readyFullFrontier();
    // Only now is the store slow, so the fixture is the one every other case builds.
    slowStore.index.setD1Latency(12);
    const d1Before = slowStore.index.d1Calls();

    const result = await slowStore.makeService({ deadlineMs: 30, maxRequests: 10_000, enrich: false }).step(slowStore.row);

    expect(result.stoppedBy, 'the deadline, not the request ceiling').toBe('deadline');
    // The store *was* used, so this is a chunk cut short by D1 rather than one that found
    // nothing to do.
    expect(slowStore.index.d1Calls()).toBeGreaterThan(d1Before);

    // The shape of the cut is the assertion, and it is the shape `ScanBudget` documents:
    // "checked between units of work, so a chunk overruns by at most one in-flight
    // request". So the deadline stops the walk early **and** the origin cost is bounded by
    // that one request — against the twelve a full frontier would need.
    //
    // A deadline that fired because of WebDAV would have spent one request *per folder
    // visited*, and a `canAfford` that ignored time entirely would have spent all twelve.
    // Both fail these two numbers.
    expect(result.foldersVisited).toBeGreaterThan(0);
    expect(result.foldersVisited).toBeLessThan(ALBUMS.length);
    expect(slowStore.issued()).toBe(result.subrequests.fetch);
    expect(slowStore.issued()).toBeLessThanOrEqual(result.foldersVisited);

    // And the folders it did not reach are all still on the frontier, which is what makes
    // the chunk resumable rather than lossy.
    expect(slowStore.index.frontier()).toHaveLength(ALBUMS.length - result.foldersVisited);
  });

  it('visits the whole frontier when the bounds are generous, so the checks above have teeth', async () => {
    // The guard without this: a `canAfford` that always returned `false` would make
    // both bound tests pass, and every scan would silently do nothing. This is the
    // "a guard needs a test that proves it has teeth" rule from the testing guide.
    //
    // Its own harness, with the ceiling raised, because *generous* now means generous in both
    // dimensions. Twelve albums of three tracks cost ~130 subrequests to index, which no
    // single Free-plan invocation can pay for — so on the real ceiling this case would be
    // measuring the ceiling rather than the guard, and the guard would go untested.
    const generous = createScanHarness(albumTree(ALBUMS.length), undefined, undefined, WORKER_SUBSREQUEST_CEILING * 10);
    await generous.readyFullFrontier();
    const result = await generous.makeService({ maxRequests: 10_000, deadlineMs: 60_000, enrich: false }).step(generous.row);

    expect(result.foldersVisited).toBe(ALBUMS.length);
    expect(result.stoppedBy).toBe('frontier');
  });

  it('reports `frontier` — not a limit — for a chunk that simply ran out of folders', async () => {
    // The ordinary case must not be dressed up as a problem, or an operator reads a
    // line about limits on every healthy poll.
    const generous = createScanHarness(albumTree(ALBUMS.length), undefined, undefined, WORKER_SUBSREQUEST_CEILING * 10);
    await generous.readyFullFrontier();
    expect((await generous.makeService({ enrich: false }).step(generous.row)).stoppedBy).toBe('frontier');
  });

  it('leaves the frontier partly drained on the real ceiling, and says so rather than failing', async () => {
    // The Free-plan shape, asserted as the *expected* behaviour rather than as a compromise:
    // twelve albums cost more than one invocation's ceiling, so a chunk reconciles the ones
    // that fit, reports `requests`, and leaves the rest for the alarm to come back for. The
    // assertion that matters is the last one — the chunk returned. Before the ceiling was
    // measured, it did not: the platform terminated the invocation.
    await harness.readyFullFrontier();
    const result = await harness.makeService({ maxRequests: 10_000, enrich: false }).step(harness.row);

    expect(result.status).toBe('scanning');
    expect(result.stoppedBy).toBe('requests');
    expect(result.foldersVisited).toBeGreaterThan(0);
    expect(result.foldersVisited).toBeLessThan(ALBUMS.length);
    expect(result.subrequests.total).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    expect(harness.index.frontier().length).toBeGreaterThan(0);
  });

  it('resumes on the next poll with no folder lost and none walked twice', async () => {
    // The property that makes leaving early safe: the frontier is in D1, so a folder
    // this chunk skipped is the next chunk's work. Asserted on the paths the origin
    // was actually asked for, because `scanned_count` is a running total and says
    // nothing about which folders were visited.
    await harness.readyFullFrontier();
    // Three folders' worth, not three requests'. A ceiling that cannot pay for a whole folder
    // admits none, which is the correct answer and a different one from "admits three folders".
    const service = harness.makeService({ maxRequests: FIXTURE_FOLDER_COST * 3, enrich: false });
    const first = await service.step(harness.row);
    expect(first.foldersVisited).toBe(3);
    expect(first.stoppedBy).toBe('requests');

    for (let poll = 0; poll < 20; poll += 1) {
      if ((await service.step(harness.row)).status !== 'scanning') break;
    }

    // Every album walked exactly once across the chunks — a `Depth: 1` walk of a path
    // is the only request for it, so a repeat is a folder walked twice — and the scan
    // finished rather than looping on a frontier it could not drain.
    const walked = harness.dav.propfinds.filter((path) => ALBUMS.includes(path.slice(ROOT.length + 1)));
    expect(new Set(walked).size).toBe(walked.length);
    expect(new Set(walked)).toEqual(new Set(ALBUMS.map((album) => `${ROOT}/${album}`)));
    expect(harness.index.frontier()).toEqual([]);
  });

  it('admits no folder at all when the ceiling cannot pay for one', async () => {
    // The case that was impossible to express before, and the one a Free-plan account lives
    // in. A chunk that checks only the cost of the next `PROPFIND` starts a folder it cannot
    // finish; on this platform that is not a slow folder, it is a terminated invocation. So
    // the check is the folder's whole base cost, and below it the chunk does nothing and says
    // so — a normal, resumable return rather than a failure.
    await harness.readyFullFrontier();
    const result = await harness.makeService({ maxRequests: SUBSREQUESTS_PER_FOLDER_BASE - 1, enrich: false }).step(harness.row);

    expect(result.status).toBe('scanning');
    expect(result.foldersVisited).toBe(0);
    expect(result.stoppedBy).toBe('requests');
    expect(harness.dav.requestCount()).toBe(0);
    // And the frontier is untouched, so the next poll with a workable ceiling does the work.
    expect(harness.index.frontier()).toHaveLength(ALBUMS.length);
  });

  it('enriches the tracks it can afford, and leaves the rest for `getSong`', async () => {
    // Enrichment takes the remainder of the budget rather than a reserved slice, so
    // a wide-changed album can end its own chunk. The tracks it skipped keep
    // `enriched_at = null` — a degraded answer, not a failed chunk.
    //
    // The ceiling is two tracks plus a folder: an album of three tracks costs `6` to index and
    // `SUBSREQUESTS_PER_ENRICHED_TRACK` (5) a track to enrich, so 20 pays for the folder and
    // two of its three tracks and stops before the third. That the *third* is the one left
    // behind is the assertion that matters — a budget which spent its remainder on nothing, or
    // on all three, would both pass a count-only check.
    await harness.readyFullFrontier();
    // The folder up to enrichment (9), then two tracks at 5 each, then **one short of a third**:
    // 9 + 10 + 4 = 23, so the third track would need 24. Spelled out rather than tuned, because
    // a ceiling chosen to make an assertion pass is the thing this file exists to distrust — and
    // `SUBSREQUESTS_PER_FOLDER_BASE` cannot be used here, since it is only the part of a
    // folder's cost that does not depend on how many tracks it holds.
    const ceiling = FIXTURE_FOLDER_COST_BEFORE_ENRICHMENT + SUBSREQUESTS_PER_ENRICHED_TRACK * 2 + (SUBSREQUESTS_PER_ENRICHED_TRACK - 1);
    const result = await harness.makeService({ maxRequests: ceiling }).step(harness.row);

    expect(result.status).toBe('scanning');
    expect(result.stoppedBy).toBe('requests');
    // Something was enriched *and* something was not, which is the trade being made
    // visible rather than asserted in a comment.
    expect(result.subrequests.fetch).toBeGreaterThan(result.foldersVisited);
    expect(result.subrequests.total).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    // Two tracks' worth of range reads past the folder's own `PROPFIND`, and not three. This
    // is the assertion about `SUBSREQUESTS_PER_ENRICHED_TRACK`: with the old reservation of 2
    // the chunk admitted all three tracks and crossed the ceiling, and a count-only check
    // would have called that a pass.
    expect(result.subrequests.fetch).toBe(result.foldersVisited + 4);
  });

  it('spends nothing on enrichment when the scan has none to do', async () => {
    // The incrementality invariant, under a bound: an unchanged rescan is one request
    // and zero rows, and the budget must not turn that into a partial chunk.
    const service = harness.makeService();
    await harness.drain(service);
    harness.dav.reset();
    const result = await service.start(harness.row);

    expect(result.status).toBe('idle');
    expect(result.subrequests.fetch).toBe(1);
    expect(result.stoppedBy).toBeNull();
  });
});

describe('a slow origin', () => {
  /**
   * Real `setTimeout` latency in the double, so the deadline is exercised through the
   * same `Date.now` production uses rather than a mocked clock.
   *
   * The assertions are on **counts and folders visited**, never on elapsed
   * milliseconds: a wall-clock assertion is a flaky assertion, and a bound is a
   * decision rather than a duration. Four albums at 30 ms a request against a 90 ms
   * deadline admits one or two of them; a machine slow enough to admit all four would
   * have to take over 90 ms a request, which is a broken test runner rather than a
   * slow origin.
   */
  it('returns instead of running the whole frontier, and resumes afterwards', async () => {
    const harness = createScanHarness(albumTree(4), 30);
    // The full frontier matters here: one level per chunk would drain the tree before
    // the deadline had anything to cut short.
    await harness.readyFullFrontier(4);
    const service = harness.makeService({ deadlineMs: 90, enrich: false });

    const first = await service.step(harness.row);

    expect(first.status).toBe('scanning');
    expect(first.stoppedBy).toBe('deadline');
    expect(first.foldersVisited).toBeGreaterThan(0);
    expect(first.foldersVisited).toBeLessThan(4);
    // The count is still the truth about the origin, deadline or not.
    expect(first.subrequests.fetch).toBe(harness.issued());

    // And the work the deadline cut short is picked up rather than abandoned.
    expect(harness.index.frontier().length).toBeGreaterThan(0);
    expect((await service.step(harness.row)).foldersVisited).toBeGreaterThan(0);
  });
});

/**
 * The backfill and the walk share one chunk budget.
 *
 * ### Why this needed its own instrument
 *
 * Because this file's harness had **no derivation store at all** until now, so `backfill`
 * answered `0` and the phase that runs *first* on every poll — ahead of `decideStep`, ahead
 * of `listFrontier` — was absent from every case here. A correct degradation, and an
 * invisible one: the file that measures a chunk's cost measured a chunk with one fewer
 * phase than production runs.
 *
 * ### The two failures it can have, and they are not the same
 *
 * **Refuse.** The page is one `UPDATE` per row with `requireComplete`, so a page the chunk
 * cannot hold whole is refused — and the refusal is thrown from `backfill`, which is *before*
 * `listFrontier`, so the walk never runs. That is the shipped defect: `scanning` for ever,
 * with a `count` that never moves, on a library of ~100 tracks.
 *
 * **Starve.** Sized to fit, but sized without holding a folder back, the backfill spends the
 * whole allowance and the loop's `canAfford(SUBSREQUESTS_PER_FOLDER_BASE)` refuses, so the
 * chunk returns `scanning` having visited **zero** folders. Same symptom, no throw, and it is
 * what a fix that only removed the throw would have shipped.
 *
 * One case asserts both halves, because either alone passes against the other.
 */
describe('the backfill and the walk share one chunk budget', () => {
  /**
   * A derivation double that charges and refuses, as `runWriteBatch` does.
   *
   * The same shape as the one in `test/scan-incremental.test.ts`, and for the same reason:
   * a double that answers any write for free cannot observe a budget, so it reports a
   * chunk that spends 200 statements as one that spends two.
   */
  function meteringDerivation(meter: SubrequestCounter, pending: number) {
    const state = { remaining: pending };
    return {
      state,
      store: {
        listNeedingDerivation: async (_libraryId: string, limit: number) => {
          meter.charge(1, 'd1');
          return Array.from({ length: Math.min(limit, state.remaining) }, (_, index) => ({ id: `s${index}`, dir_path: 'Blur/Holocene', name: '01 - Holocene.opus' }));
        },
        async deriveFor(rows: readonly { id: string; dir_path: string; name: string }[]) {
          return rows.map((row) => ({ id: row.id, title: deriveTitleFromFileName(row.name), ...deriveFromPath(row.dir_path, DERIVED_MARKER) }));
        },
        applyDerivation: async (writes: readonly { id: string }[]) => {
          if (!meter.canAfford(writes.length)) {
            throw new SubrequestBudgetExhaustedError(
              `Writing ${writes.length} rows for songs.applyDerivation needs ${writes.length} subrequests and ${meter.remaining} remain in this invocation.`,
            );
          }
          meter.charge(writes.length, 'd1');
          state.remaining -= writes.length;
          return {
            changes: writes.length,
            written: writes.length,
            truncated: false,
            billedRows: billedRowsForTable('songs', writes.length),
          };
        },
      },
    };
  }

  it('drains a backlog and still visits a folder, at the shipped defaults', async () => {
    // The shipped numbers, not a generous ceiling: the defect lived *between* the page size
    // and the chunk budget, so a case with a raised ceiling cannot see it.
    const harness = createScanHarness(albumTree(4));
    await harness.readyFullFrontier(4);
    const { store, state } = meteringDerivation(harness.index.meter, 100);
    const service = harness.makeService({
      folders: SCAN_CHUNK_FOLDER_LIMIT,
      maxRequests: SCAN_CHUNK_SUBSREQUEST_BUDGET,
      derivation: store,
      enrich: false,
    });

    const result = await service.step(harness.row);

    // Not a failure. A refusal from the backfill arrives as `failed`, because `step`'s catch
    // turns every fault into a recorded retry — which is exactly why the shipped defect read
    // as a live scan rather than as an error.
    expect(result.status).toBe('scanning');
    expect(result.lastError).toBeNull();

    // Half of the guarantee: the walk advanced. Zero folders here is the starvation failure
    // — the same stuck scan with the throw removed — so this assertion is what distinguishes
    // a page that fits from a page that merely fits.
    expect(result.foldersVisited).toBeGreaterThanOrEqual(1);

    // And the other half: the backlog shrank. Neither half implies the other, and a fix that
    // only shrank the page would satisfy this and fail the assertion above.
    expect(state.remaining).toBeLessThan(100);

    // The ceiling that actually kills an invocation, which is **not** the chunk budget: a
    // folder's cost is a base and not a total, so a chunk that reserved
    // `SUBSREQUESTS_PER_FOLDER_BASE` for one may overshoot it, and the chunk budget is the
    // inner limit checked at each reservation rather than a cap on the total. Asserting the
    // chunk budget here would be asserting a number the design does not promise — the
    // existing "keeps a rescan chunk inside the platform ceiling" case says the same thing
    // for the same reason.
    expect(harness.index.meter.spent).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    expect(result.subrequests.d1).toBeGreaterThan(0);
  });

  it('drains the whole backlog across chunks rather than one chunk', async () => {
    // The pass is *bounded*, which is a different property from *converging*, and both are
    // asserted across polls here because a single-chunk drain is what the old page size
    // claimed and could not do.
    const harness = createScanHarness(albumTree(4));
    await harness.readyFullFrontier(4);
    const { store, state } = meteringDerivation(harness.index.meter, 100);
    const service = harness.makeService({
      folders: SCAN_CHUNK_FOLDER_LIMIT,
      maxRequests: SCAN_CHUNK_SUBSREQUEST_BUDGET,
      derivation: store,
      enrich: false,
    });

    let chunks = 0;
    while (state.remaining > 0 && chunks < 20) {
      const result = await service.step(harness.row);
      expect(result.lastError).toBeNull();
      chunks += 1;
    }

    expect(state.remaining).toBe(0);
    expect(chunks).toBeGreaterThan(1);
  });
});

describe('the shipped defaults', () => {
  it('bounds a chunk below the platform ceiling on a Free-plan account', () => {
    // Workers Free allows **50 subrequests per invocation**, and D1 counts its own queries
    // against it. The chunk default is the ceiling less the invocation's own overhead, and it
    // is *derived* rather than typed — so the assertion is the relationship, not the numeral.
    // `40` was the previous default and it was not merely conservative: a chunk spent 40
    // *counted* requests and roughly 200 subrequests, because everything except `fetch` went
    // unmeasured.
    expect(WORKER_SUBSREQUEST_CEILING).toBe(50);
    expect(Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS)).toBe(SCAN_CHUNK_SUBSREQUEST_BUDGET);
    expect(Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS)).toBeLessThan(WORKER_SUBSREQUEST_CEILING);
  });

  it('derives the folder count and the enrich cap from that same ceiling', () => {
    // Three bounds, one number. A folder count typed beside the ceiling is the defect itself:
    // 40 folders is 40 counted requests and ~160 statements, and the two bounds were treated
    // as independent when they are the same budget spent twice.
    expect(Number(DEFAULT_SCAN_CHUNK_FOLDERS)).toBe(SCAN_CHUNK_FOLDER_LIMIT);
    expect(Number(DEFAULT_SCAN_ENRICH_MAX_PER_FOLDER)).toBe(SCAN_ENRICH_MAX_PER_FOLDER);
    expect(Number(DEFAULT_SCAN_CHUNK_FOLDERS) * SUBSREQUESTS_PER_FOLDER_BASE).toBeLessThanOrEqual(Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS));
  });

  it('keeps a rescan chunk inside the platform ceiling with enrichment on', async () => {
    // The acceptance criterion: measured against an origin that counts **and** a store that
    // counts, at the shipped defaults, and under the ceiling that actually kills an
    // invocation. The two are not the same number — the chunk budget leaves room for the
    // invocation's own statements, which is what `SUBSREQUEST_INVOCATION_RESERVE` is — so the
    // assertion is against the platform.
    const harness = createScanHarness(albumTree(ALBUMS.length));
    await harness.readyFullFrontier();
    const result = await harness
      .makeService({
        folders: Number(DEFAULT_SCAN_CHUNK_FOLDERS),
        maxRequests: Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS),
        deadlineMs: Number(DEFAULT_SCAN_CHUNK_DEADLINE_MS),
      })
      .step(harness.row);

    expect(result.subrequests.fetch).toBe(harness.issued());
    expect(result.subrequests.total).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    expect(result.status).toBe('scanning');
    // And the chunk reports *which* resource it spent, because "paused" with one number is
    // what made this undiagnosable from the operator surface.
    expect(result.subrequests.d1).toBeGreaterThan(0);
  });

  it('keeps a cold chunk inside the platform ceiling too, where nothing is indexed yet', async () => {
    // The case above drains first, so its frontier is a rescan's. A cold scan walks
    // one level per chunk and the bound has to hold for it as well — otherwise the
    // number only protects the case that was easier to reach.
    const harness = createScanHarness(albumTree(ALBUMS.length));
    const service = harness.makeService({
      folders: Number(DEFAULT_SCAN_CHUNK_FOLDERS),
      maxRequests: Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS),
      deadlineMs: Number(DEFAULT_SCAN_CHUNK_DEADLINE_MS),
    });

    await service.start(harness.row);
    // `start` and `step` are separate invocations with separate budgets, so the
    // root probe is zeroed rather than folded into the chunk's count.
    harness.dav.reset();
    const result = await service.step(harness.row);

    expect(result.subrequests.fetch).toBe(harness.issued());
    expect(result.subrequests.total).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
  });

  it('finishes the whole library, in more chunks, rather than dying partway through one', async () => {
    // The bug as an operator saw it: a 110-track library that indexed about twenty tracks,
    // died, retried, indexed twenty more, and eventually reported success — never because a
    // chunk completed but because each terminated invocation left progress behind.
    //
    // So this asserts the property the ceiling is supposed to have bought: every chunk
    // returns, and the scan still finishes. A budget that only made chunks *smaller* without
    // making them *complete* would pass every count assertion above and fail here.
    const harness = createScanHarness(albumTree(ALBUMS.length));
    const service = harness.makeService({
      folders: Number(DEFAULT_SCAN_CHUNK_FOLDERS),
      maxRequests: Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS),
      deadlineMs: Number(DEFAULT_SCAN_CHUNK_DEADLINE_MS),
    });
    await service.start(harness.row);

    let chunks = 0;
    let result = await service.step(harness.row);
    while (result.status === 'scanning' && chunks < 200) {
      // Every chunk must fit the ceiling, or the loop below is measuring the platform's
      // tolerance rather than this product's accounting.
      expect(result.subrequests.total).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
      chunks += 1;
      result = await service.step(harness.row);
    }

    expect(result.status).toBe('idle');
    expect(harness.index.songs.size).toBe(ALBUMS.length * TRACKS_PER_ALBUM);
    expect(harness.index.frontier()).toEqual([]);
    // More than one chunk is the point: the ceiling is now *below* what one chunk of twelve
    // albums costs, which is the whole change.
    expect(chunks).toBeGreaterThan(0);
  });

  it('reports a deadline a client can wait out', () => {
    // A chunk used to take ~88 s on a 2.2 s origin while clients gave up at ~45 s.
    // The deadline is what makes a poll return, so it has to sit under the time a
    // client is willing to spend — asserted as a number, not left to a comment.
    expect(Number(DEFAULT_SCAN_CHUNK_DEADLINE_MS)).toBeLessThan(45_000);
  });
});
