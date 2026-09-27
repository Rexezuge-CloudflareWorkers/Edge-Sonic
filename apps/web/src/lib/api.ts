/**
 * Typed fetch wrappers for the admin API.
 *
 * Same-origin only, and no API base URL: the worker serves the SPA and the API from
 * one origin, so the Cloudflare Access session cookie rides along under the default
 * `credentials: 'same-origin'`. There is no token in JavaScript, and no place for
 * one to leak to.
 *
 * The error decoder matters more than it looks: an Access login page is HTML, and a
 * caller that puts an HTML document into a notice bar looks broken. `extractError`
 * handles the JSON shape, the `Exception` shape the reference project used, and
 * plain text, and it **truncates** — an unbounded error string from a proxy error
 * page is a rendering hazard.
 */
import type { LibrarySummary, ProbeResult, ScanStateSummary, UserSummary } from '../types';

const API_BASE = '/admin';

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
  /** The reference project's shape, still returned by some Cloudflare-level errors. */
  Exception?: { Type?: string; Message?: string };
}

/** Long enough for any real message, short enough that a proxy error page cannot wedge the UI. */
const MAX_ERROR_LENGTH = 500;

function extractError(payload: unknown, status: number): string {
  if (typeof payload === 'string') {
    return payload.trim().slice(0, MAX_ERROR_LENGTH) || `Request failed with status ${status}.`;
  }
  if (typeof payload === 'object' && payload !== null) {
    const envelope = payload as ErrorEnvelope;
    const message = envelope.error?.message ?? envelope.Exception?.Message;
    if (typeof message === 'string' && message.length > 0) return message.slice(0, MAX_ERROR_LENGTH);
  }
  return `Request failed with status ${status}.`;
}

async function readError(response: Response): Promise<string> {
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
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

export async function apiGet<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  return readJson<T>(await fetch(`${API_BASE}${path}${params ? buildQuery(params) : ''}`, { headers: { Accept: 'application/json' } }));
}

export async function apiSend<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return readJson<T>(
    await fetch(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

// --- Libraries -------------------------------------------------------------

export const listLibraries = (): Promise<{ libraries: LibrarySummary[] }> => apiGet('/libraries');

export const createLibrary = (body: {
  slug: string;
  baseUrl: string;
  rootPath: string;
  davUsername: string;
  davPassword: string;
  displayName?: string;
}): Promise<{ id: string; slug: string }> => apiSend('POST', '/libraries', body);

export const updateLibrary = (
  id: string,
  body: { slug: string; baseUrl: string; rootPath: string; davUsername: string; davPassword?: string; displayName?: string },
): Promise<{ ok: true }> => apiSend('PATCH', `/libraries/${encodeURIComponent(id)}`, body);

export const deleteLibrary = (id: string): Promise<{ ok: true }> =>
  apiSend('DELETE', `/libraries/${encodeURIComponent(id)}`);

/**
 * Probe and rescan are POSTs, not query flags on GET.
 *
 * Both perform a live outbound request with the *stored* credential, and a `GET`
 * that can be triggered by a link is a `GET` that can be triggered by a prefetcher.
 */
export const probeLibrary = (id: string): Promise<ProbeResult> => apiSend('POST', `/libraries/${encodeURIComponent(id)}/probe`);

export const startLibraryScan = (id: string): Promise<ScanStateSummary> => apiSend('POST', `/libraries/${encodeURIComponent(id)}/scan`);

export const libraryScanStatus = (id: string): Promise<ScanStateSummary> => apiGet(`/libraries/${encodeURIComponent(id)}/scan`);

// --- Users -----------------------------------------------------------------

export const listUsers = (): Promise<{ users: UserSummary[] }> => apiGet('/users');

export const createUser = (body: { username: string; password: string; email?: string; isAdmin?: boolean }): Promise<{ id: string; username: string }> =>
  apiSend('POST', '/users', body);

export const setUserEnabled = (id: string, enabled: boolean): Promise<{ ok: true }> =>
  apiSend('PATCH', `/users/${encodeURIComponent(id)}/enabled${buildQuery({ enabled })}`);

export const setUserLibraries = (id: string, libraryIds: string[]): Promise<{ ok: true }> =>
  apiSend('PATCH', `/users/${encodeURIComponent(id)}/libraries`, { libraryIds });

export const deleteUser = (id: string): Promise<{ ok: true }> => apiSend('DELETE', `/users/${encodeURIComponent(id)}`);

export const whoami = (): Promise<{ email: string }> => apiGet('/me');

export { MAX_ERROR_LENGTH };
