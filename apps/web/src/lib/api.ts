/**
 * Generic fetch primitives for the user API.
 *
 * Same-origin only, and no API base URL: the worker serves the SPA and the API from
 * one origin, so the Cloudflare Access session cookie rides along under the default
 * `credentials: 'same-origin'`. There is no token in JavaScript, and no place for
 * one to leak to.
 *
 * This module knows the transport and nothing else. Domain calls live in
 * `src/services/*` (`libraryService`, `userService`); display vocabulary lives in
 * `src/adapters` (none yet — the rows read the wire types directly, and an
 * export-only adapter with no call sites is a second vocabulary to keep in sync).
 *
 * The error decoder matters more than it looks: an Access login page is HTML, and a
 * caller that puts an HTML document into a notice bar looks broken. `extractError`
 * handles the server's `Exception` shape, plain text, and the pre-unification shape an
 * older Worker build may still return, and it **truncates** — an unbounded error string
 * from a proxy error page is a rendering hazard.
 */

const API_BASE = '/user';

class BackendError extends Error {
  readonly errorType: string | null;
  readonly status: number;

  constructor(message: string, errorType: string | null, status: number) {
    super(message);
    this.name = 'BackendError';
    this.errorType = errorType;
    this.status = status;
  }
}

interface ErrorEnvelope {
  /**
  What the server sends. `BaseRoute.toErrorBody` and `toUserResponse` both produce it,
  including the rate limiter's 429, so one decoder covers the whole user surface.
  */
  Exception?: { Type?: string; Message?: string };
  /**
  The shape this server sent before the two dialects were unified, still accepted during
  a rolling deploy while an older Worker build is serving. Remove once no deployment can
  be running the previous build.
  */
  error?: { code?: string; message?: string };
}

/**
Long enough for any real message, short enough that a proxy error page cannot wedge the UI.
*/
const MAX_ERROR_LENGTH = 500;

function extractError(payload: unknown, status: number): { message: string; type: string | null } {
  const fallback = `Request failed with status ${status}.`;
  if (typeof payload === 'string') {
    return { message: payload.trim().slice(0, MAX_ERROR_LENGTH) || fallback, type: null };
  }
  if (typeof payload === 'object' && payload !== null) {
    const envelope = payload as ErrorEnvelope;
    const type = typeof envelope.Exception?.Type === 'string' && envelope.Exception.Type.length > 0 ? envelope.Exception.Type : null;
    const message = envelope.Exception?.Message ?? envelope.error?.message;
    if (typeof message === 'string' && message.length > 0) return { message: message.slice(0, MAX_ERROR_LENGTH), type };
    if (type) return { message: `${type} (HTTP ${status})`, type };
  }
  return { message: fallback, type: null };
}

/**
 * Read an error body once.
 *
 * ### Why `text()` and then `JSON.parse`, and not `json()` with a `text()` fallback
 *
 * The previous shape was `response.json()` in a `try`, and `response.text()` in the
 * `catch` — which **cannot work**. `json()` consumes the body stream before it fails to
 * parse it, so the second read returned `''`. The intent ("not JSON — an Access login
 * page, or a platform-level error page") described a branch that was unreachable, and the
 * `typeof payload === 'string'` arm of `extractError` above it was reachable only by a
 * body that was a bare JSON *string*.
 *
 * Reading the text first and parsing it ourselves is the only shape that can distinguish
 * "the server sent prose" from "the server sent a page", which is the distinction the
 * notice bar needs.
 */
async function readError(response: Response): Promise<{ message: string; type: string | null }> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    // The body could not be read at all — a connection reset after the headers. The
    // status is still the one true thing about the request.
    return extractError(null, response.status);
  }
  try {
    return extractError(JSON.parse(raw) as unknown, response.status);
  } catch {
    // Not JSON. An Access login page and a proxy's HTML error page both land here, and
    // neither is a message an operator can act on — what they need to know is that the
    // answer did not come from this API at all. Markup is therefore reported as absent
    // rather than quoted, because pasting a login form into a notice bar reads as the app
    // rendering garbage, and a long one pushes every control off screen.
    return extractError(isProbablyProse(raw) ? raw : null, response.status);
  }
}

/**
 * Whether a non-JSON body is text worth showing, rather than markup or a binary blob.
 *
 * Short, single-line, and free of tags. Deliberately conservative: the cost of wrongly
 * refusing is the generic status sentence, and the cost of wrongly accepting is an HTML
 * page in the notice bar.
 */
// eslint-disable-next-line no-control-regex -- rejecting control characters IS the test
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

function isProbablyProse(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ERROR_LENGTH || trimmed.includes('<')) return false;
  return !CONTROL_CHARACTER.test(trimmed) && !trimmed.includes('\n');
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const { message, type } = await readError(response);
    throw new BackendError(message, type, response.status);
  }
  return await response.json();
}

function buildQuery(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const entry of value) search.append(key, entry);
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

async function apiGet<T>(path: string, params?: Record<string, string | number | boolean | string[] | undefined>): Promise<T> {
  return readJson<T>(await fetch(`${API_BASE}${path}${params ? buildQuery(params) : ''}`, { headers: { Accept: 'application/json' } }));
}

async function apiPost<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  return readJson<T>(
    await fetch(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
}

async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiPost<T>(path, body, 'PATCH');
}

async function apiDelete<T>(path: string): Promise<T> {
  return apiPost<T>(path, undefined, 'DELETE');
}

export { BackendError };
export { apiGet, apiPost, apiPatch, apiDelete, buildQuery };
