/**
 * Durable Object stubs for the per-library scan worker.
 *
 * Git `doStubs.ts` pattern: one stub per entity via `getByName`, so each
 * library's scan loop, enrichment CPU and cover-art CPU run in its own
 * isolate. Callers check `hasScanBinding` first and fall back to the direct
 * service when no binding is configured (tests, local dev without DO) — the
 * fallback is what keeps the suite green without workerd.
 */
import type { ScanWorker } from '@edge-sonic/background';
import type { SubrequestMeter } from '@edge-sonic/shared';

type ScanStub = DurableObjectStub & ScanWorker;

function hasScanBinding(env: unknown): env is { SCAN: DurableObjectNamespace } {
  return (env as { SCAN?: DurableObjectNamespace }).SCAN !== undefined;
}

/**
 * @param meter The invocation's counter. A Durable Object RPC is a subrequest, so a stub the
 *   scan or a cover lookup calls into is spending from the same 50 as everything else. It was
 *   not counted, which is why `getCoverArt` — the one endpoint that may make a DO call *and* up
 *   to six ranged reads — was the hardest request in the product to reason about and the
 *   easiest to overrun.
 */
function getScanStub(env: unknown, libraryId: string, meter?: SubrequestMeter): ScanStub {
  const ns = (env as { SCAN?: DurableObjectNamespace }).SCAN;
  if (!ns) throw new Error('SCAN binding is not configured');
  meter?.charge(1, 'rpc');
  return ns.getByName(libraryId) as unknown as ScanStub;
}

export { getScanStub, hasScanBinding };
export type { ScanStub };
