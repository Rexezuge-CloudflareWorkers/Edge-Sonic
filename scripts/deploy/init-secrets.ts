#!/usr/bin/env tsx

/**
 * Creates the Secrets Store entries declared in `wrangler.jsonc`, generating a
 * fresh value for each one that does not exist yet.
 *
 * Requires a materialized `wrangler.jsonc`; run `prepare-wrangler-config.ts`
 * first. Fails rather than skipping when the config is missing, because the deploy
 * step reporting "Secret initialization complete" having created nothing is worse
 * than a named error.
 *
 * **A rejection has to reach the runner as a non-zero exit.** This used to end in
 * `main().catch(console.error)`, which reported success while every secret had gone
 * uncreated — so a broken provisioning step was indistinguishable from a working one,
 * and the failure surfaced two steps later as Cloudflare error 10182 on
 * `wrangler deploy`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parse, type ParseError } from 'jsonc-parser';
import { fail } from '../lib/github-actions';
import { isEmptySecretsStoreListing, parseWranglerTableRows } from '../lib/wrangler-table';
import { CONFIG_PATH } from '../lib/wrangler-config/types';

interface WranglerConfig {
  secrets_store_secrets?: Array<{
    binding: string;
    store_id: string;
    secret_name: string;
  }>;
}

/**
 * Generates a fresh value for each secret this script knows how to create.
 *
 * Keyed on the secret's NAME rather than on a list this script has heard of, which
 * is the load-bearing part — see `generatorFor` for why.
 *
 * `generateAESGCMKey` reuses the WebCrypto call the worker's crypto layer already
 * depends on rather than carrying a second copy: two implementations of "produce a
 * key the worker will accept" is how a deploy ends up generating something the worker
 * cannot read.
 */
async function generateAESGCMKey(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const exported = await crypto.subtle.exportKey('raw', key);
  // Chunked rather than spread: `String.fromCharCode(...bytes)` passes 32 arguments,
  // which is fine today and is a stack overflow the day the key is longer.
  let binary = '';
  for (const byte of new Uint8Array(exported)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

/**
 * A 256-bit random signing secret for internal self-calls.
 */
function generateSigningSecret(): Promise<string> {
  let hex = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return Promise.resolve(hex);
}

/**
 * The generator for a secret name, chosen by the name's **shape**.
 *
 * This used to be a `Record` of exact names, and that was the defect. The map held
 * the `edge-git-*` names this repository was scaffolded under, so the two
 * `edge-sonic-*-encryption-key` entries threw `Unknown secret` — and because the
 * rejection was swallowed, the CD step reported success while the deploy that
 * followed failed with Cloudflare error 10182. A new entry in
 * `secrets_store_secrets[]` therefore broke deployment silently, which is the worst
 * shape a config can have.
 *
 * So the rule is the suffix, and adding a secret to the template is a one-line change
 * needing no matching edit here. A name matching neither is still refused rather than
 * given a guess: the generator is not the only thing that has to be right, and an
 * unusable value that looks provisioned is worse than a failure.
 */
function generatorFor(secretName: string): () => Promise<string> {
  if (secretName.endsWith('-encryption-key')) return generateAESGCMKey;
  if (secretName.endsWith('-signing-secret')) return generateSigningSecret;
  throw new Error(
    `Unknown secret: ${secretName}. Name it '*-encryption-key' for a generated 32-byte AES-GCM key, ` +
      `or '*-signing-secret' for 32 random bytes, and teach this script the shape if neither fits.`,
  );
}

/**
 * Runs a wrangler subcommand, optionally feeding `input` on stdin.
 *
 * Arguments are passed as an argv array rather than interpolated into a shell
 * string, so a value containing shell metacharacters cannot alter the command.
 */
function wrangler(args: string[], input?: string): string {
  try {
    // `pnpm` is resolved from PATH deliberately: the scripts run on CI runners and in
    // local shells, and both resolve it the same way.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    return execFileSync('pnpm', ['exec', 'wrangler', ...args], {
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(input !== undefined && { input }),
    });
  } catch (error: unknown) {
    const maybeProcessError = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stdout: string = maybeProcessError.stdout ? maybeProcessError.stdout.toString() : '';
    const stderr: string = maybeProcessError.stderr ? maybeProcessError.stderr.toString() : '';
    throw new Error(`Command failed: pnpm exec wrangler ${args.join(' ')}\n${stdout}${stderr || maybeProcessError.message || ''}`);
  }
}

function parseWranglerConfig(): WranglerConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `${CONFIG_PATH} not found. Run scripts/deploy/prepare-wrangler-config.ts first — it is what creates the file this script reads.`,
    );
  }

  // `parse` is error-tolerant and returns a partial object, so an empty result means
  // malformed JSON rather than "no secrets declared". Treating that as an empty list
  // would report success having created nothing.
  const errors: ParseError[] = [];
  const config = parse(readFileSync(CONFIG_PATH, 'utf8'), errors, { allowTrailingComma: true }) as WranglerConfig;
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `${CONFIG_PATH} is not valid JSONC: ${errors.length} parse error(s), first at offset ${first?.offset}. Run prepare-wrangler-config.ts to regenerate it.`,
    );
  }
  return config;
}

/**
 * Lists the secret names present in a Secrets Store.
 *
 * Returns `undefined` when the listing itself failed, which is deliberately distinct
 * from an empty list: a transient CLI failure must not be read as "the secret is
 * missing" and cause a duplicate insert over a live value. An empty store *is* a
 * confirmed absence, so it maps to an empty set rather than `undefined`.
 */
function listSecretNames(storeId: string): Set<string> | undefined {
  let output: string;
  try {
    output = wrangler(['secrets-store', 'secret', 'list', storeId, '--remote']);
  } catch (error: unknown) {
    if (isEmptySecretsStoreListing(error)) {
      console.log(`Secrets Store ${storeId} is empty`);
      return new Set();
    }
    console.warn(`Unable to list secrets in store ${storeId}:`, error instanceof Error ? error.message : 'unknown error');
    return undefined;
  }

  // The name is the first column, taken exactly. This used to be
  // `output.includes(secretName)`, and a substring match is not a membership test:
  // `edge-sonic-webdav-encryption-key-2` satisfies a search for
  // `edge-sonic-webdav-encryption-key`, so a store holding only the suffixed entry
  // reported the unsuffixed one as already present and it was never created.
  const names = new Set<string>();
  for (const row of parseWranglerTableRows(output)) {
    const name = row[0];
    if (name) names.add(name);
  }
  return names;
}

function createSecret(storeId: string, secretName: string, secretValue: string): void {
  console.log(`Creating secret: ${secretName}`);
  // The value goes in on stdin, never as an argv entry: an argv is visible to every
  // process on the runner through `ps`, and the previous
  // `echo "${secretValue}" | wrangler … ${secretName}` also broke on `"`, `$`,
  // backticks and newlines.
  wrangler(['secrets-store', 'secret', 'create', storeId, '--name', secretName, '--scopes', 'workers', '--remote'], secretValue);
}

async function main(): Promise<void> {
  console.log('Initializing Cloudflare secrets...');
  const config = parseWranglerConfig();

  const declared: Array<{ binding: string; store_id: string; secret_name: string }> = config.secrets_store_secrets ?? [];
  if (declared.length === 0) {
    throw new Error('wrangler.jsonc declares no secrets_store_secrets entries, so there is nothing to initialize.');
  }

  const listedByStore = new Map<string, Set<string> | undefined>();

  for (const secret of declared) {
    if (!listedByStore.has(secret.store_id)) {
      listedByStore.set(secret.store_id, listSecretNames(secret.store_id));
    }
    const existing = listedByStore.get(secret.store_id);
    if (existing === undefined) {
      // Refuse to guess: creating a secret we could not read back risks overwriting a
      // live value with a freshly generated one.
      throw new Error(
        `Could not list secrets in store ${secret.store_id}; refusing to create ${secret.secret_name} without confirming it is absent.`,
      );
    }

    if (existing.has(secret.secret_name)) {
      console.log(`Secret ${secret.secret_name} already exists`);
      continue;
    }

    const generate = generatorFor(secret.secret_name);
    createSecret(secret.store_id, secret.secret_name, await generate());
    existing.add(secret.secret_name);
  }

  console.log('Secret initialization complete');
}

// Top-level await rather than `.catch()`, so a rejected `main` surfaces as a stack
// trace with its cause intact. Either way the process must exit non-zero: this runs
// in the deploy pipeline, and swallowing the rejection reported a failed AES key
// bootstrap as a green step that `retry-step` would not retry.
try {
  await main();
} catch (error: unknown) {
  fail(error instanceof Error ? `Secret initialization failed: ${error.message}` : String(error));
}
