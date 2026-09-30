/**
 * Songs: the queryable half of the index.
 *
 * `nodes` answers "what is in this folder"; `songs` answers "which track matches
 * this text" and "which albums does this artist have". Both are required: a
 * recursive `PROPFIND` per request cannot answer `search3` or `getAlbumList2`, and
 * a D1 table cannot be walked cheaply per level for `getMusicDirectory`.
 *
 * ### Writes are budgeted
 *
 * The D1 free plan allows 5,000 row writes per day. A cold scan of a 1,000-folder
 * / 5,000-track library writes ~6,100 rows, so it *exceeds* the daily allowance
 * once. That is acceptable rather than a blocker because the scan is chunked and
 * resumable from a D1 cursor — the overshoot degrades to "the scan takes a couple
 * of days", not "the scan fails" — and because every subsequent scan writes zero
 * rows. The arithmetic is in `migrations/0001` so nobody is surprised by it.
 */
import { BaseDAO } from './BaseDAO';
import type { CountRow, SongRow } from './rows';
import { nowSeconds } from './identity';
import { SongIdLookupDAO } from './songIdLookup';
import { UPSERT_FILE_FACTS } from './songSql';
import type { SongMetadataInput } from './songSql';
import { deriveFromPath } from './pathConvention';
import { buildMetadataPatch } from './songMetadata';

interface SongUpsertInput {
  id: string;
  libraryId: string;
  path: string;
  dirPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  contentType: string | null;
  suffix: string;
  /**
   * The path-derived `album` / `artist` for this row, or `null` where the path says
   * nothing.
   *
   * Passed in rather than derived here because the indexer is what knows `dirPath`, and
   * a DAO that re-derived it would own a second copy of the convention. Nulls are
   * bound as SQL NULL so `COALESCE` leaves the column alone — see `songSql.ts` for why
   * filling a gap is safe and overwriting a tag is not.
   */
  derivedAlbum?: string | null;
  derivedArtist?: string | null;
}

/**
 * Insert or refresh a song's *file* facts, leaving derived metadata alone.
 *
 * The tag-derived columns (`title`, `duration`, `bitrate`, …) are deliberately absent
 * from the `SET` list. A rescan that found the file unchanged must not blank out
 * metadata an enrichment pass already filled in — that is the difference between a
 * rescan costing zero writes and it destroying the index.
 *
 * The path-derived `album`/`artist` are the one exception, and they are `COALESCE`d
 * rather than assigned: they fill a NULL and never replace a value. Without them the
 * aggregates are empty for every row the scan has not range-read, which is most of a
 * library for a long time. See `pathConvention.ts`.
 */

class SongDAO extends BaseDAO {
  /**
   * The library's genres, with real counts.
   *
   * An aggregate rather than a representative row, for the same reason as `listAlbums`: a
   * `GROUP BY genre_ci` row is one track, so a caller counting rows reports 1 song and 0
   * albums for every genre. `COUNT(*)` and `COUNT(DISTINCT ...)` are the counts
   * themselves, so they cannot drift from the rows they summarize.
   *
   * Returned rather than computed in the endpoint because the distinct-album count has to
   * be `DISTINCT` over the album key, which is a job for the database.
   */
  public async findById(id: string): Promise<SongRow | null> {
    return await this.withRetry(async () => await this.database.prepare('SELECT * FROM songs WHERE id = ?').bind(id).first<SongRow>(), 'songs.findById');
  }

  public async listByDirectory(libraryId: string, dirPath: string): Promise<SongRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM songs WHERE library_id = ? AND dir_path = ? ORDER BY disc ASC, track ASC, name_ci ASC')
          .bind(libraryId, dirPath)
          .all<SongRow>(),
      'songs.listByDirectory',
    );
    return result.results ?? [];
  }

  /**
  Every song whose containing folder is exactly `dirPath` — how an album resolves.
  */
  public async listByAlbumDir(libraryId: string, dirPath: string): Promise<SongRow[]> {
    return await this.listByDirectory(libraryId, dirPath);
  }

  public async upsertFileFacts(inputs: readonly SongUpsertInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const timestamp = nowSeconds();
    // Derived once per input rather than per bound parameter, and only when the caller
    // did not supply it — so a caller that already knows the answer (the indexer does)
    // and a caller that does not (a test, a future writer) cannot disagree about it.
    const statements = inputs.map((input) => {
      const derived = deriveFromPath(input.dirPath);
      const album = input.derivedAlbum ?? derived.album;
      const artist = input.derivedArtist ?? derived.artist;
      return this.database
        .prepare(UPSERT_FILE_FACTS)
        .bind(
          input.id,
          input.libraryId,
          input.path,
          input.dirPath,
          input.name,
          input.name.toLowerCase(),
          input.size,
          input.mtimeMs,
          input.contentType,
          input.suffix,
          // Derived names, each with its `_ci` twin, because a `_ci` column that
          // drifts from its counterpart is an ungroupable row and the drift is
          // invisible until somebody browses by artist.
          artist,
          artist?.toLowerCase() ?? null,
          album,
          album?.toLowerCase() ?? null,
          // `album_artist` mirrors the derived artist: `getArtist` groups on it, and an
          // album with a NULL album artist does not appear under the artist a client
          // navigated to. The same value, so a compilation's tracks group consistently.
          artist,
          artist?.toLowerCase() ?? null,
          timestamp,
          timestamp,
        );
    });
    return await this.runWriteBatch(statements, 'songs.upsertFileFacts');
  }

  /**
   * Apply derived metadata and enrichment results.
   *
   * Split from `upsertFileFacts` because the two have different costs: a rescan
   * calls the first for every file it sees, while this is called at most once per
   * song a client actually opens.
   */
  public async applyMetadata(id: string, metadata: SongMetadataInput): Promise<void> {
    // The column list and the `_ci`-twin rule live in `songMetadata.ts`, beside the
    // shape they target. Building them here rather than inline is what keeps
    // `SongDAO` readable and the two in step.
    const { assignments, values } = buildMetadataPatch(metadata);
    // Nothing supplied: no statement. A `SET` with no assignments still costs a round
    // trip, and a caller that supplied nothing has nothing to record.
    if (assignments.length === 0) return;

    // `enriched_at` and `updated_at` in the same statement as the values, always. A row
    // whose values moved without them is a row nothing will re-read.
    const timestamp = nowSeconds();
    await this.withRetry(
      async () =>
        await this.database
          .prepare(`UPDATE songs SET ${[...assignments, 'enriched_at = ?', 'updated_at = ?'].join(', ')} WHERE id = ?`)
          .bind(...values, timestamp, timestamp, id)
          .run(),
      'songs.applyMetadata',
    );
  }

  /**
  Song ids under a directory. Used to expand a starred album.
  */
  /**
   * Moved to `songIdLookup.ts`.
   *
   * Not a refactor for its own sake: batching this query to D1's 100-parameter ceiling took
   * it from 18 lines to 30 and pushed the file over the god-file limit, and the batching is
   * the part that needs its reasoning read in one place — it is the query that shipped with
   * a guard whose stated budget was ten times the real one.
   */
  public async listIdsIn(libraryId: string, ids: readonly string[]): Promise<SongRow[]> {
    return await new SongIdLookupDAO(this.database).listIdsIn(libraryId, ids);
  }

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
  Distinct albums, for `getArtists`/`getAlbumList2`.
  */
  public async listByGenre(libraryId: string, genreCi: string, limit: number, offset: number): Promise<SongRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM songs WHERE library_id = ? AND genre_ci = ? ORDER BY name_ci ASC LIMIT ? OFFSET ?')
          .bind(libraryId, genreCi, limit, offset)
          .all<SongRow>(),
      'songs.listByGenre',
    );
    return result.results ?? [];
  }

  public async listRandom(
    libraryId: string,
    options: { genreCi?: string | null; fromYear?: number; toYear?: number; limit: number },
  ): Promise<SongRow[]> {
    const where: string[] = ['library_id = ?'];
    const values: unknown[] = [libraryId];
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
    values.push(options.limit);

    const result = await this.withRetry(
      async () =>
        await this.database.prepare(`SELECT * FROM songs WHERE ${where.join(' AND ')} ORDER BY RANDOM() LIMIT ?`).bind(...values).all<SongRow>(),
      'songs.listRandom',
    );
    return result.results ?? [];
  }

  /**
   * Free-text search over title, artist, album, and genre.
   *
   * The term is lowercased **here** and matched against the `_ci` columns. That
   * is the predicate rule again, and it is what keeps this a `SEARCH ... USING
   * INDEX` on the leading `library_id` rather than a table scan.
   *
   * A leading `%` cannot use an index for the term itself, so the term part of
   * this is a scan of the library's rows. Documented in the migration rather than
   * hidden, with FTS5 named as the fix.
   */
  public async search(
    libraryId: string,
    term: string,
    options: { limit: number; offset: number; field?: 'any' | 'title' | 'artist' | 'album' },
  ): Promise<SongRow[]> {
    const like = `%${term.toLowerCase().replaceAll(/[%_\\]/g, (char) => `\\${char}`)}%`;
    const field = options.field ?? 'any';
    const predicate =
      field === 'title'
        ? String.raw`title_ci LIKE ? ESCAPE '\'`
        : field === 'artist'
          ? String.raw`artist_ci LIKE ? ESCAPE '\'`
          : field === 'album'
            ? String.raw`album_ci LIKE ? ESCAPE '\'`
            : String.raw`(title_ci LIKE ? ESCAPE '\' OR artist_ci LIKE ? ESCAPE '\' OR album_ci LIKE ? ESCAPE '\' OR genre_ci LIKE ? ESCAPE '\')`;

    const values: unknown[] = field === 'any' ? [libraryId, like, like, like, like, options.limit, options.offset] : [libraryId, like, options.limit, options.offset];

    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(`SELECT * FROM songs WHERE library_id = ? AND ${predicate} ORDER BY name_ci ASC LIMIT ? OFFSET ?`)
          .bind(...values)
          .all<SongRow>(),
      'songs.search',
    );
    return result.results ?? [];
  }

  /**
  Songs whose derived metadata is still missing, for tag enrichment.
  */
  /**
   * Delete songs under `dirPath` whose paths are not in `keepPaths`.
   *
   * Scoped to one directory on purpose. A prune proportional to library size
   * would spend the daily D1 delete allowance on a library that mostly still
   * exists; a prune proportional to what changed is nearly free.
   */
  public async deleteInDirectoryNotIn(libraryId: string, dirPath: string, keepPaths: readonly string[]): Promise<number> {
    const all = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT path FROM songs WHERE library_id = ? AND dir_path = ?')
          .bind(libraryId, dirPath)
          .all<{ path: string }>(),
      'songs.deleteInDirectoryNotIn.list',
    );
    const keep = new Set(keepPaths);
    const doomed = (all.results ?? []).map((row) => row.path).filter((path) => !keep.has(path));
    if (doomed.length === 0) return 0;
    const statements = doomed.map((path) => this.database.prepare('DELETE FROM songs WHERE library_id = ? AND path = ?').bind(libraryId, path));
    await this.runWriteBatch(statements, 'songs.deleteInDirectoryNotIn');
    return doomed.length;
  }

  /**
   * Delete every song in a folder and everything beneath it.
   *
   * A one-level prune is not enough. A folder that disappears takes its whole subtree
   * with it, and its songs carry `dir_path` values *deeper* than the folder, so a
   * `dir_path = ?` delete leaves them indexed — and an orphaned song row is exactly
   * what this pruning exists to prevent: it goes on appearing in `search3` and every
   * album list, pointing at a file that no longer exists.
   *
   * The `LIKE` is escaped so a folder literally named `100%` does not match
   * everything, and the prefix carries a trailing `/` so `Blur` cannot match
   * `Blurberry`.
   */
  public async deleteSubtree(libraryId: string, dirPath: string): Promise<number> {
    const escaped = `${dirPath.replaceAll(/[%_]/g, (char) => `\\${char}`)}/%`;
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(String.raw`DELETE FROM songs WHERE library_id = ? AND (dir_path = ? OR dir_path LIKE ? ESCAPE '\')`)
          .bind(libraryId, dirPath, escaped)
          .run(),
      'songs.deleteSubtree',
    );
    return result.meta?.changes ?? 0;
  }

}



export { SongDAO };
export type { SongUpsertInput };
