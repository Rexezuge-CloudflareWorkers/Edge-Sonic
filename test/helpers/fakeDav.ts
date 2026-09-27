/**
 * A WebDAV origin double.
 *
 * Exactly modelable: a `207` is XML, and the point of this helper is to let a test
 * write the *awkward* responses — a `404` propstat beside a `200` one, a
 * namespace-prefixed document, a collection with no `getlastmodified` — without
 * hand-writing XML each time.
 *
 * It also exposes a call log, so the cost invariants ("an unchanged rescan issues
 * one request") are asserted on **request counts**, not on response codes. A
 * status assertion cannot see a subrequest budget being spent.
 */
import type { DavResource } from '@edge-sonic/webdav';

interface FakeDavOptions {
  /** HTTP status to answer with instead of a `207`. */
  status?: number;
  /** Reject every request, modelling an unreachable origin. */
  failAll?: boolean;
  /** Per-call failure, so a test can fail the second request only. */
  failOnCall?: number;
}

interface FakeDav {
  readonly fetch: typeof fetch;
  /** `PROPFIND` paths requested, in order. */
  readonly propfinds: string[];
  /** `GET` paths requested, in order. */
  readonly gets: Array<{ path: string; range: string | null }>;
  /** Basic credentials seen, so a test can assert the client sent the right ones. */
  readonly credentials: string[];
  /**
   * Replace the library the origin serves.
   *
   * Required rather than optional because a test that builds a *new* tree object and
   * mutates it is mutating something the fake never reads — the scan then appears to
   * ignore every change, and the failure looks like a product bug.
   */
  setTree(next: Record<string, DavEntry[]>): void;
  reset(): void;
}

/** One entry in a fake library. */
interface DavEntry {
  readonly path: string;
  readonly collection?: boolean;
  readonly size?: number;
  readonly contentType?: string;
  /** Epoch milliseconds. */
  readonly mtime?: number;
  readonly etag?: string;
  /** Exclude one property from the `200` propstat, modelling a partial server. */
  readonly omit?: 'getcontentlength' | 'getcontenttype' | 'getlastmodified' | 'getetag' | 'displayname';
}

function propValue(entry: DavEntry, property: string): string | null {
  if (entry.omit === property) return null;
  switch (property) {
    case 'getcontentlength':
      return entry.collection ? null : String(entry.size ?? 0);
    case 'getcontenttype':
      return entry.contentType ?? null;
    case 'getlastmodified':
      return entry.mtime === undefined ? null : new Date(entry.mtime).toUTCString();
    case 'getetag':
      return entry.etag ?? null;
    case 'displayname':
      return entry.path.split('/').filter(Boolean).pop() ?? entry.path;
    default:
      return null;
  }
}

/**
 * Build a `207` body for a set of entries.
 *
 * @param prefix A namespace prefix for every element, so a test can prove the parser
 *   matches on local name rather than on a hard-coded `D:`.
 */
function multistatus(entries: readonly DavEntry[], options: { prefix?: string; hrefBase?: string } = {}): string {
  const prefix = options.prefix ?? 'D';
  const base = options.hrefBase ?? '';
  const responses = entries.map((entry) => {
    // No extra separator: `entry.path` is already a full request path with its
    // leading slash, and doubling it produces `//dav/...`, which is a *different*
    // path to `toLibraryPath` and would defeat the containment check it exists for.
    const suffix = entry.path === '' ? '/' : entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
    const href = `${base}${suffix}`;
    const properties = [
      entry.collection ? `<${prefix}:resourcetype><${prefix}:collection/></${prefix}:resourcetype>` : `<${prefix}:resourcetype/>`,
      ...(['getcontentlength', 'getcontenttype', 'getlastmodified', 'getetag', 'displayname'] as const)
        .map((property) => {
          const value = propValue(entry, property);
          return value === null ? '' : `<${prefix}:${property}>${value}</${prefix}:${property}>`;
        }),
    ].join('');

    return [
      `<${prefix}:response>`,
      `<${prefix}:href>${href}</${prefix}:href>`,
      `<${prefix}:propstat>`,
      `<${prefix}:prop>${properties}</${prefix}:prop>`,
      `<${prefix}:status>HTTP/1.1 200 OK</${prefix}:status>`,
      `</${prefix}:propstat>`,
      `</${prefix}:response>`,
    ].join('');
  });

  return `<?xml version="1.0" encoding="utf-8"?><${prefix}:multistatus xmlns:${prefix}="DAV:">${responses.join('')}</${prefix}:multistatus>`;
}

/**
 * A `fetch` implementation backed by a flat list of entries.
 *
 * @param tree Directory path → **the entries that live in that directory**,
 *   including the directory itself as the first entry. That is exactly the shape a
 *   real server's `Depth: 1` response has, which is why the self-response has to be
 *   filtered downstream rather than assumed away here.
 *
 * **Keys are the full request path, including the client's `rootPath`.** The client
 * builds `/rootPath/relative`, so a tree keyed by the relative path alone looks like
 * a library whose every folder is missing. Entries' `path` fields use the same full
 * form, because that is what `toLibraryPath` strips back to a library-relative path.
 */
function fakeDav(initialTree: Record<string, DavEntry[]>, options: FakeDavOptions = {}): FakeDav {
  let tree = initialTree;
  const propfinds: string[] = [];
  const gets: Array<{ path: string; range: string | null }> = [];
  const credentials: string[] = [];
  let calls = 0;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls += 1;
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    // The leading slash is KEPT, so tree keys are literally the request path. The
    // alternative — stripping it — makes every key in a test one prefix different
    // from what a reader of the test expects, and the mismatch shows up as a 404.
    const path = decodeURIComponent(url.pathname);
    credentials.push(request.headers.get('authorization') ?? '');

    if (options.failAll) throw new Error('WebDAV origin unreachable');
    if (options.failOnCall !== undefined && calls === options.failOnCall) throw new Error('WebDAV origin dropped the connection');

    if (request.method === 'PROPFIND') {
      propfinds.push(path);
      if (options.status !== undefined) return new Response('', { status: options.status });
      const depth = request.headers.get('depth');
      const listing = tree[path];
      if (listing === undefined) return new Response('', { status: 404 });
      // A real server answers `Depth: 1` with the directory itself *plus* its
      // immediate children, which is why `parseMultistatus` has to drop the
      // self-response. `tree[P]` holds exactly the entries that live in `P`,
      // including `P` itself as the first entry.
      const self = listing.find((entry) => entry.path === path) ?? listing[0]!;
      const entries = depth === '0' ? [self] : listing;
      return new Response(multistatus(entries), { status: 207, headers: { 'Content-Type': 'application/xml' } });
    }

    if (request.method === 'GET') {
      const range = request.headers.get('range');
      gets.push({ path, range });
      const entry = Object.values(tree).flat().find((candidate) => candidate.path === path);
      if (entry === undefined) return new Response('', { status: 404 });
      return new Response(new Uint8Array(entry.size ?? 0), {
        status: range === null ? 200 : 206,
        headers: {
          'Content-Type': entry.contentType ?? 'application/octet-stream',
          'Content-Length': String(entry.size ?? 0),
          ...(range === null ? {} : { 'Content-Range': `bytes 0-${(entry.size ?? 1) - 1}/${entry.size ?? 1}` }),
        },
      });
    }

    return new Response('', { status: 405 });
  }) as typeof fetch;

  return {
    fetch: impl,
    propfinds,
    gets,
    credentials,
    setTree: (next: Record<string, DavEntry[]>) => {
      tree = next;
    },
    reset: () => {
      propfinds.length = 0;
      gets.length = 0;
      credentials.length = 0;
      calls = 0;
    },
  };
}

/** Turn a parsed resource back into the model a test wants to assert on. */
function toResources(entries: readonly DavEntry[]): DavResource[] {
  return entries.map((entry) => ({
    href: entry.path,
    path: entry.path,
    isCollection: entry.collection === true,
    contentLength: entry.collection ? null : (entry.size ?? 0),
    contentType: entry.contentType ?? null,
    lastModifiedMs: entry.mtime ?? null,
    etag: entry.etag ?? null,
    displayName: entry.path.split('/').filter(Boolean).pop() ?? entry.path,
  }));
}

export { fakeDav, multistatus, toResources };
export type { FakeDav, FakeDavOptions, DavEntry };
