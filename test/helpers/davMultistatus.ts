/**
 * The `207 Multi-Status` body a WebDAV origin answers a `PROPFIND` with, and the entry
 * shape it is built from.
 *
 * Split out of `fakeDav` because the XML and the transport are two things a test reaches
 * for separately: most tests only need `fakeDav(tree)`, while `test/webdav-client.test.ts`
 * asserts against the body's own text — a wrong namespace prefix, a doubled leading
 * slash, a missing propstat. Those assertions are about *this* builder, so the builder has
 * to be nameable without the transport that happens to produce it.
 *
 * ### Why the prefix is a parameter
 *
 * Real servers do not agree on `D:`. The parser under test matches on **local name**, and
 * this builder can therefore emit any prefix — so a test that proves the parser is
 * prefix-agnostic is asserting against a body that really was emitted some other way,
 * rather than against a hard-coded string that happens to match.
 */

/**
One entry in a fake library.
*/
export interface DavEntry {
  readonly path: string;
  readonly collection?: boolean;
  readonly size?: number;
  readonly contentType?: string;
  /**
  Epoch milliseconds.
  */
  readonly mtime?: number;
  readonly etag?: string;
  /**
   * The bytes the server actually returns.
   *
   * Optional, and shorter than `size` is the interesting case: it is how a real origin
   * answers a prefix read of a large file, and how a test models a container whose
   * header is not at the front. Without it the fake hands back a zero buffer of
   * `size` bytes, which is 30 MB of allocation for a fixture and a file that no
   * decoder can read.
   */
  readonly body?: Uint8Array;
  /**
  Exclude one property from the `200` propstat, modelling a partial server.
  */
  readonly omit?: 'getcontentlength' | 'getcontenttype' | 'getlastmodified' | 'getetag' | 'displayname';
}

function propValue(entry: DavEntry, property: string): string | null {
  if (entry.omit === property) return null;
  switch (property) {
    case 'getcontentlength': {
      return entry.collection ? null : String(entry.size ?? 0);
    }
    case 'getcontenttype': {
      return entry.contentType ?? null;
    }
    case 'getlastmodified': {
      return entry.mtime === undefined ? null : new Date(entry.mtime).toUTCString();
    }
    case 'getetag': {
      return entry.etag ?? null;
    }
    case 'displayname': {
      return entry.path.split('/').findLast(Boolean) ?? entry.path;
    }
    default: {
      return null;
    }
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

export { multistatus };
