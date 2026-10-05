/**
 * The play-count walk's cursor.
 *
 * ### Why this is not beside the runs
 *
 * Because it has a different **lifecycle** and a different reader. A run is created by an operator
 * and read by the operator's page; the cursor is written only by `PlayCountImportWorker`, on every
 * alarm, and read by nobody except that worker and the page's progress line. It is the Durable
 * Object's **resume point**, so it has to survive an eviction at exactly the moment the process is
 * most likely to be killed for spending the daily allowance.
 *
 * ### The row is still here, and that is the exception
 *
 * **Durable Object storage, not D1, is where the walk actually keeps its position** — the object
 * already has to re-arm its own alarm, and a cursor that lived only in D1 would be unreadable in
 * the case that matters most: D1 refusing writes because the allowance is spent. That is the same
 * reason `ScanPauseStore` holds the scan's pause.
 *
 * So this row is the operator-visible half: a page that polls reads D1, and a run whose progress
 * existed only inside an object storage the page cannot reach would render as **"no progress"**
 * rather than as "paused" — two different diagnoses for the same state.
 */
import { BaseDAO } from './BaseDAO';
import { nowSeconds } from './identity';

/**
 * The play-count walk's cursor.
 *
 * **Read on every batch and written after it**, so an alarm that is killed mid-batch
 * resumes from the last album it *finished*. `lastRemoteAlbumId` is the cursor and
 * `albumsDone` the tiebreak, because a remote album id is not guaranteed to sort in
 * walk order across two different servers — an ordering assumption here would silently
 * skip or repeat albums on any source whose ids are not monotonic.
 */
class ImportPlayCountProgressDAO extends BaseDAO {
  public async read(runId: string): Promise<ImportPlayCountProgressRow | null> {
    return await this.withRetry(
      async () =>
        await this.database.prepare('SELECT * FROM import_play_count_progress WHERE run_id = ?').bind(runId).first<ImportPlayCountProgressRow>(),
      'importPlayCounts.read',
    );
  }

  public async ensure(runId: string): Promise<ImportPlayCountProgressRow> {
    const existing = await this.read(runId);
    if (existing) return existing;
    const timestamp = nowSeconds();
    await this.withRetry(
      async () =>
        await this.database
          .prepare('INSERT OR IGNORE INTO import_play_count_progress (run_id, albums_done, songs_imported, updated_at) VALUES (?, 0, 0, ?)')
          .bind(runId, timestamp)
          .run(),
      'importPlayCounts.ensure',
    );
    const created = await this.read(runId);
    if (!created) throw new Error('importPlayCounts.ensure did not produce a readable row.');
    return created;
  }

  /**
   * Advance the cursor by one finished album.
   *
   * A **delta** rather than an absolute total, for the reason `saveProgress` is: two
   * overlapping batches would otherwise each publish their own count and the smaller one
   * would win, so the number would go backwards while the work was being done. An
   * operator watching progress go down has no way to tell that from a fault.
   */
  public async advance(runId: string, lastRemoteAlbumId: string | null, albums: number, songs: number): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `UPDATE import_play_count_progress
             SET last_remote_album_id = ?, albums_done = albums_done + ?, songs_imported = songs_imported + ?, updated_at = ?
             WHERE run_id = ?`,
          )
          .bind(lastRemoteAlbumId, albums, songs, nowSeconds(), runId)
          .run(),
      'importPlayCounts.advance',
    );
  }

  public async markFinished(runId: string): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('UPDATE import_play_count_progress SET last_remote_album_id = NULL, updated_at = ? WHERE run_id = ?')
          .bind(nowSeconds(), runId)
          .run(),
      'importPlayCounts.markFinished',
    );
  }
}

/**
 * The cursor row.
 *
 * `last_remote_album_id` is the cursor and `albums_done` the tiebreak — a remote album id is **not**
 * guaranteed to sort in walk order across two different servers, so an ordering assumption on the
 * id would silently skip or repeat albums on any source whose ids are not monotonic. `advance`
 * writes a **delta** rather than a total, for the reason `saveProgress` does: two overlapping
 * batches would each publish their own count and the smaller would win, so the number would go
 * backwards while the work was being done.
 */
interface ImportPlayCountProgressRow {
  run_id: string;
  last_remote_album_id: string | null;
  albums_done: number;
  songs_imported: number;
  updated_at: number;
}

export { ImportPlayCountProgressDAO };
export type { ImportPlayCountProgressRow };
