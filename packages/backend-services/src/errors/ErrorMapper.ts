/**
 * Turning a thrown value into a response.
 *
 * ### Two error taxonomies, deliberately
 *
 * **The two surfaces have different wire shapes, and the reason is who reads them.**
 *
 * - `toSubsonicError` — the `/rest/*` surface. Always a
 *   `<subsonic-response status="failed">` with a numeric `code`, and an HTTP status
 *   derived from that code. The reference project this was scaffolded from emitted
 *   `{Exception:{Type,Message}}` everywhere, and **that is wrong for Subsonic**: a
 *   client that receives a 401 with an `Exception` body shows "server error" instead
 *   of "wrong password", because Subsonic clients branch on the envelope, not the
 *   status. A missing endpoint, a bad parameter, and a wrong password must all arrive
 *   as a well-formed envelope, or the client renders nothing at all.
 * - `toAdminResponse` — the `/admin/*` JSON surface, for the SPA. `{Exception:{Type,
 *   Message}}` with conventional statuses, because **an SPA does read the status** and
 *   nothing in the argument above applies to it. This is the shape the reference
 *   project used on this surface, and matching it fixes a split-brain: the rate limiter
 *   emitted `Exception` for a 429 while every other admin error emitted
 *   `{error:{code,message}}`, so one surface carried two error dialects and its client
 *   had to decode both. The SPA reads the message out of either, so this is a
 *   consistency fix rather than a breaking change.
 *
 * ### What holds for both
 *
 * A 5xx is masked. The cause is logged and the client learns nothing: a D1 error names
 * tables and columns, and a JWT failure that distinguishes "expired" from "bad
 * signature" is a free oracle for building a valid token.
 */
import { ConflictError, DatabaseError, NotFoundError, ServiceError, UnauthorizedError } from '@edge-sonic/backend-errors';
import { getBackendStrings } from '@edge-sonic/shared/i18n';
import { ErrorSanitizationUtil } from '@edge-sonic/shared/utils';
import { ErrorCode, isSubsonicError, SubsonicError } from '@edge-sonic/subsonic';

/**
 * HTTP statuses the admin API is allowed to return.
 *
 * Everything else collapses to 500, so a service error with a status this set does
 * not carry is masked along with its message.
 */
const ADMIN_STATUSES = new Set([400, 401, 403, 404, 409, 413, 429, 502, 503]);

/**
 * The admin API's error body. Matches the reference project, so the SPA's decoder
 * and this server agree on one shape instead of two.
 */
interface AdminErrorBody {
  Exception: { Type: string; Message: string };
}

/**
 * Map any thrown value to a `SubsonicError`.
 *
 * A `DatabaseError` becomes `code=0` with a **generic** message. D1 errors carry
 * table and column names, so echoing one discloses the schema to an unauthenticated
 * caller; the cause is logged and the client learns nothing. Every other 5xx is
 * masked the same way.
 */
function toSubsonicError(error: unknown): SubsonicError {
  if (isSubsonicError(error)) return error;
  if (error instanceof DatabaseError) {
    console.error('Database error during a Subsonic request:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    return new SubsonicError(ErrorCode.Generic);
  }
  if (error instanceof ServiceError) {
    // The 4xx service errors have a direct protocol counterpart, and collapsing them
    // all to `code=0` loses the one distinction a client acts on: "this does not
    // exist" and "you may not have this" are different answers, and a client that
    // cannot tell them apart retries forever or gives up immediately.
    //
    // `UnauthorizedError` is deliberately **not** mapped to `code=40`. That code means
    // "wrong Subsonic credential", and a service-level authorization failure is a
    // different thing — a request authenticated fine and was then refused. Reporting it
    // as 40 sends a user with valid credentials to re-enter their password.
    if (error instanceof NotFoundError) return new SubsonicError(ErrorCode.NotFound, error.getErrorMessage());
    if (error instanceof UnauthorizedError) return new SubsonicError(ErrorCode.NotAuthorized, error.getErrorMessage());
    if (error instanceof ConflictError) return new SubsonicError(ErrorCode.Generic, error.getErrorMessage());
    if (error.getErrorCode() < 500) {
      return new SubsonicError(ErrorCode.Generic, error.getErrorMessage());
    }
    console.error('Service error during a Subsonic request:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    return new SubsonicError(ErrorCode.Generic);
  }
  console.error('Unhandled error during a Subsonic request:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
  return new SubsonicError(ErrorCode.Generic);
}

/**
 * Map any thrown value to the admin API's `{Exception:{Type,Message}}` body.
 *
 * A 4xx keeps its message, because "the library does not exist" and "your JSON is
 * broken" are the two answers an operator can act on. A 5xx does not: the cause is
 * logged and the message is the localized generic one.
 */
function toAdminResponse(error: unknown, locale?: string | null): { status: number; body: AdminErrorBody } {
  const strings = getBackendStrings(locale).common;

  if (error instanceof ServiceError) {
    const status = ADMIN_STATUSES.has(error.getErrorCode()) ? error.getErrorCode() : 500;
    const masked = status >= 500;
    const message = masked ? strings.internalError : error.getErrorMessage();
    if (masked) {
      console.error('Admin API error:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    }
    return { status, body: { Exception: { Type: error.getErrorType(), Message: message } } };
  }

  console.error('Unhandled admin API error:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
  return { status: 500, body: { Exception: { Type: 'InternalServerError', Message: strings.internalError } } };
}

export { toSubsonicError, toAdminResponse, ADMIN_STATUSES };
export type { AdminErrorBody };
