/**
 * Enriching a whole library, one bounded chunk at a time.
 *
 * ### Why this exists beside the scan's own enrichment
 *
 * The scan enriches only the tracks it changed, capped per folder — a cold library of
 * 5,000 tracks is 5,000 range reads against a ceiling of 50 per chunk, so most rows sit
 * unenriched with path-derived grouping for a long time. Lazy `getSong` covers tracks one
 * by one as clients open them. Neither reaches a track nobody plays: its duration stays
 * `0`, its tags stay a guess, and the aggregates group on the guess.
 *
 * So this service walks the *rows* rather than the *folders*: each chunk selects the next
 * page still owing a tag read and enriches it through the same `EnrichmentService` both
 * other callers use, so a row enriched here and a row enriched on first play are identical.
 *
 * ### Why there is no cursor
 *
 * The selection is on `enriched_at IS NULL OR reader_version != ?` — the same pair
 * `shouldEnrich` decides on — so a stamped row leaves the selection by construction and
 * each chunk's page is the next one without anything stored. That is the derivation
 * backfill's shape rather than the walk's: a frontier in D1 would be a second answer to
 * "what remains" beside the rows themselves, free to disagree with them.
 *
 * ### Why this runs only when the scan is idle
 *
 * Both loops spend the same daily row-write allowance, and the allowance is per account:
 * two writers racing for the last rows do not each get slower, the second takes the whole
 * product down until midnight UTC. The import refuses to start beside a scan for exactly
 * this reason, and this service refuses chunk-by-chunk for it — `start` and `step` both
 * throw `ConflictError` while the scan is advancing, and the alarm re-arms behind it
 * rather than charging the retry budget for a condition that is not a fault.
 *
 * ### What a chunk costs, and what bounds it
 *
 * The scan's budget (`ScanBudget` over the scope's counter, never a local one) with the
 * scan's per-track reservation of five — the whole cost of one enrichment, not its range
 * reads alone. The page (`tracksPerChunk`, derived in `subrequests.ts`) sizes the
 * selection so a chunk that spends its whole page still fits the ceiling; `canAfford`
 * still decides per track at runtime, and the remainder is simply the next chunk's.
 */
import { ConflictError } from '@edge-sonic/backend-errors';
import { SUBSREQUESTS_PER_ENRICHED_TRACK } from '@edge-sonic/backend-runtime/config';
import type { EnrichableRow, LibraryRow, ScanStateRow } from '@edge-sonic/backend-data/dao';
import type { SubrequestCounter } from '@edge-sonic/shared';
import { ScanBudget, stopReason } from './scanBudget';
import type { EnrichmentCost } from './scanEnrichment';
import type { EnrichFacts } from './EnrichmentService';
import { storedStatus } from './scanRetry';
import type { ScanDailyBudget } from './scanTypes';
import {
  enrichD1AllowancePause,
  enrichDailyAllowancePause,
  enrichIdleResult,
  describeEnrichFailure,
} from './enrichRetry';
import type { EnrichChunkResult } from './enrichRetry';

interface EnrichLibrarySongStore {
  listNeedingEnrichment(libraryId: string, readerVersion: number, limit: number): Promise<readonly EnrichableRow[]>;
  countNeedingEnrichment(libraryId: string, readerVersion: number): Promise<number>;
}

interface EnrichLibraryScanStore {
  find(libraryId: string): Promise<ScanStateRow | null>;
}

interface EnrichLibraryDeps {
  songs: EnrichLibrarySongStore;
  scanState: EnrichLibraryScanStore;
  /**
   * The invocation's subrequest counter.
   *
   * The same object every D1 statement and KV operation charges — borrowed, never owned —
   * so the budget this chunk decides against and the counter the DAOs write to cannot be
   * two different numbers.
   */
  subrequests: SubrequestCounter;
  /**
   * One track's enrichment, through the same service `getSong` and the scan use.
   *
   * `onRequest` is the chunk's meter, forwarded so a range read is charged to the same
   * budget as the selection that found the track. Takes `EnrichFacts` rather than the
   * row so the caller maps the storage shape once, at the boundary, instead of threading
   * a database naming convention through the enrichment decision.
   */
  enrichTrack: (library: LibraryRow, facts: EnrichFacts, onRequest?: () => void) => Promise<EnrichmentCost>;
  /**
   * Subrequests one chunk may issue, of every kind. The scan's ceiling, shared rather than
   * retyped: a second number beside it would be wrong by the time the platform moves.
   */
  chunkMaxRequests: number;
  /**
   * Milliseconds one chunk may take. The scan's deadline, for the same reason: a chunk
   * that never returns on a slow origin is a poll that never answers.
   */
  chunkDeadlineMs: number;
  /**
   * Tracks one chunk selects. Derived in `subrequests.ts` from the ceiling above, so a
   * chunk that spends its whole page still fits it.
   */
  tracksPerChunk: number;
  /**
   * Which reader's stamp counts as current. Passed down rather than imported: the value
   * lives in `media-tags`, and the selection that offers rows and the guard that skips
   * them must agree on it by construction.
   */
  readerVersion: number;
  now?: () => number;
}

class LibraryEnrichmentService {
  constructor(private readonly deps: EnrichLibraryDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private budget(): ScanBudget {
    return new ScanBudget({
      meter: this.deps.subrequests,
      maxRequests: this.deps.chunkMaxRequests,
      deadlineMs: this.deps.chunkDeadlineMs,
    });
  }

  /**
   * Advance one chunk. Called from `EnrichWorker.stepOnce` (alarm-driven) or, without
   * the `ENRICH` binding, directly from the operator routes (client-driven).
   *
   * `dailyBudget` for the same reason `ScanService.step`'s is: the count lives in the
   * caller's Durable Object storage, which the composition root cannot read.
   */
  public async step(library: LibraryRow, dailyBudget?: () => ScanDailyBudget): Promise<EnrichChunkResult> {
    let remaining = 0;
    let budget: ScanBudget | undefined;
    let enriched = 0;
    let rowsWritten = 0;
    let billedRows = 0;

    try {
      // Idle-only, and checked before anything is selected: both loops spend the same
      // daily allowance, and two writers racing for it is how an outage is reached rather
      // than survived. `stalled` is allowed — nothing is scheduled to retry it — and a
      // missing row is allowed, because a library nobody scanned holds no songs either.
      await this.assertScanIdle(library.id);

      budget = this.budget();
      const chunk = budget;
      const page = await this.deps.songs.listNeedingEnrichment(library.id, this.deps.readerVersion, this.deps.tracksPerChunk);
      if (page.length === 0) return { ...enrichIdleResult(0), subrequests: chunk.spend() };

      const allowancePause = enrichDailyAllowancePause(dailyBudget?.(), page.length);
      if (allowancePause) return { ...allowancePause, subrequests: chunk.spend() };

      let stoppedEarly = false;
      for (const track of page) {
        // Checked before each track, on the whole cost rather than the range reads alone:
        // admitting a track on the cost of two of its five subrequests is how a chunk
        // stops being slow and starts being terminated.
        if (!chunk.canAfford(SUBSREQUESTS_PER_ENRICHED_TRACK)) {
          stoppedEarly = true;
          break;
        }
        try {
          // Both counts come off the service's own report, measured rather than declared:
          // the day's budget is denominated in billed rows and `songs` bills ten per row.
          const written = await this.deps.enrichTrack(
            library,
            { id: track.id, path: track.path, size: track.size, mtimeMs: track.mtime_ms },
            () => chunk.charge(),
          );
          rowsWritten += written.rowsWritten;
          billedRows += written.billedRows;
          // Stamped rows leave the selection; a transient failure writes nothing and is
          // re-offered next chunk — the same permanence rule the scan enriches under.
          if (written.rowsWritten > 0) enriched += 1;
        } catch {
          // Left unenriched for the next chunk, for the scan's reason: the rows the chunk
          // already wrote are already recorded, and one unreachable file must not discard
          // them. It contributes nothing to either count.
        }
      }

      remaining = await this.deps.songs.countNeedingEnrichment(library.id, this.deps.readerVersion);
      if (remaining === 0) {
        return { ...enrichIdleResult(0), subrequests: chunk.spend(), enriched, rowsWritten, billedRows };
      }
      return {
        status: 'enriching',
        enriched,
        remaining,
        lastError: null,
        subrequests: chunk.spend(),
        rowsWritten,
        billedRows,
        stoppedBy: stoppedEarly ? stopReason(chunk, true) : 'frontier',
        resumeAt: null,
      };
    } catch (error) {
      // The idle-only refusal is an operator answer, not a chunk failure: the scan is
      // running, so the run must wait rather than spend its retry budget on a condition
      // that is not a fault. It propagates — to a `409` on a manual step, and to the
      // alarm's re-arm behind it.
      if (error instanceof ConflictError) throw error;
      const allowancePause = enrichD1AllowancePause(error, this.now(), remaining);
      if (allowancePause) return allowancePause;
      if (budget === undefined) budget = this.budget();
      return {
        status: 'failed',
        enriched,
        remaining,
        lastError: describeEnrichFailure(error),
        subrequests: budget.spend(),
        rowsWritten,
        billedRows,
        stoppedBy: null,
        resumeAt: null,
      };
    }
  }

  /**
   * Refuse while the scan is advancing.
   *
   * Named rather than folded into `step`, because "is anything else writing right now" is
   * the single most consequential precondition this feature has. A `ConflictError` rather
   * than a result: an operator action arriving while the scan runs must be told to wait,
   * and the alarm's catch re-arms behind it without charging the retry budget — a refused
   * chunk is not a failed one.
   */
  private async assertScanIdle(libraryId: string): Promise<void> {
    const state = await this.deps.scanState.find(libraryId);
    if (state === null) return;
    const status = storedStatus(state);
    if (status === 'idle' || status === 'stalled') return;
    throw new ConflictError(
      `The scan is ${status} on this library. Enrichment runs only while the scan is idle so the two do not compete for the daily row-write allowance — wait for the scan to finish, then start the enrichment.`,
    );
  }
}

export { LibraryEnrichmentService };
export type { EnrichLibraryDeps };
