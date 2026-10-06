/**
 * Index queries over `songs`: the reads that page over a **group** rather than over rows.
 *
 * ### Why these are not on `SongDAO`
 *
 * `SongDAO` owns one row - its facts, its derived metadata, its lifecycle. These read
 * across rows: a page of albums, one artist's albums, the library's genres. They are the
 * only queries in the system that have to aggregate, and the only ones shaped by
 * the protocol's paging rather than by the schema's keys. Keeping them here puts the
 * page-then-fetch pattern in one file, where it can be read once, instead of duplicated
 * across a class that has nothing else in common with it.
 *
 * ### What an album is, and where that question is answered
 *
 * Not here. `ALBUM_GROUP_BY` decides it, `subsonic/albumKey.ts` owns the decision, this file's
 * neighbour `albumKeySql.ts` writes it as SQL, and `apps/api`'s `albumIdentity` carries it per
 * request. What this file does is make the SQL grouping and the TypeScript grouping **the same
 * function of the same columns**, which is the property every bug below was a violation of.
 */
import { BaseDAO } from './BaseDAO';
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import { albumKeySpec, specFromKey } from '@edge-sonic/subsonic';
import type { AlbumGroupingValue } from '@edge-sonic/subsonic';
import { albumGroupsPerStatement, albumKeyProjection } from './albumKeySql';
import { libraryIds, libraryReserve, libraryScope } from './libraryScope';
import type { LibraryScope } from './libraryScope';
import type { AlbumKeyRowOut } from './albumKeySql';
import type { SongRow } from './rows';

/**
 * Artists per statement: one variable each, plus the `library_id`.
 */
const ARTISTS_PER_STATEMENT = bindChunkSize(1);

/**
 * The order `listArtists`' row fetch asks for, as a comparator.
 *
 * ### Why the order is re-established here rather than left to the statement
 *
 * Because a chunked fetch cannot inherit it. Each statement is internally sorted, but the
 * chunks are concatenated, so the result is a function of the key list's order and not of
 * the database's. The keys happen to arrive ascending by `artist_ci`, which is this
 * query's leading `ORDER BY` term, so concatenating ascending chunks is already globally
 * ordered — and that is asserted in `test/schema.int.test.ts` rather than assumed, because
 * "already ordered" is a fact about two orderings agreeing and not a property of the code.
 *
 * Sorting once at the end makes the result a function of `keys` alone, which is the
 * property worth having: it is what lets the chunk count be an implementation detail.
 *
 * `NULL` sorts first, because that is SQLite's `ASC` and both `disc` and `track` are
 * nullable — an untagged track must keep landing in the same place it always did.
 *
 * ### And why the album fetch does not use this
 *
 * It used to, and it was the reason `getAlbumList2?type=alphabeticalByName` was not
 * alphabetical: this tuple leads with `album_artist_ci`, so re-sorting by it substitutes
 * *alphabetical by artist* for whatever the caller asked for. The album fetch rebuilds the
 * caller's order from its key list instead — see `songsForAlbumKeys`.
 */
function compareSongRows(a: SongRow, b: SongRow): number {
  const columns: readonly (keyof SongRow)[] = ['album_artist_ci', 'album_ci', 'disc', 'track', 'name_ci'];
  for (const column of columns) {
    const left = a[column];
    const right = b[column];
    if (left === right) continue;
    if (left === null || left === undefined) return -1;
    if (right === null || right === undefined) return 1;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

/**
One row of `listGenres`: the display value plus the counts the protocol reports.
*/
interface GenreCountRow {
  readonly value: string;
  readonly value_ci: string;
  readonly song_count: number;
  readonly album_count: number;
}

class SongIndexDAO extends BaseDAO {
  /**
   * A page of albums, as every row of every album on that page.
   *
   * ### One grouping, or two answers to the same question
   *
   * This grouped in SQL on `(album_artist_ci, album_ci)` while the caller regrouped by `dir_path`.
   * Two different definitions of "which tracks are this album", and every symptom followed from the
   * disagreement rather than from either being wrong alone:
   *
   * - **The page held the wrong number of albums.** `LIMIT 5` bounded five SQL groups; the
   *   caller's grouping then merged them, so a page could carry four albums, or one.
   * - **An album appeared on two pages.** A directory whose tracks carry two different
   *   `album_artist` values is one album to the caller and two groups to the query, so paging by
   *   group split it — and a page could carry the same album twice.
   * - **`alphabeticalByName` was not alphabetical.** The query ordered by `album_ci`, the row fetch
   *   re-sorted by `album_artist_ci` first, and the caller's grouping re-sorted by directory path.
   *   Three orderings, none of them the one that was asked for.
   *
   * It was unified on `dir_path`, which made the two agree and left the *choice* unmade: a library
   * whose folders split a release got one album per folder, which is a correct answer to a question
   * nobody asked. The grouping is now the configured one, and the SQL group and the TypeScript
   * group are both derived from the same key function — so agreeing is structural rather than a
   * coincidence to be re-tested per grouping.
   *
   * The tags choose the *order* — as aggregates over the group, so one album sorts by one value
   * rather than by whichever of its tracks happened to lead — but not the *membership*.
   *
   * @param orderBy Aggregate expressions over the group, most significant first. A list rather than
   *   one clause because `alphabeticalByArtist` is a two-term order and SQLite cannot alias a
   *   multi-term `ORDER BY` as one expression. `albumKeySql` appends the key columns as a final
   *   tiebreak, because a page boundary needs a total order.
   */
  public async listAlbums(
    scope: LibraryScope,
    options: {
      grouping: AlbumGroupingValue;
      albumArtistCi?: string | null;
      genreCi?: string | null;
      fromYear?: number;
      toYear?: number;
      limit: number;
      offset: number;
      orderBy: readonly string[];
    },
  ): Promise<SongRow[]> {
    const libraries = libraryScope(scope);
    const where: string[] = [libraries.sql, "album_ci IS NOT NULL AND album_ci <> ''"];
    const values: unknown[] = [...libraries.values];
    if (options.albumArtistCi) {
      where.push('album_artist_ci = ?');
      values.push(options.albumArtistCi);
    }
    if (options.genreCi) {
      where.push('genre_ci = ?');
      values.push(options.genreCi);
    }
    if (options.fromYear !== undefined) {
      where.push('year >= ?');
      values.push(options.fromYear);
    }
    if (options.toYear !== undefined) {
      where.push('year <= ?');
      values.push(options.toYear);
    }
    values.push(options.limit, options.offset);

    const projection = albumKeyProjection(options.grouping);
    const ordering = [...options.orderBy, ...projection.orderTiebreak].join(', ');
    const page = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT ${projection.select} FROM songs WHERE ${where.join(' AND ')}
              GROUP BY ${projection.groupBy}
              ORDER BY ${ordering}
              LIMIT ? OFFSET ?`,
          )
          .bind(...values)
          .all<AlbumKeyRowOut>(),
      'songs.listAlbums.page',
    );

    const keys = (page.results ?? []).map((row) => projection.keyOf(row));
    if (keys.length === 0) return [];
    return await this.songsForAlbumKeys(scope, keys, options.grouping, 'songs.listAlbums.rows');
  }

  /**
   * Every song belonging to a set of album keys, **in the order those keys were given**.
   *
   * Public because three callers start from a set of keys rather than from a page: `getAlbum` and
   * the starred paths from an id, `getArtist` and `search3` from the keys of rows they already hold.
   * All four need **whole** groups, which is why this returns rows rather than albums — the counts
   * and the album-level fields come from the same rows.
   */
  public async listForAlbumKeys(scope: LibraryScope, keys: readonly string[], grouping: AlbumGroupingValue): Promise<SongRow[]> {
    if (keys.length === 0) return [];
    return await this.songsForAlbumKeys(scope, keys, grouping, 'songs.listForAlbumKeys');
  }

  /**
   * ### Why the order is rebuilt here rather than left to the statement
   *
   * Because a chunked fetch cannot inherit it. Each statement is internally sorted, but the chunks
   * are concatenated, so the result is a function of the *key list's* order and not of the
   * database's. It used to be re-sorted by `(album_artist_ci, album_ci, disc, track, name_ci)` —
   * right for making an album's tracks contiguous and ordered, and wrong for the list itself, because
   * it discards the ordering the caller asked for and substitutes one that happens to be
   * alphabetical *by artist*.
   *
   * So the order is rebuilt from the key list: each chunk is grouped, and the groups are emitted in
   * the order the keys arrived. That makes the result a function of `keys` alone, which is what lets
   * the chunk count stay an implementation detail — and it is the same trick `listIdsIn` uses for an
   * ordered id list, for the same reason.
   *
   * Within a group the tracks keep the protocol's order: disc, then track, then name. This
   * `ORDER BY` only has to make each album's rows contiguous and roughly ordered before the caller
   * re-sorts them with `compareAlbumTracks`, which is the order a client reads; the two are asserted
   * to agree on a fixture whose names differ only by case, which is what `name_ci` versus `name`
   * separates.
   *
   * @param keys Album keys in the caller's chosen order.
   */
  private async songsForAlbumKeys(
    scope: LibraryScope,
    keys: readonly string[],
    grouping: AlbumGroupingValue,
    context: string,
  ): Promise<SongRow[]> {
    // Refuse rather than stop early. The key page above already fixed *which* albums this request
    // is about, so returning a subset would be a page that silently omits albums the caller asked for
    // and the client will render as "that is all there is". The size is bounded upstream by
    // `MAX_PAGE_SIZE_CEILING`, so this is the backstop for a caller that bypassed it — and it is
    // checked before the first statement, so a refusal costs nothing.
    //
    // The reservation is the library count rather than a single `library_id`, so a scope of ten
    // libraries cannot quietly push the statement one variable over D1's ceiling — the batch size
    // is derived, so the derivation has to know what else the statement binds.
    const perStatement = albumGroupsPerStatement(grouping) - libraryReserve(scope);
    this.requireSubrequests(Math.ceil(keys.length / perStatement), context);

    const libraries = libraryScope(scope);
    const rows: SongRow[] = [];
    for (const chunk of chunkArray(keys, perStatement)) {
      // One predicate per key, and the predicate comes **from the key** — never reconstructed from a
      // column list at the call site. Under `album_artist` it has to be a NULL-safe pair, and the two
      // ways to write it are not equivalent: `album_artist_ci = ?` cannot match the NULL group at
      // all, while `COALESCE(album_artist_ci, '') = ?` matches the right rows and silently stops
      // using `idx_songs_album`. Identical results, one page instead of a scan, nothing to see.
      const specs = chunk.map((key) => specFromKey(key));
      const clause = specs.map((spec) => `(${spec.predicate})`).join(' OR ');
      const values: unknown[] = [...libraries.values];
      for (const spec of specs) values.push(...spec.values);

      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(
              `SELECT * FROM songs WHERE ${libraries.sql} AND (${clause})
                ORDER BY disc ASC, track ASC, name_ci ASC`,
            )
            .bind(...values)
            .all<SongRow>(),
        context,
      );
      rows.push(...(result.results ?? []));
    }

    // Bucket by key, then emit the buckets in the key list's order.
    const byKey = new Map<string, SongRow[]>();
    for (const row of rows) {
      const key = albumKeySpec(row, grouping).string;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(row);
      else byKey.set(key, [row]);
    }
    const ordered: SongRow[] = [];
    for (const key of keys) {
      const bucket = byKey.get(key);
      if (bucket) ordered.push(...bucket);
    }
    return ordered;
  }

  public async listArtists(scope: LibraryScope, requestedLimit: number, offset: number): Promise<SongRow[]> {
    // Clamped, and this is the one read whose size the caller *does* choose, so it is the one
    // place a page can be made to fit rather than refused. The callers ask for 500
    // (`getArtists`), 5,000 (`getArtist`) and 500 (`getCoverArt`'s artist probe); against a
    // ceiling of 50 subrequests, 5,000 artists is 51 statements before a single row is read,
    // so the honest clamp is "as many artists as the remaining budget can fetch rows for".
    //
    // It clamps the **artist count**, not the statement count, so the answer is still one page
    // of whole artists rather than a page of half-fetched ones.
    //
    // Both statements reserve the library count, so a union of ten libraries spends ten of the
    // hundred variables on its own scope and the derived batch is nine keys smaller. That is
    // arithmetic rather than a policy: the batch sizes below are `bindChunkSize` with the
    // reservation already subtracted, so a statement cannot bind one variable past D1's ceiling.
    const perStatement = ARTISTS_PER_STATEMENT - libraryReserve(scope, true);
    const libraries = libraryScope(scope);
    const limit = this.clampToSubrequestBudget(requestedLimit, perStatement);
    const page = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT artist_ci AS artist_key FROM songs
              WHERE ${libraries.sql} AND artist_ci IS NOT NULL AND artist_ci <> ''
              GROUP BY artist_ci ORDER BY artist_ci ASC LIMIT ? OFFSET ?`,
          )
          .bind(...libraries.values, limit, offset)
          .all<{ artist_key: string }>(),
      'songs.listArtists.page',
    );

    const keys = (page.results ?? []).map((row) => row.artist_key);
    if (keys.length === 0) return [];

    // Batched for the same reason as `songsForAlbumKeys`, and this one was worse: the
    // callers ask for 500 artists (`getArtists`), 5,000 (`getArtist`) and 500
    // (`getCoverArt`'s artist probe), so every one of them was a guaranteed masked 500 on
    // any library with 100 or more artists — the endpoint a player draws its front page
    // from.
    const rows: SongRow[] = [];
    for (const chunk of chunkArray(keys, perStatement)) {
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(
              `SELECT * FROM songs WHERE ${libraries.sql} AND artist_ci IN (${chunk.map(() => '?').join(', ')})
                ORDER BY artist_ci ASC, album_ci ASC, disc ASC, track ASC, name_ci ASC`,
            )
            .bind(...libraries.values, ...chunk)
            .all<SongRow>(),
        'songs.listArtists.rows',
      );
      rows.push(...(result.results ?? []));
    }
    return rows.sort(compareSongRows);
  }

  /**
   * `getGenres` — the library's genres, with song and album counts.
   *
   * Two statements and the reason matters. The obvious implementation is `GROUP BY genre_ci` in SQL,
   * and it is wrong in a way that is invisible in the row count: the group collapses each genre to
   * one **representative row**, so the caller sees one track per genre and every genre reports
   * `songCount: 1` and an album count of 1. Clients draw a genre's length and track count from
   * exactly those two fields, so the whole library looks wrong and nothing errors.
   *
   * So the counts are aggregates here, in the same statement as the names, and cannot drift from
   * the rows they summarize. The distinct-album count is over the album key — which under a tag
   * grouping is a pair of columns, so it is `DISTINCT` over their concatenation rather than over
   * `album_ci` alone: counting by name alone would report one album for two self-titled records.
   */
  public async listGenres(scope: LibraryScope): Promise<GenreCountRow[]> {
    const libraries = libraryScope(scope);
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT genre AS value, genre_ci AS value_ci, COUNT(*) AS song_count,
                    COUNT(DISTINCT COALESCE(album_artist_ci || char(31) || album_ci, '')) AS album_count
               FROM songs
              WHERE ${libraries.sql} AND genre_ci IS NOT NULL AND genre_ci <> ''
              GROUP BY genre_ci
              ORDER BY genre_ci ASC`,
          )
          .bind(...libraries.values)
          .all<GenreCountRow>(),
      'songs.listGenres',
    );
    return result.results ?? [];
  }
}

export { SongIndexDAO };
export type { GenreCountRow };