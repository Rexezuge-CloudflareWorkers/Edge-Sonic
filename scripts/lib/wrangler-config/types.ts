import path from 'node:path';

/**
 * Shared paths, placeholders and shape definitions for the wrangler config helpers.
 *
 * Every script that reads or writes `wrangler.jsonc` resolves it here, so the backup
 * workflow cannot end up inspecting a different file than the deploy materialized.
 */
export const CONFIG_PATH = path.join(process.cwd(), 'wrangler.jsonc');
export const TEMPLATE_PATH = path.join(process.cwd(), 'apps/api/wrangler.template.jsonc');

/**
 * The id `apps/api/wrangler.template.jsonc` carries for a D1 database that does not
 * exist yet. `provisionWranglerResources` replaces it with a real id;
 * `resolve-d1-target.ts` refuses to export while it is still in place, because a
 * database that was just created holds no user data.
 */
export const DEFAULT_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The placeholder for a KV namespace id and for a Secrets Store id.
 */
export const DEFAULT_HEX_ID = '00000000000000000000000000000000';

export const DEFAULT_SECRET_STORE_NAME = 'default';

/**
 * Fallback when the config declares no `name`, used to derive resource names.
 */
export const DEFAULT_WORKER_NAME = 'edge-sonic';

export const DEFAULT_KV_NAMESPACE_NAMES: Record<string, string> = {
  CACHE: 'edge-sonic-cache',
};
export const VECTORIZE_DIMENSIONS = 1024;

/**
 * `vars` is widened with `null` on purpose: jsonc-parser yields `null` for an
 * explicit `vars: null`, and the vars-patch path must be able to reject that
 * rather than treat the field as absent.
 */
export interface WranglerConfig {
  name?: string;
  vars?: Record<string, unknown> | null;
  d1_databases?: Array<{
    binding?: string;
    database_id?: string;
    database_name?: string;
  }>;
  kv_namespaces?: Array<{
    binding?: string;
    id?: string;
  }>;
  secrets_store_secrets?: Array<{
    binding?: string;
    store_id?: string;
    secret_name?: string;
  }>;
  queues?: {
    producers?: Array<{ binding: string; queue: string }>;
    consumers?: Array<{ queue: string }>;
  };
  vectorize?: Array<{
    binding: string;
    index_name: string;
  }>;
}

export interface D1Database {
  name?: string;
  uuid?: string;
  id?: string;
  database_id?: string;
}

export interface KVNamespace {
  title?: string;
  name?: string;
  id?: string;
}

export interface SecretStore {
  name: string;
  id: string;
}
