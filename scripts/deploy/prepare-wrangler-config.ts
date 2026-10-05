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
 */
import { applyTopLevelPatch, applyVarsPatch, ensureMinimumConfigVersion, prepareConfigFile } from '../lib/wrangler-config/patches';
import { provisionWranglerResources } from '../lib/wrangler-config/resources';

prepareConfigFile();
ensureMinimumConfigVersion();
applyTopLevelPatch();
applyVarsPatch();
provisionWranglerResources();
console.log('Wrangler configuration is ready.');
