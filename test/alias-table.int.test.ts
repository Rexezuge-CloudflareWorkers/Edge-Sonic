/**
 * The alias table resolves, in the config that owns it.
 *
 * ### Why this file exists
 *
 * `test/integration/vitest.config.mts` used to carry a hand-copied copy of the root
 * config's alias array, with a comment saying the two "must be kept in step by hand". They
 * had **already** drifted by two entries — `cloudflare:workers` and `@edge-sonic/background`
 * — and it was harmless only because neither `.int.test.ts` reached `apps/background`. So
 * the first test importing it would pass in the root suite and fail in CI's integration job,
 * with an unresolvable-specifier error, on a job whose entire content is "did CI pass".
 *
 * Extracting one shared table fixed the drift. This file is the *other* half of the fix: it
 * is an `.int.test.ts`, so it runs under the config that drifted, and it imports through
 * every alias — so a table that drifts again fails **here**, in the job that would have
 * caught it, rather than in whatever test happens to reach it next.
 *
 * It also pins the two per-entry roots that a generated table would get wrong. `background`
 * is in `apps/`, not `packages/`, because it is the Durable Object the API worker's `SCAN`
 * binding names; assuming `packages/${name}/src` produced a path one tree too deep, and the
 * failure was a startup error rather than a wrong answer.
 */
import { describe, expect, it } from 'vitest';

import { ScanWorker } from '@edge-sonic/background';
import { deriveFromPath } from '@edge-sonic/backend-data/dao';
import { encryptData } from '@edge-sonic/backend-data/crypto';
import { executeD1WithRetry } from '@edge-sonic/backend-data/utils';
import { Container } from '@edge-sonic/backend-runtime/di';
import { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import { KvCache } from '@edge-sonic/backend-runtime/kv';
import { createLogger } from '@edge-sonic/backend-runtime/logger';
import { AccessAuthService } from '@edge-sonic/backend-services/auth';
import { createRequestScope } from '@edge-sonic/backend-services/composition';
import { toSubsonicError } from '@edge-sonic/backend-services/errors';
import { MAX_CONSECUTIVE_FAILURES } from '@edge-sonic/backend-services/index';
import { LibraryService } from '@edge-sonic/backend-services/library';
import { readAudioTags } from '@edge-sonic/media-tags';
import { UUIDUtil } from '@edge-sonic/shared/utils';
import { BUNDLES } from '@edge-sonic/shared/i18n';
import { DEMO_USER_EMAIL } from '@edge-sonic/shared/constants';
import { elList } from '@edge-sonic/subsonic';
import { WebDavClient } from '@edge-sonic/webdav';
import { NotFoundError } from '@edge-sonic/backend-errors';

/**
`apps/api/src/index.ts` imports this specifier; nothing else may.
*/
import { DurableObject } from 'cloudflare:workers';

describe('the shared alias table', () => {
  it('resolves every specifier both configs are asked to resolve', () => {
    // A `typeof` check rather than a call: the point is that the module *resolved*, and a
    // call would couple this file to every signature in the repository.
    for (const [name, value] of Object.entries({
      background: ScanWorker,
      'backend-data/dao': deriveFromPath,
      'backend-data/crypto': encryptData,
      'backend-data/utils': executeD1WithRetry,
      'backend-errors': NotFoundError,
      'backend-runtime/di': Container,
      'backend-runtime/config': AppConfiguration,
      'backend-runtime/kv': KvCache,
      'backend-runtime/logger': createLogger,
      'backend-services/auth': AccessAuthService,
      'backend-services/composition': createRequestScope,
      'backend-services/errors': toSubsonicError,
      'backend-services/index': MAX_CONSECUTIVE_FAILURES,
      'backend-services/library': LibraryService,
      'media-tags': readAudioTags,
      'shared/utils': UUIDUtil,
      'shared/i18n': BUNDLES,
      'shared/constants': DEMO_USER_EMAIL,
      subsonic: elList,
      webdav: WebDavClient,
      'cloudflare:workers': DurableObject,
    })) {
      expect(value, `${name} must resolve`).toBeDefined();
    }
  });

  it('gives each package its own root, so `background` is not looked for under `packages/`', () => {
    // The specific mistake: one tree for every entry, with `apps/background` the only
    // exception. Asserted by resolving through the package's own entry rather than by
    // reading the table, so the test is about the alias and not about the array.
    expect(ScanWorker.name).toBe('ScanWorker');
    // And the mock, which is the other exception: `cloudflare:workers` has no source tree
    // at all, so it must resolve to `test/mocks/cloudflare-workers.ts`.
    expect(typeof DurableObject).toBe('function');
  });
});
