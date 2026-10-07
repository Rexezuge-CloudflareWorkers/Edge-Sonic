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
 * writing so an unchanged folder costs zero rows.** Both use `nodeRowNeedsWrite`,
 * which is the whole of that invariant's enforcement.
 *
 * It did not used to be true, and the sentence above claimed it while the opposite was the
 * case. This module had a compare; `scanFolder.ts` had a comment describing one it did not
 * have. So the two writers disagreed about when a node row may be written, the one without a
 * compare re-offered every row it had already written, and a folder with more entries than fit
 * in one invocation could never be closed — which cost 231,620 rows on an 80-album library
 * against a 5,000-rows/day allowance. "Both go through `persistChildren`, which is the only
 * place a node row is written" was the sentence that hid it: the scan never went through it.
 *
 * `is_scanned` is the other half of this module's half of the deal, and it now means what it
 * says. This path reads a `Depth: 1` listing and nothing below it, so it does not get to
 * decide that a folder has been descended into — see `persistChildren`.
 */
import { BadRequestError, NotFoundError } from '@edge-sonic/backend-errors';
import type { LibraryRow, NodeRow, SongRow, WriteBatchResult } from '@edge-sonic/backend-data/dao';
import { deriveShortSongId } from '@edge-sonic/subsonic';
import { toLibraryPath } from '@edge-sonic/webdav';
import type { DavResource, WebDavClient } from '@edge-sonic/webdav';
import { nodeRowNeedsWrite } from './nodeWrite';
// `AUDIO_SUFFIXES` is not imported here: `isAudioFile` is the question this module asks, and the
// set is `libraryNames`' own business. Re-exporting it from here is what made it look importable.
import { COVER_NAMES, basename, depthOf, isAudioFile, parentOf, suffixOf } from './libraryNames';

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
      isScanned?: boolean;
    }[],
  ): Promise<WriteBatchResult>;
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
  ): Promise<WriteBatchResult>;
}

interface TreeDeps {
  nodes: NodeStore;
  songs: SongStore;
  clientFor: (row: LibraryRow) => Promise<WebDavClient>;
  timeoutMs: number;
}

/**
 * A folder plus its children, as `children()` answers.
 *
 * `node` is the folder's own row — synthesized for the library root, which has nowhere to persist
 * one — so a caller never has to branch on the root, which is the one folder every caller would
 * otherwise have to special-case.
 */
interface MaterializedFolder {
  readonly path: string;
  readonly node: NodeRow;
  readonly isCollection: boolean;
}

/**
 * A stand-in row for the library root, which has no `nodes` row of its own.
 *
 * The root is the empty path, and the schema keys rows on `path`, so there is nowhere to persist it.
 * Returning a synthesized row keeps callers from having to special-case the root — which is the
 * point: the root is the one folder every caller would otherwise branch on.
 *
 * `is_scanned: 0` is stated rather than defaulted, because it is *not* a neutral value here. It
 * means "not reconciled", so a caller that used this row to decide whether to descend would descend
 * into the root — which is correct, and which a fabricated `1` would silently prevent.
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

/**
 * The listing a `PROPFIND` returned, as `NodeRow`s, without writing any of them.
 *
 * Only the fields a folder listing publishes, and only for the answer this module gives when its
 * writes did not fit. A row read here is never persisted, so it never becomes the answer to a
 * *later* read — the folder's own row is deliberately absent, so the next browse re-lists rather
 * than trusting this.
 */
function materialized(libraryId: string, resources: readonly DavResource[], parentPath: string): NodeRow[] {
  return resources
    .map((resource) => ({ resource, path: toLibraryPath(resource.path, '') }))
    .filter((entry): entry is { resource: DavResource; path: string } => entry.path !== null && entry.path !== parentPath)
    .map(({ resource, path }) => ({
      library_id: libraryId,
      path,
      parent_path: parentPath,
      name: basename(path),
      name_ci: basename(path).toLowerCase(),
      mtime_ms: resource.lastModifiedMs,
      etag: resource.etag,
      depth: depthOf(path),
      is_scanned: 0,
      created_at: 0,
      updated_at: 0,
    }));
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

  /**
  Top-level entries, for `getIndexes` and `getMusicFolders`.
  */
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
   * The single write path for nodes and songs, on this module's half of the tree.
   *
   * Rows are written for entries that are new, or whose stored state differs from what this
   * listing says. An entry present in both listings with nothing changed is skipped entirely,
   * which is what makes a repeat browse of an unchanged folder free — and "free" matters more
   * than usual here, because a browse runs on a `GET` a client issues while browsing, against
   * the same daily D1 write allowance the scan is spending.
   *
   * The claim that the scan also came through here was false, and `nodeWrite.ts` now owns the
   * comparison both writers use instead.
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

      // A node is rewritten only when its stored state differs from what this listing says.
      // `nodeRowNeedsWrite` is the scan's predicate too — it was this module's alone, and the
      // scan described one in a comment without having it, which is how a folder too large for
      // one invocation came to be un-closable. The etag comparison is two-sided null because
      // some servers round `getlastmodified` to the minute, and a row whose etag went from a
      // value to none is a change rather than an absence of one.
      //
      // `is_scanned` is **preserved**, not cleared, and this is a change of behaviour rather
      // than a refactor. It used to bind to `0` for every child, which put every folder a client
      // merely *looked at* back on the scan frontier — so a browse of the root re-walked the
      // whole library, once per browse, spending rows from the same daily allowance the
      // scan is trying not to exhaust. The flag means "someone descended into this", and this
      // path demonstrably has not: it read a `Depth: 1` listing and nothing below it. A folder
      // discovered *here* is new, so it is written `0` and the scan descends into it — which is
      // the invariant `reconcileFolder`'s `needsDescent` reads, and it still holds.
      const nodeChanged = nodeRowNeedsWrite(known, {
        parentPath,
        name,
        mtimeMs: resource.lastModifiedMs,
        etag: resource.etag,
        depth: depthOf(path),
        isScanned: known?.is_scanned === 1,
      });

      if (nodeChanged) {
        nodeInputs.push({
          libraryId: library.id,
          path,
          parentPath,
          name,
          mtimeMs: resource.lastModifiedMs,
          etag: resource.etag,
          depth: depthOf(path),
          isScanned: known?.is_scanned === 1,
        });
      }

      // Non-audio files are still nodes — they are visible in a folder listing —
      // but never become songs, so they never reach an index or a search result.
      if (isCollection || !isAudioFile(name)) continue;

      // The song row mirrors the node row's mtime, so the same comparison answers for both.
      // `upsertFileFacts` deliberately leaves derived metadata alone, so skipping a redundant
      // write is a real saving rather than a cosmetic one.
      //
      // It used to read `nodeChanged || sizeChanged` with `sizeChanged = !known`, which is the
      // same predicate written twice: a row that did not exist is already `nodeChanged`, so the
      // second term could never be true on its own. It *looked* like it was checking `size`, and
      // a file whose length changed without its mtime moving is detected by nothing here — `nodes`
      // has no `size` column, so a folder listing cannot answer it. Stated plainly rather than
      // implied by a comparison that never fires.
      if (nodeChanged) {
        songInputs.push({
          // Derived, not minted: the same library and path always hash to the
          // same id, so a browse-materialized row and a scan-written row agree
          // without a lookup, and a rescan after an index drop recreates it.
          id: deriveShortSongId(library.id, path),
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

    // ### A browse that cannot finish persisting still answers, from what it just read
    //
    // Both writes are truncating, because a folder of 500 tracks is ~1,000 statements against a
    // ceiling of 50 and is *expected* to come back short on a Free plan. The scan can resume
    // from that; a browse cannot, and must not try to: this path already holds the complete
    // listing in memory, because it is what `PROPFIND` returned a moment ago.
    //
    // So when the writes do not fit, nothing is persisted and the caller is answered from the
    // listing — correct, one subrequest, and self-healing, because the folder's own row is
    // never written, so the next browse does the same cheap read rather than serving a
    // half-materialized tree from D1. Persisting *part* of a folder would be the one answer
    // that is worse than either alternative: a listing that is missing children, served as
    // though they were deleted.
    const nodes = nodeInputs.length > 0 ? await this.deps.nodes.upsertMany(nodeInputs) : { changes: 0, truncated: false, billedRows: 0 };
    const songs = songInputs.length > 0 ? await this.deps.songs.upsertFileFacts(songInputs) : { changes: 0, truncated: false, billedRows: 0 };
    if (nodes.truncated || songs.truncated) return { children: materialized(library.id, resources, parentPath), node: syntheticRootNode(library.id, self) };

    // Materialize the folder's own row, so the next read finds it in D1 and skips
    // the PROPFIND entirely. Skipped for the library root, which has no path.
    //
    // `isScanned: false` is stated rather than left to bind, because on **this** path it is the
    // right answer and only here: the folder's own mtime moved, so its contents moved, so it
    // genuinely has not been reconciled and belongs back on the scan frontier. The children
    // above take the opposite rule, because a child's own mtime says nothing about whether
    // anyone descended into *it*.
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
            isScanned: false,
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

  /**
  Reject a path before it reaches either DAO.
  */
  public static assertPath(path: string): void {
    if (path.length > 1024) throw new BadRequestError('Path is too long.');
    if (path.includes('\0') || path.includes('\\')) throw new BadRequestError('Path contains an illegal character.');
    if (path.startsWith('/')) throw new BadRequestError('Path must be relative to the library root.');
    if (path.split('/').some((segment) => segment === '..' || segment === '.')) {
      throw new BadRequestError('Path must not contain "." or ".." segments.');
    }
  }
}

export { TreeService };
export type { TreeDeps, MaterializedFolder };

export {toLibraryPath} from '@edge-sonic/webdav';