/**
 * Composition root for `ScanWorker` (Factory pattern).
 *
 * Extracts the scope wiring out of the Durable Object constructor so the DO
 * keeps routing/lifecycle only and the graph is unit-testable without workerd.
 */
import { createRequestScope } from '@edge-sonic/backend-services/composition';
import type { RequestScopeEnv } from '@edge-sonic/backend-services/composition';

function createScanWorkerScope(env: RequestScopeEnv): ReturnType<typeof createRequestScope> {
  return createRequestScope(env);
}

export { createScanWorkerScope };
