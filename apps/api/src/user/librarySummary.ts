/**
 * What `GET /user/libraries` publishes: a library, its indexed track count, and its scan
 * state.
 *
 * ### Why this is its own module and not three lines in `routes.ts`
 *
 * Because it is a **projection over three stores**, and the projection is where the
 * decisions live. `scan_state` says whether a scan is running and why it stopped; `songs`
 * says how much of the library is actually indexed; `libraries` says neither. A reader
 * assembling those from `listAll()` alone is reading three questions off one answer.
 *
 * ### `songCount` was a literal zero
 *
 * The response carried `songCount: 0` — a count the server never computed, on a field whose
 * whole purpose is to be counted. No client read it, so nothing failed; it was a claim on the
 * wire with nothing behind it, which is the shape a later reader trusts. It is now the real
 * `COUNT(*)`, from the same figure `getScanStatus` publishes as `count`.
 *
 * ### Why the reads are batched, and why there are exactly two
 *
 * One grouped query per store, not one per library. `MAX_LIBRARIES` defaults to 10, so the
 * per-library form is an N+1 against a page the operator loads **and then polls** — and a D1
 * query is a subrequest, spent on every tick. The batch sizes are derived from D1's measured
 * ceiling inside the DAOs, so raising `MAX_LIBRARIES` cannot push either over it.
 *
 * ### Why `scan` is nullable
 *
 * A library with no `scan_state` row has **never been scanned**, which is a different state
 * from `idle` — scanned, nothing to do — and the one that needs an operator action. `null`
 * says it. Defaulting the missing case to `idle` would render a library nobody has ever
 * pointed the scanner at as a finished one, which is the answer a client reads as "done".
 *
 * This is also why the read is a plain read: `ScanStateDAO.ensure` writes an `idle` row on
 * first sight, so using it here would create the row this `null` depends on, on a `GET`.
 */
import { Tokens } from '@edge-sonic/backend-services/composition';
import type { createRequestScope } from '@edge-sonic/backend-services/composition';
import { storedStatus } from '@edge-sonic/backend-services/index';
import type { LibraryRow, ScanStateRow } from '@edge-sonic/backend-data/dao';

type Scope = ReturnType<typeof createRequestScope>;

/**
 * The scan half of a library's wire shape.
 *
 * `stoppedBy` is absent and so is `total_count`, and both absences are deliberate:
 *
 * - **`stoppedBy`** is a property of a *chunk*, not of stored state. A read that did no work
 *   cannot report which bound ended the last one. It is readable through
 *   `POST /user/libraries/:id/scan/step`, and the SPA carries the last chunk's value in row
 *   state.
 * - **`total_count`** is written as `0` by `markScanning` and never updated, so it is not a
 *   denominator. Publishing it would invite a client to render "12 of 0". Progress here is
 *   `songCount`, which is the protocol's own unit — what `getScanStatus` publishes as `count`
 *   — plus `scanned`, which counts folders visited.
 */
interface LibraryScanSummary {
  readonly status: 'idle' | 'scanning' | 'failed' | 'stalled';
  readonly scanned: number;
  readonly lastError: string | null;
}

interface LibrarySummary {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string | null;
  readonly baseUrl: string;
  readonly rootPath: string;
  readonly davUsername: string;
  readonly isEnabled: boolean;
  /**
  Tracks indexed for this library. A real count, from `songs`.
  */
  readonly songCount: number;
  /**
  `null` when the library has never been scanned. See the module header.
  */
  readonly scan: LibraryScanSummary | null;
  readonly createdAt: number;
}

/**
 * Build the wire list.
 *
 * The two reads are batched and run concurrently; the mapping below is total, so a library
 * missing from either map is a library with no rows rather than a fabricated zero.
 */
async function listLibrarySummaries(scope: Scope): Promise<LibrarySummary[]> {
  const libraries = await scope.get(Tokens.LibraryService).listAll();
  if (libraries.length === 0) return [];

  const ids = libraries.map((library) => library.id);
  const [scanStates, songCounts] = await Promise.all([
    (await scope.get(Tokens.ScanStateDAO)()).listByLibraries(ids),
    (await scope.get(Tokens.SongDAO)()).countByLibraries(ids),
  ]);

  return libraries.map((library) => summarize(library, scanStates.get(library.id), songCounts.get(library.id)));
}

/**
 * One library's projection.
 *
 * Separate from the batching above so the mapping can be read without the `await`s — and so
 * the two `undefined`s (no scan row, no tracks) stay distinguishable instead of collapsing
 * into a defaulted zero.
 */
function summarize(library: LibraryRow, state: ScanStateRow | undefined, songCount: number | undefined): LibrarySummary {
  return {
    id: library.id,
    slug: library.slug,
    displayName: library.display_name,
    baseUrl: library.base_url,
    rootPath: library.root_path,
    davUsername: library.dav_username,
    isEnabled: library.is_enabled === 1,
    songCount: songCount ?? 0,
    scan: state === undefined ? null : { status: storedStatus(state), scanned: state.scanned_count, lastError: state.last_error },
    createdAt: library.created_at,
  };
}

export { listLibrarySummaries };
export type { LibraryScanSummary, LibrarySummary };
