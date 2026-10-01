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
import { WebDavClient } from '@edge-sonic/webdav';
import {
  DEFAULT_SCAN_CHUNK_DEADLINE_MS,
  DEFAULT_SCAN_CHUNK_FOLDERS,
  DEFAULT_SCAN_CHUNK_MAX_REQUESTS,
} from '@edge-sonic/backend-runtime/config';
import { DERIVED_VERSION, deriveFromPath } from '@edge-sonic/backend-data/dao';
import type { LibraryRow, NodeRow, ScanStateRow, SongRow } from '@edge-sonic/backend-data/dao';
import { fakeDav } from './helpers/fakeDav';
import type { DavEntry, FakeDav } from './helpers/fakeDav';

const LIBRARY_ID = 'L1';
const ROOT = '/dav/music';
const ALBUMS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12'];
const TRACKS_PER_ALBUM = 3;

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
  // Settable rather than fixed, so a test can leave the **setup** fast and make only the
  // chunk under test slow. A fixed latency applies to `readyFullFrontier`'s own drain and
  // re-seed as well, which changes the fixture rather than the case.
  let latencyMs = options.d1LatencyMs ?? 0;
  const charge = async <T>(value: () => T): Promise<T> => {
    d1Calls += 1;
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    return value();
  };

  return {
    d1Calls: () => d1Calls,
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
        listRoots: async () => await charge(() => [...nodes.values()].filter((node) => node.parent_path === '' && node.path !== '')),
        listFrontier: async (_libraryId: string, limit: number) =>
          await charge(() =>
            [...nodes.values()]
              .filter((node) => node.is_scanned === 0)
              .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
              .slice(0, limit),
          ),
        upsertMany: async (inputs: readonly { libraryId: string; path: string; parentPath: string; name: string; mtimeMs: number | null; etag: string | null; depth: number; isScanned?: boolean }[]) =>
          await charge(() => {
          let changed = 0;
          for (const input of inputs) {
            const key = nodeKey(input.path);
            const existing = nodes.get(key);
            if (existing !== undefined && existing.mtime_ms === input.mtimeMs && existing.etag === input.etag && existing.is_scanned === (input.isScanned ? 1 : 0)) continue;
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
        }),
        deleteSubtree: async (_libraryId: string, path: string) => {
          const doomed = [...nodes.values()].filter((node) => node.path === path || node.path.startsWith(`${path}/`));
          for (const node of doomed) nodes.delete(nodeKey(node.path));
          return doomed.length;
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
        upsertFileFacts: async (inputs: readonly { id: string; path: string; size: number; mtimeMs: number }[]) =>
          await charge(() => {
          for (const input of inputs) {
            const dirPath = input.path.split('/').slice(0, -1).join('/');
            const derived = deriveFromPath(dirPath);
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
              title: null,
              title_ci: null,
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
        }),
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
          const doomed = [...songs.values()].filter((song) => song.dir_path === dirPath && !keep.has(song.path));
          for (const song of doomed) songs.delete(song.id);
          return doomed.length;
        },
        deleteSubtree: async (_libraryId: string, dirPath: string) => {
          const doomed = [...songs.values()].filter((song) => song.dir_path === dirPath);
          for (const song of doomed) songs.delete(song.id);
          return doomed.length;
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
function createScanHarness(tree: Record<string, DavEntry[]>, latencyMs?: number, d1LatencyMs?: number): Harness {
  const index = createIndex(d1LatencyMs === undefined ? {} : { d1LatencyMs });
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
        ...(overrides.enrich !== false && {
          enrichSong: async (libraryRow, facts, onRequest) => {
            const client = new WebDavClient(libraryRow.base_url, libraryRow.root_path, { username: 'u', password: 'p' }, dav.fetch, onRequest);
            try {
              await client.readPrefix(facts.path, 4096, 1000);
              await client.readTail(facts.path, 4096, facts.size, 1000);
            } catch {
              // The scan swallows a failed enrichment and leaves the track for
              // `getSong`; these cases are about cost, not decoding.
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

    expect(result.webdavRequests).toBe(harness.issued());
    // And not the walk-only number, which is what it used to report.
    expect(result.webdavRequests).toBeGreaterThan(result.foldersVisited);
  });

  it('leaves the frontier when the request ceiling is reached, and names the bound', async () => {
    // One `PROPFIND` per folder, so a ceiling of 3 admits exactly three folders and
    // then stops. Asserted on the count rather than on the ceiling being honoured in
    // general: a chunk that visited everything would be the bug.
    await harness.readyFullFrontier();
    const result = await harness.makeService({ maxRequests: 3, enrich: false }).step(harness.row);

    expect(result.status).toBe('scanning');
    expect(result.foldersVisited).toBe(3);
    expect(result.webdavRequests).toBeLessThanOrEqual(3);
    expect(result.stoppedBy).toBe('requests');
    // Folders left on the frontier for the next poll, rather than lost.
    expect(harness.index.frontier()).toHaveLength(ALBUMS.length - 3);
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
    expect(slowStore.issued()).toBe(result.webdavRequests);
    expect(slowStore.issued()).toBeLessThanOrEqual(result.foldersVisited);

    // And the folders it did not reach are all still on the frontier, which is what makes
    // the chunk resumable rather than lossy.
    expect(slowStore.index.frontier()).toHaveLength(ALBUMS.length - result.foldersVisited);
  });

  it('visits the whole frontier when the bounds are generous, so the checks above have teeth', async () => {
    // The guard without this: a `canAfford` that always returned `false` would make
    // both bound tests pass, and every scan would silently do nothing. This is the
    // "a guard needs a test that proves it has teeth" rule from the testing guide.
    await harness.readyFullFrontier();
    const result = await harness.makeService({ maxRequests: 10_000, deadlineMs: 60_000, enrich: false }).step(harness.row);

    expect(result.foldersVisited).toBe(ALBUMS.length);
    expect(result.stoppedBy).toBe('frontier');
  });

  it('reports `frontier` — not a limit — for a chunk that simply ran out of folders', async () => {
    // The ordinary case must not be dressed up as a problem, or an operator reads a
    // line about limits on every healthy poll.
    await harness.readyFullFrontier();
    expect((await harness.makeService({ enrich: false }).step(harness.row)).stoppedBy).toBe('frontier');
  });

  it('resumes on the next poll with no folder lost and none walked twice', async () => {
    // The property that makes leaving early safe: the frontier is in D1, so a folder
    // this chunk skipped is the next chunk's work. Asserted on the paths the origin
    // was actually asked for, because `scanned_count` is a running total and says
    // nothing about which folders were visited.
    await harness.readyFullFrontier();
    const service = harness.makeService({ maxRequests: 3, enrich: false });
    expect((await service.step(harness.row)).foldersVisited).toBe(3);

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

  it('enriches the tracks it can afford, and leaves the rest for `getSong`', async () => {
    // Enrichment takes the remainder of the budget rather than a reserved slice, so
    // a wide-changed album can end its own chunk. The tracks it skipped keep
    // `enriched_at = null` — a degraded answer, not a failed chunk.
    await harness.readyFullFrontier();
    const result = await harness.makeService({ maxRequests: 12 }).step(harness.row);

    expect(result.status).toBe('scanning');
    expect(result.stoppedBy).toBe('requests');
    // Something was enriched *and* something was not, which is the trade being made
    // visible rather than asserted in a comment.
    expect(result.webdavRequests).toBeGreaterThan(result.foldersVisited);
    expect(result.webdavRequests).toBeLessThanOrEqual(12);
  });

  it('spends nothing on enrichment when the scan has none to do', async () => {
    // The incrementality invariant, under a bound: an unchanged rescan is one request
    // and zero rows, and the budget must not turn that into a partial chunk.
    const service = harness.makeService();
    await harness.drain(service);
    harness.dav.reset();
    const result = await service.start(harness.row);

    expect(result.status).toBe('idle');
    expect(result.webdavRequests).toBe(1);
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
    expect(first.webdavRequests).toBe(harness.issued());

    // And the work the deadline cut short is picked up rather than abandoned.
    expect(harness.index.frontier().length).toBeGreaterThan(0);
    expect((await service.step(harness.row)).foldersVisited).toBeGreaterThan(0);
  });
});

describe('the shipped defaults', () => {
  it('bounds a chunk below the platform ceiling on a Free-plan account', () => {
    // 50 external subrequests per invocation on the Free plan; 10,000 on Paid, and the
    // 1,000 figure these defaults were originally sized against was retired on
    // 2026-02-11. A default above 50 is a chunk that fails rather than one that is
    // slow, so the number is asserted rather than left to a comment.
    expect(DEFAULT_SCAN_CHUNK_MAX_REQUESTS).toBe('40');
    expect(Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS)).toBeLessThan(50);
  });

  it('keeps a rescan chunk inside that ceiling with enrichment on', async () => {
    // The acceptance criterion: measured against an origin that counts, at the shipped
    // defaults, and below the platform ceiling.
    const harness = createScanHarness(albumTree(ALBUMS.length));
    await harness.readyFullFrontier();
    const result = await harness
      .makeService({
        folders: Number(DEFAULT_SCAN_CHUNK_FOLDERS),
        maxRequests: Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS),
        deadlineMs: Number(DEFAULT_SCAN_CHUNK_DEADLINE_MS),
      })
      .step(harness.row);

    expect(result.webdavRequests).toBe(harness.issued());
    expect(result.webdavRequests).toBeLessThanOrEqual(Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS));
    expect(result.status).toBe('scanning');
  });

  it('keeps a cold chunk inside that ceiling too, where nothing is indexed yet', async () => {
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

    expect(result.webdavRequests).toBe(harness.issued());
    expect(result.webdavRequests).toBeLessThanOrEqual(Number(DEFAULT_SCAN_CHUNK_MAX_REQUESTS));
  });

  it('reports a deadline a client can wait out', () => {
    // A chunk used to take ~88 s on a 2.2 s origin while clients gave up at ~45 s.
    // The deadline is what makes a poll return, so it has to sit under the time a
    // client is willing to spend — asserted as a number, not left to a comment.
    expect(Number(DEFAULT_SCAN_CHUNK_DEADLINE_MS)).toBeLessThan(45_000);
  });
});
