/**
 * Wire types for the user API.
 *
 * Nullable, not optional, for "the server may legitimately not know this" — the
 * same convention the worker uses. Optional is reserved for "this field is not
 * present at all".
 */

interface LibrarySummary {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string | null;
  readonly baseUrl: string;
  readonly rootPath: string;
  /**
  The WebDAV account name. The password is never returned by the API.
  */
  readonly davUsername: string;
  readonly isEnabled: boolean;
  readonly createdAt: number;
}

interface ProbeResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
}

/**
Mirrors `scan_state`. `status` is the raw value so the UI can show a failure.
*/
interface ScanStateSummary {
  readonly status: 'idle' | 'scanning' | 'failed';
  readonly scanned: number;
  readonly total: number;
  readonly indexVersion: number;
  readonly lastError?: string | null;
}

interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly email: string | null;
  readonly isAdmin: boolean;
  readonly isEnabled: boolean;
  readonly libraryIds: string[];
  readonly createdAt: number;
}

interface Notice {
  readonly type: 'success' | 'error';
  readonly text: string;
}

export type { LibrarySummary, ProbeResult, ScanStateSummary, UserSummary, Notice };
