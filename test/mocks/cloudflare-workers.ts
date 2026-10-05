/**
 * Minimal `cloudflare:workers` stand-in for the Node unit pool.
 *
 * Mirrors the Git mock: real DO classes extend the real `DurableObject` on workerd, and this
 * base only stores `ctx`/`env` so lifecycle RPCs can be driven directly without Miniflare.
 *
 * ### `WorkflowEntrypoint` is here, and its shape is load-bearing
 *
 * A Workflow class extends it, so the mock has to provide it or the module fails to evaluate
 * with `Class extends value undefined` — which is a **startup** error, and therefore takes
 * down every suite that reaches `apps/background` for any unrelated reason. `ScanWorker`'s
 * importers are the ones that broke when the Workflow arrived, none of which import the
 * Workflow.
 *
 * So it stores `ctx`/`env` and nothing else, exactly like the Durable Object base. The one
 * thing a test must still be able to do is call `run()` directly, because the *failure policy*
 * under test in `runWorkflow` lives in a plain function precisely so it can be exercised
 * without workerd — see `backend-runtime/src/base/runWorkflow.ts` for why the base class was
 * not hand-declared there instead.
 */
class DurableObject<TEnv = unknown> {
  protected ctx: DurableObjectState;
  protected env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

class WorkflowEntrypoint<TEnv = unknown> {
  protected ctx: ExecutionContext;
  protected env: TEnv;

  constructor(ctx: ExecutionContext, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

export { DurableObject, WorkflowEntrypoint };
