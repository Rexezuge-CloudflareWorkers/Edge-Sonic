/**
 * What an index drop would cost, before it is run.
 *
 * ### Why the projection lives here and not in a route
 *
 * Because `billedRowsForTable` lives here, and `apps/api` may not import this package's
 * **values** (`no-restricted-imports`). A `songs * 10` written in a route is a second copy
 * of the per-table arithmetic in a layer that cannot see the table it is quoting — which is
 * the same defect as `TABLE_INDEX_COUNTS` being a typed constant rather than a derivation,
 * and the same one as `listIdsIn`'s batch size of 200 under a comment asserting SQLite's
 * limit was 999. A multiplier that is wrong is at least *visible*; a multiplier that is
 * wrong in the safe direction is invisible for ever.
 *
 * So the number the operator is asked to confirm and the number the drop is charged to are
 * produced by one call to the same function. They cannot drift, because there is nothing to
 * drift: this module's `billedRows` *is* `billedRowsForTable`, and `IndexDropDAO` reports
 * what `runWriteStatement` measured with it.
 *
 * ### Why this is a separate DAO rather than two count methods
 *
 * A count is not a row — that is the split `songCounts.ts` already makes — but this answers
 * a third question again: "what would it cost to destroy this index", which is a function of
 * two counts *and* the billing table. Splitting it would put that function somewhere that
 * cannot see the arithmetic, which is the placement this file exists to refuse.
 */
import { UNMETERED_SUBREQUESTS } from '@edge-sonic/shared';
import type { SubrequestMeter } from '@edge-sonic/shared';
import type { D1Queryable } from '../utils/D1Types';
import { BaseDAO } from './BaseDAO';
import { billedRowsForTable } from './billedRows';
import { SongCountDAO } from './songCounts';
import { NodeDAO } from './NodeDAO';
import { ScanStateDAO } from './ScanStateDAO';

/**
 * The three tables a drop destroys, and what each one bills per row.
 *
 * `nodes` is here rather than omitted because a library has far more folders than it has
 * tracks, and a projection that quoted only the songs would under-report the bill by a
 * factor the operator cannot see. `scan_state` is one row per library and is included for
 * completeness — it is the smallest term and it is the one that decides whether the library
 * reads as "never scanned" afterwards.
 */
const DROPPED_TABLES = ['songs', 'nodes', 'scan_state'] as const;

/**
 * What dropping one library's index would delete, and what that would bill.
 *
 * `billedRows` is the figure the operator is shown and is the same arithmetic the drop is
 * charged with. `scan_state` is counted rather than assumed at 1, because the honest answer
 * for a library that was never scanned is 0 — and a projection that quoted 1 for it would
 * report a cost for a table it is not going to touch.
 */
interface LibraryIndexStats {
  readonly songs: number;
  readonly nodes: number;
  readonly scanStates: number;
  readonly billedRows: number;
}

/**
 * A drop's cost for one library, or for every library at once.
 *
 * `libraries` is a list rather than a single total because the Danger Zone renders a row per
 * library, and the confirm phrase for the global action has to be agreed against a sum of
 * the same numbers the per-library rows show. Two shapes would be two answers to "what does
 * this cost", which is the thing an operator is being asked to consent to.
 */
interface IndexStats {
  readonly libraries: ReadonlyArray<{ readonly libraryId: string; readonly stats: LibraryIndexStats }>;
  /**
  The sum over `libraries` — what `POST /user/index/drop` will bill.
  */
  readonly total: LibraryIndexStats;
}

/**
 * Billed rows for a delete of these three tables.
 *
 * Shared by the projection and nothing else: `IndexDropDAO` does not use this, because a drop
 * **measures** what it billed (`meta.changes` through `runWriteStatement`) rather than
 * predicting it. Two directions, one arithmetic — the estimate is for the operator to read
 * and the measurement is what gets charged.
 */
function estimateBilledRows(songs: number, nodes: number, scanStates: number): number {
  return billedRowsForTable('songs', songs) + billedRowsForTable('nodes', nodes) + billedRowsForTable('scan_state', scanStates);
}

/**
An empty drop: nothing indexed, nothing billed. Not a default — a real answer.
*/
const EMPTY_STATS: LibraryIndexStats = { songs: 0, nodes: 0, scanStates: 0, billedRows: 0 };

class IndexStatsDAO extends BaseDAO {
  private readonly songs: SongCountDAO;
  private readonly nodes: NodeDAO;
  private readonly scanState: ScanStateDAO;

  constructor(database: D1Queryable, meter: SubrequestMeter = UNMETERED_SUBREQUESTS) {
    super(database, meter);
    // Built from this DAO rather than from the database so the meter is inherited rather than
    // re-supplied. `BaseDAO` exposes it for exactly this, and a DAO that builds another DAO
    // from the database instead is the defect `requestScope.ts` documents at length.
    this.songs = new SongCountDAO(database, meter);
    this.nodes = new NodeDAO(database, meter);
    this.scanState = new ScanStateDAO(database, meter);
  }

  /**
   * One library's drop cost.
   *
   * Three reads, because the three tables are the three things the drop deletes and a count
   * taken from a different table would be a different number. `countByLibrary` returns `0`
   * for an empty library here rather than omitting it, which is the opposite of
   * `countByLibraries`' convention and correct for this question: a caller asking what a
   * drop would cost *needs* a row for a library with nothing in it, because "0 songs, 0
   * nodes, nothing to bill" is the answer and an absent key would make the caller infer it.
   */
  public async statsForLibrary(libraryId: string): Promise<LibraryIndexStats> {
    const [songs, nodes, scanned] = await Promise.all([
      this.songs.countByLibrary(libraryId),
      this.nodes.countByLibrary(libraryId),
      this.scanState.countByLibrary(libraryId),
    ]);
    return { songs, nodes, scanStates: scanned, billedRows: estimateBilledRows(songs, nodes, scanned) };
  }

  /**
   * Every library's drop cost, plus the total.
   *
   * Batched rather than one `statsForLibrary` per library: `MAX_LIBRARIES` defaults to 10, so
   * the per-library form is three reads per library on a page that renders all of them, and
   * each read is a subrequest out of the invocation's fifty. `chunkArray` at the derived
   * bound keeps the `IN (...)` list inside D1's measured ceiling if `MAX_LIBRARIES` is raised.
   *
   * A library with no rows in a table is absent from that table's map, so it contributes
   * zero — the same convention `countByLibraries` uses, and the reason `total` is a sum over
   * maps rather than over libraries.
   */
  public async statsAcrossLibraries(libraryIds: readonly string[]): Promise<IndexStats> {
    const [songCounts, nodeCounts, scanCounts] = await Promise.all([
      this.songs.countByLibraries(libraryIds),
      this.nodes.countByLibraries(libraryIds),
      this.scanState.countByLibraries(libraryIds),
    ]);

    const entries = libraryIds.map((libraryId) => {
      const stats: LibraryIndexStats = {
        songs: songCounts.get(libraryId) ?? 0,
        nodes: nodeCounts.get(libraryId) ?? 0,
        scanStates: scanCounts.get(libraryId) ?? 0,
        billedRows: 0,
      };
      return { libraryId, stats: { ...stats, billedRows: estimateBilledRows(stats.songs, stats.nodes, stats.scanStates) } };
    });

    const total = entries.reduce<LibraryIndexStats>(
      (sum, entry) => ({
        songs: sum.songs + entry.stats.songs,
        nodes: sum.nodes + entry.stats.nodes,
        scanStates: sum.scanStates + entry.stats.scanStates,
        billedRows: sum.billedRows + entry.stats.billedRows,
      }),
      { ...EMPTY_STATS },
    );

    return { libraries: entries, total };
  }
}

export { IndexStatsDAO, estimateBilledRows, DROPPED_TABLES };
export type { LibraryIndexStats, IndexStats };
