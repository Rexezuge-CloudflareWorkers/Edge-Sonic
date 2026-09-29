/**
 * The `207 Multi-Status` reader.
 *
 * This is the seam between an untrusted WebDAV origin and the index, so the tests
 * here are about *hostile input* as much as about correct input: a path that reaches
 * `songs.path` becomes a `stream` target.
 */
import { describe, expect, it } from 'vitest';
import {
  parseMultistatus,
  parseXml,
  toLibraryPath,
  buildDavUrl,
  encodePath,
  XmlParseError,
  decodeHrefPath,
  WebDavClient,
  WebDavError,
} from '@edge-sonic/webdav';
import { multistatus } from './helpers/fakeDav';

const FILE = { path: 'music/Bon Iver/01.flac', size: 4096, contentType: 'audio/flac', mtime: 1_700_000_000_000, etag: '"abc"' };
const DIR = { path: 'music/Bon Iver', collection: true, mtime: 1_700_000_100_000 };

describe('parseXml', () => {
  it('reads elements, attributes, and text', () => {
    const root = parseXml('<a x="1"><b>hello</b><c/></a>');
    expect(root.children[0]!.name).toBe('a');
    expect(root.children[0]!.attrs.x).toBe('1');
    expect(root.children[0]!.children[0]!.text).toBe('hello');
  });

  it('rejects a DOCTYPE outright', () => {
    // An entity declaration is the entry point for every entity-expansion and XXE
    // attack, and this origin is chosen by a user. Refusing it means the question
    // never arises.
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a/>')).toThrow(XmlParseError);
  });

  it('leaves an unknown entity verbatim instead of dropping it', () => {
    // A filename really can contain `&foo;`, and deleting it would point the index
    // at a different file than the one on disk.
    const root = parseXml('<a>100%25 &foo; &amp; &#65; &#x42;</a>');
    expect(root.children[0]!.text).toBe('100%25 &foo; & A B');
  });

  it('refuses nesting past the depth cap', () => {
    // A hostile origin can nest arbitrarily deep; the cap is checked before a
    // recursive walk can exhaust the stack.
    const deep = `${'<a>'.repeat(200)}${'</a>'.repeat(200)}`;
    expect(() => parseXml(deep)).toThrow(XmlParseError);
  });

  it('refuses a mismatched closing tag rather than guessing', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(XmlParseError);
  });

  it('refuses an unterminated element or comment', () => {
    expect(() => parseXml('<a><b>')).toThrow(XmlParseError);
    expect(() => parseXml('<a><!-- oops </a>')).toThrow(XmlParseError);
  });

  it('reads CDATA verbatim, without entity decoding', () => {
    const root = parseXml('<a><![CDATA[<b> &raw</b>]]></a>');
    expect(root.children[0]!.text).toBe('<b> &raw</b>');
  });

  it('skips processing instructions and comments', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><a>x</a>');
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.text).toBe('x');
  });
});

describe('parseMultistatus', () => {
  it('reads a collection and a file', () => {
    const resources = parseMultistatus(multistatus([FILE, DIR]));
    expect(resources).toHaveLength(2);
    const file = resources.find((resource) => resource.path.includes('01.flac'))!;
    expect(file.isCollection).toBe(false);
    expect(file.contentLength).toBe(4096);
    expect(file.contentType).toBe('audio/flac');
    expect(file.lastModifiedMs).toBe(1_700_000_000_000);
    expect(file.etag).toBe('"abc"');
  });

  it('identifies a collection by the presence of resourcetype/collection', () => {
    expect(parseMultistatus(multistatus([DIR]))[0]!.isCollection).toBe(true);
    expect(parseMultistatus(multistatus([FILE]))[0]!.isCollection).toBe(false);
  });

  it('matches on local name, so any namespace prefix works', () => {
    // A server choosing `D:` or `d:` must not change the result, and must not be
    // able to hide a property by prefixing it.
    for (const prefix of ['D', 'd', 'dav', 'x0']) {
      const resources = parseMultistatus(multistatus([FILE], { prefix }));
      expect(resources, prefix).toHaveLength(1);
      expect(resources[0]!.contentLength, prefix).toBe(4096);
      expect(resources[0]!.isCollection, prefix).toBe(false);
    }
  });

  it('treats a 404 propstat as absent, not as zero', () => {
    // RFC 4918 §16 lets a server answer 200 for what it has and 404 for the rest.
    // Merging them unfiltered is how a file gets indexed with `contentLength: 0`
    // because the server said "no such property" rather than "empty file" — and an
    // empty file then streams as a zero-length response for a track the client
    // believes has content.
    const body = `<?xml version="1.0"?>
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/music/a.flac</D:href>
          <D:propstat>
            <D:prop><D:displayname>a.flac</D:displayname></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
          <D:propstat>
            <D:prop><D:getcontentlength>0</D:getcontentlength></D:prop>
            <D:status>HTTP/1.1 404 Not Found</D:status>
          </D:propstat>
        </D:response>
      </D:multistatus>`;
    const resource = parseMultistatus(body)[0]!;
    expect(resource.contentLength).toBeNull();
    expect(resource.displayName).toBe('a.flac');
  });

  it('rejects a negative or non-numeric content length rather than storing it', () => {
    const body = multistatus([FILE]).replace(
      '<D:getcontentlength>4096</D:getcontentlength>',
      '<D:getcontentlength>-1</D:getcontentlength>',
    );
    expect(parseMultistatus(body)[0]!.contentLength).toBeNull();
  });

  it('percent-decodes an href and drops any query', () => {
    expect(decodeHrefPath('/music/100%25%20Pure.flac')).toBe('/music/100% Pure.flac');
    expect(decodeHrefPath('/music/a.flac?token=x')).toBe('/music/a.flac');
    expect(decodeHrefPath('/music/a%2Eb.flac')).toBe('/music/a.b.flac');
  });

  it('skips a response with no usable href rather than inventing a path', () => {
    const body = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop/></D:propstat></D:response></D:multistatus>`;
    expect(parseMultistatus(body)).toEqual([]);
  });
});

describe('toLibraryPath', () => {
  it('strips the configured root prefix', () => {
    expect(toLibraryPath('/remote.php/dav/files/alice/Music/Blur/13', '/remote.php/dav/files/alice/Music')).toBe('Blur/13');
  });

  it('recognises the root itself as the empty path', () => {
    expect(toLibraryPath('/remote.php/dav/files/alice/Music', '/remote.php/dav/files/alice/Music')).toBe('');
  });

  it('discards a path outside the library root', () => {
    // A `207` for a library root contains only that library's resources, so a stray
    // href is a sign the server returned something unexpected. Indexing it would put
    // an unowned path in the tree.
    expect(toLibraryPath('/other/secret.txt', '/remote.php/dav/files/alice/Music')).toBeNull();
    // A prefix that is a *string* prefix but not a path boundary must not match.
    expect(toLibraryPath('/remote.php/dav/files/alice/MusicOld/a.flac', '/remote.php/dav/files/alice/Music')).toBeNull();
  });

  it('handles a root of "/" as no prefix', () => {
    expect(toLibraryPath('/music/a.flac', '/')).toBe('music/a.flac');
    expect(toLibraryPath('/', '/')).toBe('');
  });
});

describe('buildDavUrl', () => {
  it('joins origin, root, and path with exactly one separator', () => {
    expect(buildDavUrl('https://dav.example.com', '/dav/files/alice/Music', 'Blur/13.flac')).toBe(
      'https://dav.example.com/dav/files/alice/Music/Blur/13.flac',
    );
  });

  it('encodes each segment, so a space or a plus is escaped', () => {
    // `+` in particular: it means "space" in a query string but a literal plus in a
    // path, and a track called `A+B` must not become `A B`.
    expect(encodePath('A+B & C.flac')).toBe('A%2BB%20%26%20C.flac');
    expect(buildDavUrl('https://dav.example.com', '/dav', 'A+B.flac')).toBe('https://dav.example.com/dav/A%2BB.flac');
  });

  it('refuses a path containing a traversal segment', () => {
    expect(buildDavUrl('https://dav.example.com', '/dav', '../etc/passwd')).toBeNull();
    expect(buildDavUrl('https://dav.example.com', '/dav', 'a/../../etc/passwd')).toBeNull();
  });

  it('refuses a malformed origin and an over-long URL', () => {
    expect(buildDavUrl('not a url', '/dav', 'a.flac')).toBeNull();
    expect(buildDavUrl('https://dav.example.com', '/dav', 'x'.repeat(5000))).toBeNull();
  });
});

/**
 * Failure classification at the client's own boundary.
 *
 * The `207` reader's tests above are about hostile input; these are about the two
 * failures that have no status and therefore used to be indistinguishable. Both
 * arrived as an opaque rejection with no `status` property, so every caller that
 * classifies by status — `LibraryService.probe`, `ScanService.listFolder` — fell
 * through to its residual branch. For the probe that residual branch said
 * "Library is unreachable", so a hung origin and a dead one were the same answer
 * with opposite fixes.
 */
describe('WebDavClient failure classification', () => {
  /**
   * A `fetch` that hangs until its own signal aborts, which is what a real
   * `AbortSignal.timeout` does to an origin that accepts the connection and then
   * never answers.
   *
   * The abort is taken from `init.signal` rather than a timer so the test is
   * deterministic: it does not wait out a real timeout, and it cannot pass because
   * the machine happened to be slow.
   */
  function hangingFetch(): typeof fetch {
    return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal ?? null;
      // Asserted rather than assumed: the client builds the signal, and a test that
      // silently tolerated its absence would pass against a client that never
      // time-limited anything.
      if (signal === null) throw new Error('the client must pass an AbortSignal');
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted.'));
        });
      });
    }) as unknown as typeof fetch;
  }

  it('reports an aborted request as 408, not as an unclassifiable failure', async () => {
    const client = new WebDavClient('https://dav.example.com', '/', { username: 'u', password: 'p' }, hangingFetch());
    // `try`/`catch` because the assertion needs the thrown value in hand, which a
    // `.catch()` handler would have to smuggle out through a mutable binding.
    let caught: unknown = null;
    try {
      await client.propfind('', { depth: 0, timeoutMs: 5 });
    } catch (error) {
      caught = error;
    }
    // 408 rather than nothing: a hung origin is actionable (`WEBDAV_TIMEOUT_MS`) and
    // is not a DNS, TLS, or connectivity problem.
    expect(caught).toBeInstanceOf(WebDavError);
    expect((caught as WebDavError).status).toBe(408);
    expect((caught as Error).message).toMatch(/timed out after 5ms/);
  });

  it('leaves a genuine transport failure unclassified, so it is not a timeout', async () => {
    // The other half of the pair. Without this, translating every rejection into a
    // 408 would make the new branch true for everything and the distinction
    // worthless.
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = new WebDavClient('https://dav.example.com', '/', { username: 'u', password: 'p' }, failing);
    let caught: unknown = null;
    try {
      await client.propfind('', { depth: 0, timeoutMs: 1000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(WebDavError);
    expect(caught).toBeInstanceOf(TypeError);
  });
});
