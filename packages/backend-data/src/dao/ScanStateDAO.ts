/**
 * The scan's durable state: status, progress, the index version, and the retry budget.
 *
 * ### Why this is a table and not an in-memory flag
 *
 * The frontier is in D1, so the scan is already resumable across isolates for free — and
 * the fact that records *whether the scan is stuck* has to be resumable for the same
 * reason. A module-level failure counter resets whenever a different isolate serves the
 * next poll, so on a busy deployment a permanently broken library would never exhaust its
 * retry budget: every poll would look like the first failure, for ever.
 *
 * It was also the reason a failed scan could not be recovered from at all. `step`
 * short-circuited on any status other than `scanning`, `fail` sets `failed`, so one bad
 * chunk ended a scan permanently with the frontier sitting untouched — and `getScanStatus`
 * reported that identically to a finished one, so every client read it as "stop
 * polling". It shipped: a library of 80 albums sat at one scanned folder reporting
 * `{"scanning": false, "count": 1}` indefinitely.
 *
 * ### What `consecutive_failures` is for
 *
 * Not a boolean. A scan that failed once must be retried, because a WebDAV origin that
 * 500s once should not end a scan; a library whose credential is revoked must not be
 * retried for ever, spending the operator's subrequest budget to reach the same
 * conclusion on every poll. The counter is that distinction.
 *
 * It is cleared by `markScanning` — an explicit `startScan` is the operator's escape
 * hatch, needing no surface of its own — and by `saveProgress`, because a chunk that made
 * progress has demonstrably not failed. And it is incremented in the **same statement**
 * as the status: a row that says `failed` with a stale count would let the next poll
 * reset the bound without the fault being fixed, which is the loop the column exists to
 * prevent.
 */
import { BaseDAO } from './BaseDAO';
import type { ScanStateRow } from './rows';
import { nowSeconds } from './identity';

class ScanStateDAO extends BaseDAO {
  public async find(libraryId: string): Promise<ScanStateRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM scan_state WHERE library_id = ?').bind(libraryId).first<ScanStateRow>(),
      'scanState.find',
    );
  }

  /**
   * The row for a library, created on first use.
   *
   * `ensure` rather than "insert and hope": a scan state is written by whichever isolate
   * gets there first, and a racing `INSERT` is what `INSERT OR IGNORE` is for. The
   * throw is a real assertion rather than a defensive default — a scan that cannot read
   * its own state back cannot report progress, and returning a fabricated row would
   * report progress of zero, which is the answer a client reads as "finished".
   */
  public async ensure(libraryId: string): Promise<ScanStateRow> {
    const existing = await this.find(libraryId);
    if (existing) return existing;
    await this.withRetry(
      async () =>
        await this.database
          .prepare('INSERT OR IGNORE INTO scan_state (library_id, status, scanned_count, total_count, index_version, updated_at) VALUES (?, ?, 0, 0, 1, ?)')
          .bind(libraryId, 'idle', nowSeconds())
          .run(),
      'scanState.ensure',
    );
    const created = await this.find(libraryId);
    if (!created) throw new Error('scan_state.ensure did not produce a readable row.');
    return created;
  }

  /**
   * Begin a scan: reset the progress counters and clear the retry budget.
   *
   * `consecutive_failures = 0` is the operator's escape hatch, and it is why the retry
   * bound needs no surface of its own — a client or operator that explicitly asks to
   * scan is saying "try again", and a budget that survived that request would be a
   * wedged library with no way out but a row edit.
   */
  public async markScanning(libraryId: string, totalCount: number): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare("UPDATE scan_state SET status = 'scanning', total_count = ?, scanned_count = 0, cursor_path = NULL, last_error = NULL, consecutive_failures = 0, started_at = ?, updated_at = ? WHERE library_id = ?")
          .bind(totalCount, nowSeconds(), nowSeconds(), libraryId)
          .run(),
      'scanState.markScanning',
    );
  }

  /**
   * Record a failure, incrementing the retry counter in the same statement.
   *
   * One statement because the count and the status are one fact. Returns the new count,
   * because it is the answer to "may this scan try again?" and a second read could
   * observe a different writer's increment.
   */
  public async fail(libraryId: string, error: string): Promise<number> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare("UPDATE scan_state SET status = 'failed', last_error = ?, consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE library_id = ?")
          // Bounded before it is written, because the text originates upstream, and
          // again in the service, which is what the operator is actually shown.
          .bind(error.slice(0, 500), nowSeconds(), libraryId)
          .run(),
      'scanState.fail',
    );
    const row = await this.find(libraryId);
    return row?.consecutive_failures ?? 1;
  }

  /**
   * Record progress, which also proves the scan is not stuck.
   *
   * `consecutive_failures = 0` because a chunk that made progress has demonstrably not
   * failed. Carrying the count forward would mean one flaky folder eventually exhausts
   * the retry budget across an otherwise healthy scan — a scan that stalls having done
   * most of its work, which is the worst time to stop.
   */
  public async saveProgress(libraryId: string, scannedCount: number, cursorPath: string | null): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare("UPDATE scan_state SET status = 'scanning', scanned_count = ?, cursor_path = ?, consecutive_failures = 0, updated_at = ? WHERE library_id = ?")
          .bind(scannedCount, cursorPath, nowSeconds(), libraryId)
          .run(),
      'scanState.saveProgress',
    );
  }

  /**
   * Finish a scan and bump `index_version`.
   *
   * The bump is what invalidates every cached aggregate for this library — not by
   * deleting anything, but by making the old keys unreachable. See `KvDomains.ts` for
   * why that matters against a 1,000-writes-per-day plan. The retry budget is cleared
   * because a finished scan has, by definition, stopped failing.
   */
  public async complete(libraryId: string, scannedCount: number): Promise<number> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare("UPDATE scan_state SET status = 'idle', scanned_count = ?, cursor_path = NULL, last_error = NULL, consecutive_failures = 0, updated_at = ?, index_version = index_version + 1 WHERE library_id = ?")
          .bind(scannedCount, nowSeconds(), libraryId)
          .run(),
      'scanState.complete',
    );
    const row = await this.find(libraryId);
    return row?.index_version ?? 1;
  }
}

export { ScanStateDAO };
