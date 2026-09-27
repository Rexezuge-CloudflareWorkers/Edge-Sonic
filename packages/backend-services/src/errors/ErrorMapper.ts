/**
 * Turning a thrown value into a response.
 *
 * ### Two error taxonomies, deliberately
 *
 * The reference project this was scaffolded from had a single `ErrorMapper` that
 * emitted `{Exception:{Type,Message}}` with a non-200 status. **That wire shape is
 * wrong for Subsonic**, and copying it would be the single most damaging thing in
 * this port: a client that receives a 401 with an `Exception` body shows "server
 * error" instead of "wrong password", because Subsonic clients branch on the
 * envelope, not the status.
 *
 * So there are two mappers and no overlap:
 *
 * - `toSubsonicError` — the `/rest/*` surface. Always a
 *   `<subsonic-response status="failed">` with a numeric `code`, and an HTTP
 *   status derived from that code.
 * - `toAdminResponse` — the `/admin/*` JSON surface, for the SPA. A conventional
 *   `{error:{code,message}}` with conventional statuses, because an SPA does read
 *   the status.
 */
import { ConflictError, DatabaseError, NotFoundError, ServiceError, UnauthorizedError } from '@edge-sonic/backend-errors';
import { getBackendStrings } from '@edge-sonic/shared/i18n';
import { ErrorSanitizationUtil } from '@edge-sonic/shared/utils';
import { ErrorCode, isSubsonicError, SubsonicError } from '@edge-sonic/subsonic';

/** HTTP statuses the admin API is allowed to return. */
const ADMIN_STATUSES = new Set([400, 401, 403, 404, 409, 413, 429, 502, 503]);

interface AdminErrorBody {
  error: { code: string; message: string };
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

/** A service-error code mapped onto the closest Subsonic protocol code. */
function toAdminResponse(error: unknown, locale?: string | null): { status: number; body: AdminErrorBody } {
  const strings = getBackendStrings(locale).common;

  if (error instanceof ServiceError) {
    const status = ADMIN_STATUSES.has(error.getErrorCode()) ? error.getErrorCode() : 500;
    const message = status >= 500 ? strings.internalError : error.getErrorMessage();
    if (status >= 500) {
      console.error('Admin API error:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
    }
    return { status, body: { error: { code: error.getErrorType(), message } } };
  }

  console.error('Unhandled admin API error:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
  return { status: 500, body: { error: { code: 'InternalServerError', message: strings.internalError } } };
}

export { toSubsonicError, toAdminResponse };
export type { AdminErrorBody };
