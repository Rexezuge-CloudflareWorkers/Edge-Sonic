import { writeFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { parseWranglerTableRows } from '../wrangler-table';
import {
  CONFIG_PATH,
  DEFAULT_HEX_ID,
  DEFAULT_KV_NAMESPACE_NAMES,
  DEFAULT_SECRET_STORE_NAME,
  DEFAULT_WORKER_NAME,
  DEFAULT_UUID,
  VECTORIZE_DIMENSIONS,
  type D1Database,
  type KVNamespace,
  type SecretStore,
  type WranglerConfig,
} from './types';
import { parseJsonArray, runWrangler } from './cli';
import { readConfig, writeConfigValue } from './patches';

export function getD1Id(database: D1Database): string | undefined {
  return database.uuid ?? database.database_id ?? database.id;
}

export function listD1Databases(): D1Database[] {
  return parseJsonArray<D1Database>(runWrangler(['d1', 'list', '--json']), 'wrangler d1 list --json');
}

/**
 * What `ensure*` did, so a caller can act on the difference.
 *
 * The backup workflow needs to know whether the D1 database **existed** or was created
 * moments ago: a database that was just provisioned holds no user data, and uploading
 * that empty dump is a false sense of safety. That used to be inferred by re-reading the
 * placeholder id out of `wrangler.jsonc` — which is unreachable, because this very
 * function patches the placeholder away before the reader ever runs. So the fact is
 * returned here instead of re-derived from an artefact this call has already changed.
 */
export interface Provisioned {
  id: string;
  created: boolean;
}

export function ensureD1Database(databaseName: string): Provisioned {
  let database = listD1Databases().find((candidate) => candidate.name === databaseName);
  let created = false;
  if (!database) {
    console.log(`Creating D1 database: ${databaseName}`);
    runWrangler(['d1', 'create', databaseName]);
    database = listD1Databases().find((candidate) => candidate.name === databaseName);
    created = true;
  }

  const databaseId = database ? getD1Id(database) : undefined;
  if (!databaseId) {
    throw new Error(`Unable to discover D1 database ID for ${databaseName}.`);
  }
  return { id: databaseId, created };
}

export function listKVNamespaces(): KVNamespace[] {
  return parseJsonArray<KVNamespace>(runWrangler(['kv', 'namespace', 'list']), 'wrangler kv namespace list');
}

export function getKVNamespaceName(config: WranglerConfig, binding: string): string {
  return DEFAULT_KV_NAMESPACE_NAMES[binding] ?? `${config.name ?? DEFAULT_WORKER_NAME}-${binding.toLowerCase()}`;
}

export function ensureKVNamespace(config: WranglerConfig, binding: string): Provisioned {
  const namespaceName = getKVNamespaceName(config, binding);
  const candidateNames = new Set([namespaceName, `${config.name ?? DEFAULT_WORKER_NAME}-${binding}`, binding]);
  let namespace = listKVNamespaces().find((candidate) => {
    const candidateName = candidate.title ?? candidate.name;
    return candidate.id && candidateName && candidateNames.has(candidateName);
  });
  let created = false;
  if (!namespace) {
    console.log(`Creating KV namespace: ${namespaceName}`);
    runWrangler(['kv', 'namespace', 'create', namespaceName]);
    namespace = listKVNamespaces().find((candidate) => candidate.id && (candidate.title ?? candidate.name) === namespaceName);
    created = true;
  }

  if (!namespace?.id) {
    throw new Error(`Unable to discover KV namespace ID for ${namespaceName}.`);
  }
  return { id: namespace.id, created };
}

export function getRequiredKvBindings(): string[] {
  return Object.keys(DEFAULT_KV_NAMESPACE_NAMES);
}

export function ensureRequiredKvBindings(content: string, config: WranglerConfig): string {
  const existing = new Set((config.kv_namespaces ?? []).map((namespace) => namespace.binding).filter(Boolean));
  const missing = getRequiredKvBindings().filter((binding) => !existing.has(binding));
  if (missing.length === 0) {
    return content;
  }

  const next = [...(config.kv_namespaces ?? [])];
  for (const binding of missing) {
    console.log(`Adding missing KV namespace binding: ${binding}`);
    next.push({ binding, id: DEFAULT_HEX_ID });
  }
  return writeConfigValue(content, ['kv_namespaces'], next);
}

export function parseSecretStoresTable(output: string): SecretStore[] {
  const stores: SecretStore[] = [];
  // Through the shared table parser rather than a second inline split: `wrangler`
  // renders through `cli-table3`, whose cells are separated by U+2502 and are *not*
  // space-aligned, so a parser written for aligned output silently matches nothing —
  // which reads as "the store does not exist" and makes provisioning create a
  // duplicate. `init-secrets.ts` needs the same parse, and two parsers would be free
  // to disagree about it.
  for (const row of parseWranglerTableRows(output)) {
    const name = row[0];
    const id = row[1];
    // Store ids are 32 hex characters; a row without one is a header, a border, or an
    // unrelated column, and is skipped rather than stored with an undefined id.
    if (name && id && /^[a-f0-9]{32}$/i.test(id)) {
      stores.push({ name, id });
    }
  }
  return stores;
}

export function listSecretStores(): SecretStore[] {
  const output = runWrangler(['secrets-store', 'store', 'list', '--remote']);
  try {
    return parseJsonArray<SecretStore>(output, 'wrangler secrets-store store list --remote');
  } catch {
    // The subcommand prints a table rather than JSON on some versions.
    return parseSecretStoresTable(output);
  }
}

export function ensureSecretStore(): string {
  const stores = listSecretStores();
  const existing = stores.find((candidate) => candidate.name === DEFAULT_SECRET_STORE_NAME) ?? stores[0];
  if (existing) {
    return existing.id;
  }

  console.log(`Creating Secrets Store: ${DEFAULT_SECRET_STORE_NAME}`);
  const output = runWrangler(['secrets-store', 'store', 'create', DEFAULT_SECRET_STORE_NAME, '--remote']);
  const createdStoreId = /ID:\s*([a-f0-9]{32})/i.exec(output)?.[1];
  if (createdStoreId) {
    return createdStoreId;
  }

  // The create output did not name the id, so read it back rather than guessing.
  const refreshed = listSecretStores();
  const store = refreshed.find((candidate) => candidate.name === DEFAULT_SECRET_STORE_NAME) ?? refreshed[0];
  if (!store?.id) {
    throw new Error(`Unable to discover Secrets Store ID for ${DEFAULT_SECRET_STORE_NAME}.`);
  }
  return store.id;
}

export function ensureQueue(queueName: string): boolean {
  try {
    runWrangler(['queues', 'info', queueName]);
    console.log(`Queue ${queueName} already exists.`);
    return false;
  } catch {
    console.log(`Creating queue: ${queueName}`);
    runWrangler(['queues', 'create', queueName]);
    return true;
  }
}

/**
 * Queue names a deployment needs, in first-seen order.
 *
 * Pure so it is testable without wrangler: producers and consumers name the
 * same queue twice (one queue, two roles), and a name appearing in both must
 * be created once. Follows the `locale-checks`/`lock-check` rule — a rule
 * module with no test is a rule nothing measures.
 */
export function queueNamesIn(config: WranglerConfig): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const producer of config.queues?.producers ?? []) {
    if (producer.queue && !seen.has(producer.queue)) {
      seen.add(producer.queue);
      names.push(producer.queue);
    }
  }
  for (const consumer of config.queues?.consumers ?? []) {
    if (consumer.queue && !seen.has(consumer.queue)) {
      seen.add(consumer.queue);
      names.push(consumer.queue);
    }
  }
  return names;
}

export function ensureVectorizeIndex(indexName: string, dimensions: number): void {
  try {
    runWrangler(['vectorize', 'info', indexName]);
    console.log(`Vectorize index ${indexName} already exists.`);
  } catch {
    console.log(`Creating Vectorize index: ${indexName} with ${dimensions} dimensions`);
    runWrangler(['vectorize', 'create', indexName, `--dimensions=${dimensions}`, '--metric=cosine']);
  }
}

export function provisionWranglerResources(): string[] {
  // Every resource this call had to create, as `<kind>:<name>`. Returned rather than
  // logged, because a caller acts on it: the backup workflow refuses to export a D1
  // database that appears here, since one created moments ago holds no user data and an
  // empty dump uploaded on schedule is a false sense of safety.
  const created: string[] = [];
  let { content, config } = readConfig();

  // KV namespaces — inject required bindings missing from custom configs
  // (e.g. WRANGLER_JSONC without kv_namespaces) so CD auto-creates them.
  content = ensureRequiredKvBindings(content, config);
  config = parse(content) as WranglerConfig;

  // D1 databases — patch placeholder UUIDs with real IDs
  for (const [index, database] of config.d1_databases?.entries() ?? []) {
    if (database.database_id !== DEFAULT_UUID) {
      continue;
    }
    if (!database.database_name) {
      throw new Error(`D1 database binding ${database.binding ?? index} has a placeholder database_id but no database_name.`);
    }

    const resolved = ensureD1Database(database.database_name);
    if (resolved.created) {
      created.push(`d1:${database.database_name}`);
    }
    console.log(`Using D1 database ${database.database_name}: ${resolved.id}`);
    content = writeConfigValue(content, ['d1_databases', index, 'database_id'], resolved.id);
  }

  // KV namespaces — patch placeholder hex IDs with real IDs
  config = parse(content) as WranglerConfig;
  for (const [index, namespace] of config.kv_namespaces?.entries() ?? []) {
    if (namespace.id !== DEFAULT_HEX_ID) {
      continue;
    }
    if (!namespace.binding) {
      throw new Error(`KV namespace at index ${index} has a placeholder id but no binding.`);
    }

    const resolvedNamespace = ensureKVNamespace(config, namespace.binding);
    const namespaceName = getKVNamespaceName(config, namespace.binding);
    if (resolvedNamespace.created) {
      created.push(`kv:${namespaceName}`);
    }
    console.log(`Using KV namespace ${namespaceName}: ${resolvedNamespace.id}`);
    content = writeConfigValue(content, ['kv_namespaces', index, 'id'], resolvedNamespace.id);
  }

  // Secrets Store — patch placeholder hex IDs with real store ID
  config = parse(content) as WranglerConfig;
  const secretStoreIndexes = (config.secrets_store_secrets ?? [])
    .map((secret, index) => ({ secret, index }))
    .filter(({ secret }) => secret.store_id === DEFAULT_HEX_ID);
  if (secretStoreIndexes.length > 0) {
    const existed = listSecretStores().some((store) => store.name === DEFAULT_SECRET_STORE_NAME);
    const storeId = ensureSecretStore();
    if (!existed) {
      created.push(`secrets-store:${DEFAULT_SECRET_STORE_NAME}`);
    }
    console.log(`Using Secrets Store: ${storeId}`);
    for (const { index } of secretStoreIndexes) {
      content = writeConfigValue(content, ['secrets_store_secrets', index, 'store_id'], storeId);
    }
  }

  writeFileSync(CONFIG_PATH, content.endsWith('\n') ? content : `${content}\n`);

  // Queues — name-based, no config patching needed. Created names are reported
  // like every other resource so a deploy log shows what appeared.
  config = parse(content) as WranglerConfig;
  for (const queueName of queueNamesIn(config)) {
    if (ensureQueue(queueName)) {
      created.push(`queue:${queueName}`);
    }
  }

  // Vectorize indexes — name-based, no config patching needed
  for (const binding of config.vectorize ?? []) {
    ensureVectorizeIndex(binding.index_name, VECTORIZE_DIMENSIONS);
  }

  return created;
}
