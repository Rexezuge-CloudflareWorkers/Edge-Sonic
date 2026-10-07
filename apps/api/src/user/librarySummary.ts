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
 *
 * ### And why this projection has to survive D1 refusing every query
 *
 * Because it is the page an operator opens to find out what is wrong, and since 2026-09-01 an
 * account over D1's daily row allowance has **every query fail** until midnight UTC — these two
 * included. Two D1 reads and no fallback meant a `500`, which is the answer that sends somebody
 * to debug their own database instead of reading *"the write allowance is spent; it resets at
 * 00:00 UTC"*.
 *
 * There are two distinct events here and conflating them is how this page would end up lying
 * twice. They need different answers, and only one of them is answerable on this surface.
 *
 * **D1 is refusing every query.** Then this projection cannot be built at all: `libraries` is
 * itself a D1 read, so there is nothing to enumerate. The answer is not a partial list — it is
 * `toUserResponse`'s `503` carrying the reason and the hour it resumes, which comes from
 * `ErrorMapper` and is asserted there and in `test/user-api.test.ts`. A list of zero libraries
 * would be the worst available answer, because "No libraries yet" is the one sentence on this page
 * that means something is genuinely absent.
 *
 * **A scan is paused while D1 is perfectly healthy.** That is the *preventive* half — the library
 * spent its share of the day's row-write allowance, so the scan stopped before the platform
 * refused anything — and here D1's `scan_state` row is simply wrong about it, because a pause is
 * held in Durable Object storage and `scan_state` still says `scanning`. Which an operator reads
 * as working and a client reads as poll-me. So the scan state is read from the per-library Durable
 * Object as well, and its answer wins.
 *
 * The DO read is a read, which is what makes the pause visible without turning a page an operator
 * polls every few seconds into a writer on an allowance that is already spent.
 */
import { Tokens } from '@edge-sonic/backend-services/composition';
import type { createRequestScope } from '@edge-sonic/backend-services/composition';
import { storedStatus } from '@edge-sonic/backend-services/index';
import type { ChunkResult, EnrichChunkResult } from '@edge-sonic/backend-services/index';
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
 *   state. `resumeAt` is the exception and is here, because a pause is not a property of a chunk
 *   — it is the state the scan is in, and it lasts until a moment an operator needs told.
 * - **`total_count`** is written as `0` by `markScanning` and never updated, so it is not a
 *   denominator. Publishing it would invite a client to render "12 of 0". Progress here is
 *   `songCount`, which is the protocol's own unit — what `getScanStatus` publishes as `count`
 *   — plus `scanned`, which counts folders visited.
 */
interface LibraryScanSummary {
  readonly status: 'idle' | 'scanning' | 'failed' | 'stalled' | 'paused';
  readonly scanned: number;
  readonly lastError: string | null;
  /**
   * When a paused scan resumes itself, epoch milliseconds. `null` for every other status,
   * because "when it resumes" has no meaning for a scan that resumes on its next poll.
   */
  readonly resumeAt: number | null;
}

/**
 * The enrichment half of a library's wire shape.
 *
 * `enriched` is the current run's total — tracks stamped since the run started — and
 * `remaining` is the live count still owing a tag read, so the operator watches one
 * number grow and one fall rather than two numbers that have to agree. Both ride the
 * same batched poll as the scan half, and neither is nullable inside the object: a
 * library with nothing owing reports `remaining: 0`, which is a measurement rather than
 * an absence.
 */
interface LibraryEnrichSummary {
  readonly status: 'idle' | 'enriching' | 'failed' | 'stalled' | 'paused';
  readonly enriched: number;
  readonly remaining: number;
  readonly lastError: string | null;
  /**
   * When a paused run resumes itself, epoch milliseconds; `null` otherwise.
   */
  readonly resumeAt: number | null;
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
   * Tracks indexed for this library. A real count, from `songs`.
   *
   * Not nullable, and deliberately: this projection only exists when D1 answered, because
   * `libraries` is a D1 read. When D1 is refusing, the request is a `503` naming the reason and
   * the hour it resumes — see the module header — so there is no "count unavailable" state to
   * render here, and adding one would be a field with no path that produces it.
   */
  readonly songCount: number;
  /**
   * `null` when the library has never been scanned. See the module header.
   */
  readonly scan: LibraryScanSummary | null;
  /**
   * `null` when no enrichment run was ever started and tracks remain. A library whose
   * tracks were all enriched lazily reports `idle` with `remaining: 0`, not `null` —
   * `null` says nobody has asked, not that nothing is owed.
   */
  readonly enrich: LibraryEnrichSummary | null;
  readonly createdAt: number;
}

/**
 * Build the wire list.
 *
 * The Durable Object reads run concurrently with the D1 ones, because they are the only source for
 * a pause and a pause is the one answer `scan_state` cannot give. They are not awaited first: that
 * would add a round trip to a page an operator polls every few seconds, and nothing here depends
 * on their order.
 */
async function listLibrarySummaries(
  scope: Scope,
  scanStatusFor: (libraryId: string) => Promise<ChunkResult | null>,
  enrichStatusFor?: (libraryId: string) => Promise<EnrichChunkResult | null>,
): Promise<LibrarySummary[]> {
  const libraries = await scope.get(Tokens.LibraryService).listAll();
  if (libraries.length === 0) return [];

  const ids = libraries.map((library) => library.id);
  const [fromWorkers, scanStates, songCounts, enrichStatuses] = await Promise.all([
    Promise.all(ids.map(async (id) => await safeScanStatus(scanStatusFor, id))),
    (await scope.get(Tokens.ScanStateDAO)()).listByLibraries(ids),
    (await scope.get(Tokens.SongDAO)()).countByLibraries(ids),
    enrichStatusFor === undefined
      ? Promise.resolve(ids.map(() => null))
      : Promise.all(ids.map(async (id) => await safeEnrichStatus(enrichStatusFor, id))),
  ]);

  return libraries.map((library, index) =>
    summarize(library, scanStates.get(library.id), songCounts.get(library.id), fromWorkers[index] ?? null, enrichStatuses[index] ?? null),
  );
}

/**
 * One library's Durable Object status, or `null` when there is no binding or the call failed.
 *
 * `null` for a failed call is deliberate: a Durable Object that cannot be reached is a different
 * event from a scan that is paused, and reporting `paused` for an RPC fault would tell an operator
 * to wait for midnight over a broken binding. The scan's status comes from D1 in that case, which
 * is where it comes from whenever D1 is answering — and D1 *is* answering on the only path that
 * reaches this, because `libraries` is itself a D1 read.
 */
async function safeScanStatus(
  scanStatusFor: (libraryId: string) => Promise<ChunkResult | null>,
  libraryId: string,
): Promise<ChunkResult | null> {
  try {
    return await scanStatusFor(libraryId);
  } catch {
    return null;
  }
}

/**
 * One library's projection.
 *
 * Separate from the batching above so the mapping can be read without the `await`s — and so
 * the two `undefined`s (no scan row, no tracks) stay distinguishable instead of collapsing
 * into a defaulted zero.
 */
function summarize(
  library: LibraryRow,
  state: ScanStateRow | undefined,
  songCount: number | undefined,
  status: ChunkResult | null,
  enrich: EnrichChunkResult | null,
): LibrarySummary {
  return {
    id: library.id,
    slug: library.slug,
    displayName: library.display_name,
    baseUrl: library.base_url,
    rootPath: library.root_path,
    davUsername: library.dav_username,
    isEnabled: library.is_enabled === 1,
    songCount: songCount ?? 0,
    scan: scanSummary(state, status),
    enrich: enrichSummary(enrich),
    createdAt: library.created_at,
  };
}

/**
 * One library's scan summary, from the Durable Object where it holds something D1 cannot.
 *
 * Precedence is the whole of this function, and it is the reverse of what a reader expects: the
 * DO's answer wins. A pause lives in the DO's storage because it is caused by D1 refusing writes,
 * so D1's row is *guaranteed* stale about it — it says `scanning`, which is the answer that makes
 * an operator wait and a client poll. D1 still fills the counts when the DO has nothing to add,
 * because those are measurements and the DO does not hold them.
 */
function scanSummary(state: ScanStateRow | undefined, status: ChunkResult | null): LibraryScanSummary | null {
  if (status?.status === 'paused') {
    return { status: 'paused', scanned: status.scanned, lastError: status.lastError, resumeAt: status.resumeAt };
  }
  if (state === undefined) return null;
  return { status: storedStatus(state), scanned: state.scanned_count, lastError: state.last_error, resumeAt: null };
}

/**
 * One library's enrichment status, or `null` when there is no binding or the call failed.
 *
 * `null` for a failed call is deliberate, for the scan's reason: a Durable Object that
 * cannot be reached is a different event from a run that is paused, and reporting
 * `paused` for an RPC fault would tell an operator to wait for midnight over a broken
 * binding.
 */
async function safeEnrichStatus(
  enrichStatusFor: (libraryId: string) => Promise<EnrichChunkResult | null>,
  libraryId: string,
): Promise<EnrichChunkResult | null> {
  try {
    return await enrichStatusFor(libraryId);
  } catch {
    return null;
  }
}

/**
 * One library's enrichment summary, from the run's own object.
 *
 * Unlike the scan half there is no D1 row to fall back to: progress lives in Durable
 * Object storage because metering D1 writes must not itself spend D1 writes, so with
 * nothing from the object there is no run to report. That is also why the in-process
 * fallback reports `null` until nothing remains — a live count is a measurement, not a
 * run, and the list must not dress one as the other.
 */
function enrichSummary(status: EnrichChunkResult | null): LibraryEnrichSummary | null {
  if (status === null) return null;
  return {
    status: status.status,
    enriched: status.enriched,
    remaining: status.remaining,
    lastError: status.lastError,
    resumeAt: status.resumeAt,
  };
}

export { listLibrarySummaries };
export type { LibraryEnrichSummary, LibraryScanSummary, LibrarySummary };
