/**
 * WebDAV URL construction.
 *
 * Kept separate from `fetch` so the path-containment rules are testable without a
 * network, and so every WebDAV request in the codebase builds its URL here
 * rather than at the call site. That is the difference between one audited
 * encoder and a dozen hand-rolled `encodeURIComponent(path)` calls, one of
 * which is wrong.
 */

/** Refuse to build a URL longer than this. */
const MAX_URL_LENGTH = 4096;

/**
 * Percent-encode a path for use in a URL path segment run.
 *
 * `encodeURIComponent` is almost right and wrong in the way that matters: it
 * leaves `.` unescaped, so it cannot be the only defence against traversal.
 * Encoders here are always paired with `normalizeRelativePath`.
 */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Join a configured origin and root path with a library-relative path.
 *
 * @param baseUrl Bare origin, e.g. `https://dav.example.com`. Validated by
 *   `normalizeBaseUrl` in `@edge-sonic/backend-services` before it is stored.
 * @param rootPath Path prefix inside the origin, e.g. `/remote.php/dav/files/alice/Music`.
 *   Leading and trailing slashes are tolerated.
 * @param relativePath Already validated by `normalizeRelativePath` in
 *   `@edge-sonic/subsonic`; re-checked here because this function is also used
 *   for paths that did not come from an ID.
 *
 * @returns An absolute URL, or `null` when the result would be malformed or
 *   longer than `MAX_URL_LENGTH`.
 */
function buildDavUrl(baseUrl: string, rootPath: string, relativePath = ''): string | null {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    return null;
  }

  const segments = `${rootPath}/${relativePath}`
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

  // A `..` that survived the filter above would have been a caller bug; refuse
  // rather than silently drop it, so the mistake is visible.
  if (`${rootPath}/${relativePath}`.split('/').includes('..')) return null;

  const encoded = encodePath(segments.join('/'));
  const url = `${origin.origin}${encoded.startsWith('/') ? '' : '/'}${encoded}`;
  return url.length > MAX_URL_LENGTH ? null : url;
}

export { buildDavUrl, encodePath, MAX_URL_LENGTH };
