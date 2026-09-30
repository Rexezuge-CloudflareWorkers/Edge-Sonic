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
 * The default `onRequest`: no accounting.
 *
 * A named constant rather than an inline `() => undefined` default, because a client is
 * built per folder by the scan and a fresh closure per construction is a small waste in
 * the one path that builds thousands of them.
 */
const NO_REQUEST_ACCOUNTING = (): void => undefined;

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
  /**
   * The injected `fetch`, wrapped so it is never invoked as a method of this client.
   *
   * See the constructor for why that matters.
   */
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly rootPath: string,
    private readonly credentials: DavCredentials,
    fetchImpl: typeof fetch = fetch,
    /**
     * Called once per outbound request, immediately before it is issued.
     *
     * ### Why the count is taken here
     *
     * A counter incremented by a *caller* is a claim about how much work was
     * attempted, and it drifts the moment a code path forgets to increment it. That
     * is not hypothetical: the scan counted one subrequest per `PROPFIND` and none
     * for the range reads its own enrichment made, so it under-reported its own
     * chunk by up to 40x while a comment described the number as instrumented "so
     * the budget is testable". A caller that cannot see the requests it causes
     * cannot bound them.
     *
     * `request()` is the single choke point every method funnels through —
     * `propfind`, `get`, and therefore `readPrefix` and `readTail` — so a charge
     * placed here cannot be bypassed by a new method added later.
     */
    private readonly onRequest: () => void = NO_REQUEST_ACCOUNTING,
  ) {
    // The wrapper is the fix, and it is here rather than at the call site on
    // purpose.
    //
    // A function stored in a field and called as `this.fetchImpl(...)` is a
    // **method call**: the receiver is the client, not the global scope. workerd's
    // global `fetch` validates its receiver and throws
    //
    //     TypeError: Illegal invocation: function called with incorrect `this` reference.
    //
    // which is the documented symptom of a lost `this` on a runtime-provided
    // function. It is a `TypeError` with no `status`, so it fell through every
    // status-based branch in `LibraryService.probe` and was reported to the
    // operator as "Library is unreachable." — a fault in this server, described as
    // a fault in theirs, against an origin that was answering `207` throughout.
    // Every WebDAV path shared it, because every one of them builds its client here.
    //
    // The arrow calls the injected function *bare*, so the receiver is never a
    // foreign object — for the default global `fetch` and for any test double
    // alike. Doing it in the constructor means no call site can reintroduce it.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

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
    // Charged **before** the request, so a caller that stops when the budget is
    // spent can never have one already in flight past the ceiling. The count is a
    // measure of what was issued, so it is raised whether the request succeeds or
    // throws: both consumed a subrequest.
    this.onRequest();
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

  /**
   * Read the *trailing* bytes of a file, for the Ogg duration.
   *
   * An Ogg file's length lives in the granule position on its final page, at the end of
   * the file, so the prefix read above cannot see it and the reader is right to report no
   * duration. This is the second read that closes the gap — and the duration is what a
   * client seeks by, so guessing it is not an option.
   *
   * An explicit `bytes=<start>-<end>` rather than the `bytes=-N` suffix form, because
   * the size is known here and suffix ranges are refused by some WebDAV servers. The
   * range is clamped so a `totalSize` of 0 cannot produce a negative start.
   */
  public async readTail(relativePath: string, bytes: number, totalSize: number, timeoutMs?: number): Promise<Uint8Array> {
    if (totalSize <= 0) return new Uint8Array(0);
    const end = totalSize - 1;
    const start = Math.max(0, end - Math.max(0, bytes - 1));
    const response = await this.get(relativePath, { range: `bytes=${start}-${end}`, ...(timeoutMs && { timeoutMs }) });
    const buffer = await this.readBounded(response, Math.min(bytes, MAX_MEDIA_CHUNK_BYTES) + 1024);
    return new Uint8Array(buffer);
  }

  /**
   * Read an exact byte range from the middle of a file, for embedded artwork.
   *
   * The third member of this family, and it exists because the other two cannot express
   * what artwork needs. `readPrefix` starts at zero and `readTail` ends at the file's
   * last byte, but a FLAC `PICTURE` block sits at an offset the file's own metadata
   * table states — routinely past 128 KiB, because `PICTURE` is conventionally the last
   * metadata block and is as large as the image. So the range is *passed in* rather than
   * derived from either end.
   *
   * Bounded for the same reason the other two are: a server that ignores `Range` answers
   * `200` with the entire file, and a 40 MB track must not be pulled through the worker
   * to serve 500 KB of JPEG. A body longer than the range asked for is truncated to it
   * rather than trusted — which turns "this server ignored my Range" into a picture
   * that fails its magic check and is reported as no artwork, instead of 500 KB of
   * audio served as `image/jpeg`.
   */
  public async readRange(relativePath: string, start: number, length: number, timeoutMs?: number): Promise<Uint8Array> {
    const from = Math.max(0, Math.floor(start));
    const wanted = Math.max(0, Math.floor(length));
    if (wanted === 0) return new Uint8Array(0);
    const response = await this.get(relativePath, { range: `bytes=${from}-${from + wanted - 1}`, ...(timeoutMs && { timeoutMs }) });
    const buffer = await this.readBounded(response, Math.min(wanted, MAX_MEDIA_CHUNK_BYTES) + 1024);
    return new Uint8Array(buffer).subarray(0, wanted);
  }
}

export { WebDavClient, WebDavError, basicAuthHeader, DEFAULT_TIMEOUT_MS, MAX_METADATA_BYTES, MAX_MEDIA_CHUNK_BYTES };
export type { DavCredentials, PropfindOptions };
