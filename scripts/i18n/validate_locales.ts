#!/usr/bin/env tsx

/**
 * Validate the web locale bundles.
 *
 * Everything the rule does lives in `locale-checks.ts` so it can be unit tested
 * without a bundle on disk; this entrypoint only does I/O and reporting.
 *
 * ### And it checks what a value *is*, not only that one exists
 *
 * The per-tag pass compares two bundles, so it cannot see a value that is simply
 * wrong — and with one shipped language the whole body is skipped. The call-site pass
 * covers the missing key, and also compares each inline `t('key', 'default')` against
 * the bundle's value. That check exists because the header rendered as `Edge--Sonic`:
 * `brand.rest` held `"-Sonic"` while the component rendered its own `-` between two
 * spans, and every individual surface — the bundle, the default, the markup — was
 * defensible on its own. See `checkCallSite` for the full account.
 *
 * ### Why it also reads the call sites
 *
 * Everything else is a comparison **between bundles**, so with one shipped language
 * the whole per-tag body is skipped and the script reports `ALL OK` having checked
 * nothing about the application. It could not see that
 * `libraries.scanPausedRequests` was used and absent: the string in the bundle did
 * not exist to be wrong *about* anything.
 *
 * So the keys are checked against the other direction too — every `t('…')` call site
 * under `apps/web/src` must resolve. A key present in the bundle and never referenced
 * is reported as advisory, so the bundle does not accumulate entries nothing renders.
 *
 * Run with `pnpm run validate:locales`. Key **order** drift against `en` is not a
 * finding at all: locale files are maintained by mirroring new keys into every file,
 * and failing on order would turn an otherwise-correct translation update into a CI
 * failure about formatting.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_LOCALE,
  checkBundle,
  checkCallSite,
  checkTags,
  flatten,
  hasDynamicCall,
  readDeclaredTags,
  translationCalls,
  type Finding,
  type FlatBundle,
} from './locale-checks';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');
const LOCALES_DIR = path.join(WEB_SRC, 'locales');
const WEB_I18N_FILE = path.join(WEB_SRC, 'i18n.ts');

/**
Every `.ts`/`.tsx` under `apps/web/src`, skipping `locales/` and generated output.
*/
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'locales' || entry === 'generated') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const findings: Finding[] = [];
const fail = (finding: Finding): void => {
  findings.push(finding);
};

/**
A finding about the run as a whole, which cannot be attributed to a tag or a file.
*/
function fatal(kind: Finding['kind'], detail: string): never {
  console.error(`FAIL: ${detail}`);
  process.exit(1);
}

// --- What is on disk ------------------------------------------------------

let tags: string[];
try {
  tags = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
} catch (error) {
  fatal('unreadable', `cannot list locales dir ${LOCALES_DIR}: ${error instanceof Error ? error.message : String(error)}`);
}

if (!tags.includes(BASE_LOCALE)) {
  fatal('missing-dir', `missing base locale: ${BASE_LOCALE}/translation.json`);
}

// --- What the app declares -----------------------------------------------

let declared: string[];
try {
  declared = readDeclaredTags(readFileSync(WEB_I18N_FILE, 'utf8'), WEB_I18N_FILE);
} catch (error) {
  fatal('unreadable', error instanceof Error ? error.message : String(error));
}

for (const finding of checkTags(declared, tags)) {
  fail(finding);
}

const bundles = new Map<string, FlatBundle>();
for (const tag of tags) {
  const file = path.join(LOCALES_DIR, tag, 'translation.json');
  try {
    bundles.set(tag, flatten(JSON.parse(readFileSync(file, 'utf8'))));
  } catch (error) {
    fail({
      kind: 'malformed',
      subject: tag,
      detail: `${tag}: cannot read or parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

const base = bundles.get(BASE_LOCALE);
if (!base || base.size === 0) {
  fatal('malformed', `${BASE_LOCALE} bundle is empty or unreadable`);
}

// --- Bundle against bundle -----------------------------------------------

for (const [tag, bundle] of bundles) {
  const tagFindings = checkBundle(tag, base, bundle);
  for (const finding of tagFindings) {
    fail(finding);
  }

  const count = (kind: Finding['kind']): number => tagFindings.filter((finding) => finding.kind === kind).length;
  const ok = tagFindings.length === 0;
  console.log(
    `${tag}: keys=${bundle.size} missing=${count('missing-key')} extra=${count('extra-key')} empty=${count('empty-value')} ph_mismatch=${count('placeholder-mismatch')} [${ok ? 'OK' : 'FAIL'}]`,
  );
}

// --- Call sites against the bundle ---------------------------------------

const usedKeys = new Set<string>();
const dynamicSites = new Set<string>();
let defaultsCompared = 0;

for (const file of sourceFiles(WEB_SRC)) {
  const source = readFileSync(file, 'utf8');
  const where = path.relative(REPO_ROOT, file);

  for (const call of translationCalls(source)) {
    usedKeys.add(call.key);
    if (call.inlineDefault !== null) defaultsCompared += 1;
    for (const finding of checkCallSite(where, call, base)) {
      fail(finding);
    }
  }

  // A key assembled at runtime cannot be verified, so it is named rather than passed
  // over — the script should not report coverage it does not have.
  if (hasDynamicCall(source)) {
    dynamicSites.add(where);
  }
}

const unused = [...base.keys()].filter((key) => !usedKeys.has(key));
for (const key of unused) {
  findings.push({
    kind: 'unused-key',
    subject: key,
    detail: `${BASE_LOCALE} bundle: ${key} is never referenced by a t() call`,
    advisory: true,
  });
}

console.log(
  `call sites: referenced=${usedKeys.size} unused=${unused.length} dynamic=${dynamicSites.size} defaults_compared=${defaultsCompared} [${dynamicSites.size === 0 ? 'OK' : 'UNVERIFIED'}]`,
);
for (const where of dynamicSites) {
  console.warn(`WARN: ${where}: a t() call builds its key dynamically and cannot be checked`);
}

// --- Report --------------------------------------------------------------

for (const finding of findings) {
  const line = `${finding.kind === 'unused-key' ? 'WARN' : 'FAIL'}: ${finding.detail}`;
  if (finding.advisory) console.warn(line);
  else console.error(line);
}

const fatalFindings = findings.filter((finding) => !finding.advisory);
console.log(fatalFindings.length === 0 ? 'ALL OK' : `FAILURES PRESENT (${fatalFindings.length})`);
process.exit(fatalFindings.length === 0 ? 0 : 1);
