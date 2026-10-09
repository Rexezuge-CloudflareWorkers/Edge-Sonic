import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesRemovedSinceBaseline, regressionsAgainstBaseline, runGodFileCheck } from '../../scripts/lib/godFiles';

/**
 * The ratchet's rules, exercised as rules.
 *
 * `test/schema.int.test.ts` is the counterpart for migrations: it asserts the lock on
 * disk agrees with the migrations directory. That is the *result*. What is here is the
 * behaviour, and this one earns it more than most — the gate this replaced was a hard
 * limit of 400 lines set **above the largest file in the tree** (397), so it had never
 * fired and could not have. A check that has only ever been seen passing is
 * indistinguishable from a check that does not work.
 *
 * So the assertions below are deliberately asymmetric: every claim that it *rejects*
 * growth is paired with one that it *accepts* shrinkage and deletion. A gate that
 * rejected everything would pass the first half of this file.
 */

const baseline = {
  'packages/shared/src/utils/Identity.ts': 21,
  'packages/webdav/src/xml.ts': 254,
  'apps/api/src/workers/EdgeSonicWorker.ts': 267,
};

const measured = (entries: Record<string, number>): Map<string, number> => new Map(Object.entries(entries));

describe('regressionsAgainstBaseline', () => {
  it('passes a tree identical to the baseline', () => {
    expect(
      regressionsAgainstBaseline(measured({ ...Object.fromEntries(Object.entries(baseline).map(([f, l]) => [f, l])) }), baseline),
    ).toEqual([]);
  });

  it('fails a recorded file that grew by one line', () => {
    const regressions = regressionsAgainstBaseline(measured({ 'packages/webdav/src/xml.ts': 255 }), baseline);
    expect(regressions).toEqual([{ file: 'packages/webdav/src/xml.ts', lines: 255, limit: 254, reason: 'grew past its recorded 254' }]);
  });

  it('reports the regression against the recorded size, not a global ceiling', () => {
    // The point of the inversion. `xml.ts` is over any plausible ceiling and is recorded at
    // 254; the message has to name the number the file must come back down to, or the gate
    // is a ceiling wearing a ratchet's clothes.
    const [only] = regressionsAgainstBaseline(measured({ 'packages/webdav/src/xml.ts': 1000 }), baseline);
    expect(only.limit).toBe(254);
  });

  it('accepts shrinkage in either direction, including below the new-file limit', () => {
    // Payment of debt must never fail a build, or nobody starts paying it.
    expect(regressionsAgainstBaseline(measured({ 'packages/webdav/src/xml.ts': 3 }), baseline)).toEqual([]);
  });

  it('accepts a file that has been deleted outright', () => {
    expect(regressionsAgainstBaseline(measured({}), baseline)).toEqual([]);
  });

  it('accepts a new file that fits the new-file limit', () => {
    expect(regressionsAgainstBaseline(measured({ 'packages/shared/src/utils/NewThing.ts': 120 }), baseline)).toEqual([]);
  });

  it('fails a new file arriving over the new-file limit', () => {
    const regressions = regressionsAgainstBaseline(measured({ 'packages/shared/src/utils/NewThing.ts': 301 }), baseline);
    expect(regressions).toEqual([
      { file: 'packages/shared/src/utils/NewThing.ts', lines: 301, limit: 300, reason: 'new file, over the new-file limit' },
    ]);
  });

  it('takes the new-file limit as an argument rather than reading a constant', () => {
    // A rule that reads its threshold from the module it lives in cannot be exercised at
    // a threshold the module does not use.
    expect(regressionsAgainstBaseline(measured({ 'a.ts': 150 }), {}, 100)).toHaveLength(1);
    expect(regressionsAgainstBaseline(measured({ 'a.ts': 150 }), {}, 200)).toEqual([]);
  });

  it('orders regressions worst-first, so the reported head is the worst offender', () => {
    const regressions = regressionsAgainstBaseline(measured({ 'a.ts': 300, 'b.ts': 900, 'c.ts': 400 }), {
      'a.ts': 100,
      'b.ts': 200,
      'c.ts': 300,
    });
    expect(regressions.map((r) => r.file)).toEqual(['b.ts', 'c.ts', 'a.ts']);
  });

  it('does not report a recorded file that no longer exists', () => {
    // Reporting it would make deleting a file a failure, which is the opposite of what a
    // ratchet is for.
    expect(regressionsAgainstBaseline(measured({ 'packages/webdav/src/xml.ts': 254 }), baseline)).toEqual([]);
  });
});

describe('filesRemovedSinceBaseline', () => {
  it('reports recorded files that are absent from the tree', () => {
    expect(filesRemovedSinceBaseline(measured({ 'packages/webdav/src/xml.ts': 254 }), baseline)).toEqual([
      'packages/shared/src/utils/Identity.ts',
      'apps/api/src/workers/EdgeSonicWorker.ts',
    ]);
  });

  it('reports nothing when nothing is gone', () => {
    const all = measured(Object.fromEntries(Object.entries(baseline).map(([file, lines]) => [file, lines])));
    expect(filesRemovedSinceBaseline(all, baseline)).toEqual([]);
  });
});

describe('the recorded baseline', () => {
  it('bounds every file the walk includes, so the gate is armed on day one', () => {
    // The whole ratchet is inert against a file with no recorded size — it is reported as
    // "new" and only checked against `NEW_FILE_LIMIT`. A baseline missing a file therefore
    // does not fail, it silently changes which rule applies, so this is the assertion that
    // makes the first run mean something.
    const root = path.resolve(new URL('../..', import.meta.url).pathname);
    const result = runGodFileCheck({ root, baselinePath: path.join(root, 'scripts', 'god-files.baseline.json') });
    const recorded: Record<string, number> = JSON.parse(readFileSync(path.join(root, 'scripts', 'god-files.baseline.json'), 'utf8'));

    expect(result.passed, result.reported).toBe(true);
    // Every measured file is either recorded, or new **and** within the new-file limit.
    const unexplained = result.regressions.filter((r) => recorded[r.file] === undefined);
    expect(unexplained).toEqual([]);
    expect(Object.keys(recorded).length).toBeGreaterThan(100);
  });

  it('records the largest file in the tree, and does so at a size no ceiling would have allowed', () => {
    // Why the ratchet and not a lower ceiling: the biggest file here is well past any limit
    // a gate could have been given without failing immediately. A ceiling would have had to
    // be set above it, which is the same as not having one.
    const root = path.resolve(new URL('../..', import.meta.url).pathname);
    const recorded = JSON.parse(readFileSync(path.join(root, 'scripts', 'god-files.baseline.json'), 'utf8')) as Record<string, number>;
    const largest = Math.max(...Object.values(recorded));

    expect(largest).toBeGreaterThan(400);
    expect(Object.keys(recorded)).toContain('test/schema.int.test.ts');
  });
});
