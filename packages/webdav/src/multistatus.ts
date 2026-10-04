/**
 * RFC 4918 `207 Multi-Status` → a flat list of resources.
 *
 * The single seam between an untrusted WebDAV origin and the index. Every path
 * that reaches D1, and therefore every path that can become a `stream` target,
 * passes through here.
 */
import { childText, findDescendants, firstChild, localName, parseXml } from './xml';
import type { XmlElement } from './xml';

/**
The properties the indexer asks for.
*/
const INDEX_PROPS = ['getcontentlength', 'getcontenttype', 'getlastmodified', 'getetag', 'displayname', 'resourcetype'] as const;

/**
 * A collection is identified by the presence of `<D:collection/>` inside
 * `<D:resourcetype>` (RFC 4918 §15.4). Servers vary: some send
 * `<resourcetype><collection/></resourcetype>`, some send
 * `<resourcetype><collection></collection></resourcetype>`, and some send
 * `<resourcetype/>` for a non-collection. All three are handled by looking for
 * any descendant named `collection`.
 */
interface DavResource {
  /**
  The `DAV:href` exactly as the server sent it, still percent-encoded.
  */
  readonly href: string;
  /**
  `href` percent-decoded. This is what is stored in `nodes.path`/`songs.path`.
  */
  readonly path: string;
  readonly isCollection: boolean;
  readonly contentLength: number | null;
  readonly contentType: string | null;
  /**
  Epoch milliseconds, or `null` when the server sent no usable value.
  */
  readonly lastModifiedMs: number | null;
  readonly etag: string | null;
  readonly displayName: string | null;
}

function parseHttpDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  // A negative or absurd length is not a length. Treating it as one would make
  // the `Content-Length` handling downstream produce a broken response.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
Percent-decode a `DAV:href`, preserving a literal `+` in the path.
*/
function decodeHrefPath(href: string): string {
  const withoutFragment = href.split('#', 1)[0] ?? '';
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? withoutFragment;
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    // A malformed escape means the server produced a path this server cannot
    // represent. Returning it raw is safer than dropping it: the caller's
    // containment check still runs, and a path that does not resolve simply
    // fails to match anything.
    return withoutQuery;
  }
}

/**
Text of the first prop element with this local name.
*/
/**
 * `/`, as a char code.
 */
const SLASH = 0x2f;

/**
 * Strip leading and trailing `/`.
 *
 * **A scan, not `replace(/^\/+/, '').replace(/\/+$/, '')`, because that regex is quadratic
 * and its input is an untrusted `DAV:href`.** An unbounded `/+` followed by `$` that can
 * fail is enough: for each of the *n* start positions inside a run of *n* slashes the engine
 * retries every length the run could have. 16 KB of href costs ~200 ms of CPU and 100 KB
 * costs ~8 s — against a 10 ms CPU limit on Workers Free, and comfortably inside the 8 MiB
 * body cap `MAX_METADATA_BYTES` already allows. One hostile `PROPFIND` is then an invocation
 * the runtime kills, or a slow request on Paid.
 *
 * **The run has to be _interior_ to cost anything, which is why the obvious test input does
 * not catch this.** A leading run is consumed by `replace(/^\/+/, '')` before `/+$/` sees it,
 * and a trailing run *matches*, which V8 fast-paths. Both measure in microseconds. A run with
 * a segment on each side has neither escape, and a `DAV:href` is `<base>/<path>` — so the
 * expensive shape is also the ordinary one. Measured at 16,000 slashes: 0.0 ms leading,
 * 0.0 ms trailing, 198 ms interior.
 *
 * `^\/+` is anchored and so linear on its own, but it is gone too: one function with no
 * regex in it cannot be pointed at by a scanner, and the two replacements were one operation
 * written twice.
 *
 * Each `while` walks its own run at most once, so the work is bounded by the *length* of the
 * input rather than its square. `test/redos-linear-parsing.test.ts` asserts this against an
 * oracle written from the specification, and bounds the worst case — because the two
 * analysers this repository already runs both miss this shape, so a green lint is not
 * evidence about it.
 */
function stripSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === SLASH) start++;
  while (end > start && value.charCodeAt(end - 1) === SLASH) end--;
  return start === end ? '' : value.slice(start, end);
}

/**
 * Map a `DAV:href` to a library-relative path.
 *
 * A server returns absolute hrefs rooted at its own base, which may or may not
 * include the library's configured `rootPath`. Rather than trying to reconcile the
 * two, anything that does not sit under the root is **discarded**.
 *
 * A `207` for a library root contains only that library's resources, so a stray href
 * is a sign the server returned something unexpected — and every path that survives
 * this function becomes a `stream` target.
 *
 * The prefix match is on a path *boundary*, not a string prefix: with a root of
 * `/Music`, an href of `/MusicOld/a.flac` is a different library and must not match.
 */
function toLibraryPath(hrefPath: string, rootPath: string): string | null {
  const normalizedHref = stripSlashes(hrefPath);
  const normalizedRoot = stripSlashes(rootPath);
  if (normalizedRoot.length === 0) return normalizedHref.length === 0 ? '' : normalizedHref;
  if (normalizedHref === normalizedRoot) return '';
  return normalizedHref.startsWith(`${normalizedRoot}/`) ? normalizedHref.slice(normalizedRoot.length + 1) : null;
}

function propText(props: readonly XmlElement[], name: string): string | null {
  const prop = props.find((candidate) => localName(candidate.name) === name);
  return prop ? prop.text.trim() : null;
}

/**
 * Flatten a `207` body.
 *
 * `propstat` sections are filtered by status: RFC 4918 §16 lets a server answer
 * `200` for the properties it has and `404` for the ones it does not, and a
 * `404` section's properties are *absent*, not empty. Merging them unfiltered is
 * how a file ends up indexed with `contentLength: 0` because the server said
 * "no such property" rather than "empty file" — and an empty file then streams
 * as a zero-length response for a track the client believes has content.
 */
function parseMultistatus(xml: string): DavResource[] {
  const document = parseXml(xml);
  const responses = findDescendants(document, 'response');
  const resources: DavResource[] = [];

  for (const response of responses) {
    const href = childText(response, 'href');
    if (href === null || href.length === 0) continue;

    const successful = response.children
      .filter((child) => localName(child.name) === 'propstat')
      .filter((propstat) => /\b2\d\d\b/.test(childText(propstat, 'status') ?? ''))
      .flatMap((propstat) => firstChild(propstat, 'prop')?.children ?? []);

    const resourceType = successful.find((prop) => localName(prop.name) === 'resourcetype');
    const isCollection = resourceType ? findDescendants(resourceType, 'collection').length > 0 : false;

    resources.push({
      href,
      path: decodeHrefPath(href),
      isCollection,
      contentLength: parseLength(propText(successful, 'getcontentlength')),
      contentType: propText(successful, 'getcontenttype'),
      lastModifiedMs: parseHttpDate(propText(successful, 'getlastmodified')),
      etag: propText(successful, 'getetag'),
      displayName: propText(successful, 'displayname'),
    });
  }

  return resources;
}

export { INDEX_PROPS, parseMultistatus, decodeHrefPath, toLibraryPath, propText };
export type { DavResource };
