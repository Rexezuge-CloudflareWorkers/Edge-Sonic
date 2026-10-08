/**
 * Subsonic error codes and the failure envelope.
 *
 * The code set is fixed by the protocol (ten values) and is the *only* thing a
 * client localizes — the `message` is a human-readable string that clients
 * display verbatim when they do not recognize the code. So the message is
 * written to be readable in English on its own, and the code is what code in
 * `subsonic/` branches on.
 */

/**
 * Protocol error codes, verbatim from the Subsonic API reference.
 */
const ErrorCode = {
  /**
  A generic error.
  */
  Generic: 0,
  /**
  Required parameter is missing.
  */
  MissingParameter: 10,
  /**
  Incompatible REST protocol version. Client must upgrade.
  */
  ClientTooOld: 20,
  /**
  Incompatible REST protocol version. Server must upgrade.
  */
  ServerTooOld: 30,
  /**
  Wrong username or password.
  */
  WrongCredentials: 40,
  /**
  Token authentication is not supported for this user.
  */
  TokenAuthUnsupported: 41,
  /**
  User is not authorized for the given operation.
  */
  NotAuthorized: 50,
  /**
  The requested data was not found.
  */
  NotFound: 70,
} as const;

type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Default English messages, chosen so an unrecognized code still reads as a
 * sentence to the user rather than as a number.
 */
const DEFAULT_MESSAGES: Record<ErrorCodeValue, string> = {
  [ErrorCode.Generic]: 'A generic error.',
  [ErrorCode.MissingParameter]: 'Required parameter is missing.',
  [ErrorCode.ClientTooOld]: 'Incompatible Subsonic REST protocol version. Client must upgrade.',
  [ErrorCode.ServerTooOld]: 'Incompatible Subsonic REST protocol version. Server must upgrade.',
  [ErrorCode.WrongCredentials]: 'Wrong username or password.',
  [ErrorCode.TokenAuthUnsupported]: 'Token authentication not supported for this user.',
  [ErrorCode.NotAuthorized]: 'User is not authorized for the given operation.',
  [ErrorCode.NotFound]: 'The requested data was not found.',
};

/**
 * A Subsonic protocol failure.
 *
 * Deliberately **not** an `IServiceError` subclass: the service-error hierarchy
 * carries an HTTP status and a `{Exception:{Type,Message}}` wire shape, both of
 * which are wrong for Subsonic. This type carries a protocol code, and
 * `packages/backend-services` maps it onto the envelope. Keeping the two
 * taxonomies apart is what stops an `Exception` body from reaching a client.
 */
class SubsonicError extends Error {
  public readonly code: ErrorCodeValue;

  constructor(code: ErrorCodeValue, detail?: string) {
    // The full message is what surfaces to the user; the code is what clients
    // branch on. Both must be right, so neither is derived from the other.
    const base = DEFAULT_MESSAGES[code] ?? DEFAULT_MESSAGES[ErrorCode.Generic];
    super(detail && detail.length > 0 ? detail : base);
    this.name = 'SubsonicError';
    this.code = code;
  }
}

/**
 * HTTP status for a failed response.
 *
 * **200 for every protocol error, and the body is the contract.** The protocol says a
 * failure arrives as `status="failed"` with an `error`, and every real server sends it
 * that way — Navidrome, Gonic, Airsonic — because a Subsonic client branches on the
 * envelope, not on the status.
 *
 * `40` used to be the exception, and answered 401, on the argument that proxies, WAF
 * rules and dashboards can only see a failed authentication through the status. That
 * argument is real and it is the wrong trade: a client that treats a non-2xx as a
 * transport fault loses the one thing it needs, which is that the *password* is wrong.
 * `fin` calls `.error_for_status()` before parsing anything, so a wrong password surfaced
 * as a bare HTTP 401 with no message, on a server that had authenticated 587 tests' worth
 * of correct credentials. An operator reading that cannot act on it, and the diagnostic
 * the envelope was carrying is thrown away.
 *
 * A refusal is still a refusal: it is a 200 with `code=40` and a message, which is what
 * the client renders, and the credential throttle is unaffected because it counts on the
 * envelope's code rather than on the status.
 *
 * The one exception is a **throttle**, at 429. Throttling is a transport-level condition,
 * and a client has to be able to *back off* — which an envelope cannot express, because a
 * client that only reads the envelope has no way to know it was throttled rather than
 * refused. So that one is reported twice: 429, and the same failed envelope.
 */
function httpStatusForErrorCode(throttled = false): number {
  if (throttled) return 429;
  return 200;
}

/**
True when a thrown value is a Subsonic protocol failure.
*/
function isSubsonicError(value: unknown): value is SubsonicError {
  return value instanceof SubsonicError;
}

export { ErrorCode, SubsonicError, httpStatusForErrorCode, isSubsonicError, DEFAULT_MESSAGES };
export type { ErrorCodeValue };
