import type { Container } from './Container';
import type { ServiceEnv } from '../config/ServiceEnv';

/**
 * Single-scope-per-request helper (Otter pattern).
 *
 * `scopeMiddleware` creates one `Container` per request and stores it on the Hono
 * context; handlers resolve via `getRequestScope(c)` instead of calling
 * `createRequestScope(c.env)` per handler (which minted N scopes per request and broke
 * singleton memoization).
 */
interface ScopedContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  readonly env: ServiceEnv;
}

// Namespaced to this project: the key is a property on a shared context
// object, so a collision with a host application would silently return the
// wrong scope.
const SCOPE_KEY = '__edgeSonicScope';

/**
 * The message on the missing-scope throw.
 *
 * Exported so `BaseRoute.getScope`'s fallback can recognise **this** condition rather
 * than catching everything — see the note there. Comparing a string is a fragile contract,
 * so the constant is shared rather than retyped: two literals for one message can drift,
 * and a drift would silently re-enable a per-call-site scope, which is the defect the
 * middleware ordering exists to prevent.
 */
const SCOPE_MISSING_MESSAGE = 'Request scope is not set. Register scopeMiddleware before routes.';

function setRequestScope(c: ScopedContext, scope: Container): void {
  c.set(SCOPE_KEY, scope);
}

/**
 * Structural adapter for Hono contexts.
 * Hono's `Context.get` overloads are not assignable to
 * `ScopedContext['get']`, so call sites used `c as never`. Centralize that
 * single unsafe cast here — one audited location instead of ~30 scattered
 * ones (readability/maintainability; runtime behavior identical).
 */
function asScopedContext(c: { get(key: string): unknown; set?(key: string, value: unknown): void; readonly env: unknown }): ScopedContext {
  return c as unknown as ScopedContext;
}

/**
 * The request's container, or a throw naming the mistake that omitted it.
 *
 * The throw is deliberate rather than a default: a handler that resolved `undefined` would
 * fail several frames away with a `TypeError`, and the one piece of information that fixes
 * it — that `scopeMiddleware` was not registered — would not be in the message.
 */
function getRequestScope(c: ScopedContext): Container {
  const scope = c.get(SCOPE_KEY) as Container | undefined;
  if (!scope) throw new Error(SCOPE_MISSING_MESSAGE);
  return scope;
}

export { setRequestScope, getRequestScope, asScopedContext, SCOPE_KEY, SCOPE_MISSING_MESSAGE };
export type { ScopedContext };