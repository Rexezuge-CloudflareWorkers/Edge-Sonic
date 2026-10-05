#!/usr/bin/env tsx

/**
 * Materializes `wrangler.jsonc` and provisions what it refers to.
 *
 * Run by the `deploy-worker` job before `wrangler deploy`, and by the backup
 * workflow before `wrangler d1 export` — so the database a backup covers is
 * resolved from the same config the deploy targets, with no second
 * `D1_DATABASE_ID` secret to keep in sync.
 *
 * Five ordered calls, each in `lib/wrangler-config/`: read or copy the config,
 * refuse one older than the template requires, apply the caller's patches, then
 * create whatever resources it names and write their real ids over the
 * placeholders. This file is only the order; it has nothing else to do.
 *
 * The one thing it does beyond calling is publish what `provisionWranglerResources`
 * created, which the backup workflow reads to refuse exporting a database that did not
 * exist until this run.
 */
import { setOutput } from '../lib/github-actions';
import { applyTopLevelPatch, applyVarsPatch, ensureMinimumConfigVersion, prepareConfigFile } from '../lib/wrangler-config/patches';
import { provisionWranglerResources } from '../lib/wrangler-config/resources';

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
