import { describe, expect, it } from 'vitest';
import { onRequest } from '../functions/[[path]]';

/**
 * The Pages→Worker proxy: the second deployment target, and the one with no tests.
 *
 * `functions/` is a Cloudflare Pages Functions directory, so it is outside every coverage glob
 * and outside the workspace packages — which is exactly why it had **zero** assertions while
 * being the whole difference between "the operator UI works on Pages" and "the operator UI 404s
 * on `/user/...`". A second deployment target that nothing executes is a target nothing has run.
 *
 * The `Fetcher` double is minimal and answers one question: *what request did the Worker
 * actually receive?* That is the only thing this file can be wrong about — every header decision
 * below is invisible from a status code, so a double that only reported status would pass against
 * every defect in this file.
 */

const ORIGIN = 'https://edge-sonic.pages.dev';

/**
The Worker as Pages hands it over: records the request, answers with a fixed response.
*/
function recordingWorker(): { fetch: Fetcher; seen: Request[] } {
  const seen: Request[] = [];
  const fetch = (async (request: Request): Promise<Response> => {
    seen.push(request);
    return new Response('worker', { status: 200 });
  }) as unknown as Fetcher;
  // `env.API_WORKER.fetch(...)` is called as a **method**, so the double must be an object whose
  // `fetch` is a method — an arrow assigned to `fetch` and then invoked through `env.API_WORKER`
  // would receive the wrong receiver. That is the `Illegal invocation` defect this repository
  // records about `fetch` being stubbed as a bare arrow, and the double is a `function` for the
  // same reason.
  return { fetch: { fetch } as unknown as Fetcher, seen };
}

function invoke(request: Request, fetch: Fetcher): Promise<Response> {
  // `PagesFunction` is a Workers runtime type that `test/`'s tsconfig does not load, so
  // the handler is invoked through the shape it is given rather than through its own signature.
  const handler = onRequest as unknown as (context: unknown) => Response | Promise<Response>;
  const context = {
    request,
    env: { API_WORKER: fetch },
    params: {},
    functionPath: '/[[path]]',
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    next: () => undefined,
    data: {},
  } as unknown as Parameters<typeof handler>[0];
  return Promise.resolve(handler(context)) as Promise<Response>;
}

describe('the Pages proxy', () => {
  it('preserves the original URL, because the Worker routes on it', async () => {
    const worker = recordingWorker();
    await invoke(new Request(`${ORIGIN}/user/libraries?page=2`), worker.fetch);

    const seen = worker.seen[0]!;
    expect(seen.url).toBe(`${ORIGIN}/user/libraries?page=2`);
    expect(new URL(seen.url).pathname).toBe('/user/libraries');
    expect(new URL(seen.url).searchParams.get('page')).toBe('2');
  });

  it('tells the Worker the origin Pages served, which only Pages knows', async () => {
    const worker = recordingWorker();
    await invoke(new Request(`${ORIGIN}/rest/ping.view`), worker.fetch);

    const headers = worker.seen[0]!.headers;
    expect(headers.get('X-Forwarded-Host')).toBe('edge-sonic.pages.dev');
    expect(headers.get('X-Forwarded-Proto')).toBe('https');
    expect(headers.get('X-Forwarded-Uri')).toBe('/rest/ping.view');
  });

  it('strips a client-supplied X-Forwarded-For rather than forwarding it', async () => {
    // The reason this file exists. `clientIp` in the Worker reads only `CF-Connecting-IP` and
    // refuses every forwarding header on purpose — and on `/rest` that address also keys a
    // D1-backed **fail-closed credential throttle**, so a rotating header turns a bounded
    // brute force into an unbounded one. A proxy that passes one through is a hole in that
    // decision made somewhere else.
    const worker = recordingWorker();
    await invoke(
      new Request(`${ORIGIN}/rest/getSong.view`, {
        headers: { 'X-Forwarded-For': '203.0.113.1, 198.51.100.2' },
      }),
      worker.fetch,
    );

    expect(worker.seen[0]!.headers.get('X-Forwarded-For')).toBeNull();
  });

  it('strips every other forwarding header a client could set', async () => {
    // Enumerated rather than listing the two this file used to handle: a proxy is exactly where a
    // new forwarding header gets invented upstream and then trusted downstream, and a list of two
    // is a list that falls behind. The three the proxy *sets* are restored below.
    const worker = recordingWorker();
    await invoke(
      new Request(`${ORIGIN}/user/me`, {
        headers: {
          'X-Real-Ip': '203.0.113.9',
          'True-Client-IP': '203.0.113.10',
          Forwarded: 'for=203.0.113.11',
          'X-Forwarded-Host': 'evil.example',
          'X-Forwarded-Proto': 'gopher',
          'X-Forwarded-Uri': '/spoofed',
        },
      }),
      worker.fetch,
    );

    const headers = worker.seen[0]!.headers;
    for (const header of ['X-Real-Ip', 'True-Client-IP', 'Forwarded']) {
      expect(headers.get(header), header).toBeNull();
    }
    // The three the proxy owns are set from the request, not from the client — so an injected
    // `X-Forwarded-Host` of `evil.example` must not survive.
    expect(headers.get('X-Forwarded-Host')).toBe('edge-sonic.pages.dev');
    expect(headers.get('X-Forwarded-Proto')).toBe('https');
    expect(headers.get('X-Forwarded-Uri')).toBe('/user/me');
  });

  it('carries CF-Connecting-IP across unchanged, since that is what the Worker reads', async () => {
    // The comment this file used to carry claimed `X-Forwarded-For` was what keyed the auth
    // throttle. It never was: the header is copied by `new Headers(request.headers)`, so this is
    // what has always done it. Asserted, because a future edit that drops the copy would take
    // the address away with nothing failing.
    const worker = recordingWorker();
    await invoke(new Request(`${ORIGIN}/user/me`, { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), worker.fetch);

    expect(worker.seen[0]!.headers.get('CF-Connecting-IP')).toBe('203.0.113.7');
  });

  it('forwards the request method, and sends no body for the two that cannot have one', async () => {
    const worker = recordingWorker();
    await invoke(new Request(`${ORIGIN}/user/me`, { method: 'POST', body: 'a=1' }), worker.fetch);

    const seen = worker.seen[0]!;
    expect(seen.method).toBe('POST');
    // `GET`/`HEAD` with a body is rejected outright by `Request`, so the guard is not defensive —
    // it is the difference between a forwarded GET working and the whole proxy throwing.
    await invoke(new Request(`${ORIGIN}/user/me`), worker.fetch);
    expect(worker.seen[1]!.body).toBeNull();
  });

  it('returns whatever the Worker answered, unaltered', async () => {
    const worker = { fetch: { fetch: async () => new Response('nope', { status: 418 }) } as unknown as Fetcher };
    const response = await invoke(new Request(`${ORIGIN}/rest/nope.view`), worker.fetch);

    expect(response.status).toBe(418);
    expect(await response.text()).toBe('nope');
  });

  it('does not swallow a Worker failure into a 200', async () => {
    // A proxy that catches and answers "something went wrong" reports a healthy deployment for an
    // unhealthy one, and the SPA has no way to tell the two apart.
    const worker = {
      fetch: {
        fetch: async () => {
          throw new Error('worker is down');
        },
      } as unknown as Fetcher,
    };
    await expect(invoke(new Request(`${ORIGIN}/user/me`), worker.fetch)).rejects.toThrow('worker is down');
  });
});
