/**
 * Per-feature key bindings (Factory).
 *
 * Extracted from `requestScope.ts` so the composition root owns scope lifecycle
 * only. Three keys, never merged: user (mints tokens), WebDAV (largest read
 * surface), remote (third-party credential). See `serviceFactory.resolveKey`.
 */
import type { Container } from '@edge-sonic/backend-runtime/di';
import type { SubrequestMeter } from '@edge-sonic/shared';
import { resolveKey } from './serviceFactory';
import type { RequestScopeEnv } from './serviceFactory';
import { Tokens } from './tokens';

function bindKeys(scope: Container, env: RequestScopeEnv, subrequests: SubrequestMeter): void {
  scope.bindValue(
    Tokens.UserKey,
    resolveKey(
      env.SUBSONIC_USER_ENCRYPTION_KEY_SECRET,
      env.SUBSONIC_USER_ENCRYPTION_KEY,
      'SUBSONIC_USER_ENCRYPTION_KEY_SECRET',
      'SUBSONIC_USER_ENCRYPTION_KEY',
      subrequests,
    ),
  );
  scope.bindValue(
    Tokens.WebdavKey,
    resolveKey(
      env.WEBDAV_ENCRYPTION_KEY_SECRET,
      env.WEBDAV_ENCRYPTION_KEY,
      'WEBDAV_ENCRYPTION_KEY_SECRET',
      'WEBDAV_ENCRYPTION_KEY',
      subrequests,
    ),
  );
  scope.bindValue(
    Tokens.RemoteKey,
    resolveKey(
      env.SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET,
      env.SUBSONIC_REMOTE_ENCRYPTION_KEY,
      'SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET',
      'SUBSONIC_REMOTE_ENCRYPTION_KEY',
      subrequests,
    ),
  );
}

export { bindKeys };
