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
  private readonly detail: string | undefined;

  constructor(code: ErrorCodeValue, detail?: string) {
    // The full message is what surfaces to the user; the code is what clients
    // branch on. Both must be right, so neither is derived from the other.
    const base = DEFAULT_MESSAGES[code] ?? DEFAULT_MESSAGES[ErrorCode.Generic];
    super(detail && detail.length > 0 ? detail : base);
    this.name = 'SubsonicError';
    this.code = code;
    this.detail = detail;
  }

  /**
  The message without the generic prefix, when one was supplied.
  */
  public get detailMessage(): string | undefined {
    return this.detail;
  }
}

/**
 * HTTP status for a failed response.
 *
 * 200 for everything except two cases, each of which has a reason a plain 200
 * would actively hide:
 *
 * - `40` is 401. HTTP-level tooling (proxies, WAF rules, dashboards, the
 *   Worker's own request log) can see a failed authentication only if the
 *   status reflects it. The body still carries `code=40`, so a client that
 *   branches on the envelope is unaffected.
 * - the throttled case is 429. Throttling is a transport-level condition and
 *   reporting it as a successful-looking 200 makes an attacker's failure rate
 *   indistinguishable from a client's.
 *
 * Everything else stays 200 because the body is the contract.
 */
function httpStatusForErrorCode(code: ErrorCodeValue, throttled = false): number {
  if (throttled) return 429;
  return code === ErrorCode.WrongCredentials ? 401 : 200;
}

/**
True when a thrown value is a Subsonic protocol failure.
*/
function isSubsonicError(value: unknown): value is SubsonicError {
  return value instanceof SubsonicError;
}

export { ErrorCode, SubsonicError, httpStatusForErrorCode, isSubsonicError, DEFAULT_MESSAGES };
export type { ErrorCodeValue };
