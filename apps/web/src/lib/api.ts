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

async function readError(response: Response): Promise<{ message: string; type: string | null }> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Not JSON — an Access login page, or a platform-level error page.
    try {
      payload = await response.text();
    } catch {
      payload = null;
    }
  }
  return extractError(payload, response.status);
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
