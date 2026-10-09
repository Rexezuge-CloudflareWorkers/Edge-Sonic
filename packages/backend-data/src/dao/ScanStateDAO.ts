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
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import type { CountRow, ScanStateRow } from './rows';
import { nowSeconds } from './identity';

/**
 * Library ids per statement: one variable each, and nothing else.
 *
 * Derived from the measured ceiling rather than chosen, so a raised `MAX_LIBRARIES` cannot
 * silently push this over D1's 100-parameter limit. See `sqlLimits.ts`.
 */
const LIBRARIES_PER_STATEMENT = bindChunkSize(1);

class ScanStateDAO extends BaseDAO {
  public async find(libraryId: string): Promise<ScanStateRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM scan_state WHERE library_id = ?').bind(libraryId).first<ScanStateRow>(),
      'scanState.find',
    );
  }

  /**
   * One library's scan-state rows, which is 1 or 0.
   *
   * A count rather than a boolean so the caller can sum it across libraries without a second
   * shape of the same question, and `0`/`1` rather than `true`/`false` so the answer composes
   * with the song and node counts beside it — all three are what an index drop would remove,
   * and a caller that had to convert one of them before summing had three conversions to keep
   * correct instead of one.
   */
  public async countByLibrary(libraryId: string): Promise<number> {
    const row = await this.withRetry(
      async () =>
        await this.database.prepare('SELECT COUNT(*) AS cnt FROM scan_state WHERE library_id = ?').bind(libraryId).first<CountRow>(),
      'scanState.countByLibrary',
    );
    return row?.cnt ?? 0;
  }

  /**
   * Scan-state counts for many libraries in one statement, keyed by library id.
   *
   * A `scan_state` row is at most one per library, so this is the batched twin of
   * {@link countByLibrary} and it is needed for the same reason: a caller that renders a
   * row per library spends a statement per library otherwise, and each statement is a
   * subrequest. A library with no row is **absent from the map** — the "never scanned" state
   * that `listByLibraries` documents as load-bearing, and the same convention as the other
   * batched reads in this layer.
   */
  public async countByLibraries(libraryIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const chunk of chunkArray(libraryIds, LIBRARIES_PER_STATEMENT)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(`SELECT library_id, COUNT(*) AS cnt FROM scan_state WHERE library_id IN (${placeholders}) GROUP BY library_id`)
            .bind(...chunk)
            .all<{ library_id: string; cnt: number }>(),
        'scanState.countByLibraries',
      );
      for (const row of result.results ?? []) counts.set(row.library_id, row.cnt);
    }
    return counts;
  }

  /**
   * Every stored scan state for `libraryIds`, keyed by library id.
   *
   * A **read**, and deliberately not `ensure` for the ids it does not find. `ensure` writes
   * an `idle` row on first sight, so a caller that used it here would turn a `GET` into a
   * write on every poll for every library that has never been scanned — against the
   * 5,000-rows/day allowance, and on a request path that is supposed to be observable
   * rather than mutating.
   *
   * The absence is therefore load-bearing: a library with no row has never been scanned,
   * which is a **different state** from `idle` (scanned, nothing to do) and the one that
   * needs an operator action. `ScanService.status` calls `ensure` because it reports on
   * one library and has to produce a row to report on; this is that call's opposite.
   */
  public async listByLibraries(libraryIds: readonly string[]): Promise<Map<string, ScanStateRow>> {
    const states = new Map<string, ScanStateRow>();
    for (const chunk of chunkArray(libraryIds, LIBRARIES_PER_STATEMENT)) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(`SELECT * FROM scan_state WHERE library_id IN (${placeholders})`)
            .bind(...chunk)
            .all<ScanStateRow>(),
        'scanState.listByLibraries',
      );
      for (const row of result.results ?? []) states.set(row.library_id, row);
    }
    return states;
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
          .prepare(
            'INSERT OR IGNORE INTO scan_state (library_id, status, scanned_count, total_count, index_version, updated_at) VALUES (?, ?, 0, 0, 1, ?)',
          )
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
          .prepare(
            "UPDATE scan_state SET status = 'scanning', total_count = ?, scanned_count = 0, cursor_path = NULL, last_error = NULL, consecutive_failures = 0, started_at = ?, updated_at = ?, changed = 0 WHERE library_id = ?",
          )
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
          .prepare(
            "UPDATE scan_state SET status = 'failed', last_error = ?, consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE library_id = ?",
          )
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
   *
   * ### `scannedCount` is a delta, and that is the whole point
   *
   * `scanned_count = scanned_count + ?`, not `= ?`. `saveProgress` is the only write to
   * that column a chunk makes, and a chunk can be **overlapped**: `ScanWorker.stepOnce` is
   * reachable from an operator `POST` at any moment, including while the alarm is live, and
   * the two interleave at every `await`. Read-modify-write across that gap publishes
   * whichever writer read the smaller value and landed last, so the counter ends up
   * permanently **under-reported** and a scan finishes having walked less than it reports
   * having walked.
   *
   * `is_scanned` is advanced by the same statements, so the work is genuinely done — it is
   * the count that goes backwards, which is exactly the "a row says one thing while its
   * children say another" shape. `test/scan-do.test.ts` is written against this.
   *
   * It was passing by an accident of interleaving rather than by being correct: the losing
   * order needs two chunks to read the same `scanned_count`, and before the derivation
   * backfill's read sat at the top of every chunk a sibling's write usually landed first,
   * so one chunk visited nothing and the sum the assertion compared against was smaller.
   * Adding one `await` to the prelude moved the interleaving and the latent race surfaced.
   * A guard that passes only because of a timing coincidence is not a guard.
   *
   * Same reason `fail` increments its counter in the statement rather than reading it,
   * writing it back and reading it again — which is why the two are now written alike.
   *
   * ### `indexChanged` is OR-ed in, and it is the only record that this scan changed anything
   *
   * `scan_state.changed` is what `complete()` consults before bumping `index_version`, so it
   * has to accumulate across the chunks that changed something rather than be decided in the
   * one that finishes — `finished()` runs wherever the frontier happens to empty, which is not
   * the chunk that reconciled the last folder. So the flag is set here, in the statement every
   * scanning chunk already issues, and it is **OR-ed** rather than assigned: an overlapped
   * chunk that changed nothing must not clear a sibling's answer, which is the same reason
   * `scanned_count` takes a delta.
   *
   * A boolean and not a row count, and the distinction is the point rather than a convenience:
   * most of the rows a rescan writes are frontier bookkeeping — `is_scanned` flipping both ways,
   * and a re-observation of a folder whose children were just compared and left alone. Deriving
   * this from `rowsWritten > 0` would make `index_version` a function of how many times a
   * library was rescanned. See `FolderWrites` in `scanTypes.ts`.
   */
  public async saveProgress(libraryId: string, scannedDelta: number, cursorPath: string | null, indexChanged: boolean): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            "UPDATE scan_state SET status = 'scanning', scanned_count = scanned_count + ?, cursor_path = ?, consecutive_failures = 0, updated_at = ?, changed = CASE WHEN ? = 1 THEN 1 ELSE changed END WHERE library_id = ?",
          )
          .bind(scannedDelta, cursorPath, nowSeconds(), indexChanged ? 1 : 0, libraryId)
          .run(),
      'scanState.saveProgress',
    );
  }

  /**
   * Finish a scan, bumping `index_version` **only if it changed something**.
   *
   * The bump is what invalidates every cached aggregate for this library — not by
   * deleting anything, but by making the old keys unreachable. See `KvDomains.ts` for
   * why that matters against a 1,000-writes-per-day plan. The retry budget is cleared
   * because a finished scan has, by definition, stopped failing.
   *
   * ### Why the bump is conditional, and what that cost before it was
   *
   * Unconditional meant every finished scan invalidated the whole cache, on the strength of
   * a scan that had changed nothing being indistinguishable from one that had. `start`'s cheap
   * path hides that: with a stable root mtime, `complete()` is never reached without a walk, so
   * the case does not arise — and the test asserting it did not arose was exercising a *double*
   * that shared the assumption. On a real origin whose root collection stamps `getlastmodified`
   * on every observation, the cheap path cannot match, so `startScan` — which every Subsonic
   * client calls on login — walked the root, drained the frontier and bumped the version of
   * every cached aggregate in the deployment. The free plan allots 1,000 KV writes a day.
   *
   * So `scan_state.changed` decides, and it is read **in the statement** rather than by the
   * caller: `finished()` runs on whichever chunk emptied the frontier and holds no value for
   * what the earlier ones wrote, so a caller-side check could only ever see its own chunk.
   *
   * @param changed Force the bump regardless of the stored flag. For the caller that changed
   * the index outside a scan — the library-root-gone branch deletes the whole subtree, and a
   * deleted index must not be served from cache. Absent the argument, a caller that *knows* it
   * changed something has no way to say so.
   *
   * The decision is read in the statement rather than by the caller, so it cannot race a
   * concurrent `saveProgress` between the read and the write. The `SET` order is **not**
   * load-bearing and is not load-bearing by accident: measured against `node:sqlite`, every
   * right-hand side in a `SET` list reads the row as it was *before* the statement, so
   * `changed = 0` and the `index_version` expression both see this scan's answer regardless of
   * which is written first. It is written last because that is the readable order — the bump
   * decides, then the flag is cleared — and not because the other order would be wrong.
   */
  public async complete(libraryId: string, scannedCount: number, changed: boolean = false): Promise<number> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            "UPDATE scan_state SET status = 'idle', scanned_count = ?, cursor_path = NULL, last_error = NULL, consecutive_failures = 0, updated_at = ?, changed = 0, index_version = index_version + CASE WHEN changed = 1 OR ? = 1 THEN 1 ELSE 0 END WHERE library_id = ?",
          )
          .bind(scannedCount, nowSeconds(), changed ? 1 : 0, libraryId)
          .run(),
      'scanState.complete',
    );
    const row = await this.find(libraryId);
    return row?.index_version ?? 1;
  }
}

export { ScanStateDAO };
