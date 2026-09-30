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

type ScanStub = DurableObjectStub & ScanWorker;

function hasScanBinding(env: unknown): env is { SCAN: DurableObjectNamespace } {
  return (env as { SCAN?: DurableObjectNamespace }).SCAN !== undefined;
}

function getScanStub(env: unknown, libraryId: string): ScanStub {
  const ns = (env as { SCAN?: DurableObjectNamespace }).SCAN;
  if (!ns) throw new Error('SCAN binding is not configured');
  return ns.getByName(libraryId) as unknown as ScanStub;
}

export { getScanStub, hasScanBinding };
export type { ScanStub };
