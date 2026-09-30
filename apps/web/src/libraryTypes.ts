/**
 * Library and scan wire types for the user API.
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

`lastError` is nullable rather than optional on purpose: the server sends it on
every status, because `ChunkResult` carries it unconditionally. It was optional
*and* never populated, so the one field that could explain a failed scan was
declared on the client and absent from the wire.
*/
/**
 * Which bound ended the last chunk, or `null` for one that did no work.
 *
 * `frontier` is the ordinary case — the chunk ran out of folders to visit. The other
 * two say a limit cut the work short, which is the fact an operator watching a scan
 * that is not finishing needs, and the two have different remedies: one is a slow
 * origin, the other is a chunk budget that is too small for the library.
 */
type ChunkStopReason = 'frontier' | 'requests' | 'deadline' | null;

interface ScanStateSummary {
  readonly status: 'idle' | 'scanning' | 'failed';
  readonly scanned: number;
  readonly total: number;
  readonly indexVersion: number;
  readonly lastError: string | null;
  /**
   * Present on a chunk result, absent from the read-only status.
   *
   * Nullable rather than optional for the reason the rest of this file is: the server
   * sends it on every chunk, and a client has to be able to tell "nothing stopped it"
   * from "the field is not here".
   */
  readonly stoppedBy: ChunkStopReason;
}

export type { LibrarySummary, ProbeResult, ScanStateSummary, ChunkStopReason };
