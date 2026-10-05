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
import type { DerivableRow, DerivationWrite, LibraryRow, NodeRow, ScanStateRow, WriteBatchResult } from '@edge-sonic/backend-data/dao';
import type { SubrequestCounter, SubrequestSpend } from '@edge-sonic/shared';
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
  /**
   * `WriteBatchResult` and not a count, because a cold album of 500 tracks is ~500 statements
   * against a ceiling of 50 and is *expected* to come back truncated on a Free plan. The scan
   * has to see that, because the one write it must not do for a half-written folder is the
   * folder's own row carrying `is_scanned: true`.
   */
  upsertMany(inputs: readonly ScanNodeInput[]): Promise<WriteBatchResult>;
  deleteSubtree(libraryId: string, path: string): Promise<number>;
  countByLibrary(libraryId: string): Promise<number>;
}

interface ScanSongStore {
  upsertFileFacts(inputs: readonly ScanSongInput[]): Promise<WriteBatchResult>;
  /**
   * `WriteBatchResult` for the same reason `upsertFileFacts` is: a folder that lost 200 tracks
   * is a 200-statement delete against a ceiling of 50, and the scan does not act on the
   * truncation — it is idempotent and the next chunk finishes it — but it must not be *told*
   * it deleted rows it did not.
   */
  deleteInDirectoryNotIn(libraryId: string, dirPath: string, keepPaths: readonly string[]): Promise<WriteBatchResult>;
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
   * The invocation's subrequest counter.
   *
   * Every D1 statement and KV operation the scan causes is charged here, from inside the DAO
   * and the cache, because those are constructed once per request scope and hold a reference to
   * this counter. It is also what `ScanBudget` wraps, so the budget the chunk decides against
   * and the counter the DAOs write to cannot be two different numbers.
   */
  subrequests: SubrequestCounter;
  /**
   * The `onRequest` callback is forwarded to the client, so every WebDAV subrequest this scan
   * issues is charged to the same counter — including the ones issued by `enrichSong` below,
   * which run inside the same loop.
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
   * Subrequests one chunk may issue, of **every** kind.
   *
   * The platform ceiling is 50 per invocation on the Free plan and D1 counts its own queries
   * against it, so a budget that counted only `fetch` was not a budget. Derived in
   * `subrequests.ts`; see `ConfigurationDefaults` for what it was instead.
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

  A bound on the *shape* of a folder, separate from the chunk's own budget: without it, one
  album of 500 changed tracks takes every poll for itself and the folders behind it are never
  walked. Whatever does not fit keeps `enriched_at = null` and is enriched on first play
  instead — a track with no duration until someone opens it, rather than a chunk that dies.
  */
  enrichMaxPerFolder: number;
  /**
   * Clock, for the midnight-UTC arithmetic. Absent means `Date.now()`.
   *
   * Injected rather than reached for so the boundary can be asserted: a reset computed as
   * already-past is a pause of zero length, and a zero-length pause is the one-second loop the
   * pause exists to stop.
   */
  now?: () => number;
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
 *
 * `paused` is a third thing again, and it is the reason the two above are not enough. It
 * means **retried by itself, at a known time, needing no operator**: the chunk will not run
 * until a wall-clock moment arrives, so retrying is not merely useless (as it is for
 * `stalled`) but *actively harmful*, and the retry counter has nothing to say about it.
 *
 * It exists because D1's Free-plan daily row allowance is **enforced**: since 2026-09-01 an
 * account over it has every query fail — reads included — until midnight UTC, so the whole
 * product is down and the old path through this machine treated it as a scan failure. `step`
 * caught the refusal, tried to record it with a D1 write that could not succeed, and returned
 * `failed`; `isAdvancing('failed')` is true, so `ScanWorker` re-armed one second later and did
 * it again, roughly 86,000 times before the reset. Nothing was retried in any useful sense, no
 * reason reached an operator, and the allowance was spent long before that.
 *
 * It is not persisted as a `scan_state.status`, and that is deliberate rather than convenient:
 * a pause entered *because D1 is refusing writes* has nowhere to be written. It lives in the
 * Durable Object's storage, which is the one store still accepting them. See `ScanWorker`.
 */
type ScanStatus = 'idle' | 'scanning' | 'failed' | 'stalled' | 'paused';

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

/**
 * What the caller knows about the account's row-write allowance for today.
 *
 * Supplied by `ScanWorker`, which owns the Durable Object's storage and therefore the count,
 * because **metering D1 writes must not itself spend D1 writes**: a counter in `scan_state`
 * would cost a row per chunk against the very allowance it enforces, and one extra statement out
 * of a 42-statement chunk is 2.4% of a budget that is already the binding constraint.
 *
 * The limit is a *share*, not the whole allowance — D1's is per account, so a per-library cap
 * is unsound as soon as a second library exists. See `dailyRowWriteShare`.
 */
interface ScanDailyBudget {
  /**
   * Rows written today across every library, as the caller counts them.
   *
   * A **lower bound**, deliberately: the count is persisted at most once per
   * `SCAN_ROW_COUNT_PERSIST_INTERVAL` rows, so a crash can overshoot the day's budget by at
   * most that interval. That is why the interval is inside the platform's reserve rather than
   * taken out of it.
   */
  readonly rowsWrittenToday: number;
  /**
   * Rows this library may write today. `dailyRowWriteShare` of the account's budget.
   */
  readonly limit: number;
  /**
   * Epoch milliseconds, injectable so the midnight boundary is testable — the boundary is where
   * a reset computed as already-past becomes a pause of zero length and the whole mechanism
   * turns back into a one-second loop.
   */
  readonly now: () => number;
}

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
  Subrequests this chunk issued, per kind.

  Measured at every charge point rather than accumulated by the walk — `WebDavClient` for
  `fetch`, `BaseDAO.withRetry` and `BaseDAO.runWriteBatch` for `d1`, `KvCache.guard` for `kv` —
  and all of them writing to the one counter the chunk reads.

  It was `webdavRequests: number`, and the rename is the fix rather than cosmetics. A field
  called `webdavRequests` on a chunk that spends most of its budget on D1 is a field whose name
  contradicts its value, and the test that guarded it asserted the value equalled the WebDAV
  double's count — so it was **green** while the chunk spent five times the ceiling on
  statements nobody counted. `test/scan-budget.test.ts` now asserts the total against all three
  doubles.
  */
  readonly subrequests: SubrequestSpend;
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
  /**
   * When this chunk will be attempted again on its own, epoch milliseconds, or `null`.
   *
   * `null` for every chunk that is not `paused`, including one that ran out of frontier — the
   * next chunk is the next alarm and nothing needs saying about it. A value means the opposite:
   * **this scan will not advance until this moment**, and it will do so without a client, an
   * operator, or a `startScan`.
   *
   * It is a field rather than something derived from `status` because the two consumers want
   * opposite things from the same status. `ScanWorker.armIfAdvancing` needs to know that the
   * alarm stays armed and when; `getScanStatus`'s `scanning` needs to know that a client's poll
   * buys nothing, because polling *cannot* buy anything and a client told otherwise polls for
   * hours. One predicate answering both is how `scanning: false` once stopped every scan in the
   * product — so `willResumeWithoutAPoll` and `isAdvancing` are separate functions and both are
   * asserted.
   */
  readonly resumeAt: number | null;
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
  ScanDailyBudget,
  ScanStatus,
  ChunkResult,
  ScanEnrichFacts,
};
export { LAST_ERROR_MAX, MAX_CONSECUTIVE_FAILURES };

export {type ChunkStopReason} from './scanBudget';