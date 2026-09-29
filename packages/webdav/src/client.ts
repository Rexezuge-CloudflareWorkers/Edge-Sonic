/**
 * The WebDAV client.
 *
 * The server's only door to a music library. Three properties are deliberate:
 *
 * - **The stored credential never crosses a method boundary.** `Authorization`
 *   is attached inside `request()`, after the caller has named a *library* and
 *   a *path*. No call site ever handles it, so no call site can leak it — a
 *   misdirected `Authorization` header is the classic way a proxy hands a
 *   credential to a host it should not.
 * - **Responses are size- and time-bounded.** A hostile or broken origin cannot
 *   make this worker read an unbounded body; the 207 parser has its own size cap
 *   and the client has its own body cap.
 * - **`Range` is forwarded and the body is never touched.** Seeking is how every
 *   Subsonic client skips a track, and re-buffering the response would defeat it.
 */
import { INDEX_PROPS, parseMultistatus } from './multistatus';
import type { DavResource } from './multistatus';
import { buildDavUrl } from './url';

/**
Default per-request timeout. Overridable per library.
*/
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Hard cap on a non-media response body.
 *
 * A `207` for a directory with 5,000 files is roughly 1–2 MB, so 8 MiB is
 * generous while still bounding a hostile origin. Range-limited media reads are
 * exempt: they are bounded by the range the client asked for.
 */
const MAX_METADATA_BYTES = 8 * 1024 * 1024;

/**
Cap on a single ranged media read, for the same reason.
*/
const MAX_MEDIA_CHUNK_BYTES = 32 * 1024 * 1024;

/**
 * How the `207` is asked for.
 *
 * `allprop` is what the reference router's browser client used and it works
 * everywhere, but it is wasteful and *unreliable for indexing*: `allprop` is a
 * request for whatever the server feels like returning, so a server that omits
 * `getlastmodified` produces an index that can never detect a change and a
 * rescan that can never converge. A `prop` list is explicit, and a server that
 * does not support one of the names answers `404` for it — which this client
 * filters rather than treating as an error.
 */
interface PropfindOptions {
  /**
  `0` for the resource itself, `1` for its immediate children.
  */
  depth?: 0 | 1;
  timeoutMs?: number;
}

interface DavCredentials {
  readonly username: string;
  readonly password: string;
}

/**
Raised for a non-2xx WebDAV response, carrying the status for classification.
*/
class WebDavError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WebDavError';
    this.status = status;
  }
}

/**
 * Build a Basic `Authorization` value.
 *
 * `btoa` operates on latin1, and a credential with a non-ASCII character throws
 * in it. Encoding to UTF-8 first and then widening each byte to a latin1 code
 * point produces a base64 of the UTF-8 bytes — which is what every other
 * WebDAV client sends, and what every server expects to decode.
 */
function basicAuthHeader(credentials: DavCredentials): string {
  const bytes = new TextEncoder().encode(`${credentials.username}:${credentials.password}`);
  let binary = '';
  // Chunked rather than spread: `String.fromCharCode(...bytes)` on a long
  // credential would exceed the argument limit.
  for (let index = 0; index < bytes.length; index += 0x80_00) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x80_00));
  }
  return `Basic ${btoa(binary)}`;
}

class WebDavClient {
  constructor(
    private readonly baseUrl: string,
    private readonly rootPath: string,
    private readonly credentials: DavCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Attach credentials and a timeout, then fetch.
   *
   * The only place `Authorization` is ever set, which is what makes "the stored
   * credential only ever goes to the library's own origin" a property of the
   * code rather than a convention.
   */
  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', basicAuthHeader(this.credentials));
    // Ask for a byte-identical body back; without it some origins re-encode
    // or apply a transfer encoding that changes `Content-Length`.
    headers.set('Accept-Encoding', 'identity');

    // An `AbortSignal.timeout` is a fetch-level abort, so a hung origin burns
    // this request's wall clock and nothing else.
    //
    // The abort is translated into a `WebDavError` because a timeout is a
    // *distinguishable* fault and a bare `TimeoutError` is not: it is neither an
    // `Error` shape every caller classifies nor an HTTP status, so it fell through
    // every `status`-based branch and reached the operator as "the library is
    // unreachable" — the same answer as a DNS failure, with a different fix
    // (`WEBDAV_TIMEOUT_MS` against a hung origin, a network fix against a dead
    // one). `signal.aborted` is the test rather than `error.name === 'TimeoutError'`
    // because the signal is ours: nothing else can set it, so it cannot misreport
    // a connection failure as a slow one.
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers, signal });
    } catch (error) {
      if (signal.aborted) throw new WebDavError(408, `WebDAV ${init.method ?? 'GET'} ${url} timed out after ${timeoutMs}ms.`);
      throw error;
    }
    if (!response.ok) {
      // The body is intentionally not read: it is attacker-influenced text and
      // nothing in this codebase needs it to classify the failure.
      throw new WebDavError(response.status, `WebDAV ${init.method ?? 'GET'} ${url} responded ${response.status}.`);
    }
    return response;
  }

  private async readBounded(response: Response, maxBytes: number): Promise<ArrayBuffer> {
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new WebDavError(413, `WebDAV response declared ${declared} bytes, over the ${maxBytes} byte limit.`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new WebDavError(413, `WebDAV response exceeded the ${maxBytes} byte limit.`);
    }
    return buffer;
  }

  /**
   * `PROPFIND` a resource.
   *
   * @param relativePath Empty string for the library root.
   * @returns The resources the server reported, including the resource itself
   *   when `Depth: 0`.
   * @throws WebDavError on any non-2xx status, including `404` and `401`.
   */
  public async propfind(relativePath: string, options: PropfindOptions = {}): Promise<DavResource[]> {
    const url = buildDavUrl(this.baseUrl, this.rootPath, relativePath);
    if (url === null) throw new WebDavError(400, 'Refusing to build a WebDAV URL outside the library root.');

    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<D:propfind xmlns:D="DAV:"><D:prop>${INDEX_PROPS.map((prop) => `<D:${prop}/>`).join('')}</D:prop></D:propfind>`;

    const response = await this.request(
      url,
      {
        method: 'PROPFIND',
        headers: { Depth: String(options.depth ?? 1), 'Content-Type': 'application/xml; charset=utf-8' },
        body,
      },
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    // 207 is a success status and `Response.ok` covers it, but an origin that
    // answers `200` with an HTML error page is a real failure mode, and the
    // parser would reject it anyway — the explicit check just gives a better
    // message.
    if (response.status !== 207) {
      throw new WebDavError(response.status, `Expected 207 Multi-Status, received ${response.status}.`);
    }

    return parseMultistatus(new TextDecoder().decode(await this.readBounded(response, MAX_METADATA_BYTES)));
  }

  /**
   * `GET` a media file, optionally for one byte range.
   *
   * The response body is returned **untouched**. There is no transcoding in this
   * server, so nothing here is permitted to rewrite the bytes: a `206` has to
   * stay a `206` with its `Content-Range`, because that is how a client seeks.
   *
   * @param range An HTTP `Range` header value, forwarded verbatim. Omit for a
   *   whole-file read (used by `download` and by tag enrichment).
   */
  public async get(relativePath: string, options: { range?: string; timeoutMs?: number } = {}): Promise<Response> {
    const url = buildDavUrl(this.baseUrl, this.rootPath, relativePath);
    if (url === null) throw new WebDavError(400, 'Refusing to build a WebDAV URL outside the library root.');

    const headers = new Headers();
    if (options.range) headers.set('Range', options.range);

    return await this.request(url, { method: 'GET', headers }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /**
   * Read the leading bytes of a file, for tag enrichment.
   *
   * A ranged read rather than a whole-file `GET`: an ID3v2 header can declare
   * itself hundreds of megabytes, and a 3 MB FLAC must not be pulled through the
   * worker to learn its duration.
   */
  public async readPrefix(relativePath: string, bytes: number, timeoutMs?: number): Promise<Uint8Array> {
    const end = Math.max(0, bytes - 1);
    const response = await this.get(relativePath, { range: `bytes=0-${end}`, ...(timeoutMs && { timeoutMs }) });
    const buffer = await this.readBounded(response, Math.min(bytes, MAX_MEDIA_CHUNK_BYTES) + 1024);
    return new Uint8Array(buffer);
  }
}

export { WebDavClient, WebDavError, basicAuthHeader, DEFAULT_TIMEOUT_MS, MAX_METADATA_BYTES, MAX_MEDIA_CHUNK_BYTES };
export type { DavCredentials, PropfindOptions };
