/**
 * The worker: Hono app, route ordering, and one-shot configuration validation.
 *
 * ### Route order is load-bearing
 *
 * ```
 * securityHeaders            — every response, including errors
 * onError                    — the Subsonic envelope for anything unhandled
 * /health                    — unauthenticated, so a probe never needs a credential
 * SPA shell                  — browser navigations only
 * scopeMiddleware            — one Container per request
 * OPTIONS *                  — CORS preflight, BEFORE auth (see below)
 * /admin/*  auth             — Cloudflare Access
 * /admin/*  rate limits      — AFTER auth, so a bucket is per operator
 * /admin/*  routes
 * /rest/*                    — Subsonic credentials; limits key on the client address
 * ```
 *
 * ### Why the admin rate limits follow auth
 *
 * The limiter keys on `c.get('AdminEmail')` so that a budget belongs to an operator
 * rather than to an address, and several operators can share one behind a NAT. That
 * only works if the limiter runs *after* the middleware that sets the variable. The
 * previous order registered the limits first, while a comment claimed the opposite
 * ("before auth, so they can key on the resolved identity") — so every bucket
 * silently fell back to `ip:…` and the comment documented a property the code did not
 * have. A comment asserting an ordering the code does not implement is worse than
 * either a correct comment or a correct implementation.
 *
 * `/rest/*` cannot do this: a Subsonic client authenticates inside the dispatcher from
 * `u`/`t`/`s` query parameters, so there is no ambient identity to read, and its
 * limits are installed before the route.
 *
 * ### Why the preflight precedes auth
 *
 * A Fetch-spec preflight carries no credentials *by design*. Requiring auth for one
 * can only break clients, and a browser will never issue the real request after a
 * failed preflight. It is gated on `Access-Control-Request-Method` so that it
 * cannot shadow anything else: there is no DAV capability probe here to lose, but
 * the same guard keeps a blanket `OPTIONS` handler from swallowing a future one.
 */
import { AbstractEntrypointWorker } from '@edge-sonic/backend-runtime/base';
import { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import { Hono } from 'hono';
import { errorResponse, resolveFormat } from '@edge-sonic/subsonic';
import { toAdminResponse, toSubsonicError } from '@edge-sonic/backend-services/errors';
import { registerAdminRoutes } from '../admin/routes';
import { adminAuthentication, registerAdminRateLimits, registerRestRateLimits, scopeMiddleware, securityHeaders } from '../middleware';
import { dispatchRest } from '../rest/dispatch';
import { SPA_HTML } from '../generated/spa-shell';
import type { WorkerEnv } from '../endpoints/BaseRoute';

type App = Hono<WorkerEnv>;

/**
The SPA's client-side routes. Anything else is a 404 in the SPA itself.
*/
const SPA_ROUTES = ['/', '/libraries', '/users'] as const;

class EdgeSonicWorker extends AbstractEntrypointWorker {
  protected readonly app: App;
  /**
   * Configuration problems are silent at runtime — a bad numeric var falls back to
   * its default, a missing feature key only shows up as a 500 on one endpoint — so
   * they must be reported exactly once, not per request.
   */
  private configChecked = false;

  constructor() {
    super();
    const app = new Hono<WorkerEnv>();

    app.use('*', securityHeaders());

    // Anything that escapes the dispatcher still answers in the right dialect rather
    // than Hono's default text body: a client parsing `/rest` has no way to interpret
    // anything else, and the admin SPA reads HTTP statuses and a typed error body.
    app.onError((error, c) => {
      console.error('Unhandled worker error:', error instanceof Error ? (error.stack ?? error.message) : error);
      const url = new URL(c.req.url);
      if (!url.pathname.startsWith('/rest/')) {
        // The **admin** API, which is a JSON surface whose client reads the status. A
        // blanket 500 here threw away the whole error taxonomy: a missing field, a
        // duplicate slug, and a grant for a library that does not exist all became
        // "InternalServerError", which is an answer an operator cannot act on and a
        // support ticket that cannot be reproduced. `toAdminResponse` keeps the 4xx and
        // its message, and still masks a 5xx.
        const mapped = toAdminResponse(error, c.req.header('accept-language'));
        return c.json(mapped.body, mapped.status as 400);
      }
      const mapped = toSubsonicError(error);
      return errorResponse(mapped, { format: resolveFormat(url.searchParams.get('f')), jsonpCallback: url.searchParams.get('callback') });
    });

    app.get('/health', (c) => c.json({ ok: true, service: 'edge-sonic', apiVersion: '1.16.1' }));

    // The admin SPA. Served for its own routes only; `/rest` and `/admin` are API
    // surfaces and must never return HTML, or a client that mistypes a URL gets a
    // page it cannot parse.
    for (const route of SPA_ROUTES) {
      app.get(route, (c) => c.html(SPA_HTML));
    }

    app.use('*', scopeMiddleware);

    // CORS preflight, before authentication. See the class note.
    app.options('*', async (c, next) => {
      const isPreflight = c.req.header('access-control-request-method') !== undefined;
      if (!isPreflight) {
        await next();
        return;
      }
      return new Response(null, {
        status: 204,
        headers: {
          // The admin SPA is same-origin, so the default is "same-origin only".
          // A deployment that genuinely needs a cross-origin client must opt in
          // explicitly; reflecting any origin would let a page on any site drive
          // this API with the caller's cookie.
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    });

    // `/rest/*` has no ambient identity to key on — a Subsonic client authenticates
    // inside the dispatcher — so its limits are installed before the route.
    registerRestRateLimits(app);

    app.use('/admin/*', adminAuthentication());
    // After the auth middleware, not before: the bucket is per resolved operator, and
    // that is only true if `AdminEmail` is set by the time this runs.
    registerAdminRateLimits(app);
    registerAdminRoutes(app);

    // `/rest/*` authenticates itself, inside the dispatcher, because the
    // credentials arrive as Subsonic parameters rather than as headers. A Hono
    // middleware here would have to parse the query string a second time.
    app.all('/rest/*', async (c) => {
      const outcome = await dispatchRest(c, new URL(c.req.url).pathname, c.req.raw);
      return outcome instanceof Response ? outcome : outcome.response;
    });

    // A bare `/rest` is a client mistake, not an endpoint. Answered with the
    // envelope so the client can report it.
    app.all('/rest', (c) =>
      errorResponse(toSubsonicError(new Error('No endpoint named')), {
        format: resolveFormat(new URL(c.req.url).searchParams.get('f')),
        jsonpCallback: null,
      }),
    );

    app.notFound((c) => {
      const url = new URL(c.req.url);
      if (url.pathname.startsWith('/rest/')) {
        return errorResponse(toSubsonicError(new Error('No such endpoint')), {
          format: resolveFormat(url.searchParams.get('f')),
          jsonpCallback: url.searchParams.get('callback'),
        });
      }
      return c.json({ error: { code: 'NotFound', message: 'Not found.' } }, 404);
    });

    this.app = app;
  }

  protected async onRequest(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    if (!this.configChecked) {
      this.configChecked = true;
      try {
        for (const warning of AppConfiguration.fromEnv(env).validate()) {
          console.error(`[config] ${warning}`);
        }
      } catch (error) {
        console.error('[config] validation failed:', error instanceof Error ? error.message : String(error));
      }
    }
    return await this.app.fetch(request, env, ctx);
  }
}

export { EdgeSonicWorker };
