// Minimal Workers-compatible context types so `backend-runtime` (Layer 1)
// typechecks without the generated `worker-configuration.d.ts`, which lives at the
// repository root and belongs to `apps/api`.
//
// `env` is `unknown` here on purpose. This package must not know the worker's
// binding shape — that is the app's business — and asserting a binding interface
// at Layer 1 would invert the dependency. An app narrows `onRequest`'s parameter
// to its own `Cloudflare.Env`, which TypeScript permits because method parameters
// are bivariant.
interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

abstract class AbstractEntrypointWorker {
  public async fetch(request: Request, env: unknown, ctx: WorkerExecutionContext): Promise<Response> {
    try {
      return await this.onRequest(request, env as never, ctx);
    } catch (err: unknown) {
      console.error('Unhandled error in fetch():', err);
      return new Response('Internal Error', { status: 500 });
    }
  }

  protected abstract onRequest(request: Request, env: never, ctx: WorkerExecutionContext): Promise<Response>;
}

export { AbstractEntrypointWorker };
export type { WorkerExecutionContext };
