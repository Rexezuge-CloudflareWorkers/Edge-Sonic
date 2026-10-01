/**
 * Fetching a known set of song rows, in the caller's order.
 *
 * ### Why this is its own module
 *
 * Because it is a *shape* of query rather than a fact about a song. `SongDAO` owns one row —
 * its facts, its derived metadata, its lifecycle — and this asks for many rows by id, in
 * order, which is a question about the caller's list rather than about the schema. It is
 * also the only place in the file that has to think about D1's bind-parameter ceiling, and
 * folding it in pushed `SongDAO` past the god-file limit.
 *
 * ### Why the batching is not optional
 *
 * `id IN (...)` costs one bound variable per id, and D1 allows **100 per statement** — not
 * SQLite's 32,766, and not the `999` the old SQLite default is usually quoted as. So an
 * unbatched lookup fails at 100 ids, and the caller here is `getPlayQueue`, whose input is
 * whatever queue the user happens to have saved.
 *
 * It shipped at 200 per chunk under a comment reading "Chunked to stay inside SQLite's
 * bound-parameter limit (999 by default)". The guard was real; its stated budget was
 * fiction; and 200 is *twice* the ceiling. A saved queue of 100 tracks was a masked
 * `code=0` on the endpoint that restores it. The size is now derived from the measured
 * constant — see `sqlLimits.ts` — so the arithmetic lives in one place and a test can
 * assert it.
 *
 * ### Why the order is re-established rather than inherited
 *
 * Because `id IN (...)` returns rows in whatever order the index scan produces. Returning
 * them directly shuffled every saved play queue: the client stored "Holocene, then Skinny
 * Love" and got them back in an order that changed per request, which for a queue is not a
 * cosmetic difference. The merge is over the whole result rather than per chunk, so
 * batching is invisible to the caller — the same rule `songIndex` follows, and for the same
 * reason: a chunked fetch cannot inherit an ordering it used to get from one statement.
 */
import { BaseDAO } from './BaseDAO';
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import type { SongRow } from './rows';

/**
 * Song ids per statement: one variable each, plus the `library_id`.
 *
 * Derived rather than chosen, so raising `MAX_PAGE_SIZE` — or the ceiling itself — cannot
 * silently re-break this. 99, and a saved queue is routinely longer than that.
 */
const IDS_PER_STATEMENT = bindChunkSize(1);

class SongIdLookupDAO extends BaseDAO {
  /**
   * The rows for `ids`, in the order given.
   *
   * Ids that do not resolve are **omitted**, not substituted, so an entry for a deleted
   * track disappears and the order of the rest is preserved. That is the whole difference
   * from an index scan: a caller that saved ten ids and gets eight back must be able to
   * tell which two are gone, and a placeholder row in their place would be a track the user
   * never queued.
   */
  /**
   * Songs by id, across **every** library the ids can belong to.
   *
   * A second reading, not a variant of {@link listIdsIn}. That one is library-scoped
   * because almost every caller has already resolved a single library and wants a track
   * outside it to be absent — an id from a library the caller cannot see must not resolve.
   *
   * Two callers cannot make that narrowing: the play queue and a playlist's entries are
   * both *per-user* records holding ids from whatever libraries that user was granted.
   * They resolved `libraries[0]` and filtered, so with two granted libraries every entry
   * from the second one silently vanished — no error, a shorter list, and a playlist that
   * lost songs. `getBookmarks`, which iterates all libraries, disagreed with both.
   *
   * Safe because the caller has already authorized each id: `savePlayQueue` and
   * `createBookmark` await `requireForUser` per id before writing, and a playlist's entries
   * were authorized when they were added. This method therefore widens the *lookup*, not
   * the *permission*.
   */
  public async listIdsAcrossLibraries(ids: readonly string[]): Promise<SongRow[]> {
    if (ids.length === 0) return [];
    const found = new Map<string, SongRow>();
    for (const chunk of chunkArray(ids, IDS_PER_STATEMENT)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(`SELECT * FROM songs WHERE id IN (${placeholders})`)
            .bind(...chunk)
            .all<SongRow>(),
        'songs.listIdsAcrossLibraries',
      );
      for (const row of result.results ?? []) found.set(row.id, row);
    }
    // Re-sorted to the caller's order, because an `IN` list returns rows in index-scan
    // order and a play queue that reshuffles between polls is worse than no play queue.
    return ids.flatMap((id) => {
      const row = found.get(id);
      return row === undefined ? [] : [row];
    });
  }

  public async listIdsIn(libraryId: string, ids: readonly string[]): Promise<SongRow[]> {
    if (ids.length === 0) return [];

    const found = new Map<string, SongRow>();
    for (const chunk of chunkArray(ids, IDS_PER_STATEMENT)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(`SELECT * FROM songs WHERE library_id = ? AND id IN (${placeholders})`)
            .bind(libraryId, ...chunk)
            .all<SongRow>(),
        'songs.listIdsIn',
      );
      for (const row of result.results ?? []) found.set(row.id, row);
    }

    // One pass over `ids`, not over `found`: the caller's order is the answer, and
    // `found`'s is the index's.
    return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
  }
}

export { SongIdLookupDAO, IDS_PER_STATEMENT };
