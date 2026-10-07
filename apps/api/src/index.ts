import { EdgeSonicWorker } from './workers/EdgeSonicWorker';

const worker = new EdgeSonicWorker();

export default {
  fetch: (request: Request, env: Cloudflare.Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
};

// Re-exported so the wrangler bindings resolve: `SCAN` names `ScanWorker`, `MEDIA_DO` names
// `MediaWorker` and `ENRICH` names `EnrichWorker`, and a class a binding names has to be
// reachable from this entrypoint. They are three namespaces rather than one class on purpose —
// see `MediaWorker.ts` and `EnrichWorker.ts` for why background loops cannot share an object.
export { ScanWorker, MediaWorker, EnrichWorker, LibraryImportWorkflow, PlayCountImportWorker } from '@edge-sonic/background';
