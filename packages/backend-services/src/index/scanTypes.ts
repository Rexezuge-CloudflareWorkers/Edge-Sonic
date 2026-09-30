/**
 * The contracts `ScanService` needs from the outside world.
 *
 * Split out because they are a different kind of thing from the service. The service is a
 * state machine over a scan; these are the shape of that state machine's inputs, and
 * keeping them here means the file that documents what the service requires is also the
 * file a test's fakes are written against.
 *
 * They are structural rather than nominal on purpose. `ScanService` never imports a DAO -
 * it receives narrow interfaces - so a test can supply a store that answers only the
 * handful of queries its case needs, and a change to a DAO that the scan does not depend
 * on is not a change here.
 */
import type { DerivableRow, DerivationWrite, LibraryRow, NodeRow, ScanStateRow } from '@edge-sonic/backend-data/dao';
import type { WebDavClient } from '@edge-sonic/webdav';
import type { ChunkStopReason } from './scanBudget';

/**
 * What a range read needs to enrich a track, and nothing else.
 *
 * Structural rather than a `SongRow`: the scan holds the facts it just upserted, and
 * fabricating a row to satisfy a signature would be a copy of the schema that rots
 * silently when a column is added.
 */
interface ScanEnrichFacts {
  id: string;
  path: string;
  size: number;
  mtimeMs: number;
}

interface ScanNodeInput {
  libraryId: string;
  path: string;
  parentPath: string;
  name: string;
  mtimeMs: number | null;
  etag: string | null;
  depth: number;
  isScanned?: boolean;
}

interface ScanSongInput {
  id: string;
  libraryId: string;
  path: string;
  dirPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  contentType: string | null;
  suffix: string;
}

interface ScanNodeStore {
  find(libraryId: string, path: string): Promise<NodeRow | null>;
  listChildren(libraryId: string, parentPath: string): Promise<NodeRow[]>;
  listRoots(libraryId: string): Promise<NodeRow[]>;
  listFrontier(libraryId: string, limit: number): Promise<NodeRow[]>;
  upsertMany(inputs: readonly ScanNodeInput[]): Promise<number>;
  deleteSubtree(libraryId: string, path: string): Promise<number>;
  countByLibrary(libraryId: string): Promise<number>;
}

interface ScanSongStore {
  upsertFileFacts(inputs: readonly ScanSongInput[]): Promise<number>;
  deleteInDirectoryNotIn(libraryId: string, dirPath: string, keepPaths: readonly string[]): Promise<number>;
  deleteSubtree(libraryId: string, dirPath: string): Promise<number>;
  countByLibrary(libraryId: string): Promise<number>;
}

interface ScanStateStore {
  find(libraryId: string): Promise<ScanStateRow | null>;
  ensure(libraryId: string): Promise<ScanStateRow>;
  markScanning(libraryId: string, totalCount: number): Promise<void>;
  saveProgress(libraryId: string, scannedCount: number, cursorPath: string | null): Promise<void>;
  complete(libraryId: string, scannedCount: number): Promise<number>;
  /**
   * Record a failure and report how many consecutive failures there have now.
   *
   * The count is the return value rather than a second read, because the bound it
   * feeds is the answer to "may this scan try again?" and a read after the write
   * could observe a different writer's increment.
   */
  fail(libraryId: string, error: string): Promise<number>;
}

/**
 * The store the derivation backfill needs.
 *
 * Separate from `ScanSongStore` because it answers a different question — "which rows are
 * behind the current naming convention, and stamp them" — over a selection no other scan
 * query makes. It is a *version* selection rather than a change selection, which is the
 * whole point: every other song write here happens because a file moved, and this is the
 * one that happens because the convention moved.
 */
interface ScanDerivationStore {
  listNeedingDerivation(libraryId: string, limit: number): Promise<readonly DerivableRow[]>;
  applyDerivation(writes: readonly DerivationWrite[]): Promise<number>;
}

interface ScanDeps {
  nodes: ScanNodeStore;
  songs: ScanSongStore;
  scanState: ScanStateStore;
  /**
   * Backfill the path-derived grouping for rows the file-change path will never revisit.
   *
   * Optional so the doubles in the scan suites are not required to model it, and required
   * in production by the composition root. A scan that cannot derive still walks, which is
   * the right degradation: the aggregates stay empty and nothing else regresses.
   */
  derivation?: ScanDerivationStore;
  /**
   * The `onRequest` callback is forwarded to the client, so every subrequest this
   * scan issues is charged to the chunk's budget — including the ones issued by
   * `enrichSong` below, which run inside the same loop and were previously
   * uncounted.
   */
  clientFor: (row: LibraryRow, onRequest?: () => void) => Promise<WebDavClient>;
  timeoutMs: number;
  /**
  Folders descended into per chunk.

  A bound on **D1 work** — frontier rows read and rows written — sized against the
  5,000-rows/day allowance rather than against the subrequest ceiling. The two are
  different resources, so both bounds exist; see `ScanBudget`.
  */
  chunkFolders: number;
  /**
   * Subrequests one chunk may issue.
   *
   * Sized against the platform's *external* subrequest ceiling. That is 50 on the
   * Free plan and 10,000 on Paid — the 1,000 this was originally sized against was
   * retired on 2026-02-11 — so a default assuming 1,000 produced a chunk that
   * *fails* rather than one that is slow.
   */
  chunkMaxRequests: number;
  /**
   * Milliseconds one chunk may take.
   *
   * The bound that makes a poll *return* on a slow origin: 40 folders at 2.2 s each
   * is 88 seconds of work a client abandoned at 45. Checked between units of work,
   * so a chunk overruns by at most one in-flight request.
   */
  chunkDeadlineMs: number;
  /**
  Fill in a changed track's duration, bitrate and text tags while the scan holds its
  facts in hand.

  Optional, and that is deliberate: the scan is a folder walk and enrichment is a
  per-track range read, so a scan that enriched everything would multiply a cold scan's
  subrequests by the track count. `EnrichmentService` stays the authority — the scan
  calls the same method `getSong` does, so a row enriched here and a row enriched on
  first play are enriched identically.
  *
  * `onRequest` is the chunk's meter, forwarded so a range read is charged to the same
  * budget as the `PROPFIND` that found the file.
  */
  enrichSong?: (library: LibraryRow, facts: ScanEnrichFacts, onRequest?: () => void) => Promise<void>;
  /**
  Tracks enriched per folder, per chunk.

  A bound on the *shape* of a folder, separate from the chunk's own budget: without
  it, one album of 500 changed tracks takes the whole budget on its first folder and
  the walk never advances. An Ogg track costs a prefix read and a tail read, so the
  chunk budget admits one on the cost of two. Whatever does not fit keeps
  `enriched_at = null` and is enriched on first play instead — a track with no
  duration until someone opens it, rather than a chunk that fails.
  */
  enrichMaxPerFolder: number;
}

/**
 * The scan's **output**, alongside the inputs above.
 *
 * `ChunkResult` is what every scan call returns and what the operator surface
 * renders, so it is declared here with the contracts rather than inside
 * `ScanService`: a test writing a fake `scanState` writes against this file, and a
 * field added to the result without a fake that produces it is a field nothing
 * exercises.
 */
/**
 * A scan's state, as the service reports it.
 *
 * `stalled` is separated from `failed` because the two mean opposite things about
 * what happens next: `failed` is retried by the following poll, `stalled` has spent
 * its retry budget and will not be. Collapsing them is what let a wedged scan report
 * as finished — `getScanStatus` derives `scanning` from this value, and both `failed`
 * and a completed scan serialize as `scanning: false`.
 */
type ScanStatus = 'idle' | 'scanning' | 'failed' | 'stalled';

/**
 * How many consecutive failed chunks a scan may spend before it is declared stalled.
 *
 * A bound, not a policy of one. An origin that 500s once must not end a scan, so a
 * single failure is not terminal; a library whose credential is revoked must not be
 * re-attempted on every poll for ever, spending the operator's WebDAV requests to
 * reach the same conclusion each time. Three is the smallest number that separates
 * "flaked" from "broken" without a flag day, and `startScan` resets it — the
 * operator's escape hatch, needing no surface of its own.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

interface ChunkResult {
  readonly status: ScanStatus;
  readonly scanned: number;
  readonly total: number;
  readonly indexVersion: number;
  /**
  Why the last chunk failed, or `null`.

  This is the `scan_state.last_error` the DAO has always written and nothing ever
  read back. An operator polling a failed scan got `status: 'failed'` and no
  reason, which is the same defect as a probe reporting "unreachable": the
  diagnosis existed in the database and never reached the screen.

  Truncated to `LAST_ERROR_MAX` by the service as well as by the DAO, so what the
  operator is shown is exactly what was persisted rather than a longer string the
  database never held.
  */
  readonly lastError: string | null;
  /**
  Folders this chunk actually opened.

  Folders visited, **not** the length of the frontier it was handed. A chunk
  that leaves early because it hit a bound visited fewer than it asked for, and
  reporting the frontier length would claim work that did not happen.
  */
  readonly foldersVisited: number;
  /**
  Subrequests this chunk issued, counted by `WebDavClient` itself.

  Measured rather than accumulated by the walk, which is what makes it a budget:
  the scan's loop used to `+= 1` per `PROPFIND` and charge nothing for the range
  reads its own enrichment made, so it under-reported by up to 40x while the
  field's comment described it as instrumented "so the budget is testable". A
  test asserts this equals what the WebDAV double received, so the two cannot
  drift apart again.
  */
  readonly webdavRequests: number;
  readonly rowsWritten: number;
  /**
  Which bound ended this chunk, or `null` for one that did no work.

  `'frontier'` is the ordinary case. `'requests'` and `'deadline'` say the work
  was cut short by a limit, which is the fact an operator watching a scan that is
  not finishing needs — and the two have different remedies, so they are reported
  separately rather than collapsed into "stopped". `null` is a chunk that had
  nothing to do: no scan running, or a library not yet configured.
  */
  readonly stoppedBy: ChunkStopReason;
}

/**
Bound on a persisted scan failure, matching `ScanStateDAO.fail`.

The text originates upstream, so it is bounded before it is written and again in
the DAO. Two bounds is defence in depth, not drift: the DAO's is a hard guarantee
for every writer, the service's is what the operator is shown.
*/
const LAST_ERROR_MAX = 500;

export type {
  ScanDeps,
  ScanNodeInput,
  ScanNodeStore,
  ScanSongInput,
  ScanSongStore,
  ScanStateStore,
  ScanDerivationStore,
  ScanStatus,
  ChunkResult,
  ScanEnrichFacts,
};
export { LAST_ERROR_MAX, MAX_CONSECUTIVE_FAILURES };

export {type ChunkStopReason} from './scanBudget';