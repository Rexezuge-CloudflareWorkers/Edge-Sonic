/**
 * `ScanDriver` — the port through which a caller reaches "the thing that advances a library's
 * index", and the two strategies behind it.
 *
 * ### The decision this file exists to make **once**
 *
 * Whether a Durable Object is carrying the scan loop is a property of the **deployment**, not of
 * the call site, and it was being asked at five of them: `system.ts` twice, `user/routes.ts`
 * three times, `scopeMiddleware` and `dispatch` each once. Five sites is five places to add a
 * binding, five to forget one, and five to leave disagreeing.
 *
 * Worse, they did not agree. Asking "what is this library's scan state?" reached
 * `ScanWorker.getStatus` **and** `ScanService.step` from one route, and `ScanWorker.getStatus`
 * **and** `ScanService.status` from another — so one question had two answers depending on
 * deployment configuration, which is this repository's most-repeated shape of defect: *a
 * comparison written twice is two answers, and the one that was absent is the one that shipped.*
 * Here both were present, and the difference was invisible because both compile and both return
 * a `ChunkResult`.
 *
 * So the two are **named** rather than chosen per call site. `readState` is passive on both
 * strategies. `advance` is passive on the object (the object advances itself from its alarm) and
 * does a chunk in-process when there is no object to do it. `pollStatus` is the legacy
 * client-driven compromise, and it is a third name because it is a third behaviour — see its own
 * comment, which is the honest place for why it differs.
 *
 * ### Why the port is a parameter and not read off `env`
 *
 * A layer boundary rather than a convenience. Reaching a Durable Object means a namespace stub,
 * and constructing one is `apps/api`'s business — Layer 3 cannot see `DurableObjectNamespace` as
 * anything but `unknown` on `RequestScopeEnv`. Exactly the argument `IndexDropService`'s
 * `scanFor` makes, and for the same reason — which is also why **this** file holds the in-process
 * strategy and `apps/api` holds the object-backed one.
 *
 * ### The object-backed strategy charges a subrequest meter; this one has nothing to charge
 *
 * A Durable Object RPC is a subrequest and `getScanStub` charges one at resolution. There is no
 * equivalent charge here, and there should not be: an RPC that did not happen spent nothing, and
 * inventing a charge for it would make the ceiling describe work the platform never did.
 */
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { ChunkResult, ScanDailyBudget } from '../index';

/**
 * The three operations an in-process driver needs from the walk.
 *
 * A **port**, not `ScanService`, and that is a testability and layering decision rather than a
 * smallness one. `ScanService` carries four private members — its dependency bundle, its clock,
 * its per-chunk budget factory and its folder-probe helper — so nothing outside it can be handed
 * one structurally, and a driver typed against the class can only be exercised through a cast.
 * A cast is exactly the hole this repository keeps getting bitten by: two implementations free to
 * disagree, and nothing measuring the pair.
 *
 * `ScanService` satisfies this by construction, and so does a three-spy fake — which is what lets
 * `test/scan-driver.test.ts` assert *which* method each named operation reaches, which is the whole
 * invariant.
 */
interface ScanRunner {
  start(library: LibraryRow, dailyBudget?: () => ScanDailyBudget): Promise<ChunkResult>;
  step(library: LibraryRow, dailyBudget?: () => ScanDailyBudget): Promise<ChunkResult>;
  status(libraryId: string): Promise<ChunkResult>;
}

/**
 * What every caller needs from "the thing that advances this library's index".
 *
 * Deliberately narrow: three operations and no `enrichSong`/`coverArt`. Those are the media
 * object's, they run on request latency rather than on the scan's schedule, and they are not
 * reachable through a driver that falls back to in-process execution.
 */
interface ScanDriver {
  /**
   * Seed the frontier and report. Never does walk work beyond the root probe `start` performs.
   *
   * Takes the **row**, not the id: the in-process `ScanService.start` needs the library's origin
   * and credential, and a route that does not hold a row would have to fabricate one — a copy of
   * the schema that rots silently when a column is added.
   */
  start(library: LibraryRow): Promise<ChunkResult>;
  /**
   * Do one bounded chunk. Takes the row, for `ScanService.step`'s sake, on the same argument.
   */
  advance(library: LibraryRow): Promise<ChunkResult>;
  /**
   * The library's stored scan state, without doing work — the operator surface's read.
   *
   * Takes an **id**, because nothing on this path needs the row: `ScanService.status` and
   * `ScanWorker.getStatus` both read by library id. A signature demanding a row here would be a
   * row the caller has to invent.
   */
  readState(libraryId: string): Promise<ChunkResult>;
  /**
   * The `/rest/getScanStatus` behaviour, which is a read **or** an advance depending on the
   * deployment, and is the only operation here whose two strategies differ in kind rather than in
   * place.
   *
   * On an object it is `readState`, so polling never does work and a client that backs off keeps
   * observing progress instead of stopping it. With no object there is nothing advancing the scan
   * except a poll, so it is `advance` — the legacy client-driven path the suite exercises.
   *
   * A third name rather than an overload of the first two, because folding it into either would
   * have hidden the asymmetry that produced the two answers in the first place. It takes the row
   * because the in-process branch does walk work.
   */
  pollStatus(library: LibraryRow): Promise<ChunkResult>;
  /**
   * The library's state for the operator's library list, or `null` when nothing can report one.
   *
   * `null` rather than a `ChunkResult` because the caller overlays it on a D1-derived summary, and
   * an overlay built from nothing is not the same claim as one built from a pause. On the
   * in-process strategy it is always `null`: a pause is held in Durable Object storage because it
   * is usually *caused* by D1 refusing writes, so an in-process answer has no pause to report and
   * pretending otherwise would put D1's stale `scanning` back on the page.
   */
  stateForLibraryList(libraryId: string): Promise<ChunkResult | null>;
}

/**
 * The in-process strategy: every operation is a direct service call, and the scan is
 * client-driven.
 *
 * ### `ScanService` arrives as a **thunk**, and it has to
 *
 * The driver is built by the composition root's caller — `scopeMiddleware` — at the moment the
 * scope is being constructed, so the service it would hold does not exist yet. A thunk is the
 * same answer `scopeMiddleware`'s `meterOf` gives for the same reason: read it at the point of
 * use, out of the scope that owns it, rather than close over a value that is not there.
 *
 * It is called per operation rather than memoized, which is safe because `Tokens.ScanService` is
 * itself a memoized factory: every call returns the same instance.
 *
 * ### `stateForLibraryList` is always `null`, and that is the honest answer
 *
 * A pause is held in Durable Object storage **because it is usually caused by D1 refusing
 * writes** — so with no object there is no pause to read back. Returning a `ChunkResult` here
 * would overlay the operator's library list with a second, weaker claim about a field D1 already
 * answers, and the whole point of the overlay is the one status D1 is guaranteed stale about.
 *
 * ### `pollStatus` advances, and it is the only operation where that is not a fallback
 *
 * `readState` and `advance` are the same question asked two ways, and each caller wants a fixed
 * one. `pollStatus` is `/rest/getScanStatus`, which has no caller-chosen answer: with no object
 * nothing else advances the scan, so a passive reply would be a library that never indexes — which
 * is the shipped defect this port exists to end. With an object it is a plain read.
 */
class InProcessScanDriver {
  constructor(private readonly scan: () => ScanRunner) {}

  public async start(library: LibraryRow): Promise<ChunkResult> {
    return await this.scan().start(library);
  }

  public async advance(library: LibraryRow): Promise<ChunkResult> {
    return await this.scan().step(library);
  }

  public async readState(libraryId: string): Promise<ChunkResult> {
    return await this.scan().status(libraryId);
  }

  public async pollStatus(library: LibraryRow): Promise<ChunkResult> {
    return await this.scan().step(library);
  }

  public async stateForLibraryList(): Promise<ChunkResult | null> {
    return null;
  }
}

export { InProcessScanDriver };
export type { ScanDriver, ScanRunner };
