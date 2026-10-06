/**
 * Destroying a scanned index: `songs`, `nodes` and `scan_state`.
 *
 * ### What this drops, and what it deliberately does not
 *
 * The three tables are the index. What is **not** dropped is everything else: the `libraries`
 * row with its encrypted WebDAV credential, and every per-user annotation — stars, ratings,
 * bookmarks, the play queue, play counts, playlist entries.
 *
 * The annotations are the surprising half, and the reason is that they have **no foreign key**
 * to `songs`. They hold song ids as opaque strings. Leaving them behind is safe anyway, and it
 * is safe for a specific reason rather than by luck:
 *
 * > A song id is `s:` + base64url(`libraryId` + "\n" + `path`) — derived, not minted.
 *
 * So a rescan of the same library recreates byte-identical ids, and every star, play count and
 * playlist entry re-attaches to the row it belonged to. Dropping the annotations as well would
 * spend more billed rows (`stars` is 3 per row, `playlists` 4) to destroy listening history
 * that a rescan would have restored for free.
 *
 * A file that no longer exists leaves its annotation orphaned, which is the same state a deleted
 * track already produces and which every read of these tables already handles.
 *
 * ### Why `scan_state` is deleted rather than reset
 *
 * Because **absence is a state the operator surface reads**. `librarySummary` reports `scan: null`
 * for a library with no `scan_state` row, and `null` renders as "never scanned" — which is
 * exactly the state an operator wants after dropping an index, because the next Rescan is meant
 * to be a first scan.
 *
 * Resetting the row to `idle` instead would render `idle` with `songCount: 0`, which is the
 * contradictory pair `describeScanState`'s `empty` case in `apps/web/src/lib/scanStatus.ts` exists
 * to catch: a success-toned "Up to date." beside "0 tracks indexed". Deleting the row makes the
 * two facts agree.
 *
 * ### Why the statements are separate rather than batched
 *
 * Three statements, so three subrequests, and each bills at **its own table's** multiplier
 * through `runWriteStatement` — `songs` at ten rows per row, `nodes` at four, `scan_state` at two.
 * A `batch()` would bill the same and report one `changes` figure, which would then have to be
 * attributed across three tables by hand. `billedRowsFor` needs the SQL to know which index
 * entries a change rewrote, and only the statement carries that.
 *
 * `scan_state` is deleted **first**. It is the smallest statement and the one whose absence
 * makes the library read as unscanned, so getting it out of the way first means a caller who
 * reads `GET /user/libraries` between the three statements sees a library that is honestly
 * "never scanned" rather than one reporting progress towards rows that are being removed.
 */
import { BaseDAO } from './BaseDAO';

/**
 * What a drop removed, and what it billed.
 *
 * Both counts, because they answer different questions and this is the surface that reports
 * them to an operator: `changes` is how much was destroyed, `billedRows` is how much of the
 * day's allowance the destruction consumed. See `WriteBatchResult` in `BaseDAO.ts` for why
 * collapsing them would force one claim to be a lie.
 */
interface IndexDropResult {
  readonly songs: number;
  readonly nodes: number;
  readonly scanStates: number;
  readonly changes: number;
  readonly billedRows: number;
}

class IndexDropDAO extends BaseDAO {
  /**
   * Drop one library's index.
   *
   * Scoped by `library_id` rather than deleting everything, because the Danger Zone offers a
   * per-library action beside the global one and the two must not share a statement. Three
   * separate `DELETE`s against one `library_id`; `scan_state` first, for the reason the class
   * comment gives.
   */
  public async dropLibrary(libraryId: string): Promise<IndexDropResult> {
    const scanStates = await this.runWriteStatement(
      this.prepare('DELETE FROM scan_state WHERE library_id = ?').bind(libraryId),
      'indexDrop.scanState',
    );
    const songs = await this.runWriteStatement(
      this.prepare('DELETE FROM songs WHERE library_id = ?').bind(libraryId),
      'indexDrop.songs',
    );
    const nodes = await this.runWriteStatement(
      this.prepare('DELETE FROM nodes WHERE library_id = ?').bind(libraryId),
      'indexDrop.nodes',
    );
    return {
      songs: songs.changes,
      nodes: nodes.changes,
      scanStates: scanStates.changes,
      changes: songs.changes + nodes.changes + scanStates.changes,
      billedRows: songs.billedRows + nodes.billedRows + scanStates.billedRows,
    };
  }

  /**
   * Drop **every** library's index, leaving the registrations in place.
   *
   * Three unscoped `DELETE`s. The libraries themselves survive, which is the whole difference
   * from `LibraryDAO.delete` — that one cascades `libraries` and takes the encrypted WebDAV
   * credential with it, so a wrong password currently has no remedy but re-registering the
   * origin. This is the remedy.
   *
   * `scan_state` first again, and for a stronger reason at this scope: with every row gone,
   * `GET /user/libraries` reports every library as `scan: null`, which is the truth, and it
   * does so before the two larger deletes have run.
   *
   * Note what is **not** scoped and does not need to be: there is no `WHERE`, because "every
   * library" is the whole table by definition. `libraries` is never touched, so the list the
   * operator comes back to is the same list they left.
   */
  public async dropAll(): Promise<IndexDropResult> {
    const scanStates = await this.runWriteStatement(this.prepare('DELETE FROM scan_state'), 'indexDrop.allScanState');
    const songs = await this.runWriteStatement(this.prepare('DELETE FROM songs'), 'indexDrop.allSongs');
    const nodes = await this.runWriteStatement(this.prepare('DELETE FROM nodes'), 'indexDrop.allNodes');
    return {
      songs: songs.changes,
      nodes: nodes.changes,
      scanStates: scanStates.changes,
      changes: songs.changes + nodes.changes + scanStates.changes,
      billedRows: songs.billedRows + nodes.billedRows + scanStates.billedRows,
    };
  }
}

export { IndexDropDAO };
export type { IndexDropResult };
