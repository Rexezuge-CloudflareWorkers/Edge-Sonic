/**
 * Index queries over `songs`: the reads that page over a **group** rather than over rows.
 *
 * ### Why these are not on `SongDAO`
 *
 * `SongDAO` owns one row - its facts, its derived metadata, its lifecycle. These read
 * across rows: a page of albums, one artist's albums, the library's genres. They are the
 * only queries in the system that have to aggregate, and the only ones shaped by the
 * protocol's paging rather than by the schema's keys. Keeping them here puts the
 * page-then-fetch pattern in one file, where it can be read once, instead of duplicated
 * across a class that has nothing else in common with it.
 */
import { BaseDAO } from './BaseDAO';
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import type { SongRow } from './rows';

interface AlbumKeyRow {
  readonly artist_key: string | null;
  readonly album_key: string;
}

/**
 * Album groups per statement: two variables each, plus the `library_id`.
 *
 * Derived, never chosen — see `sqlLimits.ts`. It is 49, and 49 is *measured* rather than
 * conservative: 49 groups bind 99 variables and answer, 50 bind 101 and fail. A round
 * number like 40 would work and would leave a third of the ceiling unused on the endpoint
 * a client calls to draw its whole library.
 */
const ALBUM_GROUPS_PER_STATEMENT = bindChunkSize(2);

/**
 * Artists per statement: one variable each, plus the `library_id`.
 */
const ARTISTS_PER_STATEMENT = bindChunkSize(1);

/**
 * Order the `SELECT *` fetches ask for, as a comparator.
 *
 * ### Why the order is re-established here rather than left to the statement
 *
 * Because a chunked fetch cannot inherit it. Each statement is internally sorted, but the
 * chunks are concatenated in the order the **key page** supplied, and that order is
 * `orderBy` — which is `RANDOM()` for `type=random` and `mtime_ms DESC` for `type=newest`,
 * neither of which is this tuple. So a single statement used to return globally sorted
 * rows and a chunked one would not, and the difference would depend on the library's size:
 * under 50 albums sorted, over 50 not. The same answer would be produced by two
 * different code paths depending on how much music the user owns.
 *
 * Sorting once at the end makes the result a function of `keys` alone, which is the
 * property worth having: it is what lets the chunk count be an implementation detail, and
 * it is what `test/schema.int.test.ts` asserts by running the same keys through one
 * statement and five.
 *
 * `NULL` sorts first, because that is SQLite's `ASC` and both `disc` and `track` are
 * nullable — an untagged track must keep landing in the same place it always did.
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
  public async listAlbums(
    libraryId: string,
    options: { albumArtistCi?: string | null; genreCi?: string | null; fromYear?: number; toYear?: number; limit: number; offset: number; orderBy: string },
  ): Promise<SongRow[]> {
    const where: string[] = ['library_id = ?', "album_ci IS NOT NULL AND album_ci <> ''"];
    const values: unknown[] = [libraryId];
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

    const page = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT album_artist_ci AS artist_key, album_ci AS album_key
               FROM songs WHERE ${where.join(' AND ')}
              GROUP BY album_artist_ci, album_ci
              ORDER BY ${options.orderBy}
              LIMIT ? OFFSET ?`,
          )
          .bind(...values)
          .all<AlbumKeyRow>(),
      'songs.listAlbums.page',
    );

    const keys = page.results ?? [];
    if (keys.length === 0) return [];
    return await this.songsForAlbumKeys(libraryId, keys, 'songs.listAlbums.rows');
  }

  /**
   * Every song belonging to a set of `(album_artist_ci, album_ci)` keys.
   *
   * A row-value `IN` would read better, and it would be no smaller: two variables per
   * group either way. The OR-chain is kept because each pair stays an index seek on
   * `(library_id, album_artist_ci, album_ci)`, which a `COALESCE`d single-column key could
   * not be without giving up the index the aggregates depend on.
   *
   * **Batched, on key boundaries.** The page is bounded by the request's `size`, which
   * `MAX_PAGE_SIZE` caps at 500 — and 500 groups bind 1,001 variables against a ceiling of
   * 100. The original comment here claimed the page size made batching unnecessary; it
   * made it necessary at twice the size the database accepts. Splitting on *keys* rather
   * than on rows is what keeps an album's songs in one statement, so no album is ever
   * split across two and counted twice.
   */
  private async songsForAlbumKeys(libraryId: string, keys: readonly AlbumKeyRow[], context: string): Promise<SongRow[]> {
    const rows: SongRow[] = [];
    for (const chunk of chunkArray(keys, ALBUM_GROUPS_PER_STATEMENT)) {
      const clause = chunk.map(() => '(album_artist_ci IS ? AND album_ci IS ?)').join(' OR ');
      const values: unknown[] = [libraryId];
      for (const key of chunk) values.push(key.artist_key, key.album_key);

      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(
              `SELECT * FROM songs WHERE library_id = ? AND (${clause})
                ORDER BY album_artist_ci ASC, album_ci ASC, disc ASC, track ASC, name_ci ASC`,
            )
            .bind(...values)
            .all<SongRow>(),
        context,
      );
      rows.push(...(result.results ?? []));
    }
    return rows.sort(compareSongRows);
  }

  public async listArtists(libraryId: string, limit: number, offset: number): Promise<SongRow[]> {
    const page = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT artist_ci AS artist_key FROM songs
              WHERE library_id = ? AND artist_ci IS NOT NULL AND artist_ci <> ''
              GROUP BY artist_ci ORDER BY artist_ci ASC LIMIT ? OFFSET ?`,
          )
          .bind(libraryId, limit, offset)
          .all<{ artist_key: string }>(),
      'songs.listArtists.page',
    );

    const keys = (page.results ?? []).map((row) => row.artist_key);
    if (keys.length === 0) return [];

    // Batched for the same reason as `songsForAlbumKeys`, and this one is worse: the
    // callers ask for 500 artists (`getArtists`), 5,000 (`getArtist`) and 500
    // (`getCoverArt`'s artist probe), so every one of them was a guaranteed masked 500 on
    // any library with 100 or more artists — the endpoint a player draws its front page
    // from. Unlike the album fetch no re-sort is needed: the keys are already ascending by
    // `artist_ci`, which is this query's leading `ORDER BY` term, so concatenating
    // ascending chunks is already globally ordered. Asserted anyway, because "already
    // ordered" is a fact about two orderings agreeing and not a property of the code.
    const rows: SongRow[] = [];
    for (const chunk of chunkArray(keys, ARTISTS_PER_STATEMENT)) {
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(
              `SELECT * FROM songs WHERE library_id = ? AND artist_ci IN (${chunk.map(() => '?').join(', ')})
                ORDER BY artist_ci ASC, album_ci ASC, disc ASC, track ASC, name_ci ASC`,
            )
            .bind(libraryId, ...chunk)
            .all<SongRow>(),
        'songs.listArtists.rows',
      );
      rows.push(...(result.results ?? []));
    }
    return rows.sort(compareSongRows);
  }

  /**
   * The songs of one page of albums.
   *
   * Two statements, and the reason matters. The obvious implementation is
   * `GROUP BY album_artist_ci, album_ci` in SQL, and it is wrong in a way that is invisible
   * in the row count: the group collapses each album to one **representative row**, so the
   * caller sees one track per album and every album in the product reports
   * `songCount: 1` and a duration equal to its first track. Clients draw an album's
   * length and track count from exactly those two fields, so the whole library looks wrong
   * and nothing errors.
   *
   * So the SQL only decides *which* albums are on this page and in what order, and the
   * fetch returns **every** song of those albums. The aggregation then happens once, in
   * `groupAlbums`, from the same rows the counts are derived from - which is the only way
   * the two cannot disagree.
   *
   * Paging is over albums, not songs, because that is what the protocol means by `size`:
   * a page of ten albums is ten albums, not however many tracks ten albums hold.
   *
   * The second query deliberately does **not** re-apply the year or genre filter. Those
   * filters choose which albums appear; an album selected because one of its tracks is
   * from 2007 is still the whole album, and a partial track count for it would be the
   * same bug in a narrower window.
   */

  public async listGenres(libraryId: string): Promise<GenreCountRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT genre AS value, genre_ci AS value_ci, COUNT(*) AS song_count,
                    COUNT(DISTINCT COALESCE(album_artist_ci || char(31) || album_ci, '')) AS album_count
               FROM songs
              WHERE library_id = ? AND genre_ci IS NOT NULL AND genre_ci <> ''
              GROUP BY genre_ci
              ORDER BY genre_ci ASC`,
          )
          .bind(libraryId)
          .all<GenreCountRow>(),
      'songs.listGenres',
    );
    return result.results ?? [];
  }

  /**
   * The songs of one page of artists.
   *
   * Two statements for the same reason as `listAlbums`: a SQL `GROUP BY artist_ci`
   * returns one row per artist, so `getArtist`'s `albumCount` and every album's
   * `songCount` would each be 1 for a real discography. The page is chosen in SQL; the
   * rows are complete.
   */
}

export { SongIndexDAO };
export type { GenreCountRow };
