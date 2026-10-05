import { describe, expect, it } from 'vitest';
import {
  BASE_LOCALE,
  checkBundle,
  checkCallSite,
  checkTags,
  decodeLiteral,
  flatten,
  hasDynamicCall,
  placeholdersOf,
  readDeclaredTags,
  translationCalls,
} from '../../scripts/i18n/locale-checks';

/**
 * The rules `pnpm run validate:locales` enforces.
 *
 * This module exists as a pure file for exactly this reason. The checker's own parser
 * went wrong twice while being ported — once matching a string literal past its own
 * closing quote, and once excluding an apostrophe that a double-quoted default legally
 * contains — and **neither was caught by a test**, because the parser had no test. Both
 * were caught only by running the validator against the real corpus and reading its
 * output, and the second one's failure mode is the dangerous one: the call it stopped
 * matching was simply no longer checked, which looks identical to a passing run.
 */
describe('translationCalls', () => {
  it('reads a key and its default from a single-quoted call', () => {
    expect(translationCalls(`t('brand.rest', 'Sonic')`)).toEqual([{ key: 'brand.rest', inlineDefault: 'Sonic' }]);
  });

  it('reads a key and its default from a double-quoted call', () => {
    expect(translationCalls(`t("brand.rest", "Sonic")`)).toEqual([{ key: 'brand.rest', inlineDefault: 'Sonic' }]);
  });

  it('accepts an apostrophe inside a double-quoted default', () => {
    // The regression that motivated this file. `LibraryRow.tsx` has exactly this call,
    // and a parser excluding `'` from the shared character class stopped matching it —
    // which is not a visible failure, it is a check that silently stopped running.
    const source = `t('libraries.scanPaused', "D1's daily write allowance is spent.")`;
    expect(translationCalls(source)).toEqual([
      { key: 'libraries.scanPaused', inlineDefault: "D1's daily write allowance is spent." },
    ]);
  });

  it('accepts a double quote inside a single-quoted default', () => {
    expect(translationCalls(`t('a.b', 'say "hi"')`)).toEqual([{ key: 'a.b', inlineDefault: 'say "hi"' }]);
  });

  it('accepts an escaped quote in either delimiter', () => {
    expect(translationCalls(String.raw`t('a.b', 'it\'s here')`)).toEqual([{ key: 'a.b', inlineDefault: "it's here" }]);
    expect(translationCalls(String.raw`t('a.b', "say \"hi\"")`)).toEqual([{ key: 'a.b', inlineDefault: 'say "hi"' }]);
  });

  it('reports a one-argument call as having no default, which is not an empty default', () => {
    // `null` and `''` are different answers: the first means "nothing to compare", the
    // second means "compare against the empty string", and only one of them is a bug.
    expect(translationCalls(`t('nav.label')`)).toEqual([{ key: 'nav.label', inlineDefault: null }]);
  });

  it('stops one call at its own terminator', () => {
    // The other regression. A shared `[^\\]` class matches the closing quote as readily
    // as any other character, so the capture ran on and swallowed the rest of the file.
    const source = [
      `{t('a.one', 'first')}`,
      `{t('a.two', 'second')}`,
      `{t('a.three', 'third')}`,
    ].join('\n');
    expect(translationCalls(source)).toEqual([
      { key: 'a.one', inlineDefault: 'first' },
      { key: 'a.two', inlineDefault: 'second' },
      { key: 'a.three', inlineDefault: 'third' },
    ]);
  });

  it('handles a multi-line call, which is how the real source is written', () => {
    const source = `t(\n  'libraries.hint',\n  'A library is a WebDAV origin.',\n)`;
    expect(translationCalls(source)).toEqual([{ key: 'libraries.hint', inlineDefault: 'A library is a WebDAV origin.' }]);
  });

  it('handles an interpolation object after the default, which is the third argument', () => {
    const source = `t('landing.signInDidNothing', 'Check {{path}}.', { path: '/home' })`;
    expect(translationCalls(source)).toEqual([
      { key: 'landing.signInDidNothing', inlineDefault: 'Check {{path}}.' },
    ]);
  });

  it('mixes the two delimiters in one call, which the key and default choose independently', () => {
    // The shape that ruled out one pattern per delimiter for the whole call: the key
    // matches the single-quoted branch and the default the double-quoted one, so a
    // single combined pattern reports no default and stops comparing it. This is the
    // real `libraries.scanPaused` call.
    expect(translationCalls(`t('a.key', "a default")`)).toEqual([{ key: 'a.key', inlineDefault: 'a default' }]);
    expect(translationCalls(`t("a.key", 'a default')`)).toEqual([{ key: 'a.key', inlineDefault: 'a default' }]);
  });

  it('does not take a later call’s default as this one’s', () => {
    // The default is matched from where the key ended, so a comma two calls down the
    // line cannot be picked up as this call's.
    const source = [`t('a.one')`, `, t('a.two', 'second')`].join('');
    expect(translationCalls(source)).toEqual([
      { key: 'a.one', inlineDefault: null },
      { key: 'a.two', inlineDefault: 'second' },
    ]);
  });

  it('is stable across repeated calls on the same source', () => {
    // `T_KEY` is a module-level `/g` regex. A `matchAll` that leaves `lastIndex` set
    // would make the second call return a suffix of the first, which reads as "some
    // call sites were not checked" and nothing else.
    const source = `t('a.one', 'One'); t('a.two', 'Two')`;
    const first = translationCalls(source);
    expect(translationCalls(source)).toEqual(first);
    expect(first).toHaveLength(2);
  });

  it('finds every call in a file rather than only the first', () => {
    const source = `t('a.b', 'B'); t('c.d', 'D'); t('e.f')`;
    expect(translationCalls(source).map((call) => call.key)).toEqual(['a.b', 'c.d', 'e.f']);
  });

  it('names a dynamically built key instead of skipping it silently', () => {
    // A script that cannot see a call should say so rather than reporting coverage it
    // does not have.
    expect(hasDynamicCall('t(`libraries.${x}`)')).toBe(true);
    expect(hasDynamicCall(`t('libraries.name', 'Libraries')`)).toBe(false);
  });
});

describe('flatten', () => {
  it('turns nested objects into dotted paths', () => {
    expect([...flatten({ brand: { accent: 'Edge', rest: 'Sonic' }, count: 3 })]).toEqual([
      ['brand.accent', 'Edge'],
      ['brand.rest', 'Sonic'],
      ['count', 3],
    ]);
  });

  it('treats an array as a leaf, because a locale value that is a list has no per-index key', () => {
    const flat = flatten({ items: ['a', 'b'] });
    expect(flat.get('items')).toEqual(['a', 'b']);
    expect(flat.has('items.0')).toBe(false);
  });

  it('keeps an empty string, which is a finding rather than an absence', () => {
    expect(flatten({ a: '' }).get('a')).toBe('');
  });

  it('keeps a null, which is a different thing from a missing key', () => {
    expect(flatten({ a: null }).get('a')).toBeNull();
  });
});

describe('placeholdersOf', () => {
  it('returns the distinct tokens in a stable order', () => {
    expect(placeholdersOf('{{count}} of {{total}}')).toEqual(['{{count}}', '{{total}}']);
  });

  it('sorts, so two values carrying the same tokens in different orders compare equal', () => {
    // i18next substitutes by name, so order carries no meaning — and a mismatch report
    // that depended on the machine's locale would be its own bug.
    expect(placeholdersOf('{{b}} {{a}}')).toEqual(placeholdersOf('{{a}} {{b}}'));
  });

  it('deduplicates a repeated token', () => {
    expect(placeholdersOf('{{count}} / {{count}}')).toEqual(['{{count}}']);
  });

  it('returns nothing for a non-string, rather than throwing', () => {
    expect(placeholdersOf(3)).toEqual([]);
    expect(placeholdersOf(null)).toEqual([]);
  });
});

describe('decodeLiteral', () => {
  it('decodes the escapes locale strings actually use', () => {
    expect(decodeLiteral(String.raw`a\nb`)).toBe('a\nb');
    expect(decodeLiteral(String.raw`a\tb`)).toBe('a\tb');
    expect(decodeLiteral(String.raw`a\\b`)).toBe(String.raw`a\b`);
    expect(decodeLiteral(String.raw`it\'s`)).toBe("it's");
  });

  it('passes an unrecognised escape through rather than crashing', () => {
    // A validator that throws on an unfamiliar escape reports nothing at all, which is
    // worse than reporting a value it had to guess at.
    expect(decodeLiteral(String.raw`a\qb`)).toBe(String.raw`a\qb`);
  });
});

describe('checkBundle', () => {
  const base = flatten({ brand: { accent: 'Edge' }, tracks: '{{count}} tracks' });

  it('passes a bundle that matches', () => {
    expect(checkBundle('fr', base, flatten({ brand: { accent: 'Bord' }, tracks: '{{count}} pistes' }))).toEqual([]);
  });

  it('names a key the bundle is missing', () => {
    const findings = checkBundle('fr', base, flatten({ brand: { accent: 'Bord' } }));
    expect(findings.map((finding) => [finding.kind, finding.subject])).toEqual([['missing-key', 'fr: tracks']]);
  });

  it('names a key the bundle carries with no source, which nothing can translate', () => {
    const findings = checkBundle('fr', base, flatten({ brand: { accent: 'Bord' }, tracks: '{{count}} pistes', extra: 'x' }));
    expect(findings.map((finding) => finding.kind)).toContain('extra-key');
  });

  it('reports an empty value, which i18next cannot distinguish from a missing key', () => {
    const findings = checkBundle('fr', base, flatten({ brand: { accent: '' }, tracks: '{{count}} pistes' }));
    expect(findings.map((finding) => finding.kind)).toEqual(['empty-value']);
    expect(findings[0]?.subject).toBe('fr: brand.accent');
  });

  it('reports a placeholder the translation dropped', () => {
    // The sentence still renders, with the number missing from it.
    const findings = checkBundle('fr', base, flatten({ brand: { accent: 'Bord' }, tracks: 'pistes' }));
    expect(findings.map((finding) => finding.kind)).toEqual(['placeholder-mismatch']);
  });

  it('does not report a placeholder mismatch for a value with no placeholders to lose', () => {
    const withNone = flatten({ plain: 'text' });
    expect(checkBundle('fr', withNone, flatten({ plain: 'texte' }))).toEqual([]);
  });

  it('checks the base locale like every other, because an empty value there reaches the most users', () => {
    const findings = checkBundle(BASE_LOCALE, base, flatten({ brand: { accent: '' }, tracks: '{{count}} tracks' }));
    expect(findings.map((finding) => finding.kind)).toEqual(['empty-value']);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const findings = checkBundle('fr', base, flatten({ brand: { accent: '' } }));
    expect(findings.map((finding) => finding.kind).toSorted()).toEqual(['empty-value', 'missing-key']);
  });
});

describe('checkCallSite', () => {
  const base = flatten({ brand: { rest: 'Sonic' }, nav: { label: 'Primary' } });

  it('accepts a default that equals the bundle', () => {
    expect(checkCallSite('f.tsx', { key: 'brand.rest', inlineDefault: 'Sonic' }, base)).toEqual([]);
  });

  it('fails a default that disagrees with the bundle', () => {
    // The defect: three individually defensible surfaces and one wrong rendered string.
    const findings = checkCallSite('f.tsx', { key: 'brand.rest', inlineDefault: '-Sonic' }, base);
    expect(findings.map((finding) => finding.kind)).toEqual(['default-disagrees']);
    expect(findings[0]?.detail).toContain('"Sonic"');
    expect(findings[0]?.detail).toContain('"-Sonic"');
  });

  it('names a key the bundle does not carry', () => {
    const findings = checkCallSite('f.tsx', { key: 'nope.missing', inlineDefault: 'X' }, base);
    expect(findings.map((finding) => finding.kind)).toEqual(['unknown-key']);
  });

  it('does not also report the default for a key that is absent', () => {
    // One defect, one finding. A second would restate the first and bury it.
    expect(checkCallSite('f.tsx', { key: 'nope.missing', inlineDefault: 'X' }, base)).toHaveLength(1);
  });

  it('has nothing to compare for a one-argument call', () => {
    expect(checkCallSite('f.tsx', { key: 'nav.label', inlineDefault: null }, base)).toEqual([]);
  });
});

describe('readDeclaredTags', () => {
  it('reads the declared language list', () => {
    const source = `export const SUPPORTED_LANGUAGES = ['en', 'fr', 'de'];`;
    expect(readDeclaredTags(source, 'i18n.ts')).toEqual(['en', 'fr', 'de']);
  });

  it('accepts the other spelling of the same list', () => {
    // Only one of the two spellings is a rename away from the other.
    expect(readDeclaredTags(`const SUPPORTED_LOCALES = ['en'];`, 'i18n.ts')).toEqual(['en']);
  });

  it('throws rather than returning nothing, so a changed file shape is not read as "no languages"', () => {
    // An empty list here would turn every declared tag into an "extra directory"
    // finding and name the wrong thing entirely.
    expect(() => readDeclaredTags('const SOMETHING_ELSE = [];', 'i18n.ts')).toThrow(/could not parse/);
  });
});

describe('checkTags', () => {
  it('passes when the two lists agree', () => {
    expect(checkTags(['en', 'fr'], ['en', 'fr'])).toEqual([]);
  });

  it('names a declared language with no bundle, which throws inside loadLanguage at runtime', () => {
    const findings = checkTags(['en', 'fr'], ['en']);
    expect(findings.map((finding) => [finding.kind, finding.subject])).toEqual([['missing-dir', 'fr']]);
  });

  it('names a bundle nothing will ever load', () => {
    const findings = checkTags(['en'], ['en', 'de']);
    expect(findings.map((finding) => [finding.kind, finding.subject])).toEqual([['extra-dir', 'de']]);
  });
});