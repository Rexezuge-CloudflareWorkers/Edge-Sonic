/**
 * Top songs for one artist, from the **calling user's** play counts.
 *
 * ### Why this is not last.fm, and why an empty answer is an empty answer
 *
 * The protocol describes `getTopSongs` as last.fm-backed. This server has no last.fm
 * integration, so the only chart it can honestly publish is the one the data supports:
 * the tracks of that artist this user has actually played, most-played first. That is a
 * narrower claim than a global chart, and it is stated rather than hidden behind a
 * failure or an empty table entry.
 *
 * Zero play counts are **not** a ranking. An artist whose tracks have never been played
 * has no local chart to report, so the endpoint answers a present `topSongs` wrapper
 * with no songs rather than a list sorted by path and labelled "top". The `p.play_count
 * > 0` predicate is what makes that distinction, and it is here rather than in the
 * handler because a caller cannot infer from the returned rows which ones were zero.
 *
 * ### One statement, both bounds from the caller
 *
 * The play counts are the driving table: `p.user_id = ?` is the table's composite primary
 * key, so the cost starts with this user's plays rather than with every row of every
 * library. The `JOIN` resolves each played song by primary key, and the artist predicate
 * plus the library scope decide which of them are eligible. Both the scope and the limit
 * are bound; no `IN (...)` list is built here, so there is no batch size to derive —
 * `libraryScope` still renders a singleton as `=` and an empty set as `0 = 1`.
 *
 * The sort tuple ends in `(library_id, path)` so two songs with the same count have one
 * order for every caller and every query plan. A ranking that depended on SQLite's row
 * order would change when an index changed, and nothing on the wire would say why.
 *
 * ### Why this class sits between `SongSimilarDAO` and `SongIndexDAO`
 *
 * `SongIndexDAO` already inherits the local similarity reads so the request layer carries
 * one aggregate DAO. Putting this method there would put it over the god-file ceiling;
 * adding a second DAO to `RestContext` would give the handler two objects that can be
 * constructed with different meters. Extending the chain keeps one construction and one
 * meter, for the same reason `songSimilar.ts` gives for being inherited at all.
 */
import { SongSimilarDAO } from './songSimilar';
import { libraryScope } from './libraryScope';
import type { LibraryScope } from './libraryScope';
import type { SongRow } from './rows';

/**
 * The statement behind `getTopSongs`, exposed so a query-plan assertion tests the SQL
 * that actually runs rather than a copy of it. A copy would agree with the plan while
 * the DAO moved on, which is the same defect as a double that shares the code's assumptions.
 */
function topSongsQuery(scope: LibraryScope, userId: string, artistCi: string, limit: number): { sql: string; values: readonly unknown[] } {
  const libraries = libraryScope(scope, 's.library_id');
  return {
    sql: `SELECT s.*, p.play_count AS play_count
            FROM play_counts p
            JOIN songs s ON s.id = p.song_id
            WHERE p.user_id = ? AND p.play_count > 0 AND ${libraries.sql}
              AND (s.artist_ci = ? OR s.album_artist_ci = ?)
            ORDER BY p.play_count DESC, s.library_id ASC, s.path ASC
            LIMIT ?`,
    values: [userId, ...libraries.values, artistCi, artistCi, limit],
  };
}

class SongTopDAO extends SongSimilarDAO {
  /**
   * This user's most-played songs by an artist, inside the caller's library scope.
   *
   * `artistCi` is provided lowercased by the handler, which lowercases the **parameter**
   * rather than the column — the rule that keeps `idx_songs_artist` usable. `limit` is
   * clamped by the caller's page ceiling; this layer does not pick a number.
   */
  public async listTopSongs(scope: LibraryScope, userId: string, artistCi: string, limit: number): Promise<SongRow[]> {
    if (limit <= 0) return [];
    const query = topSongsQuery(scope, userId, artistCi, limit);
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(query.sql)
          .bind(...query.values)
          .all<SongRow>(),
      'songs.listTopSongs',
    );
    return result.results ?? [];
  }
}

export { SongTopDAO, topSongsQuery };
