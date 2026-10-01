#!/usr/bin/env node
/**
 * Validate web locale bundles: JSON-valid, key parity with en (no missing or
 * extra keys), `{{placeholder}}` parity, no empty values, and bundle-dir
 * parity with web `SUPPORTED_LANGUAGES` (parsed from `apps/web/src/i18n.ts`,
 * so a listed-but-unshipped language fails here instead of at runtime in
 * `loadLanguage`). Key order drift vs en is warn-only (keeps diffs reviewable
 * without failing the run).
 *
 * ### Why it also reads the call sites
 *
 * Everything above is a comparison **between bundles**, so with one shipped language the
 * whole per-tag body is skipped by `if (tag === 'en') continue` and the script reports
 * `ALL OK` having checked nothing about the application. It could not see that
 * `libraries.scanPausedRequests` was used and absent: the string in the bundle did not
 * exist to be wrong *about* anything.
 *
 * So the keys are checked against the other direction too — every `t('…')` call site under
 * `apps/web/src` must resolve. That is a check the bundle-to-bundle comparison cannot
 * express, and it is the one that catches a key added to a component and forgotten
 * everywhere else. A key present in the bundle and never referenced is reported too, so
 * the bundle does not accumulate entries nothing renders.
 *
 * Usage: `pnpm run validate:locales` from the repo root.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(REPO_ROOT, 'apps', 'web', 'src');
const LOCALES_DIR = join(WEB_SRC, 'locales');
const WEB_I18N_FILE = join(WEB_SRC, 'i18n.ts');
const PLACEHOLDER = /\{\{[^}]+\}\}/g;

/** Every `.ts`/`.tsx` under `apps/web/src`, skipping `locales/`. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'locales' || entry === 'generated') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `t('a.b.c')` and `t('a.b.c', 'default')`.
 *
 * Only the first string argument is a key. A dynamic key (`t(\`libraries.${x}\`)`) cannot
 * be checked and is reported as such rather than silently passed, because a script that
 * cannot see it should say so instead of reporting coverage it does not have.
 */
const T_CALL = /\bt\(\s*(['"])([a-zA-Z0-9_.]+)\1/g;

function flatten(node, prefix, out) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out.push([path, value]);
    }
  }
  return out;
}

function placeholdersOf(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(value.match(PLACEHOLDER) ?? [])].sort();
}

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`FAIL: ${message}`);
};
const warn = (message) => {
  console.warn(`WARN: ${message}`);
};

let tags;
try {
  tags = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  fail(`cannot list locales dir ${LOCALES_DIR}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (!tags.includes('en')) {
  fail('missing base locale: en/translation.json');
  process.exit(1);
}

// Every tag in web `SUPPORTED_LANGUAGES` (single source of truth:
// `apps/web/src/i18n.ts`) must ship a bundle dir, and vice versa —
// otherwise `loadLanguage` throws at runtime for a listed language.
let supported;
try {
  const i18nSource = readFileSync(WEB_I18N_FILE, 'utf8');
  const match = i18nSource.match(/SUPPORTED_LANGUAGES\s*=\s*\[([^\]]+)\]/);
  supported = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
} catch (error) {
  fail(`cannot read web i18n.ts ${WEB_I18N_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (supported.length === 0) fail('could not parse SUPPORTED_LANGUAGES from web i18n.ts');
for (const tag of supported.filter((tag) => !tags.includes(tag)))
  fail(`missing locale directory for supported language: ${tag}/translation.json`);
for (const tag of tags.filter((tag) => !supported.includes(tag))) fail(`extra locale directory not in SUPPORTED_LANGUAGES: ${tag}`);

const bundles = new Map();
for (const tag of tags) {
  const file = join(LOCALES_DIR, tag, 'translation.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`${tag}: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  try {
    bundles.set(tag, JSON.parse(raw));
  } catch (error) {
    fail(`${tag}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const enEntries = flatten(bundles.get('en') ?? {}, '', []);
const enKeys = enEntries.map(([key]) => key);
const enSet = new Set(enKeys);
const enByKey = new Map(enEntries);
if (enKeys.length === 0) fail('en bundle is empty or unreadable');

for (const [tag, bundle] of bundles) {
  if (tag === 'en') continue;
  const entries = flatten(bundle ?? {}, '', []);
  const keys = entries.map(([key]) => key);
  const set = new Set(keys);
  const byKey = new Map(entries);

  for (const key of enKeys.filter((key) => !set.has(key)).slice(0, 10)) fail(`${tag}: missing key ${key}`);
  const missingCount = enKeys.filter((key) => !set.has(key)).length;
  for (const key of keys.filter((key) => !enSet.has(key)).slice(0, 10)) fail(`${tag}: extra key ${key} (no en source)`);
  const extraCount = keys.filter((key) => !enSet.has(key)).length;

  const empty = entries.filter(([, value]) => typeof value !== 'string' || value === '').map(([key]) => key);
  for (const key of empty.slice(0, 10)) fail(`${tag}: empty value at ${key}`);

  const phMismatches = keys.filter((key) => {
    if (!enSet.has(key)) return false;
    const a = placeholdersOf(enByKey.get(key));
    const b = placeholdersOf(byKey.get(key));
    return a.length !== b.length || a.some((ph, i) => ph !== b[i]);
  });
  for (const key of phMismatches.slice(0, 10)) {
    fail(
      `${tag}: placeholder mismatch at ${key} (en=${JSON.stringify(placeholdersOf(enByKey.get(key)))} vs ${tag}=${JSON.stringify(placeholdersOf(byKey.get(key)))})`,
    );
  }

  const orderDrift = keys.length !== enKeys.length || keys.some((key, index) => key !== enKeys[index]);
  if (orderDrift) {
    warn(`${tag}: key order differs from en (warn-only)`);
  }

  const status = missingCount === 0 && extraCount === 0 && empty.length === 0 && phMismatches.length === 0 ? 'OK' : 'FAIL';
  console.log(
    `${tag}: keys=${keys.length} missing=${missingCount} extra=${extraCount} empty=${empty.length} ph_mismatch=${phMismatches.length} [${status}]`,
  );
}

// ### Call sites against the bundle
const usedKeys = new Map();
const dynamicCalls = [];
for (const file of sourceFiles(WEB_SRC)) {
  const source = readFileSync(file, 'utf8');
  const where = relative(REPO_ROOT, file);
  for (const match of source.matchAll(T_CALL)) {
    const key = match[2];
    if (!enByKey.has(key)) {
      fail(`${where}: t('${key}') is not in the en bundle — it renders as the inline default and is untranslatable`);
    }
    if (!usedKeys.has(key)) usedKeys.set(key, where);
  }
  // A key assembled at runtime cannot be verified, so it is named rather than passed over.
  for (const match of source.matchAll(/\bt\(\s*`/g)) {
    dynamicCalls.push(where);
  }
}

const unused = enKeys.filter((key) => !usedKeys.has(key));
for (const key of unused) warn(`en bundle: ${key} is never referenced by a t() call`);

console.log(
  `call sites: referenced=${usedKeys.size} unused=${unused.length} dynamic=${dynamicCalls.length} [${dynamicCalls.length === 0 ? 'OK' : 'UNVERIFIED'}]`,
);
if (dynamicCalls.length > 0) {
  for (const where of [...new Set(dynamicCalls)]) warn(`${where}: a t() call builds its key dynamically and cannot be checked`);
}

console.log(failed ? 'FAILURES PRESENT' : 'ALL OK');
process.exit(failed ? 1 : 0);
