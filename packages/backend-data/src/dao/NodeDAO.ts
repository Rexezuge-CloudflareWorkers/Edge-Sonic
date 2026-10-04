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
import type { WriteBatchResult } from './BaseDAO';
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
   * than in a follow-up `UPDATE`: a node row is written once, correctly, instead of
   * twice — and a second write is a second spend from a 5,000/day allowance. It used to
   * be also patchable through a `NodeDAO.patch` that nothing called, so the second
   * spelling existed with no user.
   */
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

  /**
   * Write node rows, as many as the subrequest budget allows.
   *
   * `truncated` is load-bearing and is why this does not return a plain count: the scan
   * writes a folder's children and *then* the folder's own row with `is_scanned: true`, and
   * that second write must not happen for a folder whose children are only partly there.
   * See `BaseDAO`'s `WriteBatchResult`.
   */
  public async upsertMany(inputs: readonly NodeInput[]): Promise<WriteBatchResult> {
    if (inputs.length === 0) return { changes: 0, written: 0, truncated: false };
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
export type { NodeInput };
