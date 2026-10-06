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

export type {
  LibrarySummary,
  LibraryScanSummary,
  ProbeResult,
  ScanStateSummary,
  ScanStatus,
  ChunkStopReason,
  LibraryIndexStats,
  IndexStats,
  IndexDropResult,
} from './libraryTypes';
export type { UserSummary } from './userTypes';
// The import wire types live beside the user types because an import *targets* a user account:
// the page is "manage this account's library, accounts, and what it moved from somewhere else",
// and splitting the third over a new file for four types would be structure without a question.
export type {
  ImportSourceSummary,
  ImportPhase,
  ImportReport,
  ImportRunSummary,
  PhaseReport,
  UnresolvedItem,
  UnresolvedReason,
} from './userTypes';
export type { CurrentUser, Notice };
