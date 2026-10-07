/**
 * Selecting the tracks that still owe a tag read, for the library-wide enrichment.
 *
 * Own module rather than methods on `SongDAO` for the `SongDerivationDAO` reason: the
 * backfill is a bounded pass over *many* rows selected by a stamp, which is a different
 * question from "one song row, by id" — and folding it in put `SongDAO` over the
 * god-file limit.
 *
 * ### Why the selection is on `enriched_at` *and* `reader_version`
 *
 * Staleness is a function of the file's bytes *and* of the reader that extracted from
 * them. Keying the selection on `enriched_at` alone is correct for the bytes and blind
 * to the reader, so a corrected reader leaves every row it already wrote looking
 * current: the file genuinely has not moved, so nothing re-reads it, and the wrong
 * value is served for ever. It shipped — a fixed Ogg reader left a live library
 * reporting a 240.61 s track as 3 s, and no rescan re-read it. `reader_version` is the
 * other half, stamped by `applyMetadata` in the same statement as the values, and the
 * `songMeta` KV entry carries it for the same reason. This selection is the same pair
 * `shouldEnrich` decides on, over rows instead of one row.
 */
import { BaseDAO } from './BaseDAO';
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import type { D1Queryable } from '../utils/D1Types';
import { UNMETERED_SUBREQUESTS } from '@edge-sonic/shared';
import type { SubrequestMeter } from '@edge-sonic/shared';

/**
 * Library ids per statement: one variable each, and nothing else.
 *
 * Derived from the measured ceiling rather than chosen, so a raised `MAX_LIBRARIES`
 * cannot silently push this over D1's 100-parameter limit. See `sqlLimits.ts`.
 */
const LIBRARIES_PER_STATEMENT = bindChunkSize(1);

/**
 * One track the library-wide enrichment still owes a tag read.
 *
 * Only the four fields a range read needs. `enrichFacts` takes exactly these rather than
 * a `SongRow`, so the caller does not fabricate a row to satisfy a signature — a
 * fabricated row is a copy of the schema that rots silently when a column is added.
 */
interface EnrichableRow {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly mtime_ms: number;
}

class SongEnrichmentDAO extends BaseDAO {
  constructor(database: D1Queryable, subrequests: SubrequestMeter = UNMETERED_SUBREQUESTS) {
    super(database, subrequests);
  }

  /**
   * Tracks still owing a tag read, in stable `path` order.
   *
   * Ordered rather than left to the planner: a limit without an order can return the
   * same rows twice between calls, and `path` rides `idx_songs_library_path`, so the
   * order is the index's rather than a sort. No cursor is needed: stamped rows leave
   * the selection, so each chunk's page is the next one by construction — the same shape
   * as the derivation backfill's version selection.
   *
   * `readerVersion` is a parameter rather than an import: `backend-data` is layer 0 and
   * the reader lives in `media-tags`, so the value is read once above and passed down —
   * and the selection that offers rows and the guard that skips them agree on it by
   * construction rather than by coincidence.
   */
  public async listNeedingEnrichment(libraryId: string, readerVersion: number, limit: number): Promise<EnrichableRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            'SELECT id, path, size, mtime_ms FROM songs WHERE library_id = ? AND (enriched_at IS NULL OR reader_version != ?) ORDER BY path ASC LIMIT ?',
          )
          .bind(libraryId, readerVersion, limit)
          .all<EnrichableRow>(),
      'songs.listNeedingEnrichment',
    );
    return result.results ?? [];
  }

  /**
   * How many tracks still owe a tag read.
   *
   * The denominator the operator surface renders beside a run. A count rather than
   * `listNeedingEnrichment(...).length`, because the page is bounded by the chunk budget
   * and the count is not.
   */
  public async countNeedingEnrichment(libraryId: string, readerVersion: number): Promise<number> {
    const row = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT COUNT(*) AS cnt FROM songs WHERE library_id = ? AND (enriched_at IS NULL OR reader_version != ?)')
          .bind(libraryId, readerVersion)
          .first<{ cnt: number }>(),
      'songs.countNeedingEnrichment',
    );
    return row?.cnt ?? 0;
  }

  /**
   * Tracks still owing a tag read, for many libraries in one statement per batch.
   *
   * A library with nothing owing is **absent from the map** — the same convention as the
   * other batched counts in this layer, so "nothing left" and "never looked at" stay
   * distinguishable to the caller that renders them.
   */
  public async countNeedingEnrichmentByLibraries(libraryIds: readonly string[], readerVersion: number): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const chunk of chunkArray(libraryIds, LIBRARIES_PER_STATEMENT)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(
              `SELECT library_id, COUNT(*) AS cnt FROM songs WHERE library_id IN (${placeholders}) AND (enriched_at IS NULL OR reader_version != ?) GROUP BY library_id`,
            )
            .bind(...chunk, readerVersion)
            .all<{ library_id: string; cnt: number }>(),
        'songs.countNeedingEnrichmentByLibraries',
      );
      for (const row of result.results ?? []) counts.set(row.library_id, row.cnt);
    }
    return counts;
  }
}

export { SongEnrichmentDAO };
export type { EnrichableRow };
