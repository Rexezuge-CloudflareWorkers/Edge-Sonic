/**
 * The folder tree: `nodes`.
 *
 * `nodes` exists so that a library can be **browsed before it has been scanned**
 * and so that a rescan can be **incremental**. Both properties come from the same
 * column: `mtime_ms` is what the scan compares a fresh `PROPFIND` against, so it
 * only descends into folders that actually changed.
 *
 * The invariant that makes the second scan free:
 *
 * > An unchanged rescan writes zero rows and issues zero WebDAV subrequests.
 *
 * Asserted by `test/scan-incremental.test.ts` on *write counts*, not on statuses —
 * a response-code assertion cannot see a quota being spent.
 */
import { BaseDAO } from './BaseDAO';
import type { NodeRow } from './rows';
import { nowSeconds } from './identity';

const UPSERT = `INSERT INTO nodes (library_id, path, parent_path, name, name_ci, mtime_ms, etag, depth, is_scanned, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (library_id, path) DO UPDATE SET
  parent_path = excluded.parent_path,
  name = excluded.name,
  name_ci = excluded.name_ci,
  mtime_ms = excluded.mtime_ms,
  etag = excluded.etag,
  depth = excluded.depth,
  is_scanned = excluded.is_scanned,
  updated_at = excluded.updated_at`;

interface NodeInput {
  libraryId: string;
  path: string;
  parentPath: string;
  name: string;
  mtimeMs: number | null;
  etag: string | null;
  depth: number;
  /**
   * Whether the scan still has to descend into this folder.
   *
   * Defaults to `0` (needs descending), which is right for a folder a parent
   * listing just reported as new or changed. A folder the scan has already
   * reconciled is written as `1` so it leaves the frontier.
   *
   * This flag *is* the incrementality mechanism, so it belongs in the write rather
   * than in a follow-up `patch`: a node row is written once, correctly, instead of
   * twice — and a second write is a second spend from a 5,000/day allowance.
   */
  isScanned?: boolean;
}

/**
Fields a caller wants to overwrite in place.
*/
interface NodePatch {
  mtimeMs?: number | null;
  etag?: string | null;
  isScanned?: boolean;
}

class NodeDAO extends BaseDAO {
  public async find(libraryId: string, path: string): Promise<NodeRow | null> {
    return await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM nodes WHERE library_id = ? AND path = ?')
          .bind(libraryId, path)
          .first<NodeRow>(),
      'nodes.find',
    );
  }

  public async listChildren(libraryId: string, parentPath: string): Promise<NodeRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM nodes WHERE library_id = ? AND parent_path = ? ORDER BY name_ci ASC')
          .bind(libraryId, parentPath)
          .all<NodeRow>(),
      'nodes.listChildren',
    );
    return result.results ?? [];
  }

  /**
   * Immediate children of the root, for `getIndexes`.
   *
   * `parent_path = ''` rather than a sentinel column: the root is a real path
   * (the empty string) and keeping it one makes the root's own `nodes` row
   * consistent with every other folder.
   *
   * `AND path != ''` is what keeps the root's own row out of it. The root row is
   * `path === parentPath === ''`, so it satisfies `parent_path = ''` like every top-level
   * folder does, and it was returned as though it were one of them: `getIndexes` emitted
   * a `shortcut` with an empty `name` — an unlabelled entry at the top of the `#` group,
   * which every client renders — whose id resolved to the library root and then failed
   * with `code 70`. This shipped. `listChildren('')` is unchanged and still returns it,
   * which is how `getMusicDirectory` reaches the root.
   */
  public async listRoots(libraryId: string): Promise<NodeRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare("SELECT * FROM nodes WHERE library_id = ? AND parent_path = '' AND path != '' ORDER BY name_ci ASC")
          .bind(libraryId)
          .all<NodeRow>(),
      'nodes.listRoots',
    );
    return result.results ?? [];
  }

  /**
   * The scan frontier: unscanned folders, shallowest first.
   *
   * Shallowest-first is what makes a partial scan useful. A scan that dies
   * half-way has still produced a browsable top of the tree, rather than a
   * random scattering of deep leaves.
   */
  public async listFrontier(libraryId: string, limit: number): Promise<NodeRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM nodes WHERE library_id = ? AND is_scanned = 0 ORDER BY depth ASC, path ASC LIMIT ?')
          .bind(libraryId, limit)
          .all<NodeRow>(),
      'nodes.listFrontier',
    );
    return result.results ?? [];
  }

  public async upsertMany(inputs: readonly NodeInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const timestamp = nowSeconds();
    const statements = inputs.map((input) =>
      this.database
        .prepare(UPSERT)
        .bind(
          input.libraryId,
          input.path,
          input.parentPath,
          input.name,
          input.name.toLowerCase(),
          input.mtimeMs,
          input.etag,
          input.depth,
          input.isScanned ? 1 : 0,
          timestamp,
          timestamp,
        ),
    );
    return await this.runWriteBatch(statements, 'nodes.upsertMany');
  }

  /**
   * Apply a patch to one folder.
   *
   * A no-op patch still issues the statement, which is why callers compare
   * before calling: an unchanged folder must cost zero writes. The decision
   * belongs to the caller because it needs the previous value to decide.
   */
  public async patch(libraryId: string, path: string, patch: NodePatch): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.mtimeMs !== undefined) {
      assignments.push('mtime_ms = ?');
      values.push(patch.mtimeMs);
    }
    if (patch.etag !== undefined) {
      assignments.push('etag = ?');
      values.push(patch.etag);
    }
    if (patch.isScanned !== undefined) {
      assignments.push('is_scanned = ?');
      values.push(patch.isScanned ? 1 : 0);
    }
    if (assignments.length === 0) return;
    assignments.push('updated_at = ?');
    values.push(nowSeconds(), libraryId, path);

    await this.withRetry(
      async () =>
        await this.database
          .prepare(`UPDATE nodes SET ${assignments.join(', ')} WHERE library_id = ? AND path = ?`)
          .bind(...values)
          .run(),
      'nodes.patch',
    );
  }

  /**
   * Delete child rows whose paths are no longer present.
   *
   * Called only for a folder whose mtime moved, so the cost is proportional to what
   * changed rather than to library size. This is what stops a folder deleted on the
   * WebDAV side from haunting `search3` forever.
   *
   * ### The folder's own row is always kept
   *
   * That is not a special case, it is load-bearing. The library root's `path` and
   * `parent_path` are **both** the empty string — there is no path above the root —
   * so a query of the form `parent_path = ?` matches the root's own row. Without an
   * explicit `path <> parentPath` guard, reconciling the root deletes the root, the
   * next `startScan` probe finds nothing stored, and the library is re-walked in
   * full on every scan forever. The symptom is a scan that answers correctly and
   * silently never becomes incremental.
   */
  public async deleteChildrenNotIn(libraryId: string, parentPath: string, keepPaths: readonly string[]): Promise<number> {
    const prefix = parentPath === '' ? '' : `${parentPath}/`;
    const all = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT path FROM nodes WHERE library_id = ? AND parent_path = ?')
          .bind(libraryId, parentPath)
          .all<{ path: string }>(),
      'nodes.deleteChildrenNotIn.list',
    );
    const keep = new Set(keepPaths);
    const doomed = (all.results ?? [])
      .map((row) => row.path)
      // See the method note: for the library root, `path === parentPath`, and that
      // row is the one being reconciled, not a child.
      .filter((path) => path !== parentPath && !keep.has(path));
    if (doomed.length === 0) return 0;

    const statements = doomed.map((path) => this.database.prepare('DELETE FROM nodes WHERE library_id = ? AND path = ?').bind(libraryId, path));
    // `prefix` is computed for the caller's benefit in tests; the delete itself is
    // exact-match on the child's own path, never a LIKE.
    void prefix;
    await this.runWriteBatch(statements, 'nodes.deleteChildrenNotIn');
    return doomed.length;
  }

  public async deleteSubtree(libraryId: string, path: string): Promise<number> {
    // Exact children plus a LIKE for deeper descendants. The LIKE is escaped so
    // a folder literally named `100%` does not match everything.
    const escaped = `${path.replaceAll(/[%_]/g, (char) => `\\${char}`)}/%`;
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(String.raw`DELETE FROM nodes WHERE library_id = ? AND (path = ? OR path LIKE ? ESCAPE '\')`)
          .bind(libraryId, path, escaped)
          .run(),
      'nodes.deleteSubtree',
    );
    return result.meta?.changes ?? 0;
  }

  public async countByLibrary(libraryId: string): Promise<number> {
    const row = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE library_id = ?')
          .bind(libraryId)
          .first<{ cnt: number }>(),
      'nodes.countByLibrary',
    );
    return row?.cnt ?? 0;
  }

}


export { NodeDAO };
export type { NodeInput, NodePatch };
