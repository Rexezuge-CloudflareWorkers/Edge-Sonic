/**
 * `/rest` dispatch.
 *
 * ### Why a registry rather than a route per endpoint
 *
 * Subsonic endpoints are addressed as `/rest/<name>.view` **or** `/rest/<name>.do`,
 * and both spellings are in wide use — `.do` is what several older clients send,
 * and some send neither. A Hono route per endpoint would need two registrations
 * per method and would 404 on a bare `/rest/<name>`.
 *
 * A single catch-all plus a lookup table handles all three spellings, and — more
 * usefully — puts the *protocol* rules in one auditable place: authentication,
 * version negotiation, format resolution, and the guarantee that every response
 * is a well-formed envelope whether the endpoint exists, threw, or declined to
 * implement.
 */
import { errorResponse, notFound, resolveFormat, successResponse } from '@edge-sonic/subsonic';
import { ErrorCode, isClientVersionSupported, SubsonicError } from '@edge-sonic/subsonic';

import { SubsonicParams, decodeLegacyPassword } from '@edge-sonic/subsonic';
import { toSubsonicError } from '@edge-sonic/backend-services/errors';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { UserContext } from '../endpoints/BaseRoute';
import { clientIp } from '../middleware/rateLimit';
import type { RestContext } from './context';
import { ENDPOINTS } from './endpoints';
import { openSubsonicExtensionsPayload } from './endpoints/system';
import type { RestHandler } from './endpoints';

type RestOutcome = Response | { response: Response };

/**
 * The endpoints answerable without credentials.
 *
 * One member, and it is a constant. See the note at the branch in `dispatchRest` for why
 * this is a named set rather than a per-handler flag, and `test/endpoints.test.ts` for the
 * assertion that keeps it at one.
 */
const PUBLIC_ENDPOINTS: ReadonlySet<string> = new Set(['getOpenSubsonicExtensions']);

/**
The trusted client IP, used only to key the auth throttle.

Delegates to the middleware's own `clientIp`, so there is one derivation of the
trusted address in the app. That function trusts `CF-Connecting-IP` and nothing else:
the previous fallback chain also accepted `x-real-ip`, which is client-controlled, so
an attacker could rotate it per attempt and the D1-backed **fail-closed** failure
counter would never increment. The sibling file in the same layer documents exactly
why a non-`CF-Connecting-IP` header must not be trusted for this purpose.
*/
function clientIpOf(request: Request): string {
  return clientIp((name) => request.headers.get(name) ?? undefined);
}

/**
 * Split `/rest/<name>.view` into `<name>`.
 *
 * Accepts `.view`, `.do`, and no suffix, case-insensitively. A path with extra
 * segments is a client addressing an endpoint that does not exist, and the
 * answer is `code=70` rather than a 404 — a client parsing the envelope needs the
 * envelope.
 */
function endpointNameFromPath(pathname: string): string | null {
  const prefix = '/rest/';
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest.includes('/')) return null;
  const lower = rest.toLowerCase();
  if (lower.endsWith('.view')) return rest.slice(0, -'.view'.length);
  if (lower.endsWith('.do')) return rest.slice(0, -'.do'.length);
  // A name that is all dots, or that ends mid-suffix, is not an endpoint.
  return lower.endsWith('.') ? null : rest;
}

/**
 * Authenticate and dispatch one `/rest` call.
 *
 * Order matters and is fixed:
 * 1. parse parameters (GET query **and** form POST),
 * 2. resolve the output format and JSONP callback,
 * 3. answer the one publicly-accessible endpoint, if that is what was asked for,
 * 4. authenticate — before the endpoint name is even considered, so an unknown
 *    endpoint cannot be used to probe whether an account exists,
 * 5. negotiate the protocol version,
 * 6. dispatch.
 */
async function dispatchRest(c: UserContext, pathname: string, request: Request): Promise<RestOutcome> {
  const params = await SubsonicParams.fromRequest(request);
  const format = resolveFormat(params.get('f'));
  const jsonpCallback = params.get('callback') ?? null;
  const options = { format, jsonpCallback };

  const endpointName = endpointNameFromPath(pathname);

  try {
    if (endpointName === null) throw notFound(`endpoint ${pathname}`);

    // 3. The one endpoint that answers before authentication, because the protocol says
    //    it must be publicly accessible: `getOpenSubsonicExtensions` is capability
    //    discovery, and a client that has not authenticated yet has no credentials to send
    //    with the question.
    //
    //    Safe because the answer is a compile-time constant — an empty extension list —
    //    and carries nothing about this deployment: no user, no library, no version, no
    //    capability beyond "there are none". There is no id in it to forge and nothing in
    //    it to disclose, which is the same reason the endpoint can be public at all.
    //
    //    Deliberately a named single-entry set rather than a flag on the handler. A
    //    per-handler "public" marker is one edit away from covering an endpoint that does
    //    read data, and nothing would say so; a set is greppable, and
    //    `test/endpoints.test.ts` asserts it has exactly one member and that every other
    //    endpoint still refuses an unauthenticated call.
    if (endpointName !== null && PUBLIC_ENDPOINTS.has(endpointName)) {
      return successResponse(openSubsonicExtensionsPayload(), { format, jsonpCallback });
    }

    // 4. Authenticate. An unknown endpoint must not be answerable without credentials, and
    //    a failure must not disclose which accounts exist.
    const username = params.require('u');
    const token = params.get('t') ?? null;
    const salt = params.get('s') ?? null;
    const rawPassword = params.get('p');
    // `get` returns `string | undefined`. This compared against `null`, which is never
    // equal, so an **absent** `p` parameter was passed to the decoder instead of being
    // treated as absent — and the legacy cleartext path only ever worked when the
    // parameter was present.
    const legacyPassword = rawPassword === undefined ? null : safeDecodeLegacyPassword(rawPassword);

    const scope = BaseRoute.getScope(c);
    const user = await scope.get(Tokens.SubsonicAuthService).authenticate({
      username,
      token,
      salt,
      legacyPassword,
      clientIp: clientIpOf(request),
    });

    // 5. Version negotiation, after auth so an unauthenticated caller cannot use
    //    it to fingerprint the server.
    const version = params.get('v');
    if (version !== undefined) assertClientVersion(version);

    const handler = ENDPOINTS[endpointName] as RestHandler | undefined;
    if (handler === undefined) throw notFound(`endpoint ${endpointName}`);

    const context = await buildContext(c, { params, format, jsonpCallback, user, username });
    return await handler(context);
  } catch (error) {
    const mapped = toSubsonicError(error);
    return errorResponse(mapped, options);
  }
}

/**
 * `enc:`-decoding is a *credential* path, and a malformed one must look exactly
 * like a wrong password rather than like a parse error — otherwise the error
 * distinguishes "you sent nonsense" from "you sent the wrong thing", which is a
 (free) oracle for nothing but noise.
 */
function safeDecodeLegacyPassword(raw: string): string | null {
  try {
    return decodeLegacyPassword(raw);
  } catch {
    return null;
  }
}

function assertClientVersion(raw: string): void {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(raw.trim());
  if (!match) {
    // A client that sends a version this server cannot parse is not necessarily
    // wrong — the field is documented as a version, and some clients send odd
    // values. Treated as compatible rather than refused.
    return;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (isClientVersionSupported(major, minor)) return;
  // Same major but a higher minor means this server is the old one.
  throw new SubsonicError(
    major === 1 ? ErrorCode.ServerTooOld : ErrorCode.ClientTooOld,
    `This server implements Subsonic API 1.16.1; the client requested ${raw}.`,
  );
}

/**
 * Build the handler context.
 *
 * The DAOs are bound as lazy thunks in the composition root, so they are awaited
 * here — once per request, rather than per handler call. A handler never sees a
 * promise, and a request that touches one DAO does not construct the other seven.
 */
async function buildContext(
  c: UserContext,
  input: {
    params: SubsonicParams;
    format: ReturnType<typeof resolveFormat>;
    jsonpCallback: string | null;
    user: RestContext['user'];
      username: string;
  },
): Promise<RestContext> {
  const scope = BaseRoute.getScope(c);
  const config = scope.get(Tokens.AppConfig);
  const maxPage = config.getMaxPageSize();
  const defaultPage = config.getDefaultPageSize();

  return {
    params: input.params,
    format: input.format,
    jsonpCallback: input.jsonpCallback,
    request: c.req.raw,
    streamTimeoutMs: config.getStreamTimeoutMs(),
    user: input.user,
    username: input.username,
    client: input.params.getOr('c', 'unknown'),
    clientIp: clientIpOf(c.req.raw),
    libraries: scope.get(Tokens.LibraryService),
    tree: scope.get(Tokens.TreeService),
    scan: scope.get(Tokens.ScanService),
    enrichment: scope.get(Tokens.EnrichmentService),
    songs: await scope.get(Tokens.SongDAO)(),
    songIndex: await scope.get(Tokens.SongIndexDAO)(),
    users: await scope.get(Tokens.UserDAO)(),
    playlists: await scope.get(Tokens.PlaylistDAO)(),
    annotations: await scope.get(Tokens.AnnotationDAO)(),
    cache: scope.get(Tokens.KvCache),
    pageSize: (requested, fallback) => {
      const base = requested ?? fallback ?? defaultPage;
      return Math.min(Math.max(1, Math.trunc(base)), maxPage);
    },
  };
}

export { dispatchRest, endpointNameFromPath, clientIpOf, assertClientVersion, PUBLIC_ENDPOINTS };
export type { RestOutcome };

export {missingParameter, successResponse, type SubsonicError as SubsonicErrorType, errorResponse} from '@edge-sonic/subsonic';
export {ENDPOINT_NAMES} from './endpoints';