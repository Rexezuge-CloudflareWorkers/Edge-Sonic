/**
 * What the reconcile walk needs from `nodes`.
 *
 * Split out of `scanTypes.ts` for the god-file limit and not for the reader's benefit — but the
 * split lands on a seam that turns out to be the subject of this file's one rule. `nodes` has two
 * writers per reconcile: the node row and the song row, and the walk decides whether to offer each
 * of them from **one** read. So the store that answers it carries the answer for both planes, and
 * that is a decision about this port rather than about `NodeDAO`.
 *
 * The port is structural rather than nominal for the reason `scanTypes.ts` gives: `ScanService`
 * never imports a DAO, so a test can supply a store answering only what its case needs.
 */
import type { ChildNodeRow, NodeRow, WriteBatchResult } from '@edge-sonic/backend-data/dao';

/**
 * An input for one `nodes` row.
 */
interface ScanNodeInput {
  libraryId: string;
  path: string;
  parentPath: string;
  name: string;
  mtimeMs: number | null;
  etag: string | null;
  depth: number;
  isScanned?: boolean;
}

interface ScanNodeStore {
  find(libraryId: string, path: string): Promise<NodeRow | null>;
  listChildren(libraryId: string, parentPath: string): Promise<NodeRow[]>;
  /**
   * The read a reconcile diffs against, and it reports **both** planes.
   *
   * `listChildren` would be the wrong read for it: a folder's children are written as a `nodes`
   * row and, when they are audio, a `songs` row, in two batches that truncate independently — so
   * the node row can be current while the song row was never written. Answering "does this child
   * need writing" from `nodes` for a row that lives in `songs` is a proxy the two tables are free
   * to disagree about, and the folder then closes with the disagreement permanent.
   *
   * Measured on a live library: 117 `nodes` rows, 116 `songs` rows, one track browsable with
   * `duration: 0` and no album, absent from every album list, `getSong` answering `70` for an id
   * the browse had just published. `NodeDAO.listChildrenWithSongPresence` for the statement.
   */
  listChildrenWithSongPresence(libraryId: string, parentPath: string): Promise<ChildNodeRow[]>;
  listRoots(libraryId: string): Promise<NodeRow[]>;
  listFrontier(libraryId: string, limit: number): Promise<NodeRow[]>;
  /**
   * `WriteBatchResult` and not a count, because a cold album of 500 tracks is ~500 statements
   * against a ceiling of 50 and is *expected* to come back truncated on a Free plan. The scan
   * has to see that, because the one write it must not do for a half-written folder is the
   * folder's own row carrying `is_scanned: true`.
   */
  upsertMany(inputs: readonly ScanNodeInput[]): Promise<WriteBatchResult>;
  /**
   * `WriteBatchResult` and not a count, because a prune is billed like any other write and the
   * day's allowance is denominated in billed rows. `scanAccounting` for the two counts.
   */
  deleteSubtree(libraryId: string, path: string): Promise<WriteBatchResult>;
  countByLibrary(libraryId: string): Promise<number>;
}

export type { ScanNodeInput, ScanNodeStore };
