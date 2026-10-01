/**
 * Shared SPA types.
 *
 * A thin facade over the per-domain modules (`libraryTypes`, `userTypes`), so
 * existing `from '../types'` imports keep working while each domain owns its
 * own wire vocabulary.
 */

/**
 * The operator, as the Access-gated user API sees them.
 *
 * `preferredLanguage` is local-only for now: the user API does not persist it
 * yet, so `useSpaLanguage` keeps it in component state and `localStorage`.
 */
interface CurrentUser {
  readonly email: string;
  readonly preferredLanguage?: string | null;
}

interface Notice {
  readonly type: 'success' | 'error';
  readonly text: string;
}

export type { LibrarySummary, LibraryScanSummary, ProbeResult, ScanStateSummary, ScanStatus, ChunkStopReason } from './libraryTypes';
export type { UserSummary } from './userTypes';
export type { CurrentUser, Notice };
