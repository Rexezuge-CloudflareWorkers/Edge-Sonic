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
}

/**
 * Insert or refresh a song's *file* facts, leaving derived metadata alone.
 *
 * The derived columns (`title`, `album`, `duration`, …) are deliberately absent
 * from the `SET` list. A rescan that found the file unchanged must not blank out
 * metadata an enrichment pass already filled in — that is the difference between
 * a rescan costing zero writes and it destroying the index.
 */
const UPSERT_FILE_FACTS = `INSERT INTO songs
  (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix, duration, bitrate, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
ON CONFLICT (library_id, path) DO UPDATE SET
  id = excluded.id,
  name = excluded.name,
  name_ci = excluded.name_ci,
  size = excluded.size,
  mtime_ms = excluded.mtime_ms,
  content_type = excluded.content_type,
  suffix = excluded.suffix,
  updated_at = excluded.updated_at`;

interface SongQuery {
  libraryId: string;
  limit: number;
  offset?: number;
}

class SongDAO extends BaseDAO {
  public async findById(id: string): Promise<SongRow | null> {
    return await this.withRetry(async () => await this.database.prepare('SELECT * FROM songs WHERE id = ?').bind(id).first<SongRow>(), 'songs.findById');
  }

  public async findByPath(libraryId: string, path: string): Promise<SongRow | null> {
    return await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM songs WHERE library_id = ? AND path = ?')
          .bind(libraryId, path)
          .first<SongRow>(),
      'songs.findByPath',
    );
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

  /** Every song whose containing folder is exactly `dirPath` — how an album resolves. */
  public async listByAlbumDir(libraryId: string, dirPath: string): Promise<SongRow[]> {
    return await this.listByDirectory(libraryId, dirPath);
  }

  public async upsertFileFacts(inputs: readonly SongUpsertInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const timestamp = nowSeconds();
    const statements = inputs.map((input) =>
      this.database
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
          timestamp,
          timestamp,
        ),
    );
    return await this.runWriteBatch(statements, 'songs.upsertFileFacts');
  }

  /**
   * Apply derived metadata and enrichment results.
   *
   * Split from `upsertFileFacts` because the two have different costs: a rescan
   * calls the first for every file it sees, while this is called at most once per
   * song a client actually opens.
   */
  public async applyMetadata(
    id: string,
    metadata: {
      title?: string | null;
      artist?: string | null;
      album?: string | null;
      albumArtist?: string | null;
      track?: number | null;
      disc?: number | null;
      year?: number | null;
      genre?: string | null;
      duration?: number | null;
      bitrate?: number | null;
      sampleRate?: number | null;
      channels?: number | null;
    },
  ): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: string | number | null | undefined): void => {
      if (value === undefined) return;
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    // Every text column has a `_ci` twin, and they are written together here
    // rather than at each call site. A `_ci` column that drifts from its
    // counterpart is an unsearchable row, and the drift is invisible until
    // somebody searches for the track.
    const pushText = (column: string, value: string | null | undefined): void => {
      if (value === undefined) return;
      assignments.push(`${column} = ?`, `${column}_ci = ?`);
      values.push(value, value === null ? null : value.toLowerCase());
    };

    pushText('title', metadata.title);
    pushText('artist', metadata.artist);
    pushText('album', metadata.album);
    pushText('album_artist', metadata.albumArtist);
    pushText('genre', metadata.genre);
    push('track', metadata.track);
    push('disc', metadata.disc);
    push('year', metadata.year);
    push('duration', metadata.duration);
    push('bitrate', metadata.bitrate);
    push('sample_rate', metadata.sampleRate);
    push('channels', metadata.channels);
    if (assignments.length === 0) return;

    assignments.push('enriched_at = ?', 'updated_at = ?');
    const timestamp = nowSeconds();
    values.push(timestamp, timestamp, id);

    await this.withRetry(
      async () => await this.database.prepare(`UPDATE songs SET ${assignments.join(', ')} WHERE id = ?`).bind(...values).run(),
      'songs.applyMetadata',
    );
  }

  /** Song ids under a directory. Used to expand a starred album. */
  public async listIdsByAlbumDir(libraryId: string, dirPath: string): Promise<string[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT id FROM songs WHERE library_id = ? AND dir_path = ? ORDER BY disc ASC, track ASC')
          .bind(libraryId, dirPath)
          .all<{ id: string }>(),
      'songs.listIdsByAlbumDir',
    );
    return (result.results ?? []).map((row) => row.id);
  }

  public async listIdsIn(libraryId: string, ids: readonly string[]): Promise<SongRow[]> {
    if (ids.length === 0) return [];
    // Chunked to stay inside SQLite's bound-parameter limit (999 by default).
    const found: SongRow[] = [];
    for (const chunk of chunkArray(ids, 200)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(`SELECT * FROM songs WHERE library_id = ? AND id IN (${placeholders})`)
            .bind(libraryId, ...chunk)
            .all<SongRow>(),
        'songs.listIdsIn',
      );
      found.push(...(result.results ?? []));
    }
    return found;
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

  /** Distinct albums, for `getArtists`/`getAlbumList2`. */
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

    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT * FROM songs WHERE ${where.join(' AND ')} GROUP BY album_artist_ci, album_ci ORDER BY ${options.orderBy} LIMIT ? OFFSET ?`,
          )
          .bind(...values)
          .all<SongRow>(),
      'songs.listAlbums',
    );
    return result.results ?? [];
  }

  public async listArtists(libraryId: string, limit: number, offset: number): Promise<SongRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT * FROM songs WHERE library_id = ? AND artist_ci IS NOT NULL AND artist_ci <> '' GROUP BY artist_ci ORDER BY artist_ci ASC LIMIT ? OFFSET ?`,
          )
          .bind(libraryId, limit, offset)
          .all<SongRow>(),
      'songs.listArtists',
    );
    return result.results ?? [];
  }

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

  public async listGenres(libraryId: string): Promise<SongRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT * FROM songs WHERE library_id = ? AND genre_ci IS NOT NULL AND genre_ci <> '' GROUP BY genre_ci ORDER BY genre_ci ASC`,
          )
          .bind(libraryId)
          .all<SongRow>(),
      'songs.listGenres',
    );
    return result.results ?? [];
  }

  /**
   * Random songs, with optional genre and year filters.
   *
   * `ORDER BY RANDOM()` is a full sort and is documented as a follow-up (an
   * FTS5 or a precomputed ordering column) rather than hidden: a 5,000-row sort
   * is a few milliseconds, and a 50,000-row one is not.
   */
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
        ? 'title_ci LIKE ? ESCAPE \'\\\''
        : field === 'artist'
          ? 'artist_ci LIKE ? ESCAPE \'\\\''
          : field === 'album'
            ? 'album_ci LIKE ? ESCAPE \'\\\''
            : '(title_ci LIKE ? ESCAPE \'\\\' OR artist_ci LIKE ? ESCAPE \'\\\' OR album_ci LIKE ? ESCAPE \'\\\' OR genre_ci LIKE ? ESCAPE \'\\\')';

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

  /** Songs whose derived metadata is still missing, for tag enrichment. */
  public async listEnrichmentCandidates(libraryId: string, limit: number): Promise<SongRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM songs WHERE library_id = ? AND duration = 0 ORDER BY mtime_ms DESC LIMIT ?')
          .bind(libraryId, limit)
          .all<SongRow>(),
      'songs.listEnrichmentCandidates',
    );
    return result.results ?? [];
  }

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

}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}


export { SongDAO, chunkArray };
export type { SongUpsertInput, SongQuery };
