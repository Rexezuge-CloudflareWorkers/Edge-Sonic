/**
 * The `subsonic-response` envelope: the single exit point for every endpoint.
 *
 * Both success and failure are produced here so that the two can never diverge
 * on the attributes clients rely on (`version`, `type`, `serverVersion`,
 * `openSubsonic`) — a failure envelope missing `version` is reported by some
 * clients as a server outage rather than as the actual error.
 */
import { API_VERSION, DEFAULT_FORMAT, OPEN_SUBSONIC, SERVER_TYPE, SERVER_VERSION, XML_NAMESPACE } from './constants';
import type { ResponseFormat } from './constants';
import { ErrorCode, SubsonicError, httpStatusForErrorCode } from './errors';
import type { ElementNode, Node } from './nodes';
import { el, elList } from './nodes';
import { isValidJsonpCallback, serializeJson, serializeJsonp, serializeXml } from './serialize';

const CONTENT_TYPES: Record<ResponseFormat, string> = {
  xml: 'text/xml; charset=UTF-8',
  json: 'application/json; charset=UTF-8',
  jsonp: 'application/javascript; charset=UTF-8',
};

/**
 * Resolve the requested output format.
 *
 * An unrecognized `f` falls back to the protocol default rather than failing:
 * `f` is advisory, and rejecting the call would break a client over a cosmetic
 * difference when the same data is available in the default form.
 */
function resolveFormat(raw: string | null | undefined): ResponseFormat {
  if (raw === 'json' || raw === 'jsonp' || raw === 'xml') return raw;
  return DEFAULT_FORMAT;
}

function rootAttributes(status: 'ok' | 'failed'): Record<string, string | number | boolean> {
  return {
    status,
    version: API_VERSION,
    type: SERVER_TYPE,
    serverVersion: SERVER_VERSION,
    openSubsonic: OPEN_SUBSONIC,
  };
}

/** Options every response builder accepts. */
interface EnvelopeOptions {
  format: ResponseFormat;
  /** Only consulted for `jsonp`. */
  jsonpCallback?: string | null;
}

function render(root: ElementNode, options: EnvelopeOptions): string {
  if (options.format === 'json') return serializeJson(root);
  if (options.format === 'jsonp' && options.jsonpCallback && isValidJsonpCallback(options.jsonpCallback)) {
    return serializeJsonp(root, options.jsonpCallback);
  }
  return serializeXml(root);
}

/**
 * Build a successful response.
 *
 * `payload` is the endpoint's single result element, or `null` for endpoints
 * whose success response is empty (`ping`, `deletePlaylist`, `star`, …) — the
 * protocol specifies a bare `<subsonic-response status="ok"/>` there, and some
 * clients treat any child element as a protocol violation.
 */
function successResponse(payload: ElementNode | null, options: EnvelopeOptions): Response {
  const root: ElementNode = {
    name: 'subsonic-response',
    attrs: rootAttributes('ok'),
    ...(payload ? { children: [payload] } : {}),
  };
  return new Response(render(root, options), {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPES[options.format],
      // Responses are per-user and per-library; a shared cache must never serve
      // one user's library to another.
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Build a failure response from a protocol error.
 *
 * @param throttled Set when the request was rejected by the auth throttle, so
 *   the status can be 429 while the body stays a valid `failed` envelope.
 */
function errorResponse(error: SubsonicError, options: EnvelopeOptions, throttled = false): Response {
  const root: ElementNode = {
    name: 'subsonic-response',
    attrs: rootAttributes('failed'),
    children: [el('error', { code: error.code, message: error.message })],
  };
  return new Response(render(root, options), {
    status: httpStatusForErrorCode(error.code, throttled),
    headers: {
      'Content-Type': CONTENT_TYPES[options.format],
      'Cache-Control': 'no-store',
    },
  });
}

/** Convenience constructor for a missing-parameter failure. */
function missingParameter(name: string): SubsonicError {
  return new SubsonicError(ErrorCode.MissingParameter, `Required parameter is missing: ${name}`);
}

/** Convenience constructor for a not-found failure. */
function notFound(what: string): SubsonicError {
  return new SubsonicError(ErrorCode.NotFound, `The requested data was not found: ${what}`);
}

export {
  successResponse,
  errorResponse,
  resolveFormat,
  missingParameter,
  notFound,
  CONTENT_TYPES,
  XML_NAMESPACE,
  el,
  elList,
};
export type { EnvelopeOptions, ResponseFormat, Node, ElementNode };
