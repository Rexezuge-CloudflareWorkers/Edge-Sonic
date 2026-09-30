/**
 * Minimal `cloudflare:workers` stand-in for the Node unit pool.
 *
 * Mirrors the Git mock: real DO classes extend the real `DurableObject` on
 * workerd, and this base only stores `ctx`/`env` so lifecycle RPCs can be
 * driven directly without Miniflare.
 */
class DurableObject<TEnv = unknown> {
  protected ctx: DurableObjectState;
  protected env: TEnv;

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

export { DurableObject };
