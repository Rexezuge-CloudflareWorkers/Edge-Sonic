/**
 * The folder tree: `getIndexes` and `getMusicDirectory`.
 *
 * ### Read-through materialization
 *
 * A folder the index has never seen is `PROPFIND`ed live **and written to D1**,
 * so browsing an unscanned library works *and* gets fast on the second visit.
 *
 * That makes a `GET` a writer, which is a deliberate trade and not an accident:
 *
 * - a `GET` that only reads means an unscanned library browses at live-WebDAV
 *   speed forever, and only becomes quick after somebody remembers to scan;
 * - a `GET` that writes is bounded, because it materializes exactly the one
 *   folder asked for, and converges to the same state a scan would produce.
 *
 * The consequence is stated in the invariant rather than left implicit: **the
 * index has two writers, the scan and this path, and both must compare before
 * writing so an unchanged folder costs zero rows.** Both go through
 * `persistChildren`, which is the only place a node row is written.
 */
import { BadRequestError, NotFoundError } from '@edge-sonic/backend-errors';
import type { LibraryRow, NodeRow, SongRow } from '@edge-sonic/backend-data/dao';
import { encodeId, IdKind } from '@edge-sonic/subsonic';
import { toLibraryPath } from '@edge-sonic/webdav';
import type { DavResource, WebDavClient } from '@edge-sonic/webdav';

interface NodeStore {
  find(libraryId: string, path: string): Promise<NodeRow | null>;
  listChildren(libraryId: string, parentPath: string): Promise<NodeRow[]>;
  listRoots(libraryId: string): Promise<NodeRow[]>;
  upsertMany(
    inputs: readonly {
      libraryId: string;
      path: string;
      parentPath: string;
      name: string;
      mtimeMs: number | null;
      etag: string | null;
      depth: number;
    }[],
  ): Promise<number>;
  patch(libraryId: string, path: string, patch: { mtimeMs?: number | null; etag?: string | null; isScanned?: boolean }): Promise<void>;
  countByLibrary(libraryId: string): Promise<number>;
}

interface SongStore {
  listByDirectory(libraryId: string, dirPath: string): Promise<SongRow[]>;
  upsertFileFacts(
    inputs: readonly {
      id: string;
      libraryId: string;
      path: string;
      dirPath: string;
      name: string;
      size: number;
      mtimeMs: number;
      contentType: string | null;
      suffix: string;
    }[],
  ): Promise<number>;
}

interface TreeDeps {
  nodes: NodeStore;
  songs: SongStore;
  clientFor: (row: LibraryRow) => Promise<WebDavClient>;
  timeoutMs: number;
}

/** File suffixes the indexer treats as playable audio. */
const AUDIO_SUFFIXES: ReadonlySet<string> = new Set([
  'mp3',
  'flac',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'mp4',
  'aac',
  'wav',
  'wma',
  'aiff',
  'aif',
  'ape',
  'wv',
  'mpc',
  'dsf',
  'dff',
  'alac',
]);

/** Cover art filenames probed in an album folder, in preference order. */
const COVER_NAMES: readonly string[] = ['cover', 'folder', 'front', 'album', 'albumart', 'thumb'];

function isAudioFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return AUDIO_SUFFIXES.has(name.slice(dot + 1).toLowerCase());
}

function suffixOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function depthOf(path: string): number {
  return path.length === 0 ? 0 : path.split('/').length;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

interface MaterializedFolder {
  readonly path: string;
  readonly node: NodeRow;
  readonly isCollection: boolean;
}

/**
 * A stand-in row for the library root, which has no `nodes` row of its own.
 *
 * The root is the empty path, and the schema keys rows on `path`, so there is
 * nowhere to persist it. Returning a synthesized row keeps callers from having to
 * special-case the root — which is the point: the root is the one folder every
 * caller would otherwise branch on.
 */
function syntheticRootNode(libraryId: string, self: DavResource | undefined): NodeRow {
  return {
    library_id: libraryId,
    path: '',
    parent_path: '',
    name: '',
    name_ci: '',
    mtime_ms: self?.lastModifiedMs ?? null,
    etag: self?.etag ?? null,
    depth: 0,
    is_scanned: 0,
    created_at: 0,
    updated_at: 0,
  };
}

class TreeService {
  constructor(private readonly deps: TreeDeps) {}

  /**
   * A folder's children, materializing the folder itself if it is unknown.
   *
   * `Depth: 1` returns the resource itself plus its children; the self-response
   * is dropped rather than filtered by href comparison, because href comparison
   * is exactly the step that goes wrong when a server anchors hrefs at `/`
   * instead of at the request path.
   */
  public async children(library: LibraryRow, path: string): Promise<{ folder: MaterializedFolder; children: NodeRow[] }> {
    const existing = await this.deps.nodes.find(library.id, path);
    if (existing) {
      return { folder: { path, node: existing, isCollection: true }, children: await this.deps.nodes.listChildren(library.id, path) };
    }

    const listed = await this.listFromDav(library, path);
    if (!listed) throw new NotFoundError('Directory not found.');

    const { children, node } = await this.persistChildren(library, path, listed);
    return { folder: { path, node, isCollection: true }, children };
  }

  /** Top-level entries, for `getIndexes` and `getMusicFolders`. */
  public async roots(library: LibraryRow): Promise<NodeRow[]> {
    const known = await this.deps.nodes.listRoots(library.id);
    if (known.length > 0) return known;
    const listed = await this.listFromDav(library, '');
    if (!listed) return [];
    const { children } = await this.persistChildren(library, '', listed);
    return children;
  }

  /**
   * `PROPFIND` a folder, or `null` when it does not exist.
   *
   * A `404` is the only status treated as "absent". A `401` or a `5xx` propagates
   * as an error rather than being reported as an empty folder — silently showing
   * "no music" for a credential failure is indistinguishable from an empty
   * library, and the user has no way to tell which they are looking at.
   */
  private async listFromDav(library: LibraryRow, path: string): Promise<DavResource[] | null> {
    const client = await this.deps.clientFor(library);
    try {
      const resources = await client.propfind(path, { depth: 1, timeoutMs: this.deps.timeoutMs });
      return resources;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404 || status === 410) return null;
      throw error;
    }
  }

  /**
   * The single write path for nodes and songs.
   *
   * Both the scan and read-through materialization come through here, which is
   * what makes "an unchanged folder writes nothing" enforceable rather than
   * aspirational: there is nowhere else a node row is created.
   *
   * Rows are written for files that are new or whose `mtime_ms` changed. A file
   * present in both listings with an identical mtime is skipped entirely, which is
   * what makes a repeat browse of an unchanged folder free.
   */
  private async persistChildren(
    library: LibraryRow,
    parentPath: string,
    resources: readonly DavResource[],
  ): Promise<{ children: NodeRow[]; node: NodeRow }> {
    const self = resources.find((resource) => toLibraryPath(resource.path, library.root_path) === parentPath);

    // One query for the folder's existing children, then every comparison below
    // is in-memory. The obvious alternative — a `find` per child — is 2N indexed
    // reads for a folder of N files, which on a 500-track album is 1,000 round
    // trips to learn that nothing changed.
    const existing = new Map((await this.deps.nodes.listChildren(library.id, parentPath)).map((node) => [node.path, node]));

    const nodeInputs: Parameters<NodeStore['upsertMany']>[0][number][] = [];
    const songInputs: Parameters<SongStore['upsertFileFacts']>[0][number][] = [];

    for (const resource of resources) {
      const path = toLibraryPath(resource.path, library.root_path);
      if (path === null || path === parentPath) continue;

      const name = basename(path);
      const isCollection = resource.isCollection;
      const known = existing.get(path);

      // A node is rewritten only when its own mtime or etag moved. The etag
      // comparison matters because some servers round `getlastmodified` to the
      // minute, which would otherwise freeze a subtree as permanently unchanged.
      const nodeChanged =
        !known ||
        known.mtime_ms !== resource.lastModifiedMs ||
        (resource.etag !== null && known.etag !== null && known.etag !== resource.etag);

      if (nodeChanged) {
        nodeInputs.push({
          libraryId: library.id,
          path,
          parentPath,
          name,
          mtimeMs: resource.lastModifiedMs,
          etag: resource.etag,
          depth: depthOf(path),
        });
      }

      // Non-audio files are still nodes — they are visible in a folder listing —
      // but never become songs, so they never reach an index or a search result.
      if (isCollection || !isAudioFile(name)) continue;

      // The song row mirrors the node row's mtime and size, so the same
      // comparison answers for both. `upsertFileFacts` deliberately leaves derived
      // metadata alone, so skipping a redundant write is a real saving rather
      // than a cosmetic one.
      const sizeChanged = !known;
      if (nodeChanged || sizeChanged) {
        songInputs.push({
          id: encodeId(IdKind.Song, library.id, path),
          libraryId: library.id,
          path,
          dirPath: parentPath,
          name,
          size: resource.contentLength ?? 0,
          mtimeMs: resource.lastModifiedMs ?? 0,
          contentType: resource.contentType,
          suffix: suffixOf(name),
        });
      }
    }

    if (nodeInputs.length > 0) await this.deps.nodes.upsertMany(nodeInputs);
    if (songInputs.length > 0) await this.deps.songs.upsertFileFacts(songInputs);

    // Materialize the folder's own row, so the next read finds it in D1 and skips
    // the PROPFIND entirely. Skipped for the library root, which has no path.
    if (parentPath !== '' && self) {
      const own = await this.deps.nodes.find(library.id, parentPath);
      if (!own || own.mtime_ms !== self.lastModifiedMs || own.etag !== self.etag) {
        await this.deps.nodes.upsertMany([
          {
            libraryId: library.id,
            path: parentPath,
            parentPath: parentOf(parentPath),
            name: basename(parentPath),
            mtimeMs: self.lastModifiedMs,
            etag: self.etag,
            depth: depthOf(parentPath),
          },
        ]);
      }
    }

    const children = await this.deps.nodes.listChildren(library.id, parentPath);
    const node = await this.deps.nodes.find(library.id, parentPath);
    return { children, node: node ?? syntheticRootNode(library.id, self) };
  }

  /**
   * The cover image for a folder, as a library-relative path.
   *
   * Probed in preference order rather than "first image-looking file", because
   * album folders routinely contain a `folder.png` *and* a `cover.jpg`, and the
   * user picked one deliberately.
   */
  public static findCover(siblings: readonly NodeRow[]): NodeRow | null {
    const byName = new Map(siblings.map((node) => [node.name.toLowerCase(), node]));
    for (const base of COVER_NAMES) {
      for (const extension of ['jpg', 'jpeg', 'png', 'webp']) {
        const hit = byName.get(`${base}.${extension}`);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Reject a path before it reaches either DAO. */
  public static assertPath(path: string): void {
    if (path.length > 1024) throw new BadRequestError('Path is too long.');
    if (path.includes('\0') || path.includes('\\')) throw new BadRequestError('Path contains an illegal character.');
    if (path.startsWith('/')) throw new BadRequestError('Path must be relative to the library root.');
    if (path.split('/').some((segment) => segment === '..' || segment === '.')) {
      throw new BadRequestError('Path must not contain "." or ".." segments.');
    }
  }
}

export { TreeService, isAudioFile, suffixOf, toLibraryPath, parentOf, depthOf, basename, AUDIO_SUFFIXES, COVER_NAMES };
export type { TreeDeps, MaterializedFolder };
