/**
 * How many tracks a library holds.
 *
 * ### Its own module, and why
 *
 * A count is not a row. `SongDAO` answers "what is this one song" and "which rows match this",
 * and these two methods answer neither — they answer "how many", for a caller that then renders
 * a number and never looks at a track. It is the same split as `SongIdLookupDAO` beside it, and
 * for the same reason: `SongDAO` was over the god-file limit and this is the cohesive block that
 * moved.
 *
 * `SongDAO` keeps both methods as one-line delegates rather than dropping them, because the call
 * sites are about a library and not about a DAO — a caller reaching for `songs.countByLibrary`
 * is reading the right thing off the right object, and routing it through a second token would
 * be a rename in `Tokens` that buys nothing.
 */
import { BaseDAO } from './BaseDAO';
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import type { CountRow } from './rows';

/**
 * Library ids per statement: one variable each, and nothing else.
 *
 * Derived from the measured ceiling rather than chosen, so a raised `MAX_LIBRARIES` cannot
 * silently push this over D1's 100-parameter limit. See `sqlLimits.ts`.
 */
const LIBRARIES_PER_STATEMENT = bindChunkSize(1);

class SongCountDAO extends BaseDAO {
  /**
   * One library's track count.
   *
   * `0` for a library with no tracks, which is a real answer for this method — the caller
   * distinguishes "never scanned" from "scanned and empty" by combining this with the scan
   * state, so a defaulted zero here erases nothing and a `null` would break the arithmetic.
   */
  public async countByLibrary(libraryId: string): Promise<number> {
    const row = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT COUNT(*) AS cnt FROM songs WHERE library_id = ?')
          .bind(libraryId)
          .first<CountRow>(),
      'songs.countByLibrary',
    );
    return row?.cnt ?? 0;
  }

  /**
   * Track counts for many libraries in one statement, keyed by library id.
   *
   * One grouped read rather than one `countByLibrary` per library. The operator list needs a
   * count for every library it renders, and `MAX_LIBRARIES` defaults to 10 — so the
   * per-library form is an N+1 on the page an operator loads and then polls, and it spends a
   * D1 query (a subrequest) each time. `idx_songs_library_path` has `library_id` leading, so
   * the grouping is an index walk.
   *
   * A library with no tracks is **absent from the map**, not present with a zero. The caller
   * distinguishes "no tracks indexed" from "this library has no scan state" by combining the
   * two maps, and a defaulted `0` here would erase that difference.
   */
  public async countByLibraries(libraryIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const chunk of chunkArray(libraryIds, LIBRARIES_PER_STATEMENT)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(`SELECT library_id, COUNT(*) AS cnt FROM songs WHERE library_id IN (${placeholders}) GROUP BY library_id`)
            .bind(...chunk)
            .all<{ library_id: string; cnt: number }>(),
        'songs.countByLibraries',
      );
      for (const row of result.results ?? []) counts.set(row.library_id, row.cnt);
    }
    return counts;
  }
}

export { SongCountDAO };