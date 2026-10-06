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
import { multistatus } from './davMultistatus';
import type { DavEntry } from './davMultistatus';

export interface FakeDavOptions {
  /**
  HTTP status to answer with instead of a `207`.
  */
  status?: number;
  /**
  Reject every request, modelling an unreachable origin.
  */
  failAll?: boolean;
  /**
  Per-call failure, so a test can fail the second request only.
  */
  failOnCall?: number;
  /**
  Milliseconds of real delay before every response.

  ### Why this exists

  The scan's wall-clock bound is the second of the two that keep a chunk inside its
  budget, and until this option existed **no test could observe it**: `fakeDav`
  answered instantly, so a chunk finished in microseconds no matter how slow the
  origin was, and a deadline that did nothing looked exactly like a deadline that
  worked. That is the same defect as the subrequest count — a double that cannot
  observe the failure lends it a passing test.

  A **real** `setTimeout` rather than a fake clock, so the deadline is exercised
  through the same `Date.now` the Worker uses and a test cannot pass by mocking
  away the thing under test. Tests using it assert on *counts* (folders visited,
  requests issued), never on elapsed milliseconds: a wall-clock assertion is a flaky
  assertion, and the bound this models is a decision, not a duration.
  */
  latencyMs?: number;
  /**
   * Status to answer every media `GET` with, leaving `PROPFIND` at its normal `207`.
   *
   * ### Why this exists separately from `status`
   *
   * `status` fails the whole server, so it models an origin that is *down*. Nothing
   * could express an origin that will **list** a file and then refuse to serve its
   * bytes, which is the shape a real WebDAV server produces under load — and it is the
   * shape that matters here, because it is the one that must not be mistaken for "there
   * is nothing there". The origin this suite was last run against answers `207` on
   * `PROPFIND` and `503` on a ranged `GET` of a file it listed a moment earlier, so the
   * whole library reads fine and every cover is a transparent pixel.
   *
   * A read that *completed* and found no picture is a different observation from a read
   * that failed, and only the second one is worth repeating. Use `setGetStatus` to change
   * it mid-test, which is how the recovery is expressed.
   */
  getStatus?: number;
  /**
   * Answer every media `GET` with `200` and the **whole file**, ignoring the `Range`
   * header.
   *
   * ### Why this exists
   *
   * Because a real WebDAV server does it, and because the shape it produces is the one
   * this repository shipped a permanent fault on. A server that has not heard of ranges
   * does not answer `416` or `206`; it answers `200` with everything, which is a
   * perfectly valid response to the request as written. `WebDavClient.readBounded` then
   * refuses it — the body is over the bound it asked for — and raises `413`.
   *
   * Which used to be classified as a *definitive* answer about the file, so enrichment
   * stamped `enriched_at` and wrote `duration: 0` with no tags: one origin like this
   * stamped an entire library "already read" without reading any of it, and no `getSong`
   * or rescan could undo it. See `isTransientEnrichmentFailure`.
   *
   * Mutable for the same reason as `setGetStatus`: the fault is only visible across the
   * moment the origin changes, and a knob fixed at construction cannot express it.
   */
  ignoreRange?: boolean;
}

export interface FakeDav {
  readonly fetch: typeof fetch;
  /**
  `PROPFIND` paths requested, in order.
  */
  readonly propfinds: string[];
  /**
  `GET` paths requested, in order.
  */
  readonly gets: Array<{ path: string; range: string | null }>;
  /**
  Every request this origin received, of any method.

  The number a test asserts `ChunkResult.webdavRequests` against. The service
  counts inside `WebDavClient.request()`, so this is an independent observation of
  the same fact rather than the service's own arithmetic restated — which is what
  makes the equality meaningful.
  */
  readonly requestCount: () => number;
  /**
  Basic credentials seen, so a test can assert the client sent the right ones.
  */
  readonly credentials: string[];
  /**
   * Replace the library the origin serves.
   *
   * Required rather than optional because a test that builds a *new* tree object and
   * mutates it is mutating something the fake never reads — the scan then appears to
   * ignore every change, and the failure looks like a product bug.
   */
  setTree(next: Record<string, DavEntry[]>): void;
  /**
   * Make every media `GET` answer `status`, leaving `PROPFIND` at `207`. `null` restores
   * normal serving.
   *
   * Mutable for the same reason `setTree` is: the defect it exists for is only visible
   * across the moment the origin recovers, and a knob fixed at construction cannot
   * express a recovery.
   */
  setGetStatus(status: number | null): void;
  /**
   * Start or stop ignoring `Range` on media `GET`s. See `FakeDavOptions.ignoreRange`.
   */
  setIgnoreRange(ignore: boolean): void;
  reset(): void;
}

/**
 * Serve a `GET`, honouring `Range`.
 *
 * ### Why the range is actually applied
 *
 * This fake used to return the whole file with a `206` and a `Content-Range` header
 * claiming otherwise. That modelled a server which lies about the range it served, and
 * it hid the one bug that matters most here: a caller that builds the request and then
 * ignores the response length. The product promise is that `stream` is a `Range`
 * passthrough with no transcoding, and that promise is only testable against a fake
 * that genuinely truncates.
 *
 * The unsatisfiable case (`start >= total`) answers `416` with the `Content-Range`
 * unsatisfied form, because a caller handed a `200` for a beyond-the-end range would
 * silently read the whole file.
 */
/**
 * A `Response` body from bytes.
 *
 * The copy through a fresh `ArrayBuffer` is not incidental: a `Uint8Array` over a
 * `SharedArrayBuffer` is not a `BodyInit`, and without the copy this only compiles
 * against a narrower lib than the one the Workers runtime uses.
 */
function asBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function serveEntry(entry: DavEntry, range: string | null): Response {
  const total = entry.size ?? entry.body?.length ?? 0;
  const contentType = entry.contentType ?? 'application/octet-stream';
  const body = entry.body;

  if (range === null) {
    const whole = body ?? new Uint8Array(total);
    return new Response(asBody(whole), { status: 200, headers: { 'Content-Type': contentType, 'Content-Length': String(whole.length) } });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match === null) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });

  const start = match[1] === '' ? 0 : Number(match[1]);
  const requestedEnd = match[2] === '' ? total - 1 : Number(match[2]);
  if (!Number.isFinite(start) || start >= total) {
    return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }

  // Only materialize up to the requested end: a 128 KiB prefix read of a 4 GiB file
  // must not allocate 4 GiB in a test.
  const available = body ?? new Uint8Array(Math.min(requestedEnd + 1, total));
  const end = Math.min(requestedEnd, total - 1, available.length - 1);
  const slice = available.subarray(start, end + 1);

  return new Response(asBody(slice), {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${start + slice.length - 1}/${total}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

/**
 * Reject a `fetch` invoked with the wrong receiver, the way workerd does.
 *
 * ### Why this exists, and what it cost to not have it
 *
 * `WebDavClient` stored the global `fetch` in a field and called it as
 * `this.fetchImpl(...)` — a **method call**, so the receiver was the client rather
 * than the global scope. workerd's `fetch` validates its receiver and throws
 * `TypeError: Illegal invocation: function called with incorrect 'this' reference.`
 * Every WebDAV path in the product was broken by it: probe, scan, tree
 * materialization, enrichment, and streaming, all against a live origin answering
 * `207`.
 *
 * The suite was green throughout, for two reasons that had to both be true:
 *
 * 1. **The double was an arrow function.** An arrow has no `this` binding, so it
 *    *cannot observe a receiver*. A double that is structurally incapable of
 *    detecting the class of bug it existed to detect is worse than no double,
 *    because it lends the bug a passing test.
 * 2. **Node's real `globalThis.fetch` does not check its receiver either.** So even
 *    the tests that stubbed in this double were exercising a `fetch` more forgiving
 *    than the platform's.
 *
 * A double is a claim about the platform. This one now makes the claim workerd
 * actually makes, and it is a `function` rather than an arrow precisely so that the
 * receiver is observable.
 *
 * ### The rule being enforced
 *
 * A platform global must be invoked **bare** — `fetch(url)` — or with the global
 * scope as its receiver. `this` is `undefined` for a bare call from module code,
 * which is what a hand-written `fetch(...)` in a Worker produces; anything else
 * means a stored reference is being called as somebody else's method.
 *
 * @param inner The implementation to guard. Its own receiver is irrelevant, so it
 *   stays an arrow.
 */
function withReceiverCheck(inner: typeof fetch): typeof fetch {
  return function receiverChecked(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError(
        "Illegal invocation: function called with incorrect `this` reference. " +
          'A platform global was invoked as a method of another object.',
      );
    }
    return inner(input, init);
  } as typeof fetch;
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
  let getStatus: number | null = options.getStatus ?? null;
  let ignoreRange = options.ignoreRange ?? false;
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

    // Before the response is built, and after the call is recorded, so a delayed
    // origin still counts every request it was asked for.
    if (options.latencyMs !== undefined && options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    }

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
      if (getStatus !== null) return new Response('', { status: getStatus });
      const entry = Object.values(tree).flat().find((candidate) => candidate.path === path);
      if (entry === undefined) return new Response('', { status: 404 });
      // `null` range: the whole body with a `200`, which is what a server without range
      // support actually sends. Deliberately *not* a `206` claiming a prefix — that would
      // model a server lying about what it served, which this file already stopped doing.
      return serveEntry(entry, ignoreRange ? null : range);
    }

    return new Response('', { status: 405 });
  }) as typeof fetch;

  return {
    fetch: withReceiverCheck(impl),
    propfinds,
    gets,
    credentials,
    // `calls` rather than `propfinds.length + gets.length`: a third method added to
    // the client later would show up here without this helper changing, so the count
    // cannot quietly go stale the way a two-array sum would.
    requestCount: () => calls,
    setTree: (next: Record<string, DavEntry[]>) => {
      tree = next;
    },
    setGetStatus: (next: number | null) => {
      getStatus = next;
    },
    setIgnoreRange: (next: boolean) => {
      ignoreRange = next;
    },
    reset: () => {
      propfinds.length = 0;
      gets.length = 0;
      credentials.length = 0;
      calls = 0;
    },
  };
}

/**
Turn a parsed resource back into the model a test wants to assert on.
*/
function toResources(entries: readonly DavEntry[]): DavResource[] {
  return entries.map((entry) => ({
    href: entry.path,
    path: entry.path,
    isCollection: entry.collection === true,
    contentLength: entry.collection ? null : (entry.size ?? 0),
    contentType: entry.contentType ?? null,
    lastModifiedMs: entry.mtime ?? null,
    etag: entry.etag ?? null,
    displayName: entry.path.split('/').findLast(Boolean) ?? entry.path,
  }));
}

export { fakeDav, toResources, withReceiverCheck };
// Re-exported so a test that only needs the `207` body does not import the transport that
// happens to produce it, and so `DavEntry` keeps the one import path it had.
export { multistatus } from './davMultistatus';
export type { DavEntry } from './davMultistatus';
