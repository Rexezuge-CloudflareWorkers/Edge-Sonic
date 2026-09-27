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
import { errorResponse, missingParameter, notFound, resolveFormat, successResponse } from '@edge-sonic/subsonic';
import { ErrorCode, isClientVersionSupported, SubsonicError } from '@edge-sonic/subsonic';
import type { SubsonicError as SubsonicErrorType } from '@edge-sonic/subsonic';
import { SubsonicParams, decodeLegacyPassword } from '@edge-sonic/subsonic';
import { toSubsonicError } from '@edge-sonic/backend-services/errors';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { BaseRoute } from '@/admin/routes';
import type { RestContext } from './context';
import type { AdminContext } from '@/admin/routes';
import { ENDPOINTS, ENDPOINT_NAMES } from './endpoints';
import type { RestHandler } from './endpoints';

type RestOutcome = Response | { response: Response };

/** The trusted client IP, used only to key the auth throttle. */
function clientIpOf(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? '0.0.0.0';
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
  if (lower.endsWith('.')) return null;
  return rest;
}

/**
 * Authenticate and dispatch one `/rest` call.
 *
 * Order matters and is fixed:
 * 1. parse parameters (GET query **and** form POST),
 * 2. resolve the output format and JSONP callback,
 * 3. authenticate — before the endpoint name is even considered, so an unknown
 *    endpoint cannot be used to probe whether an account exists,
 * 4. negotiate the protocol version,
 * 5. dispatch.
 */
async function dispatchRest(c: AdminContext, pathname: string, request: Request): Promise<RestOutcome> {
  const params = await SubsonicParams.fromRequest(request);
  const format = resolveFormat(params.get('f'));
  const jsonpCallback = params.get('callback') ?? null;
  const options = { format, jsonpCallback };

  const endpointName = endpointNameFromPath(pathname);

  try {
    if (endpointName === null) throw notFound(`endpoint ${pathname}`);

    // 3. Authenticate first. An unknown endpoint must not be answerable without
    //    credentials, and a failure must not disclose which accounts exist.
    const username = params.require('u');
    const token = params.get('t') ?? null;
    const salt = params.get('s') ?? null;
    const rawPassword = params.get('p');
    const legacyPassword = rawPassword === null || rawPassword === undefined ? null : safeDecodeLegacyPassword(rawPassword);

    const scope = BaseRoute.getScope(c);
    const user = await scope.get(Tokens.SubsonicAuthService).authenticate({
      username,
      token,
      salt,
      legacyPassword,
      clientIp: clientIpOf(request),
    });

    // 4. Version negotiation, after auth so an unauthenticated caller cannot use
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
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
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
  c: AdminContext,
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
    users: await scope.get(Tokens.UserDAO)(),
    playlists: await scope.get(Tokens.PlaylistDAO)(),
    annotations: await scope.get(Tokens.AnnotationDAO)(),
    pageSize: (requested, fallback) => {
      const base = requested ?? fallback ?? defaultPage;
      return Math.min(Math.max(1, Math.trunc(base)), maxPage);
    },
  };
}

export { dispatchRest, endpointNameFromPath, clientIpOf, assertClientVersion, successResponse, errorResponse, missingParameter, ENDPOINT_NAMES };
export type { RestOutcome, SubsonicErrorType };
