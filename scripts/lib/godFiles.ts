/**
 * Fail CI when a source file grows past the size it was recorded at.
 *
 * Rationale: a file past a few hundred lines stops being readable as a unit. The
 * failure modes are not hypothetical — this repo's own history has a 219-line
 * god-class and a 495-line React component, both of which had to be split by hand.
 * A cheap gate turns that from a discovery into a review prompt.
 *
 * ### Why this is a ratchet and not a ceiling
 *
 * It was a ceiling: soft 300 (warn), hard 400 (error). That is a limit set **above the
 * largest file that exists** — the tree's maximum was 397 — so `HARD` had never fired,
 * while `SOFT` reported 40 files over and exited 0 every time. A ceiling above the current
 * maximum measures nothing: it cannot tell a repository getting worse from one that never
 * got better, and raising the ceiling is always available, so the only thing it enforced
 * was that the ceiling had been chosen generously.
 *
 * So the rule is inverted. `scripts/god-files.baseline.json` records the size of every
 * file when the ratchet was adopted. A file may shrink freely, may be deleted, and may
 * grow **only up to its own recorded size**. A file with no entry is new, and is held to
 * {@link NEW_FILE_LIMIT}.
 *
 * This cannot be satisfied by raising a number: the recorded sizes are the contract, so
 * paying down debt is deleting lines, and lowering a limit means editing the baseline in
 * the same commit that spends the effort — where the diff shows what was bought.
 *
 * ### Tests are in scope, and used not to be
 *
 * The old skip list excluded every `*.test.*` file and every path under a test directory,
 * so nothing bounded a test file at all: `test/schema.int.test.ts` sat at 4,343 lines,
 * a quarter of the suite, with no limit of any kind applying to it. A test is the same
 * shape of problem as a module — one describe block that hides six subjects — so the
 * ratchet holds them too, and the recorded sizes come down as the file splits.
 *
 * ### The one write path
 *
 * `pnpm run check:god-files:update` rewrites the baseline. There is deliberately no
 * `--force` that skips the check, because a write that could bless a drift without
 * reading the drift is the operator blessing their own edit, and they are by definition
 * the one making it.
 *
 * Excludes: node_modules, dist, build output, generated, locales, lockfiles, tooling.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const BASELINE_RELATIVE = 'scripts/god-files.baseline.json';
const BASELINE_PATH = path.join(ROOT, BASELINE_RELATIVE);
/**
 * A file with no baseline entry is new. It gets the ceiling the original gate had, so
 * adopting the ratchet does not forbid the next module — it only forbids the next module
 * arriving as a 500-line god file on its first commit.
 */
const NEW_FILE_LIMIT = 300;
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.wrangler', 'coverage', 'coverage-integration', '.git']);
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|css)$/;

/**
 Paths relative to ROOT, so the patterns below can match on directory too.

 Every directory pattern is anchored with `(?:^|/)` rather than a bare leading `/`.
 `relative()` yields `test/helpers/x.ts` for this repository's top-level test directory
 and `scripts/lib/x.ts` for the scripts directory — **no leading separator** — so a
 pattern written as `/\/(?:test|tests|__tests__)\//` never matches either one. It looks
 right, it does match when handed an absolute path, and against these two directories
 it is silently a no-op. The `scripts` pattern carries the anchor; the test-directory
 pattern did not, so the exclusion was dead for the exact layout it was written for.
 */
export function shouldSkip(rel: string): boolean {
  return (
    // Generated trees and data, which are rewritten wholesale rather than edited.
    /(?:^|\/)(?:locales|generated)\//.test(rel) ||
    // `__tests__`/`__mocks__` can be the last segment of a path too, so matched as
    // whole segments rather than requiring something after the slash.
    /(?:^|\/)__(?:tests|mocks)__(?:\/|$)/.test(rel) ||
    // Tooling is not source: build, lint and test configs, and the deploy and backup
    // scripts, grow with project surface rather than with complexity. Matched on a path
    // segment rather than `/scripts/` because `relative()` yields `scripts/...` with no
    // leading separator for a top-level directory.
    /(?:^|\/)scripts\//.test(rel) ||
    /\.config\.(?:m?[jt]s|cjs)$/.test(rel) ||
    // Declarations and data. `.d.ts` is generated for the most part, and a JSON file's
    // line count says nothing about whether it is understandable.
    rel.endsWith('.d.ts') ||
    rel.endsWith('.json') ||
    rel.endsWith('.sql') ||
    rel.endsWith('.md')
  );
}

export function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      // A dangling symlink or a file removed mid-walk is not a god-file problem.
      continue;
    }
    if (stat.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (SOURCE_EXTENSIONS.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function lineCount(file: string): number {
  return readFileSync(file, 'utf8').split('\n').length;
}

/**
 * Every file a file in `measured` grew past its recorded size, worst first.
 *
 * Pure, and the whole of the rule: it takes what is on disk and what was recorded and
 * answers what may not be committed. Exported so `test/scripts/god-files.test.ts` can
 * exercise it directly, because a gate that can only be observed passing is not a gate —
 * this one was a ceiling set above the largest file in the tree, and it reported success
 * for the whole history of that.
 *
 * Three outcomes, and they are not the same verdict:
 *
 * - **Recorded and not grown** — fine. Shrinking further is always fine too, because the
 *   comparison is one-directional: paying down debt can never fail a build, which is what
 *   makes the gate safe to enforce from day one against 341 files already over 300.
 * - **New** — held to `newFileLimit`. A new file is not a regression, so it is only
 *   reported when it arrives as a god file.
 * - **Recorded and grown** — the only failure. Reported against the recorded size rather
 *   than a global ceiling, so the number in the message is the number the file has to
 *   come back down to.
 *
 * A file recorded in the baseline and absent from `measured` is not reported: deletion is
 * a legitimate way to pay down debt, and reporting it would make removing a file a
 * failure.
 */
export function regressionsAgainstBaseline(
  measured: Map<string, number>,
  baseline: Record<string, number>,
  newFileLimit = NEW_FILE_LIMIT,
): Regression[] {
  const regressions: Regression[] = [];
  for (const [file, lines] of measured) {
    const recorded = baseline[file];
    if (recorded === undefined) {
      if (lines > newFileLimit) {
        regressions.push({ file, lines, limit: newFileLimit, reason: 'new file, over the new-file limit' });
      }
      continue;
    }
    if (lines > recorded) {
      regressions.push({ file, lines, limit: recorded, reason: `grew past its recorded ${recorded}` });
    }
  }
  return regressions.sort((a, b) => b.lines - a.lines);
}

/**
Recorded files that are gone. Informational, never a failure.
*/
export function filesRemovedSinceBaseline(measured: Map<string, number>, baseline: Record<string, number>): string[] {
  return Object.keys(baseline).filter((file) => !measured.has(file));
}

/**
 * Run the gate, and report whether it passed.
 *
 * Returns the verdict instead of exiting, so a caller can assert on it; the script
 * wrapper below is what turns a `false` into a non-zero exit code.
 */
export function runGodFileCheck({
  root = ROOT,
  baselinePath = BASELINE_PATH,
  writeBaseline = false,
}: GodFileCheckOptions = {}): GodFileCheckResult {
  const files = walk(root).filter((file) => !shouldSkip(path.relative(root, file)));
  const measured = new Map();
  for (const file of files) measured.set(path.relative(root, file), lineCount(file));

  if (writeBaseline) {
    const sorted = [...measured].sort(([a], [b]) => a.localeCompare(b));
    writeFileSync(baselinePath, `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`, 'utf8');
    return {
      passed: true,
      regressions: [],
      removed: [],
      measured,
      reported: `God-file baseline updated: ${sorted.length} files recorded` + describeLargest(sorted),
    };
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    return {
      passed: false,
      regressions: [],
      removed: [],
      measured,
      reported:
        `God-file check failed: cannot read ${path.relative(root, baselinePath)}.\n` +
        `Run \`pnpm run check:god-files:update\` to record the current sizes, and commit the result.`,
    };
  }

  const regressions = regressionsAgainstBaseline(measured, baseline, NEW_FILE_LIMIT);
  const removed = filesRemovedSinceBaseline(measured, baseline);
  return {
    passed: regressions.length === 0,
    regressions,
    removed,
    measured,
    reported:
      regressions.length > 0
        ? `\nGod-file check failed: ${regressions.length} file(s) grew past their recorded size.\n` +
          `Shrink the file, or lower its entry in ${path.relative(root, baselinePath)} in the same commit that grows it.`
        : `God-file check passed (${files.length} files, ${removed.length} recorded and now absent). ` +
          `Files may shrink or be deleted freely; growth past the recorded size fails.`,
  };
}

/**
One file past a size the ratchet allows.
*/
interface Regression {
  /**
  Path relative to the repository root.
  */
  readonly file: string;
  /**
  Lines it currently has.
  */
  readonly lines: number;
  /**
  Lines it is allowed — its recorded size, or the new-file limit.
  */
  readonly limit: number;
  /**
  Why it is a regression, phrased for the error output.
  */
  readonly reason: string;
}

interface GodFileCheckOptions {
  /**
  Repository root to walk. Defaults to the repository this script lives in.
  */
  root?: string;
  /**
  Where the recorded sizes are read from and written to.
  */
  baselinePath?: string;
  /**
  Record the current sizes instead of checking against them.
  */
  writeBaseline?: boolean;
}

/**
 * Name the largest recorded file, which is the one a reader wants to see after an update.
 *
 * A function because it is only reached on the `--update` path and its `.at(-1)` needs two
 * guards — the list can legitimately be empty in a fresh checkout with nothing but this file.
 */
function describeLargest(sorted: [string, number][]): string {
  const largest = sorted.at(-1);
  if (!largest) return '.';
  return ` (largest ${largest[1]} lines, ${largest[0]}).`;
}

interface GodFileCheckResult {
  /**
  Whether the tree may be committed as it stands.
  */
  passed: boolean;
  /**
  Files past their recorded size, worst first.
  */
  regressions: Regression[];
  /**
  Recorded files that no longer exist — reported, never a failure.
  */
  removed: string[];
  /**
  What the walk measured, keyed by relative path.
  */
  measured: Map<string, number>;
  /**
  The message to print, either way.
  */
  reported: string;
}
