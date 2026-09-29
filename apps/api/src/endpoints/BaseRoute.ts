/**
 * The shared request context and the base class every route handler uses.
 *
 * ### Why this is its own module
 *
 * The context type used to be declared in `user/routes.ts` (previously `admin/routes.ts`)
 * and imported *backwards* by `rest/dispatch.ts` and `middleware/userAuth.ts` — so a route
 * module owned the type that `/rest`, `/user`, and the auth middleware all shared, and each
 * of those three re-declared its own copy inline. Two of those copies had already drifted:
 * they named an `AuthenticatedUserEmailAddress` variable that nothing in this worker ever
 * set. One declaration, imported everywhere, is the fix that makes drift impossible
 * rather than merely absent today.
 *
 * It also brings `user/routes.ts` back under the 300-line god-file warn: `BaseRoute`
 * and the type are ~100 lines that were sitting in a route module.
 *
 * ### `type C` is not a public name
 *
 * `UserContext` is the type; `C` is the one-character alias handlers take, because
 * every signature below repeats the full name and the repetition is noise.
 * `sonarjs/redundant-type-aliases` objects, and it is switched off with that reason
 * recorded in `eslint.config.mjs`.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Context } from 'hono';
import { BadRequestError } from '@edge-sonic/backend-errors';
import { createRequestScope } from '@edge-sonic/backend-services/composition';
import { getRequestScope, asScopedContext } from '@edge-sonic/backend-runtime/di';
import { toUserResponse } from '@edge-sonic/backend-services/errors';
import type { UserErrorBody } from '@edge-sonic/backend-services/errors';

/**
 * The Worker's environment shape.
 *
 * `AuthenticatedUserEmailAddress` is the Cloudflare Access identity, published by
 * `userAuthentication` and read by `/user/*`. It is declared **required** rather than
 * optional so a handler that reads it before the middleware ran is a type error instead
 * of a `undefined` that surfaces as a 500 at runtime.
 *
 * The name matches the reference project on purpose: the identity variable is the one
 * thing every middleware, limiter, and route must spell identically, and a project-local
 * alias is how it drifted into two spellings last time.
 */
type WorkerEnv = { Bindings: Cloudflare.Env; Variables: { AuthenticatedUserEmailAddress: string } };

/**
 * The canonical handler context. `/user/*`, `/rest/*`, and every middleware share
 * this one type, so there is a single point where the environment and the identity
 * variable are declared.
 */
type UserContext = Context<WorkerEnv>;

/**
User JSON body cap. Small by design — no user call carries media.
*/
const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * The status → `Exception.Type` table.
 *
 * A registry rather than a `switch`: the mapping is data, not branching logic, so a
 * `Record` keeps the entry scannable and testable as data, and an unmapped status
 * falls through to `InternalServerError` without a `default:` arm that can drift.
 *
 * The cast to `ContentfulStatusCode` is where the allow-list meets the type system:
 * `toUserResponse` returns a plain `number` because `USER_STATUSES` lives in a
 * Layer 3 package that must not know Hono's status union, and the set it filters
 * through is exactly the set of statuses that union allows.
 */
const ERROR_TYPE_REGISTRY: Readonly<Record<number, string>> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  409: 'Conflict',
  413: 'PayloadTooLarge',
  429: 'RateLimited',
};

abstract class BaseRoute {
  /**
   * Single-scope resolution. Prefers the per-request container installed by
   * `scopeMiddleware`; falls back to a fresh scope for a call site outside the
   * middleware ordering (a unit test driving a handler directly).
   */
  public static getScope(c: { get(key: string): unknown; env: unknown }): ReturnType<typeof createRequestScope> {
    try {
      return getRequestScope(asScopedContext(c));
    } catch {
      return createRequestScope(c.env as Cloudflare.Env);
    }
  }

  /**
   * Strict JSON body reader.
   *
   * Distinguishes *malformed* from *empty* because collapsing a parse error to `{}`
   * turns "your JSON is broken" into "the `name` field is required", which sends the
   * caller looking in the wrong place. Oversized bodies are rejected before they are
   * buffered.
   */
  public static async readJson<T>(c: C): Promise<{ malformed: boolean; oversized: boolean; body: T }> {
    // The declared length is a *fast path only*. A chunked request carries no
    // `content-length`, and a client that omits or lies about one is not unusual — so
    // trusting the header alone means the cap is enforced for well-behaved callers and
    // not for anyone else, which is the wrong way round for a limit that exists to
    // bound memory.
    const raw = c.req.header('content-length');
    const declared = raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
      return { malformed: false, oversized: true, body: {} as T };
    }

    let text: string;
    try {
      text = await c.req.text();
    } catch {
      return { malformed: true, oversized: false, body: {} as T };
    }
    // The authoritative check, on what was actually received. Measured in bytes rather
    // than `String.length`, which counts UTF-16 code units and so undercounts a body
    // of multi-byte characters by up to a factor of three.
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
      return { malformed: false, oversized: true, body: {} as T };
    }
    if (text.trim().length === 0) return { malformed: false, oversized: false, body: {} as T };

    try {
      return { malformed: false, oversized: false, body: JSON.parse(text) as T };
    } catch {
      return { malformed: true, oversized: false, body: {} as T };
    }
  }

  /**
   * Read a required string field.
   *
   * An explicit type check rather than a cast: `body.name.trim()` on a number that
   * arrived as JSON surfaces as a 500 where the answer is a 400.
   */
  public static requireString(body: Record<string, unknown>, field: string, maxLength = 512): string {
    const value = body[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestError(`Field "${field}" is required and must be a non-empty string.`);
    }
    if (value.length > maxLength) throw new BadRequestError(`Field "${field}" exceeds ${maxLength} characters.`);
    return value.trim();
  }

  public static optionalString(body: Record<string, unknown>, field: string, maxLength = 512): string | null {
    const value = body[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new BadRequestError(`Field "${field}" must be a string.`);
    if (value.length > maxLength) throw new BadRequestError(`Field "${field}" exceeds ${maxLength} characters.`);
    return value;
  }

  public static toErrorType(status: number): string {
    return ERROR_TYPE_REGISTRY[status] ?? 'InternalServerError';
  }

  public static toErrorBody(status: number, message: string): UserErrorBody {
    return { Exception: { Type: this.toErrorType(status), Message: message } };
  }

  /**
   * A direct validation failure, in the same wire shape `toErrorResponse` produces.
   *
   * Every hand-built `c.json({ error: … }, N)` in a route was a second error dialect
   * living beside the canonical one; this is the single way to answer a bad request
   * without going through the error taxonomy.
   */
  public static jsonError(c: C, message: string, status = 400): Response {
    return c.json(this.toErrorBody(status, message), status as ContentfulStatusCode);
  }

  /**
   * The error path for the user API, which does read HTTP statuses.
   */
  public static toErrorResponse(c: C, error: unknown): Response {
    const mapped = toUserResponse(error, c.req.header('accept-language'));
    return c.json(mapped.body, mapped.status as ContentfulStatusCode);
  }
}

type C = UserContext;

export { BaseRoute, MAX_JSON_BODY_BYTES };
export type { UserContext, WorkerEnv };


export {type UserErrorBody} from '@edge-sonic/backend-services/errors';