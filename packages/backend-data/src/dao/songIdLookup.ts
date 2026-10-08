/**
 * Fetching a known set of song rows, in the caller's order.
 *
 * ### There is no legacy-id fallback here any more
 *
 * Every method below used to answer a miss by decoding the id as a reversible `s:` id and
 * resolving it through `(library_id, path)` — a second statement per miss, a per-library grouping,
 * and an `O(n)` decode attempt over ids that were never ids. Rotation rewrote `songs.id` in bounded
 * batches and the fallback was kept for clients holding a pre-rotation id; that is retired, so a
 * miss is a miss.
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
   * One song by its library-relative path.
   *
   * Rides `idx_songs_library_path`, the same index the reconcile identity is
   * keyed on — so this is the lookup the legacy-id fallback and the cover-art
   * song branch share, rather than each reconstructing an id to probe with.
   */
  public async findByPath(libraryId: string, path: string): Promise<SongRow | null> {
    return await this.withRetry(
      async () =>
        await this.database.prepare('SELECT * FROM songs WHERE library_id = ? AND path = ?').bind(libraryId, path).first<SongRow>(),
      'songs.findByPath',
    );
  }

  /**
   * One song by id, or `null`.
   *
   * **One statement.** It used to fall back to decoding the id as a reversible `s:` id and reading
   * `(library_id, path)` — so a client holding a pre-rotation id resolved, at the cost of a second
   * statement on every miss and a decode attempt on every id that was never one. Both are gone with
   * the fallback; the primary key answers it.
   *
   * A caller that genuinely holds a **path** rather than a song id — `getCoverArt`'s song branch —
   * uses {@link findByPath} for that, which is a different question about the same row.
   */
  public async findBySongId(id: string): Promise<SongRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM songs WHERE id = ?').bind(id).first<SongRow>(),
      'songs.findBySongId',
    );
  }

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
    // Before the first statement, for the reason `songsForAlbumDirs` gives: the id list is the
    // answer's identity, so resolving a subset of it is a shorter queue or a playlist that
    // lost songs — both of which have shipped here before, from a different cause.
    this.requireSubrequests(Math.ceil(ids.length / IDS_PER_STATEMENT), 'songs.listIdsAcrossLibraries');
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

    // Refuse rather than resolve a subset, for the reason `listIdsAcrossLibraries` gives: the
    // caller's id list *is* the answer, and a shorter one is a wrong answer.
    this.requireSubrequests(Math.ceil(ids.length / IDS_PER_STATEMENT), 'songs.listIdsIn');

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
    //
    // The membership test is `found.has(id)` and the read is a `get`, on purpose — a `Map` keyed by
    // the same strings in both places is a single structure, so a row cannot be present in one and
    // absent from the other. It used to be two hand-maintained collections in the legacy path, and
    // a `!` bridged them; a divergence there would have written `undefined` into a saved queue rather
    // than omitting a track, which is the difference between a shorter queue and a corrupt one.
    return ids.flatMap((id) => (found.has(id) ? [found.get(id) as SongRow] : []));
  }
}

export { SongIdLookupDAO, IDS_PER_STATEMENT };
