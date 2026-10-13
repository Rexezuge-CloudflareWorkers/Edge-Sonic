#!/usr/bin/env tsx

/**
 * Materializes `wrangler.jsonc` and provisions what it refers to.
 *
 * The five ordered calls are `@rexezuge/tooling`'s, converged from this file and
 * Durable-DAV's. This repository keeps the entrypoint so the `deploy-worker` job
 * and the backup workflow keep invoking a path they already name, and it adds one
 * thing the kit's script does not: it resolves `@rexezuge/tooling`'s shipped
 * `src/` rather than its `dist/`, because these scripts are **run from disk with
 * `tsx`** and resolve paths relative to the repository they run in.
 *
 * The kit's version is also a superset — `WRANGLER_CONFIG_PATH` and
 * `WRANGLER_TEMPLATE_PATH` override the two paths it otherwise derives from
 * `process.cwd()`, which is what lets a repo script or a test drive it from
 * somewhere else.
 */
import { setOutput } from '@rexezuge/tooling/src/scripts/lib/github-actions';
import {
  applyTopLevelPatch,
  applyVarsPatch,
  ensureMinimumConfigVersion,
  prepareConfigFile,
} from '@rexezuge/tooling/src/scripts/wrangler-config/patches';
import { provisionWranglerResources } from '@rexezuge/tooling/src/scripts/wrangler-config/resources';

prepareConfigFile();
ensureMinimumConfigVersion();
applyTopLevelPatch();
applyVarsPatch();
const created = provisionWranglerResources();

// Published as a step output rather than only printed. `export-d1` in the backup
// workflow needs to know whether the D1 database *existed* or was created moments ago:
// a fresh one holds no user data, and uploading that empty dump every night is a false
// sense of safety. The alternative — re-reading the placeholder id out of
// `wrangler.jsonc` — is unreachable, because `provisionWranglerResources` patches the
// placeholder away before the reader ever runs.
setOutput('created', created.join(','));
console.log('Wrangler configuration is ready.');
