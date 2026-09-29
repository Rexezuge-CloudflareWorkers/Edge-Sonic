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
 * `request.url`, and the `X-Forwarded-*` headers are what it reads to recover the
 * request's own origin, so a rewritten path would present as an unknown route.
 */
interface PagesProxyEnv {
  API_WORKER: Fetcher;
}

const CF_CONNECTING_IP_HEADER = 'CF-Connecting-IP';
const FORWARDED_FOR_HEADER = 'X-Forwarded-For';
const FORWARDED_HOST_HEADER = 'X-Forwarded-Host';
const FORWARDED_PROTO_HEADER = 'X-Forwarded-Proto';
const FORWARDED_URI_HEADER = 'X-Forwarded-Uri';

async function proxyToApi({ request, env }: Parameters<PagesFunction<PagesProxyEnv>>[0]): Promise<Response> {
  const originalUrl: URL = new URL(request.url);

  const headers: Headers = new Headers(request.headers);
  headers.set(FORWARDED_HOST_HEADER, originalUrl.host);
  headers.set(FORWARDED_PROTO_HEADER, originalUrl.protocol.replace(':', ''));
  headers.set(FORWARDED_URI_HEADER, `${originalUrl.pathname}${originalUrl.search}`);

  // The client IP has to be restated, because a service binding hands the Worker a
  // request whose socket is the Pages project rather than the end user. Without it every
  // call would arrive from one address and the auth throttle would key on that.
  const clientIp: string | null = request.headers.get(CF_CONNECTING_IP_HEADER);
  if (clientIp) {
    headers.set(FORWARDED_FOR_HEADER, clientIp);
  }

  // `GET`/`HEAD` carry no body, and a `Request` with a body is rejected outright for
  // those methods. A streamed body is not buffered here: `request.body` is forwarded as
  // a stream, so a large upload does not have to fit in memory on the Pages side.
  const proxyRequest: Request = new Request(originalUrl.href, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: request.redirect,
  });

  return env.API_WORKER.fetch(proxyRequest);
}

export const onRequest: PagesFunction<PagesProxyEnv> = proxyToApi;
