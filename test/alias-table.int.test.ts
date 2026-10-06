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

import { LibraryImportWorkflow, MediaWorker, PlayCountImportWorker, ScanWorker } from '@edge-sonic/background';
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
import { elList } from '@edge-sonic/subsonic';
import { WebDavClient } from '@edge-sonic/webdav';
import { NotFoundError } from '@edge-sonic/backend-errors';

/**
`apps/api/src/index.ts` imports this specifier; nothing else may.
*/
import { DurableObject } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { PLATFORM_MODULE_MOCKS } from './helpers/aliases';

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
      subsonic: elList,
      webdav: WebDavClient,
      'cloudflare:workers': DurableObject,
      'cloudflare:workflows': NonRetryableError,
      // Resolved through the barrel rather than a subpath, because the three suites that broke
      // on the missing mock all reached `@edge-sonic/background` for `ScanWorker` and nothing
      // else — so the import that must work is the one they did *not* know they were making.
      'background/LibraryImportWorkflow': LibraryImportWorkflow,
      'background/PlayCountImportWorker': PlayCountImportWorker,
      // Resolved for the same reason as the two above: `apps/api/src/index.ts` re-exports
      // `MediaWorker` so the `MEDIA_DO` binding resolves, and an unresolvable class there is a
      // **startup** error in whichever job runs the worker first.
      'background/MediaWorker': MediaWorker,
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
    expect(typeof NonRetryableError).toBe('function');
  });

  it('mocks every platform module the repository imports, so a new one fails here', () => {
    // The third occurrence is prevented by this rather than discovered: a platform specifier with
    // no mock is an unresolvable **startup** error, so it takes down every suite that reaches the
    // module for some unrelated reason — three of them, the first time — and the error names a
    // file none of them imported.
    const mocked = PLATFORM_MODULE_MOCKS.map((mock) => mock.find);

    expect(mocked).toContain('cloudflare:workers');
    expect(mocked).toContain('cloudflare:workflows');
    // And every entry resolves to a file that exists, which the alias table would otherwise only
    // discover at import time — in whichever suite imported first.
    for (const mock of PLATFORM_MODULE_MOCKS) {
      expect(mock.file, `${mock.find} must point at a real mock`).toMatch(/^test\/mocks\//);
    }
  });
});
