/**
 * Normalizing a remote Subsonic origin, under the SSRF gate.
 *
 * ### Why this cannot be `normalizeBaseUrl`
 *
 * `LibraryService.normalizeBaseUrl` refuses any path — "put the path in the root path
 * field" — which is right for a WebDAV library, where `rootPath` is a column of its own,
 * and wrong here. A Subsonic server behind a reverse proxy is mounted at
 * `https://example.com/sonic`, and there is nowhere else to put that: the protocol's
 * `/rest` is relative to the mount point, so a base URL without it addresses nothing.
 *
 * So the rule is *similar* and the difference is stated, rather than the existing function
 * being loosened. Loosening it would let a WebDAV registration carry a path in `base_url`
 * **and** in `root_path`, which is two answers to "where does this library start".
 *
 * ### The gate is the same gate, and it is the reason this file exists
 *
 * The Worker will send a **stored credential** to this host on the operator's behalf. That
 * is exactly the hazard `normalizeBaseUrl` was built for: a registration form is a way to
 * send a secret to `169.254.169.254` or to an internal admin port, and the response is
 * readable back through the import report. So:
 *
 * - private, loopback and link-local hosts are refused unless
 *   `ALLOW_PRIVATE_WEBDAV_HOSTS` opts in, re-using that gate rather than inventing a second
 *   one — two SSRF classifiers are two answers, and the second would be the one nobody tests;
 * - plaintext `http` is allowed only for loopback, because a Subsonic password sent in a
 *   query string must not cross a network in the clear;
 * - a credential embedded in the URL is refused rather than stripped, so the caller learns
 *   the shape is wrong instead of silently getting a URL that leaks their own password into
 *   logs and support tickets.
 *
 * And the check is re-applied **on read**, exactly as `LibraryService.assertReachable`
 * re-applies it: a row written before this policy existed, or written under a laxer
 * environment, must not be grandfathered because it is already in the database.
 */
import { BadRequestError, NotFoundError } from '@edge-sonic/backend-errors';
import { isLocalhostName, isPrivateOrInternalHost, MAX_URL_LENGTH as SSRF_MAX_URL_LENGTH } from '@edge-sonic/shared/utils';

/**
Matches `LibraryService`'s, so a mount path may not smuggle a traversal.
*/
const MAX_BASE_PATH_LENGTH = 1024;

/**
 * Canonicalize a remote Subsonic origin **and its mount path**.
 *
 * Returns an origin with no trailing slash, which is what makes `join()` below a
 * concatenation rather than a path-join: `${baseUrl}/rest/getPlaylists.view`.
 */
function normalizeRemoteBaseUrl(raw: string, allowPrivate: boolean): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) throw new BadRequestError('Import source URL is required.');
  if (value.length > SSRF_MAX_URL_LENGTH) throw new BadRequestError('Import source URL is too long.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError('Import source URL is not a valid absolute URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestError('Import source URL must use http or https.');
  }
  if (url.protocol === 'http:' && !isLoopbackForPlaintext(url.hostname)) {
    throw new BadRequestError('Import source URL must use https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new BadRequestError('Import source URL must not embed credentials.');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new BadRequestError('Import source URL must not contain a query or fragment.');
  }

  // A trailing slash is stripped here rather than at each call site, because `${base}/rest`
  // and `${base}//rest` are both reachable from one stored string and the second is a
  // different URL to every server behind a mount point.
  const mountPath = normalizeMountPath(url.pathname);
  const origin = url.origin;

  if (!allowPrivate && isPrivateOrInternalHost(url.hostname)) {
    throw new BadRequestError(
      'Import source URL points at a private, loopback, or link-local address. Set ALLOW_PRIVATE_WEBDAV_HOSTS to permit this deliberately.',
    );
  }

  return mountPath === '' ? origin : `${origin}${mountPath}`;
}

/**
 * The mount path: always empty or `/`-prefixed with no trailing slash, no traversal, and
 * no query or fragment — a subset of `normalizeRootPath`'s rules for the same reason, and
 * kept separate rather than shared because a WebDAV root path *requires* a leading slash
 * (it is a directory) and this one may be absent entirely (a server mounted at the root).
 */
function normalizeMountPath(raw: string): string {
  if (raw.length > MAX_BASE_PATH_LENGTH) throw new BadRequestError('Import source mount path is too long.');
  if (raw.includes('?') || raw.includes('#')) throw new BadRequestError('Import source mount path must not contain a query or fragment.');
  if (raw.includes('\\') || raw.includes('\0')) throw new BadRequestError('Import source mount path contains an illegal character.');

  // Decoded first: a mount path of `/sonic%2F..%2Fadmin` is a traversal attempt that only
  // becomes visible on decode.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new BadRequestError('Import source mount path is not valid percent-encoding.');
  }
  if (decoded.includes('\\') || decoded.includes('\0')) throw new BadRequestError('Import source mount path contains an illegal character.');
  if (decoded.split('/').includes('..')) throw new BadRequestError('Import source mount path must not contain "..".');

  const joined = decoded
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('/');

  // **Empty**, not `'/'`, for a server mounted at the root.
  //
  // Returning `'/'` makes `https://example.com/` normalize to `https://example.com/`, and then
  // `${base}/rest/getPlaylists.view` is a **double slash** — a different URL to every server
  // behind a mount point, answering 404 on a perfectly correct configuration. It is the exact
  // failure the caller-side comment warns about, reached by the one input everybody types first.
  return joined.length === 0 ? '' : `/${joined}`;
}

/**
 * Plaintext hosts: loopback only, matching `LibraryService`.
 */
function isLoopbackForPlaintext(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isLocalhostName(host) || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
}

function isLoopbackOrPrivate(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || isPrivateOrInternalHost(host);
}

/**
 * Re-check a stored origin against the current SSRF policy.
 *
 * Re-validating on read matters for the reason `assertReachable` gives: the policy can
 * change after a row is written, so an operator who tightens
 * `ALLOW_PRIVATE_WEBDAV_HOSTS` must not leave existing private-origin sources usable.
 *
 * A violation is a **`NotFoundError`**, not a `BadRequestError`, and that is not a
 * distinction of taste. The source does exist and the operator can see it in their own
 * list; what must not happen is the import answering "your URL is malformed" for a row
 * whose *URL is fine* and whose host is merely no longer permitted. So the refusal is the
 * one that is indistinguishable from absence.
 */
function assertRemoteReachable(row: { readonly base_url: string }, allowPrivate: boolean): void {
  let host: string;
  try {
    host = new URL(row.base_url).hostname;
  } catch {
    throw new NotFoundError('Import source not found.');
  }
  if (!allowPrivate && isPrivateOrInternalHost(host)) {
    throw new NotFoundError('Import source not found.');
  }
}

/**
The operator-chosen label, bounded and stripped of control characters.
*/
function normalizeSourceName(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) throw new BadRequestError('Import source name is required.');
  if (value.length > 64) throw new BadRequestError('Import source name must be 64 characters or fewer.');
  // Control characters are refused because the name reaches the operator page and a log
  // line, and a newline in a log field is a record of an event nobody can read.
  // eslint-disable-next-line no-control-regex -- the control characters ARE the check.
  if (/[\u0000-\u001F\u007F]/.test(value)) throw new BadRequestError('Import source name must not contain control characters.');
  return value;
}

/**
The remote account name, bounded. Sent as `?u=`, so it cannot carry a control character either.
*/
function normalizeRemoteUsername(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length === 0) throw new BadRequestError('Import source username is required.');
  if (value.length > 256) throw new BadRequestError('Import source username must be 256 characters or fewer.');
  // eslint-disable-next-line no-control-regex -- the control characters ARE the check.
  if (/[\u0000-\u001F\u007F]/.test(value)) throw new BadRequestError('Import source username must not contain control characters.');
  return value;
}

export { normalizeRemoteBaseUrl, normalizeMountPath, normalizeSourceName, normalizeRemoteUsername, assertRemoteReachable };