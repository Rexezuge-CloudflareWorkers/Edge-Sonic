/**
 * Reading songs **by directory**, in one batched statement.
 *
 * ### Why this is its own module
 *
 * Because it is a different-shaped question from "one song row": it takes a *set* of directories
 * and returns rows **grouped by** them, over the caller's whole library scope, and it is the only
 * read in this package that has to reason about D1's bind ceiling with one variable per library
 * *and* one per directory. `SongDAO` owns one row and is over the soft god-file limit; the batching
 * is the part whose reasoning needs reading in one place, for the same reason
 * `songIdLookup.ts` exists.
 *
 * ### Why it exists rather than `listByAlbumDir` in a loop
 *
 * `getStarred` resolves each stored album id, and a folder-shaped `al:` id names a **directory** — so
 * resolving one is a read. That read was issued per id, sequentially, against `libraries[0]` alone,
 * which was three defects in one loop:
 *
 * - a star whose directory lives in a **second granted library** resolved to nothing and was
 *   silently dropped — while the starred *songs* beside it in the same response were unioned, so the
 *   one response was internally inconsistent;
 * - ~50 starred albums crossed the Free subrequest ceiling and the request was terminated by the
 *   platform, with no envelope and nothing in a log;
 * - the dedup beside it was `keys.includes` over a growing array.
 *
 * The answer is keyed **by directory** because the caller needs to look a directory up by name: it
 * holds a list of album ids, derives the directories from them, and then asks each one what its rows
 * are. Keying by input position would make it re-derive which id produced which directory.
 */
import { BaseDAO } from './BaseDAO';
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import { libraryReserve, libraryScope } from './libraryScope';
import type { LibraryScope } from './libraryScope';
import type { SongRow } from './rows';

class SongAlbumDirDAO extends BaseDAO {
  /**
   * Every song in every one of `dirPaths`, across a whole scope, keyed by directory.
   *
   * **Scoped, and refused rather than truncated.** The directory list is the caller's list of starred
   * albums, and a directory silently missing from the map is a star the client marked and can no
   * longer see — so this raises `SubrequestBudgetExhaustedError` rather than answering with a subset.
   * That is the same rule `listIdsIn` and `listIdsAcrossLibraries` follow, and for the same reason:
   * the caller's id list *is* the answer.
   *
   * An empty list is an empty map and issues nothing at all.
   *
   * **The chunk is derived, not chosen.** One variable per library plus one per directory, so
   * `bindChunkSize(1)` alone — the number `songIdLookup.ts` uses — is wrong the moment a second
   * library is granted. That is the recorded `libraryReserve` defect, and this is the second read to
   * need it.
   */
  public async songsByAlbumDirs(scope: LibraryScope, dirPaths: readonly string[]): Promise<Map<string, SongRow[]>> {
    const byDir = new Map<string, SongRow[]>();
    const wanted = [...new Set(dirPaths)];
    if (wanted.length === 0) return byDir;
    const perStatement = bindChunkSize(1, libraryReserve(scope));
    this.requireSubrequests(Math.ceil(wanted.length / perStatement), 'songs.songsByAlbumDirs');
    const scopeSql = libraryScope(scope);
    for (const chunk of chunkArray(wanted, perStatement)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(
              `SELECT * FROM songs WHERE ${scopeSql.sql} AND dir_path IN (${placeholders}) ORDER BY disc ASC, track ASC, name_ci ASC`,
            )
            .bind(...scopeSql.values, ...chunk)
            .all<SongRow>(),
        'songs.songsByAlbumDirs',
      );
      for (const row of result.results ?? []) {
        const existing = byDir.get(row.dir_path);
        if (existing) existing.push(row);
        else byDir.set(row.dir_path, [row]);
      }
    }
    return byDir;
  }
}

export { SongAlbumDirDAO };
