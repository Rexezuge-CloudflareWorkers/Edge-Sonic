/**
 * Similar-song reads: the local answer to the protocol's "songs from the given artist
 * and similar artists".
 *
 * ### Why this is not last.fm, and why it is here
 *
 * The Subsonic docs define both endpoints against last.fm. This server has no external
 * integration and no credential for one, so the question has to be answered from the index
 * it owns: an artist is similar to another artist when they share a genre in this library.
 * That is a narrower claim than the reference server's, and it is stated rather than
 * hidden — a client rendering an empty panel from a library with no genre tags is being
 * told something true.
 *
 * ### Two statements, both bounded by the bind ceiling
 *
 * The genre list and the ranked artist list are capped by {@link bindChunkSize}, with the
 * library scope reserved out. A seed with more genres than fit one statement is sampled
 * in sorted order rather than chunked: every chunk would spend a subrequest, and the
 * answer is a ranking, not a page of data the caller is entitled to read in full. The
 * caps are derived from D1's measured ceiling, never typed next to a query.
 *
 * Both statements carry the library scope in the `WHERE`, so a key that exists only in a
 * library the caller cannot see cannot contribute a similar artist or a song. The
 * authorization decision belongs to the endpoint's resolver; this layer only makes sure
 * the decision is not widened below it.
 *
 * `SongIndexDAO` extends this class rather than composing it, so every aggregate read
 * stays on the one DAO the request layer already carries — one construction, one meter,
 * no second token and no second binding to wire up.
 */
import { BaseDAO } from './BaseDAO';
import { bindChunkSize } from './sqlLimits';
import { libraryReserve, libraryScope } from './libraryScope';
import type { LibraryScope } from './libraryScope';
import type { SongRow } from './rows';

/**
 * The signals read off a seed's rows. Both are already lowercased — they come from the
 * `_ci` columns — so the predicates never lowercase a column in SQL.
 */
interface SimilarSeed {
  readonly scope: LibraryScope;
  readonly genreCi: readonly string[];
  readonly artistCi: readonly string[];
}

interface SimilarArtistRow {
  readonly name: string;
  readonly shared: number;
}

class SongSimilarDAO extends BaseDAO {
  /**
   * A bounded sample of one artist's rows, used as the seed when the id names an artist.
   *
   * The limit is derived here rather than passed in: the caller has no way to know D1's
   * bind ceiling, and a limit chosen at the call site is the same number that is wrong
   * by the time the ceiling moves.
   */
  public async listArtistSeedRows(scope: LibraryScope, artistCi: string): Promise<SongRow[]> {
    const libraries = libraryScope(scope);
    const limit = bindChunkSize(2, libraryReserve(scope) + 1);
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT * FROM songs WHERE ${libraries.sql} AND (artist_ci = ? OR album_artist_ci = ?)
              ORDER BY library_id ASC, path ASC LIMIT ?`,
          )
          .bind(...libraries.values, artistCi, artistCi, limit)
          .all<SongRow>(),
      'songs.listArtistSeedRows',
    );
    return result.results ?? [];
  }

  /**
   * Artists in scope that share a genre with the seed, most shared genres first.
   *
   * Seed artists are removed **after** the read, and the read asks for `limit + seeds`
   * rows. Removing them in SQL would bind one variable per seed artist and compete with
   * the genres for the same 100-parameter ceiling; doing it here costs one extra row per
   * seed and leaves the statement's budget entirely to the genres.
   */
  public async listSimilarArtists(seed: SimilarSeed, limit: number): Promise<SimilarArtistRow[]> {
    const libraries = libraryScope(seed.scope);
    const genres = seed.genreCi.slice(0, bindChunkSize(1, libraryReserve(seed.scope) + 1));
    if (genres.length === 0 || limit <= 0) return [];

    const exclude = new Set(seed.artistCi);
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT artist_ci AS name, COUNT(DISTINCT genre_ci) AS shared
              FROM songs
              WHERE ${libraries.sql} AND genre_ci IN (${genres.map(() => '?').join(', ')})
                AND artist_ci IS NOT NULL AND artist_ci <> ''
              GROUP BY artist_ci
              ORDER BY shared DESC, artist_ci ASC
              LIMIT ?`,
          )
          // Caller-sorted genres, so the sampled prefix is a function of the seed's rows
          // rather than of a Set's insertion order.
          .bind(...libraries.values, ...genres, limit + exclude.size)
          .all<SimilarArtistRow>(),
      'songs.listSimilarArtists',
    );

    return (result.results ?? [])
      .filter((row) => !exclude.has(row.name))
      .sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((row) => ({ name: row.name, shared: row.shared }));
  }

  /**
   * Songs by the seed's artists and the ranked similar artists, in that order.
   *
   * A `VALUES` CTE carries the ranking so the ORDER BY is the one the caller computed,
   * not an ordering inferred from the artist names. A song credited to two of the artists
   * is grouped on its primary key so it is published once, at its best rank.
   *
   * `s.id IS NOT ?` is SQLite's null-safe inequality: with no seed song the bound value
   * is `null` and every row passes, and with a seed song only that row is removed.
   */
  public async listSimilarSongs(
    seed: SimilarSeed,
    artists: readonly string[],
    excludeSongId: string | null,
    limit: number,
  ): Promise<SongRow[]> {
    // Two binds per artist (the key is bound, the rank is a literal we generated), plus
    // the scope, the exclusion and the LIMIT.
    const ranked = artists.filter((name) => name.length > 0).slice(0, bindChunkSize(2, libraryReserve(seed.scope) + 2));
    if (ranked.length === 0 || limit <= 0) return [];

    const values = ranked.map((_, index) => `(?, ${index})`).join(', ');
    const libraries = libraryScope(seed.scope, 's.library_id');
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `WITH ranked(artist_key, rank) AS (VALUES ${values})
              SELECT s.*, MIN(r.rank) AS similarity_rank
                FROM songs s
                JOIN ranked r ON (s.artist_ci = r.artist_key OR s.album_artist_ci = r.artist_key)
                WHERE ${libraries.sql} AND s.id IS NOT ?
                GROUP BY s.id
                ORDER BY similarity_rank ASC, s.library_id ASC, s.path ASC
                LIMIT ?`,
          )
          .bind(...ranked, ...libraries.values, excludeSongId, limit)
          .all<SongRow>(),
      'songs.listSimilarSongs',
    );
    return result.results ?? [];
  }
}

export { SongSimilarDAO };
export type { SimilarSeed, SimilarArtistRow };
