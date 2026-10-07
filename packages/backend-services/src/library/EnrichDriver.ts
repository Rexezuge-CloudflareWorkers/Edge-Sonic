/**
 * `EnrichDriver` — the port through which a caller reaches "the thing that enriches a
 * whole library", and the two strategies behind it.
 *
 * The scan's `ScanDriver` under a different name, and a separate port rather than three
 * more methods on it for one reason: the two answer different questions about what is
 * running. A caller asking "is the scan advancing" and one asking "is the enrichment
 * advancing" through one object gets one answer for two loops on two alarms — and the
 * whole point of the separate `ENRICH` namespace is that the two loops never share one.
 *
 * So the read-versus-advance split is named here exactly as it is there. `readState` is
 * passive on both strategies. `advance` runs one chunk in the object's isolate, or one
 * chunk in-process when there is no object to do it.
 */
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { NO_SUBREQUESTS_SPENT } from '@edge-sonic/shared';
import type { EnrichChunkResult } from '../index/enrichRetry';
import type { ScanDailyBudget } from '../index/scanTypes';

/**
 * The three operations an in-process driver needs from the enrichment run.
 *
 * A port rather than `LibraryEnrichmentService`, for the scan's reason: the service
 * carries private members nothing outside it can be handed structurally, and a driver
 * typed against the class can only be exercised through a cast.
 */
interface EnrichRunner {
  step(library: LibraryRow, dailyBudget?: () => ScanDailyBudget): Promise<EnrichChunkResult>;
}

/**
 * What every caller needs from "the thing that enriches this library".
 */
interface EnrichDriver {
  /**
   * Begin the run and report. Takes the row, not the id: the service needs the library's
   * origin and credential, and a route that does not hold a row would have to fabricate
   * one.
   */
  start(library: LibraryRow): Promise<EnrichChunkResult>;
  /**
   * Do one bounded chunk. Takes the row, for the service's sake, on the same argument.
   */
  advance(library: LibraryRow): Promise<EnrichChunkResult>;
  /**
   * The run's state, without doing work — the operator surface's read.
   *
   * Takes an id, because nothing on this path needs the row.
   */
  readState(libraryId: string): Promise<EnrichChunkResult | null>;
  /**
   * The run's state for the operator's library list, or `null` when nothing can report one.
   *
   * `null` rather than a result because the caller overlays it on a D1-derived summary:
   * on the object strategy the run's own progress is what overlays, and on the in-process
   * strategy a live remaining count decides between `null` (tracks remain, no run) and an
   * `idle` that says the library is enriched however it got there.
   */
  stateForLibraryList(libraryId: string): Promise<EnrichChunkResult | null>;
}

/**
 * The in-process strategy: every operation is a direct service call.
 *
 * `stateForLibraryList` is always `null`, for the scan's reason: progress lives in
 * Durable Object storage because metering D1 writes must not itself spend D1 writes, so
 * with no object there is no progress to read back. The list still carries a live
 * remaining count from its own batched read — which is a measurement, not a run.
 */
class InProcessEnrichDriver {
  constructor(
    private readonly enrich: () => EnrichRunner,
    private readonly remaining: (libraryId: string) => Promise<number>,
  ) {}

  public async start(library: LibraryRow): Promise<EnrichChunkResult> {
    return await this.enrich().step(library);
  }

  public async advance(library: LibraryRow): Promise<EnrichChunkResult> {
    return await this.enrich().step(library);
  }

  public async readState(libraryId: string): Promise<EnrichChunkResult | null> {
    const remaining = await this.remaining(libraryId);
    if (remaining === 0) {
      return {
        status: 'idle',
        enriched: 0,
        remaining: 0,
        lastError: null,
        subrequests: NO_SUBREQUESTS_SPENT,
        rowsWritten: 0,
        billedRows: 0,
        stoppedBy: null,
        resumeAt: null,
      };
    }
    return null;
  }

  public async stateForLibraryList(libraryId: string): Promise<EnrichChunkResult | null> {
    // The same live measurement as `readState`: with no object there is no run to report,
    // so the list shows `null` until nothing remains — at which point the library is
    // enriched however it got there, and `idle` is the honest answer.
    return await this.readState(libraryId);
  }
}

export { InProcessEnrichDriver };
export type { EnrichDriver, EnrichRunner };
