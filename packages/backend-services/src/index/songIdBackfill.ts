/**
 * The bounded pass that rotates legacy long song ids to short ones.
 *
 * New rows are derived short at insert time, but every row indexed before the
 * switch carries `s:base64url(libraryId + "\n" + path)` — up to ~1,400 chars,
 * and several hundred for ordinary CJK libraries. Clients file downloads under
 * the id, and a component over 255 bytes is `ENAMETOOLONG` with no
 * server-side error. So the rows have to be renamed, one chunk at a time — to
 * the derived short id the indexer now writes, so the rename converges rather
 * than minting a second value for the same file.
 *
 * Runs ahead of the walk on every poll, beside the derivation backfill, for
 * the same reason: the walk only touches changed files, so an untouched
 * library would keep its long ids for ever. The selection is `LENGTH(id) > 32`,
 * so the remaining set strictly shrinks and the pass terminates without a
 * cursor. Once a library is current the read returns no rows and nothing is
 * issued, so a healthy poll costs one indexed read.
 *
 * Each song costs two statements — the `songs` rename plus the
 * `playlist_entries` rewrite that the entry join depends on — issued with
 * `requireComplete`, so a page this chunk cannot hold whole is deferred to the
 * next poll rather than half-renamed. Stars, ratings, bookmarks, queues and
 * play counts are not rewritten: reads resolve both forms (see `SongDAO`
 * and `songToModel`), and writes store the canonical id, so they migrate
 * lazily.
 */
import {
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SUBSREQUESTS_PER_CHUNK_OVERHEAD,
  SUBSREQUESTS_PER_FOLDER_BASE,
} from '@edge-sonic/backend-runtime/config';
import { deriveShortSongId } from '@edge-sonic/subsonic';
import type { ScanBudget } from './scanBudget';
import type { ScanIdRotationStore } from './scanTypes';

/**
 * Statements one rotated song costs: the `songs` rename and the
 * `playlist_entries` rewrite. The read selecting the page is counted
 * separately, once per chunk.
 */
const STATEMENTS_PER_ROTATED_SONG = 2;

const SCAN_SONG_ID_MAX_ROWS_PER_CHUNK = Math.max(
  1,
  Math.floor((SCAN_CHUNK_SUBSREQUEST_BUDGET - SUBSREQUESTS_PER_CHUNK_OVERHEAD - SUBSREQUESTS_PER_FOLDER_BASE - 1) / STATEMENTS_PER_ROTATED_SONG),
);

interface IdRotationCost {
  readonly rowsWritten: number;
  readonly billedRows: number;
}

const NO_ROTATION: IdRotationCost = { rowsWritten: 0, billedRows: 0 };

async function rotatePendingSongIds(store: ScanIdRotationStore, libraryId: string, budget: ScanBudget): Promise<IdRotationCost> {
  if (budget.remainingMs <= 0) return NO_ROTATION;

  const rows = await store.listLegacySongIds(libraryId, SCAN_SONG_ID_MAX_ROWS_PER_CHUNK);
  if (rows.length === 0) return NO_ROTATION;

  // The whole page's statements, decided before any are issued: a rename that
  // stops halfway leaves songs renamed without their playlist entries (or the
  // reverse), and the selection re-reads the leftovers next poll anyway.
  if (!budget.canAfford(1 + rows.length * STATEMENTS_PER_ROTATED_SONG)) return NO_ROTATION;

  let rowsWritten = 0;
  let billedRows = 0;
  for (const row of rows) {
    const result = await store.rotateSongId(libraryId, row.path, row.id, deriveShortSongId(libraryId, row.path));
    rowsWritten += result.changes;
    billedRows += result.billedRows;
  }
  return { rowsWritten, billedRows };
}

export { rotatePendingSongIds, NO_ROTATION, SCAN_SONG_ID_MAX_ROWS_PER_CHUNK, STATEMENTS_PER_ROTATED_SONG };
export type { IdRotationCost };
