#!/usr/bin/env tsx

import { execFileSync, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'jsonc-parser';

interface WranglerConfig {
  secrets_store_secrets?: Array<{
    binding: string;
    store_id: string;
    secret_name: string;
  }>;
}

function execFile(command: string, args: readonly string[], input?: string): string {
  try {
    return execFileSync(command, [...args], { encoding: 'utf8', stdio: 'pipe', input });
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Command failed: ${command} ${args.join(' ')}\n${error.message}`);
    }
    throw new Error(`Command failed: ${command} ${args.join(' ')}\nUnknown error.`);
  }
}

function parseWranglerConfig(): WranglerConfig {
  const configPath = join(process.cwd(), 'wrangler.jsonc');
  const content = readFileSync(configPath, 'utf8');
  return parse(content);
}

function checkSecret(storeId: string, secretName: string): boolean {
  try {
    // Argv array (no shell): `storeId` never interpolates into `sh -c`.
    const output = execFile('pnpm', ['exec', 'wrangler', 'secrets-store', 'secret', 'list', storeId, '--remote']);
    return output.includes(secretName);
  } catch {
    return false;
  }
}

async function generateAESGCMKey(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const exported = await crypto.subtle.exportKey('raw', key);
  return btoa(String.fromCharCode(...new Uint8Array(exported)));
}

function generateSigningSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * A secret's value is chosen by its NAME, not by a list of names this script has heard of.
 *
 * The list was the defect. It held the `edge-git-*` names only, so the two
 * `edge-sonic-*-encryption-key` entries threw `Unknown secret` — and because the
 * rejection was swallowed, the CD step reported success while the deploy that followed
 * failed with Cloudflare error 10182. A new entry in `secrets_store_secrets[]` therefore
 * broke deployment silently, which is the worst shape a config can have.
 *
 * So the rule is the shape: `*-encryption-key` gets a 32-byte AES-GCM key (base64, which
 * is what `isUsableKey` on the read side requires), `*-signing-secret` gets 32 random
 * bytes. Adding a secret to the template is now a one-line change that needs no matching
 * edit here, and a name that matches neither is still refused rather than given a guess.
 */
async function generateSecretValue(secretName: string): Promise<string> {
  if (secretName.endsWith('-encryption-key')) {
    console.log('Generated AES encryption key');
    return generateAESGCMKey();
  }
  if (secretName.endsWith('-signing-secret')) {
    console.log('Generated signing secret');
    return generateSigningSecret();
  }
  throw new Error(
    `Unknown secret: ${secretName}. Name it '*-encryption-key' for a generated 32-byte AES-GCM key, ` +
      `or '*-signing-secret' for 32 random bytes, and teach this script the shape if neither fits.`,
  );
}

function createSecret(storeId: string, secretName: string, secretValue: string): void {
  console.log(`Creating secret: ${secretName}`);
  // Why `spawnSync` with piped stdin: the previous
  // `echo "${secretValue}" | wrangler ... ${secretName}` broke on `"`, `$`,
  // backticks, and newlines and leaked the value via `ps`. Argv + stdin pipe
  // keeps both the value and the names out of any shell.
  const child = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'secrets-store', 'secret', 'create', storeId, '--name', secretName, '--scopes', 'workers', '--remote'],
    {
      input: secretValue,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
  if (child.status !== 0) {
    throw new Error(
      `Command failed: wrangler secrets-store secret create ${storeId} --name ${secretName}\n${child.stderr || child.error?.message || 'Unknown error.'}`,
    );
  }
}

async function main() {
  console.log('Initializing Cloudflare secrets...');
  const config = parseWranglerConfig();
  if (config.secrets_store_secrets) {
    for (const secret of config.secrets_store_secrets) {
      if (!checkSecret(secret.store_id, secret.secret_name)) {
        const secretValue = await generateSecretValue(secret.secret_name);
        createSecret(secret.store_id, secret.secret_name, secretValue);
        console.log(`Created secret: ${secret.secret_name}`);
      } else {
        console.log(`Secret ${secret.secret_name} already exists`);
      }
    }
  }
  console.log('Secret initialization complete');
}

// The exit code is the point of this line. `main().catch(console.error)` reported success
// while every secret had gone uncreated, so a broken provisioning step was indistinguishable
// from a working one and the failure surfaced two steps later as a Cloudflare 10182 on
// `wrangler deploy`. A rejected guard has to reach the runner as a non-zero exit; this is
// the same rule as awaiting an authorization check rather than voiding it.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
