/**
 * Songs: the queryable half of the index.
 *
 * `nodes` answers "what is in this folder"; `songs` answers "which track matches this text" and
 * "which albums does this artist have". Both are required: a recursive `PROPFIND` per request cannot
 * answer `search3` or `getAlbumList2`, and a D1 table cannot be walked cheaply per level for
 * `getMusicDirectory`.
 *
 * ### Writes are budgeted, and the unit is not a row
 *
 * D1's Free plan allows **100,000 row writes per day** and *enforces* it: an account over its
 * allowance has every query fail until midnight UTC, so the whole product is down rather than slow.
 *
 * The unit is a **billed row** — the table row plus every index entry the write rewrote — and
 * `songs` carries **nine** indexes, so one insert is ten rows of allowance. A cold scan of a
 * 1,000-folder / 5,000-track library therefore bills ~61,000 rows rather than ~6,100: it fits in one
 * day, where the same scan metered in table rows looked ten times cheaper than it was.
 *
 * Every write here reports its cost in billed rows. `billedRows.ts` owns the model, and
 * `test/schema.int.test.ts` asserts it against the real schema.
 */
import { BaseDAO } from './BaseDAO';
import type { WriteBatchResult } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import { UNMETERED_SUBREQUESTS } from '@edge-sonic/shared';
import type { SubrequestMeter } from '@edge-sonic/shared';
import type { SongRow } from './rows';
import { nowSeconds } from './identity';
import { SongIdLookupDAO } from './songIdLookup';
import { SongIdRotationDAO } from './songIdRotation';
import { SongCountDAO } from './songCounts';
import { libraryScope } from './libraryScope';
import type { LibraryScope } from './libraryScope';
import { UPSERT_FILE_FACTS, bindFileFacts } from './songSql';
import type { SongMetadataInput, SongUpsertInput } from './songSql';
import { buildMetadataPatch, NO_METADATA_WRITE } from './songMetadata';
import type { MetadataWriteResult } from './songMetadata';

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
   * The marker appended to a path-derived name, from the deployment's configuration.
   *
   * Injected because `backend-data` is layer 0 and the configuration layer sits above it,
   * and held as a field because it is the same for the whole request: deriving a page
   * against two markers would write a grouping split across both spellings, and half of
   * each would be invisible to whichever predicate the operator is relying on.
   *
   * An empty marker is a supported value and not a fallback — it is what makes a derived
   * `X` and a tagged `X` the same album. See `pathConvention.ts`.
   */
  constructor(
    database: D1Queryable,
    private readonly derivedMarker: string,
    subrequests: SubrequestMeter = UNMETERED_SUBREQUESTS,
  ) {
    super(database, subrequests);
  }

  /**
   * The count DAO, built from `this` so it holds the request scope's meter. Constructed per call
   * rather than cached: it is two tiny wrappers, and a cache would be state this DAO keeps correct.
   */
  private counts(): SongCountDAO {
    return new SongCountDAO(this.database, this.subrequests);
  }

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
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM songs WHERE id = ?').bind(id).first<SongRow>(),
      'songs.findById',
    );
  }

  /**
   * One song by its library-relative path. Delegates to {@link SongIdLookupDAO},
   * built from `this` so it inherits the request scope's meter.
   */
  public async findByPath(libraryId: string, path: string): Promise<SongRow | null> {
    return await new SongIdLookupDAO(this.database, this.subrequests).findByPath(libraryId, path);
  }

  /**
   * One song by whatever id a client is holding — short or legacy. Delegates
   * to {@link SongIdLookupDAO} for the same reason as `findByPath`.
   */
  public async findBySongId(id: string): Promise<SongRow | null> {
    return await new SongIdLookupDAO(this.database, this.subrequests).findBySongId(id);
  }

  /**
   * Rows still carrying a reversible long id. Delegates to
   * {@link SongIdRotationDAO}, the scan backfill's store.
   */
  public async listLegacySongIds(libraryId: string, limit: number): Promise<readonly Pick<SongRow, 'id' | 'library_id' | 'path'>[]> {
    return await new SongIdRotationDAO(this.database, this.subrequests).listLegacySongIds(libraryId, limit);
  }

  /**
   * Rotate one song's id and its playlist entries, atomically. Delegates to
   * {@link SongIdRotationDAO}.
   */
  public async rotateSongId(libraryId: string, path: string, oldId: string, newId: string): Promise<WriteBatchResult> {
    return await new SongIdRotationDAO(this.database, this.subrequests).rotateSongId(libraryId, path, oldId, newId);
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

  /**
   * Write song rows, as many as the subrequest budget allows.
   *
   * `WriteBatchResult` rather than a count: a cold album of 500 tracks is ~500 statements against a
   * ceiling of 50, so truncation is the *expected* case on Free, and the caller must see it or it
   * will mark a half-written folder reconciled.
   *
   * The bind order and the derivations are in `songSql.ts`, beside the statement they target.
   * The two are positional — a `?` in one is an argument in the other — so a reader who has to
   * hold both files open to check them is being asked to do what a module boundary is for, and
   * this one is over the soft god-file limit.
   */
  public async upsertFileFacts(inputs: readonly SongUpsertInput[]): Promise<WriteBatchResult> {
    if (inputs.length === 0) return { changes: 0, written: 0, truncated: false, billedRows: 0 };
    return await this.runWriteBatch(
      inputs.map((input) => bindFileFacts(this.prepare(UPSERT_FILE_FACTS), input, this.derivedMarker, nowSeconds())),
      'songs.upsertFileFacts',
    );
  }

  /**
   * Apply derived metadata and enrichment results.
   *
   * Split from `upsertFileFacts` because the two have different costs: a rescan
   * calls the first for every file it sees, while this is called at most once per
   * song a client actually opens.
   *
   * Returns what the write cost rather than nothing, because the scan meters it against the day's
   * row-write allowance. `void` here is what forced that meter to declare `1` at the call site, and
   * `songs` bills ten. See `MetadataWriteResult`.
   */
  public async applyMetadata(id: string, metadata: SongMetadataInput): Promise<MetadataWriteResult> {
    // The column list and the `_ci`-twin rule live in `songMetadata.ts`, beside the
    // shape they target. Building them here rather than inline is what keeps
    // `SongDAO` readable and the two in step.
    const { assignments, values } = buildMetadataPatch(metadata);
    // Nothing supplied: no statement. A `SET` with no assignments still costs a round
    // trip, and a caller that supplied nothing has nothing to record.
    if (assignments.length === 0) return NO_METADATA_WRITE;

    // `enriched_at` and `updated_at` in the same statement as the values, always. A row
    // whose values moved without them is a row nothing will re-read.
    const timestamp = nowSeconds();
    // `runWriteStatement` rather than `withRetry`, so the cost is **measured** rather than
    // declared by the caller — `songs` bills ten rows here, and reporting it as one is how a scan
    // enriched track by track spent ten times the allowance it believed it respected.
    const sql = `UPDATE songs SET ${[...assignments, 'enriched_at = ?', 'updated_at = ?'].join(', ')} WHERE id = ?`;
    return await this.runWriteStatement(this.prepare(sql).bind(...values, timestamp, timestamp, id), 'songs.applyMetadata');
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
    return await new SongIdLookupDAO(this.database, this.subrequests).listIdsIn(libraryId, ids);
  }

  /**
   * Songs by id across every library. See `SongIdLookupDAO.listIdsAcrossLibraries` for why
   * this is a separate method rather than a nullable `libraryId`.
   */
  public async listIdsAcrossLibraries(ids: readonly string[]): Promise<SongRow[]> {
    return await new SongIdLookupDAO(this.database, this.subrequests).listIdsAcrossLibraries(ids);
  }

  /**
   * Delegates to {@link SongCountDAO}, built from `this` so it inherits the request scope's meter —
   * a DAO that constructs another DAO must pass the counter down, or the inner one spends a budget
   * nothing is watching.
   */
  public async countByLibrary(libraryId: string): Promise<number> {
    return await this.counts().countByLibrary(libraryId);
  }

  /**
   * Delegates to {@link SongCountDAO}. A library with no tracks is absent from the map rather
   * than present with a zero — see that method for why the difference carries meaning.
   */
  public async countByLibraries(libraryIds: readonly string[]): Promise<Map<string, number>> {
    return await this.counts().countByLibraries(libraryIds);
  }

  /**
  Distinct albums, for `getArtists`/`getAlbumList2`.
  */
  public async listByGenre(scope: LibraryScope, genreCi: string, limit: number, offset: number): Promise<SongRow[]> {
    const libraries = libraryScope(scope);
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(`SELECT * FROM songs WHERE ${libraries.sql} AND genre_ci = ? ORDER BY name_ci ASC LIMIT ? OFFSET ?`)
          .bind(...libraries.values, genreCi, limit, offset)
          .all<SongRow>(),
      'songs.listByGenre',
    );
    return result.results ?? [];
  }

  public async listRandom(
    scope: LibraryScope,
    options: { genreCi?: string | null; fromYear?: number; toYear?: number; limit: number },
  ): Promise<SongRow[]> {
    const libraries = libraryScope(scope);
    const where: string[] = [libraries.sql];
    const values: unknown[] = [...libraries.values];
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
        await this.database
          .prepare(`SELECT * FROM songs WHERE ${where.join(' AND ')} ORDER BY RANDOM() LIMIT ?`)
          .bind(...values)
          .all<SongRow>(),
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
    scope: LibraryScope,
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

    // The scope's own variables come first so the bind order is the SQL's order — the library
    // predicate precedes the term, and a `LIKE` list that followed it would be bound to the
    // wrong placeholders.
    const libraries = libraryScope(scope);
    const values: unknown[] = [...libraries.values];
    if (field === 'any') values.push(like, like, like, like);
    else values.push(like);
    values.push(options.limit, options.offset);

    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(`SELECT * FROM songs WHERE ${libraries.sql} AND ${predicate} ORDER BY name_ci ASC LIMIT ? OFFSET ?`)
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
  public async deleteInDirectoryNotIn(libraryId: string, dirPath: string, keepPaths: readonly string[]): Promise<WriteBatchResult> {
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
    if (doomed.length === 0) return { changes: 0, written: 0, truncated: false, billedRows: 0 };
    const statements = doomed.map((path) => this.prepare('DELETE FROM songs WHERE library_id = ? AND path = ?').bind(libraryId, path));
    // Handed to the batch rather than counted here: a folder that lost 200 tracks is another
    // statement group that can exceed the ceiling on its own. A prune that stops halfway is
    // idempotent, so the rows it did not reach are simply still there for the next chunk — and
    // nothing downstream reads `truncated` for a delete, because a prune reporting "incomplete"
    // would read as a fault and it is not one.
    return await this.runWriteBatch(statements, 'songs.deleteInDirectoryNotIn');
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
  public async deleteSubtree(libraryId: string, dirPath: string): Promise<WriteBatchResult> {
    const escaped = `${dirPath.replaceAll(/[%_]/g, (char) => `\\${char}`)}/%`;
    const result = await this.runWriteStatement(
      this.prepare(String.raw`DELETE FROM songs WHERE library_id = ? AND (dir_path = ? OR dir_path LIKE ? ESCAPE '\')`).bind(
        libraryId,
        dirPath,
        escaped,
      ),
      'songs.deleteSubtree',
    );
    // One statement, so never truncated. `billedRows` is what makes this shape worth the change: a
    // prune of 200 tracks bills ten rows each, and the caller is the only thing that can charge it.
    return { changes: result.changes, written: result.changes, truncated: false, billedRows: result.billedRows };
  }
}

export { SongDAO };

export { type SongUpsertInput } from './songSql';
