/**
 * One Durable Object per library: the alarm-driven library-wide enrichment loop, and
 * nothing else.
 *
 * ### Why this is a second object rather than three more methods on `ScanWorker`
 *
 * A Durable Object handles one event at a time, so an enrich chunk walking the origin —
 * up to `ENRICH_TRACKS_PER_CHUNK` tracks inside the chunk deadline — would block every
 * RPC to the same object, including the scan's own `getStatus` and `stepOnce`. That is
 * the `MediaWorker` argument arriving on the background side: background work must not
 * serialize behind other background work that holds the same gate, and no arrangement of
 * methods on one object can prevent it. Only a second object can. The template already
 * carries this argument for `IMPORT_DO`, and it applies here with the same force — a
 * lifecycle *is* its alarm, so sharing a namespace would let one loop's terminal
 * `deleteAlarm` silently disarm the other.
 *
 * ### Why this runs only when the scan is idle
 *
 * Both loops spend the same daily row-write allowance, and the allowance is per account:
 * two writers racing for the last rows do not each get slower, the second takes the whole
 * product down until midnight UTC. The service refuses chunk-by-chunk (`ConflictError`
 * while the scan is advancing); a manual step surfaces that as `409` to the operator, and
 * the alarm re-arms behind it without charging the retry budget — a refused chunk is not
 * a failed one.
 *
 * ### What lives where
 *
 * D1 stays authoritative for the work itself: the remaining set *is* the `songs` rows
 * still owing a tag read, so a lost isolate resumes rather than restarts and no cursor
 * can disagree with the rows. DO storage holds the library id, the alarm, the run's
 * progress (enriched total, retry counter, last error), the day's row-write count and any
 * pause — the same split `ScanWorker` keeps, for the same reason metering D1 writes must
 * not itself spend D1 writes.
 *
 * An index drop needs nothing here: it deletes `songs`, so the remaining count falls to
 * zero and the run reads as `idle`, and re-enriching a deleted row writes nothing. The
 * drop's spend is charged to the scan objects alone; this object's day-count undercounts
 * it by that figure, and the reactive pause — not the pacing — is what catches the
 * breach.
 */
import { DurableObject } from 'cloudflare:workers';
import { READER_VERSION } from '@edge-sonic/media-tags';
import { NO_SUBREQUESTS_SPENT } from '@edge-sonic/shared';
import { ConflictError } from '@edge-sonic/backend-errors';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { MAX_CONSECUTIVE_FAILURES, d1AllowancePause } from '@edge-sonic/backend-services/index';
import type { ChunkResult, EnrichChunkResult, ScanDailyBudget } from '@edge-sonic/backend-services/index';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { ScanPauseStore, isDailyLimitRefusal, SCAN_ALARM_DELAY_MS } from './scanPause';
import { createScanWorkerScope } from './ScanWorkerFactory';

/**
 * The alarm the chain re-arms itself with after a fault it could not record, and behind
 * a scan that is still running.
 *
 * `SCAN_ALARM_DELAY_MS` and nothing else: one attempt a second against a store that is
 * refusing writes is cheap and stops the instant the store recovers, and one check a
 * second against a running scan resumes the run the moment the scan goes idle. A pause's
 * known end is what `ScanPauseStore.arm` sleeps to instead.
 */
const RETRY_ARM_DELAY_MS = SCAN_ALARM_DELAY_MS;

/**
 * What this object remembers about a run.
 *
 * `enriched` is the run's total — the sum of every chunk's delta — because a chunk
 * reports only what it stamped and the page an operator polls must show one number that
 * grows. `finished` is sticky: once the remaining count hits zero the run is `idle`
 * however many alarms arrive late.
 */
interface EnrichProgress {
  readonly started: boolean;
  readonly finished: boolean;
  readonly enriched: number;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

const NO_PROGRESS: EnrichProgress = {
  started: false,
  finished: false,
  enriched: 0,
  consecutiveFailures: 0,
  lastError: null,
};

/**
 * An enrich result as the scan's pause store reads it.
 *
 * `ScanPauseStore` records billed rows, holds the pause and arms the chain from a
 * `ChunkResult`, and this run's answers fit that shape exactly once `enriching` is read
 * as `scanning`: both mean "more work remains and the alarm stays armed", and every
 * other status already shares its name. One mapping beside the class rather than a
 * second pause store free to disagree about the day's count.
 */
function toScanResult(enrich: EnrichChunkResult): ChunkResult {
  return {
    status: enrich.status === 'enriching' ? 'scanning' : enrich.status,
    scanned: enrich.enriched,
    indexVersion: 0,
    lastError: enrich.lastError,
    foldersVisited: 0,
    subrequests: enrich.subrequests,
    rowsWritten: enrich.rowsWritten,
    billedRows: enrich.billedRows,
    stoppedBy: enrich.stoppedBy,
    resumeAt: enrich.resumeAt,
  };
}

/**
 * A pause the scan's store produced, read back as this run's answer.
 *
 * The store speaks `ChunkResult` and this surface speaks `EnrichChunkResult`; the only
 * status a pause ever carries is `paused`, which both vocabularies spell the same way,
 * so the mapping is a field copy rather than a decision.
 */
function toEnrichResult(pause: ChunkResult, remaining: number): EnrichChunkResult {
  return {
    status: 'paused',
    enriched: 0,
    remaining,
    lastError: pause.lastError,
    subrequests: pause.subrequests,
    rowsWritten: pause.rowsWritten,
    billedRows: pause.billedRows,
    stoppedBy: pause.stoppedBy,
    resumeAt: pause.resumeAt,
  };
}

class EnrichWorker extends DurableObject<Cloudflare.Env> {
  private readonly pause: ScanPauseStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.pause = new ScanPauseStore(ctx.storage);
  }

  private scope(): ReturnType<typeof createScanWorkerScope> {
    return createScanWorkerScope(this.env);
  }

  private async libraries(): Promise<LibraryRow[]> {
    return await this.scope().get(Tokens.LibraryService).listAll();
  }

  private async librariesOrPause(): Promise<LibraryRow[] | null> {
    try {
      return await this.libraries();
    } catch (error) {
      if (isDailyLimitRefusal(error)) return null;
      throw error;
    }
  }

  private async progress(): Promise<EnrichProgress> {
    return (await this.ctx.storage.get<EnrichProgress>('enrichProgress')) ?? NO_PROGRESS;
  }

  /**
   * The pause for a library lookup D1 refused, recorded and armed like the scan's.
   *
   * Shared by all three entry points that can reach it, because "record it, then arm
   * for it" is one operation and three copies would be free to disagree about which
   * comes first.
   */
  private async pauseForRefusal(remaining: number): Promise<EnrichChunkResult> {
    const pause = await this.pause.pauseForRefusal();
    await this.pause.record(pause);
    await this.pause.arm(pause);
    return toEnrichResult(pause, remaining);
  }

  /**
   * Seed the run and schedule the alarm chain.
   *
   * Resets the progress unconditionally: starting is the operator saying "enrich
   * everything owing now", and a counter carried across runs would report one run's
   * tracks against another's. Refuses with `409` while the scan is advancing — the
   * service's idle-only guard, surfaced rather than swallowed, so the operator learns
   * to wait rather than watching a run that cannot move.
   */
  public async startEnrich(libraryId: string): Promise<EnrichChunkResult> {
    const libraries = await this.librariesOrPause();
    if (libraries === null) return await this.pauseForRefusal(0);

    const library = libraries.find((candidate) => candidate.id === libraryId);
    if (library === undefined) throw new Error(`Unknown library "${libraryId}".`);
    await this.ctx.storage.put('libraryId', libraryId);
    await this.ctx.storage.put<EnrichProgress>('enrichProgress', { ...NO_PROGRESS, started: true });
    return await this.runChunk(library, await this.pause.budget(libraries.length));
  }

  /**
   * Read-only status. Never advances the run — that is what the alarm is for.
   *
   * Overlaid with this object's own pause, for the scan's reason: a pause is usually
   * caused by D1 refusing writes, so D1's rows are guaranteed stale about it. `null`
   * when the run was never started and tracks remain — the "never enriched" state the
   * operator's page renders as an action, distinct from an `idle` run that finished.
   */
  public async getStatus(libraryId: string): Promise<EnrichChunkResult | null> {
    const held = await this.pause.held();
    const remaining = await this.remaining(libraryId);
    if (held !== null) {
      const stored = await this.progress();
      return {
        status: 'paused',
        enriched: stored.enriched,
        remaining,
        lastError: held.reason,
        subrequests: NO_SUBREQUESTS_SPENT,
        rowsWritten: 0,
        billedRows: 0,
        stoppedBy: null,
        resumeAt: held.resumeAt,
      };
    }
    const stored = await this.progress();
    if (!stored.started && remaining > 0) return null;
    // `stalled` first: a run that spent its retry budget is terminal even when the
    // remaining count cannot be read — `remaining` falls back to `0` on a D1 refusal,
    // and reading that as "done" would mask the failure the operator has to act on.
    // `finished` cannot meet it: a completing chunk resets the counter, so a finished
    // run always carries zero failures.
    const failures = stored.consecutiveFailures;
    if (!stored.finished && failures >= MAX_CONSECUTIVE_FAILURES) {
      return {
        status: 'stalled',
        enriched: stored.enriched,
        remaining,
        lastError: stored.lastError,
        subrequests: NO_SUBREQUESTS_SPENT,
        rowsWritten: 0,
        billedRows: 0,
        stoppedBy: null,
        resumeAt: null,
      };
    }
    if (stored.finished || remaining === 0) {
      return {
        status: 'idle',
        enriched: stored.enriched,
        remaining: 0,
        lastError: null,
        subrequests: NO_SUBREQUESTS_SPENT,
        rowsWritten: 0,
        billedRows: 0,
        stoppedBy: null,
        resumeAt: null,
      };
    }
    return {
      status: failures > 0 ? 'failed' : 'enriching',
      enriched: stored.enriched,
      remaining,
      lastError: stored.lastError,
      subrequests: NO_SUBREQUESTS_SPENT,
      rowsWritten: 0,
      billedRows: 0,
      stoppedBy: null,
      resumeAt: null,
    };
  }

  /**
   * Advance one chunk, then re-arm the alarm while more work remains.
   *
   * The operator `POST .../enrich/step` and `alarm()` share the chunk below: a manual
   * step is one chunk of the same run, not a second implementation of it. A scan running
   * underneath surfaces as `409` here rather than being swallowed — the operator asked,
   * so the operator is told to wait — while the alarm re-arms behind it silently.
   */
  public async stepOnce(libraryId: string): Promise<EnrichChunkResult> {
    const libraries = await this.librariesOrPause();
    if (libraries === null) return await this.pauseForRefusal(0);

    const library = libraries.find((candidate) => candidate.id === libraryId);
    if (library === undefined) throw new Error(`Unknown library "${libraryId}".`);
    await this.rememberLibrary(libraryId);
    return await this.runChunk(library, await this.pause.budget(libraries.length));
  }

  public override async alarm(): Promise<void> {
    try {
      const libraryId = await this.ctx.storage.get<string>('libraryId');
      if (!libraryId) return;
      const libraries = await this.librariesOrPause();
      if (libraries === null) {
        await this.pauseForRefusal(0);
        return;
      }
      const library = libraries.find((candidate) => candidate.id === libraryId);
      if (library === undefined) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      try {
        await this.runChunk(library, await this.pause.budget(libraries.length));
      } catch (error) {
        // The scan is still running: not a fault, so the retry budget is untouched and
        // the chain re-arms behind it. Swallowing it here is what keeps a refused chunk
        // from reading as a failed one everywhere the status is rendered.
        if (error instanceof ConflictError) {
          await this.ctx.storage.setAlarm(Date.now() + RETRY_ARM_DELAY_MS);
          return;
        }
        throw error;
      }
    } catch (error) {
      const pause = d1AllowancePause(error, Date.now());
      if (pause) {
        await this.pause.record(pause);
        await this.pause.arm(pause);
        return;
      }
      console.error('[EnrichWorker] alarm failed; the chain stays armed for a bounded retry', error);
      await this.ctx.storage.setAlarm(Date.now() + RETRY_ARM_DELAY_MS);
    }
  }

  /**
   * One chunk of the run, with the progress stored and the alarm re-armed from the final
   * result.
   *
   * `stepOnce` and `alarm` share this because they are one loop. The retry counter lives
   * here rather than in the service because the service holds no run state — a chunk that
   * failed reports `failed`, and *this* is what counts it towards `stalled`. The promotion
   * happens *before* the arm, for the scan's reason: arming on `failed` keeps the chain
   * alive, and a run that just spent its retry budget must delete the alarm instead.
   */
  private async runChunk(library: LibraryRow, dailyBudget: () => ScanDailyBudget): Promise<EnrichChunkResult> {
    const scope = this.scope();
    const result = await scope.get(Tokens.LibraryEnrichmentService).step(library, dailyBudget);
    const stored = await this.progress();

    let final: EnrichChunkResult = result;
    if (result.status === 'failed') {
      const consecutiveFailures = stored.consecutiveFailures + 1;
      await this.ctx.storage.put<EnrichProgress>('enrichProgress', {
        started: true,
        finished: false,
        enriched: stored.enriched + result.enriched,
        consecutiveFailures,
        lastError: result.lastError,
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) final = { ...result, status: 'stalled' };
    } else {
      await this.ctx.storage.put<EnrichProgress>('enrichProgress', {
        started: true,
        finished: result.status === 'idle',
        enriched: stored.enriched + result.enriched,
        consecutiveFailures: 0,
        lastError: result.lastError,
      });
    }
    await this.pause.arm(toScanResult(final));
    await this.pause.record(toScanResult(final));
    return final;
  }

  /**
   * Tracks still owing a tag read, or `0` when D1 cannot be asked.
   *
   * A read, so it spends one subrequest of the object's own budget against a ceiling no
   * status poll can threaten. `0` on refusal conflates "unknown" with "done", and that
   * is the honest degradation: the callers that render it cannot reach D1's rows either,
   * and the chunk loop — which holds the authoritative answer — keeps the run armed.
   */
  private async remaining(libraryId: string): Promise<number> {
    try {
      const songs = await this.scope().get(Tokens.SongEnrichmentDAO)();
      return await songs.countNeedingEnrichment(libraryId, READER_VERSION);
    } catch {
      return 0;
    }
  }

  private async rememberLibrary(libraryId: string): Promise<void> {
    const current = await this.ctx.storage.get<string>('libraryId');
    if (current !== libraryId) await this.ctx.storage.put('libraryId', libraryId);
  }
}

export { EnrichWorker };
export type { EnrichProgress };
