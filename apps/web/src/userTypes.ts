/**
 * User wire types for the user API.
 *
 * Nullable, not optional, for "the server may legitimately not know this" — the
 * same convention the worker uses. Optional is reserved for "this field is not
 * present at all".
 */

interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly email: string | null;
  readonly isAdmin: boolean;
  readonly isEnabled: boolean;
  readonly libraryIds: string[];
  readonly createdAt: number;
}

/**
 * A registered remote Subsonic instance.
 *
 * Carries no credential, and that is not an omission in the type — the server's `listSummaries`
 * is a projection that does not **select** the ciphertext columns, so a secret one JSON response
 * away from a browser is not reachable through this surface even by accident. There is no
 * `hasPassword` field either: a write-only value has nothing to display.
 */
interface ImportSourceSummary {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly musicFolderId: string | null;
  readonly createdAt: number;
}

type ImportPhase = 'playlists' | 'stars' | 'bookmarks' | 'playQueue' | 'playCounts';

/**
Why one item did not resolve. `ambiguous` is kept distinct because the remedy differs.
*/
type UnresolvedReason = 'not-found' | 'ambiguous' | 'no-metadata';

/**
 * One item that could not be matched, **named**.
 *
 * The list is the feature. A run reporting "imported 97 of 100" is indistinguishable from one
 * that silently lost three tracks the user removed years ago, and the operator has no way to tell
 * which — so the server names every one, and this type is where those names arrive.
 */
interface UnresolvedItem {
  readonly category: string;
  readonly context: string;
  readonly remoteId: string;
  readonly label: string;
  readonly reason: UnresolvedReason;
}

/**
 * One phase's outcome.
 *
 * `skipped` is distinct from `failed` and from zero counts: a phase the operator did not ask for
 * is *skipped*, and folding that into "0 imported" would make a deliberate choice look like a
 * defect.
 */
interface PhaseReport {
  readonly phase: string;
  readonly status: 'imported' | 'skipped' | 'failed' | 'partial';
  readonly imported: number;
  readonly rowsWritten: number;
  readonly unresolvedCount: number;
  readonly unresolved: readonly UnresolvedItem[];
  readonly lastError: string | null;
}

interface ImportReport {
  readonly runId: string;
  readonly sourceName: string;
  readonly targetUsername: string;
  readonly phases: readonly PhaseReport[];
  /**
  Epoch seconds, or `null` while running — so progress is distinguishable from "stopped".
  */
  readonly finishedAt: number | null;
}

interface ImportRunSummary {
  readonly id: string;
  readonly sourceId: string;
  /**
  `null` when the source was deleted, rather than the reader's own name standing in for it.
  */
  readonly sourceName: string | null;
  readonly targetUsername: string | null;
  readonly status: string;
  readonly lastError: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

export type {
  UserSummary,
  ImportSourceSummary,
  ImportPhase,
  ImportReport,
  ImportRunSummary,
  PhaseReport,
  UnresolvedItem,
  UnresolvedReason,
};
