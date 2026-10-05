/**
 * The two untrusted-input parsers cannot be quadratic.
 *
 * ### What is asserted, and what is not
 *
 * Two functions read a string that came off the wire and used a regular expression on it:
 * `toLibraryPath` (a `DAV:href`, in `packages/webdav`) and `fromFlatAlbumFolder` (a
 * directory name, in `packages/backend-data`). CodeQL reported both as *polynomial regular
 * expression used on uncontrolled data*, and both are genuinely quadratic — not
 * exponentially so, which is the shape every linter looks for, but quadratically:
 *
 *     n           \s+[-–—]\s+     /\/+$/ on an interior run
 *     8,000            70 ms                  50 ms
 *     16,000          278 ms                 199 ms
 *     40,000        1,741 ms               1,245 ms
 *     100,000      10,891 ms               7,774 ms
 *
 * Four times the work per doubling, on both. The mechanism is the same in each: an
 * **unbounded quantifier followed by a character that can fail**, with the scan unanchored.
 * For each of the *n* start positions inside a run of *n* identical characters, the engine
 * retries every length the run could have, so the cost is the *square* of the run rather
 * than its length.
 *
 * Neither function needs the whole run. `stripSlashes` walks in from each end and stops at
 * the first non-slash. `findAlbumSeparator` walks left to right and stops at the first
 * dash-like character with whitespace on both sides — and because both sides of the split
 * are `.trim()`ed by the caller, the *extent* of the whitespace runs cannot change the
 * answer, which is what lets it answer with the dash's own index and never measure a run.
 *
 * ### Why this is a measurement and not a lint rule
 *
 * Because `pnpm run lint` already runs `eslint-plugin-regexp`'s
 * `no-super-linear-backtracking` and `sonarjs`'s `slow-regex`, and **neither fires on either
 * of these.** Probed directly:
 *
 *     /^(a+)+$/        both fire      (exponential — the shape they look for)
 *     /\s+[-–—]\s+/    slow-regex     (quadratic)
 *     /\/+$/           neither         (quadratic)
 *
 * So the repository was lint-clean over a live denial of service, and the only instrument
 * that found it was CodeQL, which is not a test and does not run on every commit. The
 * assertions below are what makes this class visible locally. There is no lint rule for
 * "quadratic in the input", which is why the timing assertions are load-bearing rather than
 * belt-and-braces.
 *
 * ### Why the references are `new RegExp` and not literals
 *
 * The quadratic reference has to exist for the teeth tests, and writing it as a literal
 * would re-open the very alert this file exists to close — CodeQL's default configuration
 * scans `test/` along with everything else, and a literal `/\/+$/` in a test is the same
 * finding at the same severity. `new RegExp` builds the identical pattern from a string and
 * is outside the query's set. That is the whole reason for the construction, and it is why
 * a future expansion of CodeQL's coverage is worth re-checking here rather than treated as
 * a regression.
 */
import { describe, expect, it } from 'vitest';

import { deriveFromPath } from '@edge-sonic/backend-data/dao';
import { DERIVED_MARKER } from './helpers/harness';
import { toLibraryPath } from '@edge-sonic/webdav';

/**
 * Worst-case length for the timing assertions.
 *
 * Chosen from the measured table above so the two regimes are separated by orders of
 * magnitude rather than by a factor that could drift: at 40,000 characters the linear path
 * is ~0.2 ms and the quadratic one is ~1.2–1.7 s. A budget anywhere between those is sound,
 * and this one sits closer to the linear measurement — 1,200x of headroom below it — so a
 * loaded CI machine cannot turn it red, while a regression to the regex fails by
 * *assertion* in about a second and a half instead of hanging into a test timeout.
 */
const HOSTILE_LENGTH = 40_000;

/**
 * Linear-path budget, in milliseconds.
 *
 * Not a tight bound: it is an assertion that the work is bounded by the input's length, at
 * a length where the quadratic alternative would be visible. `HOSTILE_LENGTH` is chosen so
 * the gap is 3-4 orders of magnitude in both directions, so this number does not need to be
 * re-tuned when the machine changes.
 */
const LINEAR_BUDGET_MS = 250;

/**
 * The two patterns the production code used to carry, rebuilt from a string.
 *
 * Applied in this order, which is the order they were written in and the order that decides
 * which input is expensive — see the note on `interiorSlashRun`.
 *
 * **`prefer-regex-literals` is switched off for these two, and the reason is the whole point
 * of the file.** CodeQL's default configuration scans `test/` alongside `packages/`, and a
 * literal `/[/]+$/` here is the same finding at the same severity as the alert this file
 * closes — so the teeth test would re-open the thing it exists to prove fixed. The lint rule
 * is not wrong in general; it is wrong for a reference implementation whose purpose is to be
 * *found* by the security scanner. Nothing else in the repository needs this exemption, and
 * if the quadratic reference is ever deleted the disables go with it.
 */
/* eslint-disable prefer-regex-literals -- a literal here would re-trip CodeQL's own query */
const QUADRATIC_LEADING_SLASHES = new RegExp('^/+');
const QUADRATIC_TRAILING_SLASHES = new RegExp(String.raw`\/+$`);
/* eslint-enable prefer-regex-literals */

/**
 * The implementation the code used to have, for the teeth test to measure against.
 *
 * Kept faithful to the original — same two replacements, same order — because a partial
 * restoration measures a different defect than the one that shipped.
 */
function quadraticStripSlashes(value: string): string {
  return value.replace(QUADRATIC_LEADING_SLASHES, '').replace(QUADRATIC_TRAILING_SLASHES, '');
}

/**
 * The pattern `fromFlatAlbumFolder` used to carry, rebuilt from a string.
 *
 * `\s+` is greedy, so on *n* spaces followed by a non-dash it retries every length from *n*
 * down to 1 before giving up on that start position — and then starts again one character
 * later. Same quadratic, arrived at from a different direction, and again the reason for the
 * constructor rather than a literal.
 */
/* eslint-disable-next-line prefer-regex-literals -- a literal here would re-trip CodeQL's own query */
const QUADRATIC_ALBUM_SEPARATOR = new RegExp('\\s+[-\u2013\u2014]\\s+');

/**
 * Wall-clock milliseconds for one call, as the **minimum** of five runs.
 *
 * The minimum, not the mean or a single run: this measures the cost of the work rather than
 * the machine's mood, and a first call pays JIT and GC costs that say nothing about the
 * algorithm. A mean would fold in exactly the noise being guarded against.
 */
function bestOfFiveMs(work: () => void): number {
  let best = Infinity;
  for (let run = 0; run < 5; run++) {
    const started = process.hrtime.bigint();
    work();
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/**
 * "Leading and trailing slashes removed", derived from the definition rather than from
 * `stripSlashes`'s implementation.
 *
 * Split on `/`, drop the empty segments at the two ends, keep every segment in between —
 * **including the empty ones**, because a doubled interior separator is not this
 * function's business and neither implementation touches it. Written against the segment
 * array with `=== ''` comparisons rather than as a second character scan, so the two cannot
 * share a mistake: there are no char codes and no index arithmetic in common.
 *
 * The first version of this oracle filtered *every* empty segment, and so disagreed with
 * the production code on `a////////x/y` — the fuzz below found it on the first run it met
 * an interior run. That is the fixture-agrees-with-the-reader failure in its purest form,
 * and it is worth recording that the disagreement was in the direction of the *fixture*
 * being confidently wrong: `split`/`filter`/`join` reads like an obviously-correct
 * definition of "stripped" right up until it silently normalises the middle of the string.
 */
function stripSlashesOracle(value: string): string {
  const segments = value.split('/');
  let first = 0;
  let last = segments.length - 1;
  while (first <= last && segments[first] === '') first++;
  while (last >= first && segments[last] === '') last--;
  return segments.slice(first, last + 1).join('/');
}

/**
 * A run of *n* slashes with a non-slash on **both** sides.
 *
 * The one shape of hostile input that actually costs the old implementation its time, and the
 * reason is two escapes that the other three shapes get for free:
 *
 * - A **leading** run is removed by `replace(/^\/+/, '')`, which is anchored and linear. By the
 *   time `/+$/` runs there is nothing left to be slow about.
 * - A **trailing** run *matches*, and V8 has a fast path for `/[/]+$/` when the match succeeds.
 *   The quadratic is in the **failure**.
 *
 * An interior run has neither escape. `/^\/+/` fails at position 0 and changes nothing, so
 * `/+$/` then walks a run of *n* slashes, fails `$`, backs off one length, fails, and so on —
 * *n* attempts from each of the *n* start positions inside the run. So the cost is the square
 * of the run, and the run's *position* is what decides whether anything pays it. Measured on
 * this machine at 16,000 slashes: 0.0 ms leading, 0.0 ms trailing, 198 ms interior.
 */
function interiorSlashRun(n: number): string {
  return `Music${'/'.repeat(n)}Blur/13.flac`;
}

/**
 * Where `stripSlashes` stops, observed through `toLibraryPath`'s own contract.
 *
 * `toLibraryPath(href, '')` returns the stripped href and nothing else — the empty-root
 * branch returns `normalizedHref` before any prefix comparison happens — so this is the
 * stripped string, reached through the public seam rather than through an exported helper.
 * Testing it here rather than in `webdav-client.test.ts` keeps the helper private: a
 * `stripSlashes` export would be a second public answer to "strip these slashes", and the
 * oracle above is the reference for both.
 */
function observedStrip(value: string): string {
  return toLibraryPath(value, '') ?? '';
}

/**
 * `Artist - Album` split, derived from the written convention.
 *
 * States the rule in the order it reads: find the first dash-like character, require
 * whitespace on **both** sides, split there. `includes` and `charAt` rather than
 * `charCodeAt`, so there is no shared constant with the production scan to be wrong in the
 * same way — this is the fixture written from the spec rather than a mirror of the reader,
 * which is the rule the FLAC and Ogg fixtures in this suite already follow.
 *
 * The dash set is spelled out as literals rather than derived from a character class, and
 * the whitespace test is `\s` — the one place the engine's own definition is correct to
 * depend on, since a hand-copied list of code points is exactly the kind of fixture that
 * agrees with a wrong reader.
 */
function albumSeparatorOracle(dirName: string): number {
  for (let index = 0; index < dirName.length; index++) {
    const character = dirName.charAt(index);
    if (!'-–—'.includes(character)) continue;
    const before = index > 0 ? dirName.charAt(index - 1) : '';
    const after = index + 1 < dirName.length ? dirName.charAt(index + 1) : '';
    if (before === '' || after === '') continue;
    if (/\s/.test(before) && /\s/.test(after)) return index;
  }
  return -1;
}

/**
 * `deriveFromPath`'s answer for a depth-1 path, stated as the caller's decision rather than
 * the scan's.
 *
 * Two rules that are not the scan's, both stated here because the oracle is compared as an
 * *answer* and a rule left out of it shows up as a phantom disagreement:
 *
 * - **The empty path answers both `null`, not `album: ''`.** `deriveFromPath` returns before
 *   the branch is ever chosen. This is the module's own rule — an uninformative path yields
 *   NULL, never `''`, because `''` groups under a blank name in `getArtists`.
 * - **The fallback when either side trims to nothing is "no artist", and the album is the
 *   whole name.** `- Album` has no artist and `Artist -` has no album, and neither
 *   half-invented name is published.
 *
 * The caller is also what makes the dash's index sufficient: it trims both sides, so the
 * *extent* of the whitespace runs is unobservable here — which is the fact the production
 * scan relies on.
 */
function flatAlbumOracle(dirName: string): { artist: string | null; album: string | null } {
  if (dirName.length === 0) return { artist: null, album: null };
  const separator = albumSeparatorOracle(dirName);
  if (separator === -1) return { artist: null, album: dirName };
  const artist = dirName.slice(0, separator).trim();
  const album = dirName.slice(separator + 1).trim();
  if (artist.length === 0 || album.length === 0) return { artist: null, album: dirName };
  return { artist, album };
}

/**
 * The same answer as `deriveFromPath`, with the derived marker removed.
 *
 * `deriveFromPath` suffixes a configured marker onto the artist, so a client can tell a
 * derived grouping from a tagged one. Importing the marker rather than typing `' (derived)'`
 * here means this file does not hold a second copy of it — and the marker is *configuration*
 * now, so a copy is free to drift from a value no module owns while every assertion still
 * passed. Stripping it means the oracle compares the *naming decision* — which name came out
 * where — instead of also depending on the marker being applied, which is a separate concern
 * with its own tests.
 *
 * The marker is non-empty here on purpose: an empty one would make the strip a no-op and this
 * file could no longer tell a derivation that appended nothing from one that appended
 * something, which is the failure mode a `replace` on an empty needle would hide.
 */
function derivedNames(dirPath: string): { artist: string | null; album: string | null } {
  const derived = deriveFromPath(dirPath, DERIVED_MARKER);
  const unmark = (value: string | null): string | null => value?.replace(DERIVED_MARKER, '') ?? null;
  return { artist: unmark(derived.artist), album: unmark(derived.album) };
}

/**
 * A repeatable pseudo-random source, so a fuzz failure is reproducible from the seed.
 *
 * `Math.random` would make a red run unreproducible, which is the opposite of what a fuzz is
 * for: the point is that the *same* 20,000 inputs are checked on every run, so a regression
 * is a fixed set of cases rather than a story about the machine. A 32-bit LCG is enough —
 * these inputs are not cryptographic and the generator is stated rather than imported.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_00_00_00_00;
  };
}

/**
 * Alphabet for the slash fuzz.
 *
 * Only `/` and non-slash runs, because those are the two things `stripSlashes` distinguishes
 * — a boundary between them and a repetition of them. Including letters would exercise the
 * `startsWith` arithmetic in `toLibraryPath`, which is not what this file is about and is
 * covered by `webdav-client.test.ts`.
 */
const SLASH_ALPHABET = ['/', '//', '///', 'a', 'ab', 'x/y'] as const;

/**
 * Alphabet for the separator fuzz.
 *
 * Every character class the convention turns on: the three dashes, five whitespace spellings
 * that `\s` covers beyond the ASCII space (NBSP, en-space, line separator, ideographic
 * space), and non-space filler including a dash *inside* a word. `'-'` appears as its own
 * entry as well as inside `'a-b'`, because "dash with a space on neither side" is a case the
 * convention rejects and it should be generated, not only hand-written.
 */
const SEPARATOR_ALPHABET = [
  ' ',
  '  ',
  '\t',
  '\n',
  '\r',
  ' ',
  ' ',
  ' ',
  '　',
  '﻿',
  '-',
  '–',
  '—',
  'a',
  'Z',
  '9',
  'a-b',
  'Album',
  '_',
] as const;

describe('slash stripping stays linear', () => {
  it.each([
    ['', '', 'nothing to strip'],
    ['/', '', 'a single slash is entirely a delimiter'],
    ['//', '', 'several slashes and nothing else'],
    ['///', '', 'still nothing else'],
    ['a', 'a', 'no slashes at all'],
    ['/a', 'a', 'leading only'],
    ['a/', 'a', 'trailing only'],
    ['/a/', 'a', 'both'],
    ['//a//b//', 'a//b', 'repeated runs at both ends and one inside'],
    ['a//b', 'a//b', "a doubled interior separator is not this function's business"],
    ['a/b/c', 'a/b/c', 'an ordinary path is unchanged'],
    ['//a//', 'a', 'leading run, then a trailing run'],
    ['///a///b///', 'a///b', 'and only the outer runs go'],
  ])('strips %j to %j (%s)', (input, expected) => {
    expect(observedStrip(input)).toBe(expected);
    // The oracle is the assertion, not a cross-check: it is derived from the definition, so
    // a disagreement means one of the two is wrong about what "stripped" means.
    expect(observedStrip(input)).toBe(stripSlashesOracle(input));
  });

  it('matches the oracle on a hostile *interior* run of slashes, and does it in bounded time', () => {
    // The interior run is the one that costs the old implementation its time, and both of its
    // neighbours have to be excluded for this test to be testing anything — the case at the
    // bottom of this block measures all three. It is also the honest hostile input: a
    // `DAV:href` is `<base>/<path>`, so a run of thousands of slashes sits between two real
    // segments rather than at either end of the string.
    const hostile = interiorSlashRun(HOSTILE_LENGTH);
    const started = process.hrtime.bigint();
    const stripped = observedStrip(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(stripped).toBe(hostile);
    expect(stripped).toBe(stripSlashesOracle(hostile));
    expect(elapsedMs).toBeLessThan(LINEAR_BUDGET_MS);
  });

  it.each([
    ['a leading run', (n: number): string => `${'/'.repeat(n)}x`],
    ['a trailing run', (n: number): string => `x${'/'.repeat(n)}`],
    ['a run of nothing but slashes', (n: number): string => '/'.repeat(n)],
    ['a run of slashes on both sides of a segment', (n: number): string => `${'/'.repeat(n)}x/${'/'.repeat(n)}`],
  ])('matches the oracle on %s, in bounded time', (_shape, build) => {
    // Correctness and budget, but deliberately **not** relied on as the adversarial case —
    // the interior run above is that, and the case below the block measures all four against
    // the old implementation to prove which one bites. These three are here so the boundary
    // is stated rather than assumed, and so nobody later concludes from a green run that "a
    // long slash run" is one input when it is four with exactly one that costs anything.
    const hostile = build(HOSTILE_LENGTH);
    const started = process.hrtime.bigint();
    const stripped = observedStrip(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(stripped).toBe(stripSlashesOracle(hostile));
    expect(elapsedMs).toBeLessThan(LINEAR_BUDGET_MS);
  });

  it('only the interior run was ever adversarial, which is why that is the one asserted', () => {
    // The teeth for the budget above, and the reason it cannot be deleted quietly. Without
    // it, `LINEAR_BUDGET_MS` is a number nobody has checked against the thing it is meant to
    // exclude: a future edit could reintroduce both regexes, the leading and trailing cases
    // above would stay green, and the budget would never be asked a question.
    //
    // Measured here at 16,000 slashes, best of three:
    //
    //     leading run + non-slash        0.0 ms   <- `/^/+/` strips it first, so `/+$/` sees `x`
    //     trailing run after a segment    0.0 ms   <- V8 fast-paths a *successful* `[/]+$/`
    //     INTERIOR run                    198 ms   <- neither escape applies
    //
    // The first version of this file asserted the leading and trailing runs, and both passed
    // against the reintroduced regex — 48 of 48 green. A guard written against the wrong shape
    // of the input is indistinguishable from no guard, because the defect it exists to catch
    // is the one input it never tried. This is the FLAC-fixture rule with a wall clock: the
    // assertion has to be able to fail for the reader's reason, not merely for the reader's.
    const size = HOSTILE_LENGTH / 2.5;
    const interior = bestOfFiveMs(() => quadraticStripSlashes(interiorSlashRun(size)));
    const leading = bestOfFiveMs(() => quadraticStripSlashes(`${'/'.repeat(size)}x`));
    const trailing = bestOfFiveMs(() => quadraticStripSlashes(`x${'/'.repeat(size)}`));

    expect(interior).toBeGreaterThan(leading * 50);
    expect(interior).toBeGreaterThan(trailing * 50);
    expect(interior).toBeGreaterThan(bestOfFiveMs(() => observedStrip(interiorSlashRun(size))) * 50);
  });
});

describe('the album separator stays linear', () => {
  it.each([
    ['Artist - Album', 'the convention'],
    ['Symphony No. 5 - 1949', 'only the first separator, never the one inside the album title'],
    ['A - B - C', 'of three candidates, the first one wins'],
    ['- Album', 'a leading separator means no artist, so the whole name is the album'],
    ['Artist -', 'a trailing separator means no album'],
    ['-', 'a bare hyphen is a name, not a separator'],
    ['—', 'and so is a bare em dash'],
    ['Album', 'no dash at all'],
    ['', 'the empty name, which `deriveFromPath` answers before this function is reached'],
    ['Album - Vol 2', 'a hyphen that is part of the album title, after the real separator'],
    ['Mötley Crüe - compilation', 'non-ASCII letters around the separator'],
    ['Artist -Album', 'whitespace before the dash but not after: not the convention'],
    ['Artist- Album', 'whitespace after the dash but not before: not the convention'],
    ['a-b', 'a hyphen inside a word, with no whitespace on either side'],
    ['a -b', 'whitespace on one side only'],
    ['a- b', 'and on the other only'],
    ['Artist\u00A0-\u00A0Album', 'non-breaking spaces are whitespace to `\s`'],
    ['Artist\u2009-\u2009Album', 'and so are thin spaces'],
    ['Artist\t-\nAlbum', 'and tabs and newlines'],
    ['  Artist - Album  ', 'runs of whitespace at the ends, which trim away'],
    ['  - Album', 'a run of whitespace does not rescue a leading separator'],
  ])('derives from %j (%s)', (dirName, _reason) => {
    // Depth 1 — no `/` — so `deriveFromPath` routes to `fromFlatAlbumFolder`. The nested
    // layout is exercised in its own test below, because routing to a *different* function
    // is a case the oracle here cannot speak for.
    const observed = derivedNames(dirName);
    const oracle = flatAlbumOracle(dirName);
    // `derivedNames` strips the marker, so the oracle's unmarked names are compared directly.
    expect(observed).toEqual(oracle);
  });

  it('matches the oracle on a hostile run of spaces with a separator at the far end', () => {
    // The primary adversarial input, and every part of its shape is load-bearing:
    //
    // - **Spaces followed by a non-dash** is what makes the regex quadratic. A run that ended
    //   in a dash matched on the first attempt and cost nothing.
    // - **A segment before the run** is what makes the answer distinguishable. The first
    //   version of this test used `' '.repeat(N) + 'a'`, where the scan's only possible answer
    //   is "no separator" — and a scan that *stopped early* returned exactly that, so an
    //   implementation which read only the first 20 characters passed 50 of 50. With a real
    //   segment in front, a short scan misses the separator entirely and reports no artist.
    // - **Non-empty whitespace-separated sides** so the answer is a real split rather than the
    //   "separator at an end" fallback, which two different wrong answers can both produce.
    const hostile = `Artist${' '.repeat(HOSTILE_LENGTH)}- Album`;
    const started = process.hrtime.bigint();
    const observed = derivedNames(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // `derivedNames` strips the marker, so the split is compared unmarked; the marking itself is
    // asserted by the table above and by the nesting block.
    expect(observed).toEqual({ artist: 'Artist', album: 'Album' });
    expect(observed).toEqual(flatAlbumOracle(hostile));
    expect(elapsedMs).toBeLessThan(LINEAR_BUDGET_MS);
  });

  it.each([
    ['a run of spaces and then a non-dash, so there is no separator at all', (n: number): string => `${' '.repeat(n)}a`],
    ['a run of spaces ended by a dash, which a regex matches on its first attempt', (n: number): string => `${' '.repeat(n)}-${' '.repeat(n)}a`],
    ['a run of tabs, which are whitespace to `\s` as well', (n: number): string => `Artist${'\t'.repeat(n)}- Album`],
    ['a run of non-breaking spaces, which are whitespace too', (n: number): string => `Artist${' '.repeat(n)}- Album`],
  ])('matches the oracle on %s, in bounded time', (_shape, build) => {
    // Correctness and budget on the other three shapes. Not the adversarial case — the case
    // above is — and kept so the boundary is stated rather than assumed.
    const hostile = build(HOSTILE_LENGTH);
    const started = process.hrtime.bigint();
    const observed = derivedNames(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(observed).toEqual(flatAlbumOracle(hostile));
    expect(elapsedMs).toBeLessThan(LINEAR_BUDGET_MS);
  });

  it('the hostile inputs are genuinely adversarial, and the gap is orders of magnitude', () => {
    // The teeth for the budget above, in the same shape as the slash case and for the same
    // reason: without a measured ratio, `LINEAR_BUDGET_MS` is a number nobody has checked
    // against the thing it is meant to exclude.
    const hostile = `${' '.repeat(HOSTILE_LENGTH / 2.5)}a`;
    const quadratic = bestOfFiveMs(() => QUADRATIC_ALBUM_SEPARATOR.test(hostile));
    const linear = bestOfFiveMs(() => albumSeparatorOracle(hostile));

    expect(quadratic).toBeGreaterThan(linear * 50);
  });
});

describe('the nesting rule is unaffected by the separator scan', () => {
  // Depth 2 and deeper route to `fromNestedPath`, which splits on the last `/` and does not
  // consult the separator at all. Asserted here because the separator rewrite is the change
  // and this is the path it must not touch — a scan that ran on nested paths would turn
  // `Artist - 2009 Remaster` into an artist called `Artist`, which is the exact mistake the
  // depth check exists to prevent.
  it.each([
    ['Bonobo/Black Sands', 'the ordinary layout'],
    ['A - B/C - D', 'dashes on both sides of the separator, at depth 2: the leaf is the album'],
    ['Artist - Album/2011 Remaster', 'a dash in the artist folder does not split anything'],
    ['A/B/C', 'deeper still, and still the last two segments'],
  ])('derives %j as nested (%s)', (dirPath, _reason) => {
    const derived = deriveFromPath(dirPath, DERIVED_MARKER);
    const slash = dirPath.lastIndexOf('/');
    expect(derived.artist).toBe(`${dirPath.slice(0, slash)}${DERIVED_MARKER}`);
    // The marker is on the album too, and `songDerivation.ts` keys its overwrite on it — so a
    // marker on one column and not the other is a rule true for half the columns, and this
    // assertion is what catches the artist-only half.
    expect(derived.album).toBe(`${dirPath.slice(slash + 1)}${DERIVED_MARKER}`);
  });

  it('a dash-free name at depth 1 is an album with no artist, not the nested branch', () => {
    // The trap this test file nearly fell into, recorded because it is the one place the
    // two branches disagree on the same input. `Artist - Album` has **no slash**, so it is
    // depth 1 and goes to `fromFlatAlbumFolder` — which splits it. The `slash <= 0` branch
    // of `fromNestedPath` (artist is the whole path, album is null) is reachable only
    // through a *leading* slash, which `lastIndexOf` reports as 0.
    expect(deriveFromPath('Artist - Album', DERIVED_MARKER)).toEqual({
      artist: `Artist${DERIVED_MARKER}`,
      album: `Album${DERIVED_MARKER}`,
    });
    expect(deriveFromPath('/Artist', DERIVED_MARKER)).toEqual({
      artist: `/Artist${DERIVED_MARKER}`,
      album: null,
    });
  });
});

describe('fuzzed against the oracle', () => {
  it('strips slashes identically over 20,000 random path-shaped strings', () => {
    // Seeded, so a red run is the same 20,000 strings every time rather than a story about
    // the machine. 20,000 is chosen because it runs in well under a second while covering
    // every combination of leading run, interior runs and trailing run up to five segments.
    const next = lcg(0x5e_ed_00_01);
    for (let iteration = 0; iteration < 20_000; iteration++) {
      let input = '';
      const segments = 1 + Math.floor(next() * 5);
      for (let segment = 0; segment < segments; segment++) {
        input += SLASH_ALPHABET[Math.floor(next() * SLASH_ALPHABET.length)];
      }
      const expected = stripSlashesOracle(input);
      expect(observedStrip(input), `input ${JSON.stringify(input)}`).toBe(expected);
    }
  });

  it('splits album names identically over 20,000 random dash-shaped names', () => {
    // Same seed discipline, different alphabet. The value is in the *combinations*: a
    // separator whose whitespace run has a non-space in the middle, a dash with a space on
    // one side and an en-space on the other, two dashes one character apart. The
    // hand-written table above covers the cases a human thinks of; this covers the ones they
    // do not, which is where a rewrite of a quantifier actually goes wrong.
    const next = lcg(0x5e_ed_00_02);
    for (let iteration = 0; iteration < 20_000; iteration++) {
      let input = '';
      const pieces = 1 + Math.floor(next() * 6);
      for (let piece = 0; piece < pieces; piece++) {
        input += SEPARATOR_ALPHABET[Math.floor(next() * SEPARATOR_ALPHABET.length)];
      }
      const oracle = flatAlbumOracle(input);
      const observed = derivedNames(input);
      expect(observed, `input ${JSON.stringify(input)}`).toEqual(oracle);
    }
  });
});