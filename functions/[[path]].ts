/**
 * Every non-asset request goes to the `edge-sonic` Worker.
 *
 * The SPA is same-origin by design: `apps/web/src/lib/api.ts` uses a root-relative
 * `API_BASE = '/user'`, and `apps/web/vite.config.ts` proxies `/user`, `/rest`, and
 * `/health` to `http://localhost:8787` in dev. There is no API base URL to configure and
 * no token in JavaScript, so the Cloudflare Access session cookie rides along under the
 * default `credentials: 'same-origin'`.
 *
 * That works on the Worker, which serves the SPA and the API from one origin. It does
 * **not** work on Pages, which serves `dist/` as static files: `/user/...` would resolve
 * to a static asset and 404, and the operator UI would render a shell that can never load
 * anything. This catch-all is what makes the second deployment target real rather than
 * decorative — the Pages log shows `Uploading Functions bundle` when it is present.
 *
 * `service` is the name in `apps/web/wrangler.template.jsonc`, which must match `name` in
 * `apps/api/wrangler.template.jsonc`. A typo here is a deploy-time failure, not a
 * runtime one, and it is the one place the two templates are coupled.
 *
 * The original URL is preserved rather than rewritten: the Worker routes on
 * `request.url`, so a rewritten path would present as an unknown route.
 */
interface PagesProxyEnv {
  API_WORKER: Fetcher;
}

const FORWARDED_HOST_HEADER = 'X-Forwarded-Host';
const FORWARDED_PROTO_HEADER = 'X-Forwarded-Proto';
const FORWARDED_URI_HEADER = 'X-Forwarded-Uri';

/**
 * Client-controlled forwarding headers, stripped before the request crosses the binding.
 *
 * ### Why these are removed rather than passed through
 *
 * `apps/api/src/middleware/rateLimit.ts` reads **only** `CF-Connecting-IP` and refuses
 * `X-Forwarded-For` and `x-real-ip` on purpose: they are settable by the client, and the
 * rate limiter keys buckets on them — and on `/rest` that identity also keys a D1-backed
 * **fail-closed credential throttle**. Rotating a forwarded header per attempt is therefore
 * the difference between a bounded brute force and an unbounded one, and
 * `test/rate-limit.test.ts` asserts the Worker ignores it.
 *
 * So this proxy must not hand the Worker a forwarded header it might come to trust. It
 * sets three itself, from values it reads off the request rather than the client:
 * `X-Forwarded-Host` and `X-Forwarded-Proto` describe the origin Pages served, which only
 * Pages knows, and `X-Forwarded-Uri` carries the original path because a service binding
 * hands over a rewritten URL.
 *
 * It previously set `X-Forwarded-For` from `CF-Connecting-IP`, with a comment claiming that
 * was what keyed the throttle. It never was — the copied `CF-Connecting-IP` header already
 * did, since `new Headers(request.headers)` carries every header across a service binding.
 * So the line was inert, and the claim beside it was the dangerous part: a reader reasoning
 * from the comment would have concluded the Worker's refusal of `X-Forwarded-For` was
 * handled here, which is exactly the conclusion that would let someone trust it later.
 *
 * Stripped rather than merely not-set, because the headers arrive from the client. A
 * request that reached Pages already carrying `X-Forwarded-For` would otherwise have its
 * value overwritten — which is fine — but the reason for overwriting rather than appending
 * is worth stating: appending would preserve an attacker-chosen entry at the far end of a
 * comma-separated list, which is what "the first value wins" readers get wrong.
 */
const CLIENT_FORWARDING_HEADERS = [
  'X-Forwarded-For',
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Forwarded-Uri',
  'X-Real-Ip',
  'Forwarded',
  'True-Client-IP',
] as const;

async function proxyToApi({ request, env }: Parameters<PagesFunction<PagesProxyEnv>>[0]): Promise<Response> {
  const originalUrl: URL = new URL(request.url);

  const headers: Headers = new Headers(request.headers);
  for (const header of CLIENT_FORWARDING_HEADERS) headers.delete(header);
  headers.set(FORWARDED_HOST_HEADER, originalUrl.host);
  headers.set(FORWARDED_PROTO_HEADER, originalUrl.protocol.replace(':', ''));
  headers.set(FORWARDED_URI_HEADER, `${originalUrl.pathname}${originalUrl.search}`);

  // `GET`/`HEAD` carry no body, and a `Request` with a body is rejected outright for
  // those methods. A streamed body is not buffered here: `request.body` is forwarded as
  // a stream, so a large upload does not have to fit in memory on the Pages side.
  //
  // `duplex: 'half'` is required by the Fetch spec whenever a `Request` is constructed with a
  // **stream** body, and Node throws without it — workerd does not, so this line was not
  // needed to run on Pages. It is here because `test/pages-proxy.test.ts` drives this handler
  // under Node, and because a stream body without it is rejected by half the implementations
  // that could execute this file. Not in the DOM lib's `RequestInit` type, hence the cast;
  // removing the cast would mean not forwarding bodies at all, which is a worse answer.
  const proxyRequest: Request = new Request(originalUrl.href, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: request.redirect,
    duplex: 'half',
  } as RequestInit);

  return env.API_WORKER.fetch(proxyRequest);
}

export const onRequest: PagesFunction<PagesProxyEnv> = proxyToApi;
