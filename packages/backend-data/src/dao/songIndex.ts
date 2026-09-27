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
import type { SongRow } from './rows';

interface AlbumKeyRow {
  readonly artist_key: string | null;
  readonly album_key: string;
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
   * A row-value `IN` would read better, but the OR-chain keeps each pair an index seek on
   * `(library_id, album_artist_ci, album_ci)`, and the page size is bounded by the
   * request's own `size` parameter.
   */

  private async songsForAlbumKeys(libraryId: string, keys: readonly AlbumKeyRow[], context: string): Promise<SongRow[]> {
    const clause = keys.map(() => '(album_artist_ci IS ? AND album_ci IS ?)').join(' OR ');
    const values: unknown[] = [libraryId];
    for (const key of keys) values.push(key.artist_key, key.album_key);

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
    return result.results ?? [];
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

    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT * FROM songs WHERE library_id = ? AND artist_ci IN (${keys.map(() => '?').join(', ')})
              ORDER BY artist_ci ASC, album_ci ASC, disc ASC, track ASC, name_ci ASC`,
          )
          .bind(libraryId, ...keys)
          .all<SongRow>(),
      'songs.listArtists.rows',
    );
    return result.results ?? [];
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
