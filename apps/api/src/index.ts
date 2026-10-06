import { EdgeSonicWorker } from './workers/EdgeSonicWorker';

const worker = new EdgeSonicWorker();

export default {
  fetch: (request: Request, env: Cloudflare.Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
};

// Re-exported so the wrangler bindings resolve: `SCAN` names `ScanWorker` and `MEDIA_DO` names
// `MediaWorker`, and a class a binding names has to be reachable from this entrypoint. They are
// two namespaces rather than one class on purpose — see `MediaWorker.ts` for why background and
// request-path work cannot share an object.
export { ScanWorker, MediaWorker, LibraryImportWorkflow, PlayCountImportWorker } from '@edge-sonic/background';
