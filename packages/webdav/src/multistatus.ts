/**
 * RFC 4918 `207 Multi-Status` → a flat list of resources.
 *
 * The single seam between an untrusted WebDAV origin and the index. Every path
 * that reaches D1, and therefore every path that can become a `stream` target,
 * passes through here.
 */
import { childText, findDescendants, firstChild, localName, parseXml } from './xml';
import type { XmlElement } from './xml';

/** The properties the indexer asks for. */
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
  /** The `DAV:href` exactly as the server sent it, still percent-encoded. */
  readonly href: string;
  /** `href` percent-decoded. This is what is stored in `nodes.path`/`songs.path`. */
  readonly path: string;
  readonly isCollection: boolean;
  readonly contentLength: number | null;
  readonly contentType: string | null;
  /** Epoch milliseconds, or `null` when the server sent no usable value. */
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

/** Percent-decode a `DAV:href`, preserving a literal `+` in the path. */
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

/** Text of the first prop element with this local name. */
function propText(props: readonly XmlElement[], name: string): string | null {
  const prop = props.find((candidate) => localName(candidate.name) === name);
  if (!prop) return null;
  return prop.text.trim();
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

export { INDEX_PROPS, parseMultistatus, decodeHrefPath, propText };
export type { DavResource };
