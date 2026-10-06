/**
 * Library and scan wire types for the user API.
 *
 * Nullable, not optional, for "the server may legitimately not know this" — the
 * same convention the worker uses. Optional is reserved for "this field is not
 * present at all".
 */

/**
 * One library's scan state, as `GET /user/libraries` publishes it.
 *
 * Nullable on the summary rather than a defaulted `idle`: a library with no `scan_state`
 * row has **never been scanned**, which is a different state from `idle` (scanned, nothing
 * to do) and the one that needs an operator action. `null` says it; an invented `idle`
 * would render a library nobody has scanned as a finished one.
 *
 * `stoppedBy` is deliberately absent. It is a property of a *chunk*, not of stored state,
 * so a read that did no work cannot report one — it is readable through
 * `POST /user/libraries/:id/scan/step`, and `LibraryRow` carries the last chunk's value.
 *
 * `total_count` is absent for the same kind of reason and it is the one that matters here:
 * the server writes it as `0` and never updates it, so it is not a denominator. A client
 * rendering `scanned` against it would show "12 of 0". Progress is `songCount` below — the
 * protocol's own unit, the same figure `getScanStatus` publishes as `count` — plus
 * `scanned`, which counts folders visited.
 *
 * The **column** still exists and is still written, because it is part of `scan_state`; what
 * is gone is the field on the wire. `ChunkResult` carried it as a hardcoded `0` in five of the
 * six places one is built and as `scanned_count` in the sixth, and `ScanStateSummary` below
 * declared it a `number` — so a client could render "12 of 0" from two fields its own types
 * said were both real. Removing the field rather than documenting it is what stops the next
 * client from trusting it.
 */
interface LibraryScanSummary {
  readonly status: ScanStatus;
  readonly scanned: number;
  readonly lastError: string | null;
  /**
   * When a paused scan resumes itself, epoch milliseconds; `null` otherwise.
   *
   * Present and nullable rather than absent, for the reason the rest of this file is: the server
   * sends it on every status, and this client has to be able to tell "it resumes at midnight"
   * from "there is no such moment for this status".
   */
  readonly resumeAt: number | null;
}

/**
 * The scan statuses the server reports.
 *
 * `stalled` is not optional here and its absence was a live defect: the server sends it —
 * `failed` and `stalled` are the same stored status, separated only by the retry counter —
 * and the client's union named three statuses, so a terminal scan rendered as a bare word
 * with no indication that it will never retry without an explicit rescan. It also meant the
 * page had no way to stop polling: `stalled` is exactly the state where polling buys nothing.
 *
 * `paused` is the fourth of the same kind, and it arrives through the **same** hole: a status the
 * server sends that the client's union did not name. A pause is not terminal and it is not
 * advancing — it is waiting for a moment — and neither of the two answers the old union could give
 * is right for it. Rendering it as a bare word would leave an operator reading "paused" with no
 * idea that it resolves itself, which is the whole content of the status.
 */
type ScanStatus = 'idle' | 'scanning' | 'failed' | 'stalled' | 'paused';

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
  /**
  Tracks indexed for this library — the number an operator watches to know a scan is
  working. It used to arrive as a literal `0` that no client read.

  Not nullable, and that is a decision rather than an oversight. The server enumerates libraries
  from `libraries`, which is a D1 read, so when D1 is refusing there is no list at all to put a
  null on: the request answers `503` carrying the reason and the hour it resumes. A "count
  unavailable" state on the row would therefore be a state nothing produces.
  */
  readonly songCount: number;
  /**
  `null` when the library has never been scanned. See `LibraryScanSummary`.
  */
  readonly scan: LibraryScanSummary | null;
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
  readonly status: ScanStatus;
  /**
   * Folders this scan has visited. **Not a fraction** — there is no denominator to render it
   * against, and there is deliberately no field here that could be read as one.
   *
   * `total: number` used to be declared on this type and the server sent a hardcoded `0` in
   * every chunk result but one, where it sent `scanned_count` instead — the same number in a
   * different unit. So a client rendering `scanned / total` got "12 of 0" while its own type
   * said the denominator was a real figure, and no assertion anywhere could have caught it.
   * Progress is `LibrarySummary.songCount`, which is the protocol's own unit and a total
   * rather than a delta.
   */
  readonly scanned: number;
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
  /**
   * When the chunk will next be attempted on its own, epoch milliseconds; `null` otherwise.
   *
   * Nullable rather than optional because the server sends it on every chunk result, and a
   * client has to tell "at midnight" from "the field is not here" — the same convention as
   * `stoppedBy` above, and for the same reason: both were optional once and both went unread.
   */
  readonly resumeAt: number | null;
}

/**
 * What dropping one library's index would cost, as `GET /user/index/stats` projects it.
 *
 * `billedRows` is the field the Danger Zone's confirmation is built around, and it is the
 * **server's** figure rather than one computed here. D1 bills a write as the row plus every
 * index entry it rewrote, so `songs` costs ten rows per row deleted and `nodes` four — and a
 * client multiplying `songs * 10` would be a second copy of a per-table table it cannot see,
 * in the one layer where nothing would catch it being wrong.
 */
interface LibraryIndexStats {
  readonly libraryId: string;
  readonly songs: number;
  readonly nodes: number;
  readonly scanStates: number;
  readonly billedRows: number;
}

/**
 * The global drop's cost: per library, and the total.
 *
 * Both, because the Danger Zone renders a row per library *and* a global action, and the two
 * have to agree — the global confirm phrase is agreed against a sum of the same numbers the
 * per-library rows show. Two endpoints would be two answers to "what does this cost".
 */
interface IndexStats {
  readonly libraries: readonly LibraryIndexStats[];
  readonly total: LibraryIndexStats;
}

/**
 * What a drop actually removed, as the `POST …/drop` routes report it.
 *
 * `billedRows` is the **measured** cost of the `DELETE`s, not the projection the operator
 * confirmed against. They agree unless the index moved while the dialog was open, and when
 * they disagree the measured one is what was spent — so it is the one rendered in the notice.
 *
 * `libraries` is how many registrations were affected: 1 for a per-library drop, N for the
 * global one. Present so the notice can say "3 libraries" rather than "everything", which is
 * the difference between a message naming a scope and one that does not.
 */
interface IndexDropResult {
  readonly songs: number;
  readonly nodes: number;
  readonly scanStates: number;
  readonly changes: number;
  readonly billedRows: number;
  readonly libraries: number;
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
};
