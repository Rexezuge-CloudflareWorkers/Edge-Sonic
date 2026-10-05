import { EdgeSonicWorker } from './workers/EdgeSonicWorker';

const worker = new EdgeSonicWorker();

export default {
  fetch: (request: Request, env: Cloudflare.Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
};

export { ScanWorker, LibraryImportWorkflow, PlayCountImportWorker } from '@edge-sonic/background';
