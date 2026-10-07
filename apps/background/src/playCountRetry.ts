/**
 * Bounded retry for the play-count walk.
 *
 * `PlayCountImportWorker` is a router the way `ScanWorker` is: the alarm owns the
 * schedule, and this module owns the two decisions the catch has to make — how long to
 * wait before trying again, and what to tell the operator about the fault. It lives
 * apart for the same reason `scanPause.ts` does: the worker file is at the god-file
 * soft limit, and a decision with arithmetic in it does not belong in a router.
 *
 * Two rules, and both are what the October 2026 loop taught:
 *
 * - **A fault is retried within a bound, then settled.** `MAX_CONSECUTIVE_FAILURES` is
 *   the scan's bound reused rather than a second number, because two bounds for "flaked
 *   versus broken" would be free to disagree about which one a transient fault gets.
 * - **A spent D1 allowance is not a fault.** It resolves at midnight UTC by itself, so
 *   it neither consumes the bound nor re-arms in a second. Re-arming at one second over
 *   a refusal that cannot change for hours is ~86,400 identical failures before the reset.
 */
import { LAST_ERROR_MAX } from '@edge-sonic/backend-services/index/scanTypes';
import { Tokens } from '@edge-sonic/backend-services/composition';
import type { createScanWorkerScope } from './ScanWorkerFactory';

/**
 * Milliseconds to wait before the next attempt after `failures` consecutive faults.
 *
 * Exponential from the walk's own pacing delay, capped so a walk that keeps failing does
 * not sleep past the point where an operator is watching it. The cap is a judgement
 * rather than a derivation, stated rather than dressed up: what is load-bearing is that
 * the delay grows (a fixed one-second retry is the loop this exists to stop) and that it
 * is bounded (an unbounded one is a wedge wearing a backoff costume).
 */
function retryDelayMs(failures: number, baseMs: number): number {
  const capped = Math.max(1, Math.floor(failures));
  return Math.min(30_000, baseMs * 2 ** (capped - 1));
}

/**
 * What the operator reads about a walk fault.
 *
 * The thrown error's message, bounded to what `import_runs.last_error` holds. A generic
 * "could not read the import source" discarded the real reason behind every failure it
 * reported — including the budget refusal that caused the October loop — so the record
 * an operator polls never named the fault the logs held.
 */
function describeWalkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, LAST_ERROR_MAX);
}

/**
 * What a spent D1 allowance means for a walk that cannot write.
 *
 * Paused, not failed: the remedy is a clock rather than a change, and charging the retry
 * bound here would eventually settle a walk that would have resumed by itself.
 */
function dailyLimitWalkMessage(kind: 'read' | 'write'): string {
  return kind === 'write'
    ? 'The daily D1 row-write allowance is used up. D1 refuses every query until 00:00 UTC, so the play-count walk resumes itself then.'
    : 'The daily D1 row-read allowance is used up. D1 refuses every query until 00:00 UTC, so the play-count walk resumes itself then.';
}

interface WalkProgress {
  readonly albums: number;
  readonly songs: number;
  /**
  Tracked alongside the counts, because "imported 40 of 400" is not a number an operator can act on.
  */
  readonly unresolved: number;
  readonly finished: boolean;
  readonly lastError: string | null;
  /**
  Consecutive batch faults, bounded by `MAX_CONSECUTIVE_FAILURES`.
  */
  readonly consecutiveFailures: number;
}

/**
 * The phase store the walk resolves and writes through.
 *
 * A function rather than a method so the worker stays a router: the four unreachable
 * phase entries write nothing by saying so, and `setPlayCounts` stays absolute through
 * the DAO's own `requireComplete` batch.
 */
function createPlayCountStore(scope: ReturnType<typeof createScanWorkerScope>, userId: string) {
  return {
    findByPaths: async (libraryId: string, paths: readonly string[]) => await (await scope.get(Tokens.SongMatchDAO)()).findByPaths(libraryId, paths),
    findByAlbumTitle: async (libraryId: string, pairs: ReadonlyArray<readonly [string, string]>) =>
      await (await scope.get(Tokens.SongMatchDAO)()).findByAlbumTitle(libraryId, pairs),
    grantedLibraryIds: async (id: string) =>
      new Set((await scope.get(Tokens.LibraryService).listForUser(id)).map((row: { readonly id: string }) => row.id)),
    songsByIds: async (ids: readonly string[]) => await (await scope.get(Tokens.SongDAO)()).listIdsAcrossLibraries(ids),
    findPlaylistById: async (id: string) => await (await scope.get(Tokens.PlaylistDAO)()).findById(id),
    // The four below are unreachable from this phase, and say so by writing nothing. Returning
    // `0` rather than throwing is the honest answer for a method no call site reaches; a stub
    // that threw would turn a future caller of the wrong phase into a failure nobody could have
    // predicted, and this store is a port rather than the phases themselves.
    createPlaylistWithId: async () => undefined,
    replacePlaylistEntries: async () => ({ written: 0 }),
    upsertStar: async () => ({ written: 0 }),
    upsertRating: async () => ({ written: 0 }),
    upsertBookmark: async () => ({ written: 0 }),
    savePlayQueue: async () => ({ written: 0 }),
    setPlayCounts: async (input: { counts: ReadonlyArray<{ songId: string; playCount: number }> }) => ({
      // Absolute, through the DAO's own `requireComplete` batch: a partially-applied page of
      // counts is a set of numbers right in places and wrong in others, and nothing downstream
      // can tell which is which.
      written: await (await scope.get(Tokens.PlayCountDAO)()).setPlayCounts(userId, input.counts),
    }),
  };
}

export { retryDelayMs, describeWalkFailure, dailyLimitWalkMessage, createPlayCountStore };
export type { WalkProgress };
