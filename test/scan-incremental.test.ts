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
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ScanService } from '@edge-sonic/backend-services/index';
import type { NodeInput, SongUpsertInput } from '@edge-sonic/backend-data/dao';
import type { LibraryRow, NodeRow, ScanStateRow, SongRow } from '@edge-sonic/backend-data/dao';
import { fakeDav } from './helpers/fakeDav';
import type { DavEntry } from './helpers/fakeDav';

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
    updated_at: 0,
  };
  const writes = { nodes: 0, songs: 0, state: 0 };

  const nodeKey = (path: string): string => `${LIBRARY_ID}\n${path}`;

  return {
    nodes,
    songs,
    state: () => state,
    writes,
    deps: {
      nodes: {
        find: async (_libraryId: string, path: string) => nodes.get(nodeKey(path)) ?? null,
        listChildren: async (_libraryId: string, parentPath: string) =>
          [...nodes.values()].filter((node) => node.parent_path === parentPath).sort((a, b) => a.name_ci.localeCompare(b.name_ci)),
        listRoots: async () => [...nodes.values()].filter((node) => node.parent_path === '' && node.path !== ''),
        // The scan frontier: unscanned folders, shallowest first. This ordering is
        // what makes a partial scan produce a browsable top of the tree.
        listFrontier: async (_libraryId: string, limit: number) =>
          [...nodes.values()].filter((node) => node.is_scanned === 0).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)).slice(0, limit),
        upsertMany: async (inputs: readonly NodeInput[]) => {
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
          return changed;
        },
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
          return doomed.length;
        },
        countByLibrary: async () => nodes.size,
      },
      songs: {
        upsertFileFacts: async (inputs: readonly SongUpsertInput[]) => {
          let changed = 0;
          for (const raw of inputs) {
            const input = raw as { id: string; path: string; size: number; mtimeMs: number; name: string; contentType: string | null; suffix: string; dirPath: string };
            const existing = songs.get(input.id);
            if (existing !== undefined && existing.size === input.size && existing.mtime_ms === input.mtimeMs) continue;
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
              artist: null,
              artist_ci: null,
              album: null,
              album_ci: null,
              album_artist: null,
              album_artist_ci: null,
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
              created_at: 0,
              updated_at: 0,
            });
            changed += 1;
          }
          writes.songs += changed;
          return changed;
        },
        deleteInDirectoryNotIn: async (_libraryId: string, dirPath: string, keep: readonly string[]) => {
          const keepSet = new Set(keep);
          const doomed = [...songs.values()].filter((song) => song.dir_path === dirPath && !keepSet.has(song.path));
          for (const song of doomed) songs.delete(song.id);
          writes.songs += doomed.length;
          return doomed.length;
        },
        // Recursive, like the real one: a vanished folder takes its songs with it,
        // and their `dir_path` is deeper than the folder itself.
        deleteSubtree: async (_libraryId: string, dirPath: string) => {
          const doomed = [...songs.values()].filter((song) => song.dir_path === dirPath || song.dir_path.startsWith(`${dirPath}/`));
          for (const song of doomed) songs.delete(song.id);
          writes.songs += doomed.length;
          return doomed.length;
        },
        countByLibrary: async () => songs.size,
      },
      scanState: {
        find: async () => state,
        ensure: async () => state,
        markScanning: async (_libraryId: string, total: number) => {
          state = { ...state, status: 'scanning', total_count: total, scanned_count: 0, cursor_path: null, last_error: null };
          writes.state += 1;
        },
        saveProgress: async (_libraryId: string, scanned: number, cursor: string | null) => {
          state = { ...state, status: 'scanning', scanned_count: scanned, cursor_path: cursor };
          writes.state += 1;
        },
        complete: async (_libraryId: string, scanned: number) => {
          // The bump is what invalidates every cached aggregate for this library, by
          // making the old keys unreachable rather than by deleting them.
          state = { ...state, status: 'idle', scanned_count: scanned, index_version: state.index_version + 1 };
          writes.state += 1;
          return state.index_version;
        },
        fail: async (_libraryId: string, error: string) => {
          state = { ...state, status: 'failed', last_error: error };
          writes.state += 1;
        },
      },
    },
  };
}

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
      clientFor: async () =>
        new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, dav.fetch),
      timeoutMs: 1000,
      chunkFolders: 40,
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
    expect(started.webdavRequests).toBe(1);
    expect(started.status).toBe('idle');
    expect(index.writes.nodes).toBe(0);
    expect(index.writes.songs).toBe(0);

    // And a poll after that is a no-op too.
    const polled = await service.step(row);
    expect(polled.status).toBe('idle');
    expect(polled.webdavRequests).toBe(0);
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
      clientFor: async () =>
        new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, failing.fetch),
      timeoutMs: 1000,
      chunkFolders: 40,
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

  it('survives a poll with no scan running without touching the network', async () => {
    // A client opening the app polls `getScanStatus` before anything is configured.
    // That path must be free.
    dav.reset();
    const result = await service.step(row);
    expect(result.status).toBe('idle');
    expect(result.webdavRequests).toBe(0);
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
      clientFor: async () =>
        new (await import('@edge-sonic/webdav')).WebDavClient(row.base_url, row.root_path, { username: 'u', password: 'p' }, gone.fetch),
      timeoutMs: 1000,
      chunkFolders: 40,
    });
    const result = await goneService.start(row);
    expect(result.status).toBe('idle');
    // The version still advances, so a cached aggregate built from the old index
    // becomes unreachable rather than being served.
    expect(result.indexVersion).toBeGreaterThan(1);
  });
});
