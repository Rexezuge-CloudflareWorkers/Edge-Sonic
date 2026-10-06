/**
 * The object-backed `ScanDriver` strategy, and the one place the choice between the two is made.
 *
 * ### Why this file rather than a ternary at each call site
 *
 * "Is a Durable Object carrying this scan?" is a property of the **deployment**, and it was being
 * asked at seven sites. Five were `hasScanBinding(...) ? stub : service` shapes, and two of them
 * disagreed about what the *same* question meant: `/rest/getScanStatus` reached
 * `ScanWorker.getStatus` **and** `ScanService.step`, while `GET /user/libraries/:id/scan` reached
 * `ScanWorker.getStatus` **and** `ScanService.status`. One question, two answers, both compiling,
 * both returning a `ChunkResult` — the disagreement would have surfaced only as a scan that
 * advanced when it was asked to report.
 *
 * `ScanDriver` (Layer 3) names the difference, so the read-versus-advance choice is visible as a
 * method name rather than as an accident of which branch each site happened to write.
 *
 * ### Only the object-backed strategy lives here
 *
 * `InProcessScanDriver` is in `backend-services`, beside the service it calls, because it needs
 * nothing this layer has. A namespace stub is `apps/api`'s business — Layer 3 sees
 * `DurableObjectNamespace` as nothing but `unknown` — so the strategy that needs one is here and
 * the strategy that does not is not.
 *
 * ### Neither strategy can reach the media object
 *
 * `ScanDriver` has no `enrichSong` and no `coverArt`, and the media stub is resolved separately in
 * `dispatch.ts`. A driver that falls back to in-process execution cannot silently take over a
 * path whose fallback is a Durable Object — that asymmetry is what the `MediaWorker` split is for,
 * and widening the port would quietly undo it.
 */
import type { SubrequestMeter } from '@edge-sonic/shared';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { ChunkResult } from '@edge-sonic/backend-services/index';
import type { ScanDriver, ScanRunner } from '@edge-sonic/backend-services/library';
import { InProcessScanDriver } from '@edge-sonic/backend-services/library';
import { getScanStub, hasScanBinding } from './scanStubs';

/**
 * One RPC per operation, and no walk work in the fetch isolate.
 *
 * `advance` calls `stepOnce`, which runs **one bounded chunk in the object's own isolate**. That is
 * deliberate and is not the same as "the object advances it": the object's alarm is what advances a
 * scan unattended, and this is the operator's manual single-chunk trigger, which the object exists
 * to serve without spending the caller's budget on a walk.
 */
class DurableObjectScanDriver {
  constructor(
    private readonly env: unknown,
    private readonly meter?: SubrequestMeter,
  ) {}

  public async start(library: LibraryRow): Promise<ChunkResult> {
    return await getScanStub(this.env, library.id, this.meter).startScan(library.id);
  }

  public async advance(library: LibraryRow): Promise<ChunkResult> {
    return await getScanStub(this.env, library.id, this.meter).stepOnce(library.id);
  }

  public async readState(libraryId: string): Promise<ChunkResult> {
    return await getScanStub(this.env, libraryId, this.meter).getStatus(libraryId);
  }

  /**
   * A **read**, and the reason `/rest/getScanStatus` stops advancing here.
   *
   * The object's alarm advances the scan without a client, so a poll that also did a chunk would
   * be spending a walk a client asked a question to. That is the defect the `scanning` predicate
   * and this method were both written for: a client backing off must stop *doing work*, not stop
   * *observing* it.
   */
  public async pollStatus(library: LibraryRow): Promise<ChunkResult> {
    return await this.readState(library.id);
  }

  public async stateForLibraryList(libraryId: string): Promise<ChunkResult> {
    return await this.readState(libraryId);
  }
}

/**
 * The one decision, made once per request.
 *
 * `scan` is a **thunk** because this is called while the scope is being built and the walk does
 * not exist yet — the same answer `scopeMiddleware`'s `meterOf` gives, for the same reason.
 * Reading it at the point of use is what keeps the driver and the scope on the same graph;
 * constructing a second scope to get a real value would mint a second `SubrequestCounter`, and a
 * second counter is a second number that disagrees with the platform's.
 *
 * Both branches are constructed and only one is used, which is the price of deciding once — a
 * per-call-site ternary constructs neither. Neither strategy holds request state, so the unused one
 * costs an object.
 */
function resolveScanDriver(env: unknown, scan: () => ScanRunner, meter?: SubrequestMeter): ScanDriver {
  return hasScanBinding(env) ? new DurableObjectScanDriver(env, meter) : new InProcessScanDriver(scan);
}

export { resolveScanDriver, DurableObjectScanDriver };