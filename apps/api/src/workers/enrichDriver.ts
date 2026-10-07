/**
 * The object-backed `EnrichDriver` strategy, and the one place the choice between the two is made.
 *
 * The scan's `scanDriver.ts` for the enrichment loop, and separate from it for the reason
 * `EnrichDriver` states: the two answer different questions about what is running, and one
 * question decided in the scan's file is one edit from being answered by the scan's loop.
 */
import type { SubrequestMeter } from '@edge-sonic/shared';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { EnrichChunkResult } from '@edge-sonic/backend-services/index';
import type { EnrichDriver, EnrichRunner } from '@edge-sonic/backend-services/library';
import { InProcessEnrichDriver } from '@edge-sonic/backend-services/library';
import { getEnrichStub, hasEnrichBinding } from './scanStubs';

/**
 * One RPC per operation, and no enrich work in the fetch isolate.
 *
 * `advance` calls `stepOnce`, which runs **one bounded chunk in the object's own isolate**.
 * The object's alarm is what advances a run unattended, and this is the operator's manual
 * single-chunk trigger — which the object exists to serve without spending the caller's
 * budget on range reads.
 */
class DurableObjectEnrichDriver {
  constructor(
    private readonly env: unknown,
    private readonly meter?: SubrequestMeter,
  ) {}

  public async start(library: LibraryRow): Promise<EnrichChunkResult> {
    return await getEnrichStub(this.env, library.id, this.meter).startEnrich(library.id);
  }

  public async advance(library: LibraryRow): Promise<EnrichChunkResult> {
    return await getEnrichStub(this.env, library.id, this.meter).stepOnce(library.id);
  }

  public async readState(libraryId: string): Promise<EnrichChunkResult | null> {
    return await getEnrichStub(this.env, libraryId, this.meter).getStatus(libraryId);
  }

  public async stateForLibraryList(libraryId: string): Promise<EnrichChunkResult | null> {
    return await this.readState(libraryId);
  }
}

/**
 * The one decision, made once per request.
 *
 * Both branches are constructed and only one is used, which is the price of deciding
 * once. Neither strategy holds request state, so the unused one costs an object.
 */
function resolveEnrichDriver(
  env: unknown,
  enrich: () => EnrichRunner,
  remaining: (libraryId: string) => Promise<number>,
  meter?: SubrequestMeter,
): EnrichDriver {
  return hasEnrichBinding(env) ? new DurableObjectEnrichDriver(env, meter) : new InProcessEnrichDriver(enrich, remaining);
}

export { resolveEnrichDriver, DurableObjectEnrichDriver };
