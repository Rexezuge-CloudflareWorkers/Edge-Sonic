/**
 * The rules behind `scripts/i18n/validate_locales.ts`.
 *
 * Pure and exported so every check is unit testable without reading a bundle off
 * disk. The filesystem side of the script is a `readdirSync` and some
 * `JSON.parse`, and neither is where the risk lives.
 *
 * ### What the checks are, and why each exists
 *
 * - **JSON validity** — a bundle that does not parse cannot be loaded at all.
 * - **Key parity with `en`, both directions** — a missing key renders the fallback,
 *   an extra key is dead weight nothing can translate from.
 * - **`{{placeholder}}` parity** — i18next substitutes by name, so a translation that
 *   drops `{{count}}` renders a sentence with a number missing from it.
 * - **No empty values** — `''` is indistinguishable from a missing key to i18next, so
 *   it is a silent fallback rather than a translation.
 * - **Call sites resolve against the bundle** — the one check a bundle-to-bundle
 *   comparison cannot express, and the one that catches a key added to a component
 *   and forgotten everywhere else.
 * - **The inline default equals the bundle value** — everything else here compares
 *   two bundles or checks that a key exists; none of it reads what a value *is*.
 *
 * ### Why the call-site pass exists at all
 *
 * Every other check is a comparison **between bundles**, so with one shipped
 * language the whole per-tag body is skipped and the script reports `ALL OK` having
 * checked nothing about the application. It could not see that
 * `libraries.scanPausedRequests` was used and absent: the string in the bundle did
 * not exist to be wrong *about* anything.
 */

/**
 * One problem, kept as a kind plus a subject so a test asserts on the finding rather
 * than on a substring of the operator-facing wording.
 */
export interface Finding {
  readonly kind:
    | 'missing-key'
    | 'extra-key'
    | 'empty-value'
    | 'placeholder-mismatch'
    | 'unknown-key'
    | 'default-disagrees'
    | 'dynamic-key'
    | 'unused-key'
    | 'missing-dir'
    | 'extra-dir'
    | 'tag-list'
    | 'unreadable'
    | 'malformed';
  /**
   * The locale tag, the file, or the key. Empty for a finding about the run as a whole.
   */
  readonly subject: string;
  readonly detail: string;
  /**
   * True for `dynamic-key` and `unused-key`, which describe a limit of this script
   * rather than a defect in the bundles. Reported, never fatal.
   */
  readonly advisory?: boolean;
}

/**
 * A flattened bundle: dotted key path to the value at it.
 */
export type FlatBundle = Map<string, unknown>;

/**
 * The fallback every missing key resolves to, and the file new keys are added to
 * first. An empty value here is the one defect that reaches the most users.
 */
export const BASE_LOCALE = 'en';

/**
`{{name}}` — i18next's interpolation token.
*/
const PLACEHOLDER = /\{\{[^{}]+\}\}/g;

/**
 * The key argument of a `t()` call: `t('a.b.c'` or `t("a.b.c"`.
 *
 * A **backreference** closes the literal, not a character class, and that is the whole
 * trick. `\1` is whatever quote actually opened the argument, so the literal ends at
 * its own delimiter whatever that is — which is what a shared class could not do:
 * `[^\\']` breaks a double-quoted default containing an apostrophe (this repository has
 * one: `t('libraries.scanPaused', "D1's daily write allowance is spent…")`), and `[^\\]`
 * matches the closing quote itself and runs the capture past its terminator, swallowing
 * every later `t()` on the page. Both shapes shipped here first, and both were caught
 * only by running the validator against the real corpus — the second one's failure mode
 * being that the affected call simply stopped being checked, which is indistinguishable
 * from a passing run.
 */
const T_KEY = /\bt\(\s*(['"])([\w.]+)\1/g;

/**
 * The default argument, matched immediately after a key: `, 'default'` or `, "default"`.
 *
 * A **separate pass** rather than an optional group on `T_KEY`, because the two
 * delimiters are independent: this repository has a call whose key is single-quoted and
 * whose default is double-quoted. A pattern per delimiter for the whole call cannot
 * express that — the key matches one and the default the other, so the call reports no
 * default and stops being compared against the bundle.
 *
 * Each branch is well under the repo's regex-complexity ceiling, which a single
 * alternated pattern is not: the version combining key and default scored 30 against a
 * limit of 20, and the obvious simplification made it worse by rewriting
 * `[a-zA-Z0-9_.]` to `[\w.]`.
 *
 * `\\.` consumes an escaped quote either way.
 *
 * **Sticky**, not `exec`-and-hope. A sticky regex must match at `lastIndex`, so a comma
 * belonging to a *later* call cannot be picked up as this one's default — which is what
 * a plain search does, since `t('a.one'), t('a.two', 'second')` leaves `), t('a.two',
 * 'second')` after the first key and `'second'` sits in there, reachable.
 */
const T_DEFAULT = /\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/y;

/**
A `t()` whose first argument is a template literal, so its key cannot be resolved.
*/
export const DYNAMIC_T_CALL = /\bt\(\s*`/g;

/**
 * `SUPPORTED_LANGUAGES` (or `SUPPORTED_LOCALES`) in a source file.
 *
 * Matched rather than imported: the file under test is application source, and the
 * point is to read what it actually declares. Accepts both spellings because both name
 * the same list and only one of them is a rename away from the other.
 */
const TAG_ARRAY = /(?:export )?const (?:SUPPORTED_LANGUAGES|SUPPORTED_LOCALES) = \[([^\]]*)\]/;

/**
 * Every dotted key path in a bundle, depth first.
 *
 * Arrays are leaves, not branches: a locale value that is an array has no meaningful
 * per-index key, and flattening one would invent paths nothing addresses.
 */
export function flatten(node: unknown, prefix = '', out: FlatBundle = new Map()): FlatBundle {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    if (prefix) out.set(prefix, node);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    flatten(value, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/**
 * The distinct interpolation tokens in a value, sorted.
 *
 * Sorted so two values carrying the same tokens in different orders compare equal —
 * the substitution is by name, so order carries no meaning.
 */
export function placeholdersOf(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  // `localeCompare` rather than the default: both sides of a comparison go through
  // this function, so any consistent order would do — but an order that changes with
  // the platform's locale makes a mismatch report depend on the machine.
  return [...new Set(value.match(PLACEHOLDER))].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Decode a JS string literal as written in source.
 *
 * Only the escapes that appear in this repository's locale strings are handled, and an
 * unrecognised one is passed through as the backslash plus the character rather than
 * throwing — a validator that crashes on an unfamiliar escape reports nothing at all,
 * which is worse than reporting a value it had to guess at.
 */
export function decodeLiteral(raw: string): string {
  return raw.replaceAll(/\\(.)/g, (match, char: string) => {
    switch (char) {
      case 'n': {
        return '\n';
      }
      case 't': {
        return '\t';
      }
      case 'r': {
        return '\r';
      }
      case '\\':
      case "'":
      case '"':
      case '`': {
        return char;
      }
      default: {
        return match;
      }
    }
  });
}

/**
 * Every `t()` call in a source file, as `(key, defaultOrNull)`.
 *
 * `defaultOrNull` is `null` for a one-argument call, which is a different thing from a
 * call whose default is the empty string.
 */
export function translationCalls(source: string): Array<{ key: string; inlineDefault: string | null }> {
  const calls: Array<{ key: string; inlineDefault: string | null }> = [];

  // `T_KEY` is a module-level `/g` regex, so its `lastIndex` is reset per call: a
  // caller that ran it earlier would otherwise start this one mid-file.
  T_KEY.lastIndex = 0;
  for (const match of source.matchAll(T_KEY)) {
    const key = match[2];
    if (key === undefined) continue;

    // The default is matched from where the key ended, and `T_DEFAULT` is sticky, so it
    // can only match at that position.
    const afterKey = source.slice((match.index ?? 0) + match[0].length);
    T_DEFAULT.lastIndex = 0;
    const asDefault = T_DEFAULT.exec(afterKey);
    const rawDefault = asDefault?.[1] ?? asDefault?.[2];

    calls.push({ key, inlineDefault: rawDefault === undefined ? null : decodeLiteral(rawDefault) });
  }

  return calls;
}

/**
 * Whether a source file contains a `t()` call whose key cannot be resolved.
 */
export function hasDynamicCall(source: string): boolean {
  return DYNAMIC_T_CALL.test(source);
}

/**
 * Compare one bundle against `en`.
 *
 * The base is checked like every other bundle, so an empty value in `en` is reported:
 * it is the fallback for every missing key, so an empty value there is the defect that
 * reaches the most users — and the reason every call site passes an English default to
 * `t()`, which makes `''` indistinguishable from a missing key at runtime.
 */
export function checkBundle(tag: string, base: FlatBundle, bundle: FlatBundle): Finding[] {
  const findings: Finding[] = [];

  for (const key of base.keys()) {
    if (!bundle.has(key)) {
      findings.push({ kind: 'missing-key', subject: `${tag}: ${key}`, detail: `${tag} is missing ${key}, so it renders the fallback` });
    }
  }

  for (const key of bundle.keys()) {
    if (!base.has(key)) {
      findings.push({
        kind: 'extra-key',
        subject: `${tag}: ${key}`,
        detail: `${tag} carries ${key}, which en does not, so nothing can translate it`,
      });
    }

    const value = bundle.get(key);
    if (typeof value !== 'string' || value === '') {
      findings.push({
        kind: 'empty-value',
        subject: `${tag}: ${key}`,
        detail: `${tag} has an empty or non-string value at ${key}, which i18next cannot distinguish from a missing key`,
      });
      continue;
    }

    const expected = placeholdersOf(base.get(key));
    if (expected.length === 0) continue;
    const actual = placeholdersOf(value);
    if (expected.length !== actual.length || expected.some((token, index) => token !== actual[index])) {
      findings.push({
        kind: 'placeholder-mismatch',
        subject: `${tag}: ${key}`,
        detail: `${tag} expects ${JSON.stringify(expected)} at ${key} but has ${JSON.stringify(actual)}`,
      });
    }
  }

  return findings;
}

/**
 * Check one `t()` call site against the base bundle.
 *
 * The default comparison is the check that reads what a value **is**, and it is here
 * because everything else in this file compares two bundles or checks that a key exists.
 * A bundle entry could otherwise say anything and pass.
 *
 * It shipped. The header rendered as `Edge--Sonic`: `brand.accent` was "Edge",
 * `brand.rest` was "-Sonic", and the component already rendered its own `-` between the
 * two spans. Each of the three surfaces was individually defensible — the bundle
 * well-formed, the inline default saying "Sonic" as the author intended, the markup
 * correct — and the rendered string is only wrong to somebody who already knows the
 * product is called Edge-Sonic.
 *
 * So a default that disagrees with the shipped bundle **fails** rather than warns: one
 * of the two things it means is a bug. Either the bundle drifted from the source, or the
 * default is a lie that renders verbatim the day the key goes missing — which is the
 * fallback path this whole argument is about.
 */
export function checkCallSite(where: string, call: { key: string; inlineDefault: string | null }, base: FlatBundle): Finding[] {
  const findings: Finding[] = [];

  if (!base.has(call.key)) {
    findings.push({
      kind: 'unknown-key',
      subject: `${where}: ${call.key}`,
      detail: `${where}: t('${call.key}') is not in the ${BASE_LOCALE} bundle — it renders as the inline default and is untranslatable`,
    });
    // A default cannot be compared against a key that is not there; the finding above is
    // the whole report, and a second one would restate it.
    return findings;
  }

  if (call.inlineDefault === null) return findings;

  const bundled = base.get(call.key);
  if (bundled === call.inlineDefault) return findings;

  findings.push({
    kind: 'default-disagrees',
    subject: `${where}: ${call.key}`,
    detail: `${where}: t('${call.key}', …) default disagrees with the ${BASE_LOCALE} bundle — ${BASE_LOCALE}=${JSON.stringify(bundled)} default=${JSON.stringify(call.inlineDefault)}`,
  });
  return findings;
}

/**
 * The language tags a source file declares as supported.
 *
 * @throws when the array is absent or empty, which means the file's shape changed
 *   rather than that the app supports no languages — a silent empty list here would
 *   turn every declared tag into an "extra directory" finding and name the wrong thing.
 */
export function readDeclaredTags(source: string, file: string): string[] {
  const match = TAG_ARRAY.exec(source);
  const tags = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((found) => found[1] as string);
  if (tags.length === 0) {
    throw new Error(`could not parse SUPPORTED_LANGUAGES from ${file}`);
  }
  return tags;
}

/**
 * The declared tags and the bundle directories have to agree in both directions.
 *
 * A tag declared but not shipped throws inside `loadLanguage` at runtime; a directory
 * with no declaration is a bundle nothing will ever load.
 */
export function checkTags(declared: readonly string[], onDisk: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const tag of declared) {
    if (!onDisk.includes(tag)) {
      findings.push({
        kind: 'missing-dir',
        subject: tag,
        detail: `missing locale directory for supported language: ${tag}/translation.json`,
      });
    }
  }
  for (const tag of onDisk) {
    if (!declared.includes(tag)) {
      findings.push({ kind: 'extra-dir', subject: tag, detail: `extra locale directory not in SUPPORTED_LANGUAGES: ${tag}` });
    }
  }
  return findings;
}
