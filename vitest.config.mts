import { defineConfig } from 'vitest/config';
import { aliasTable } from './test/helpers/aliases';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // A custom `exclude` replaces Vitest's defaults, so `node_modules` must be
    // re-listed: `test` is a workspace project and therefore has its own. Without
    // this, `test/**/*.test.ts` reaches into `test/node_modules` and tries to run
    // other packages' own suites.
    //
    // `*.int.test.ts` is **included**, and there is no second suite.
    //
    // There were two: `vitest.config.mts` and `test/integration/vitest.config.mts`, and the
    // three `*.int.test.ts` files matched `include` in **both** — 221 tests run twice, in two CI
    // jobs. The second config's own comment conceded the point: *"the coverage floor belongs to
    // the root suite, which is the one that runs every file"* — while its `exclude` listed
    // `test/integration/**`, which matched that *directory* and so excluded nothing at all, the
    // files being at `test/` root.
    //
    // Excluding them here instead fixed the double run and **cost 1.35 points of statements**
    // (89.88 → 88.53, below the floor) because those 221 tests were carrying real coverage — the
    // schema suite alone is 4,388 lines of assertions over the SQL layer. A green measurement of
    // a subset is not a better measurement; it is a smaller one. So the duplicate suite is gone:
    // one suite, every file once, and the one that enforces the floor.
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['apps/api/src/**/*.ts', 'apps/background/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        '**/index.ts',
        '**/types.d.ts',
        '**/model/**',
        // Generated at build time from the Vite bundle: a one-line HTML blob with
        // no logic to exercise.
        'apps/api/src/generated/**',
        // Type-only modules: no runtime code to cover.
        '**/D1Types.ts',
        '**/ServiceEnv.ts',
        '**/env.d.ts',
        // `packages/backend-errors` is a pure taxonomy: an abstract base plus one
        // subclass per HTTP status, each of which only returns a constant code, a
        // constant type name, and the message it was constructed with. There is no
        // branching to exercise, so a 0% here measures the file count, not the risk.
        //
        // What is actually load-bearing about these classes — that a 5xx is masked and
        // a 4xx is not, that a `NotFoundError` becomes Subsonic `code=70` and an
        // `UnauthorizedError` never becomes `code=40` — is the *mapping out of* them,
        // and that is tested in `test/enrichment-config.test.ts`. Re-include this
        // package if any of these classes ever grows a decision.
        'packages/backend-errors/**',
      ],
      thresholds: {
        // Thresholds are a MEASURED floor, not an aspiration. Lower one to make CI
        // green and the gate stops saying anything.
        //
        // `apps/web` is deliberately NOT in `include` for v1. The reference project
        // added it on a comment claiming a vitest config in `apps/web` that never
        // existed; the entire SPA was then invisible, and the floor quietly dropped
        // from 80 to 64 with 44 presentational modules at 0%. Publishing a number
        // that is mostly untested UI is worse than saying "not measured yet" — so
        // it is excluded here, visibly, and re-including it is meant to be a
        // deliberate act once the components have tests.
        //
        // Raise these as coverage grows. Never lower them to excuse a regression in
        // code that is already covered.
        //
        // Set from a measurement of 90.40/79.70/93.69/93.34, floored to whole
        // percent (statements/branches/functions/lines). The previous recorded measurement,
        // 89.62/79.08/92.46/92.74, was **stale in both files** that quote it — this one and
        // `docs/agents/testing/AGENTS.md` — by a margin small enough that nobody noticed and
        // large enough that both were wrong, which is the recorded failure of this repository
        // applied to its own coverage numbers.
        //
        // Two things moved it. Dead code went: 21 exports with no caller, the whole
        // `D1Utils` retry classification inlined into its caller, and `runPlayCountPagePhase`.
        // Tests arrived for what nothing reached: the XML parser's own refusals, the
        // configuration validator's whole report, the metadata bucket key, the Pages proxy, and
        // the per-library lookup's cost.
        //
        // The branch floor is the one left behind, because 80 would sit above the measurement.
        // Branch coverage is what moves most when code is added, so a floor a routine PR trips is
        // a floor people learn to ignore.
        //
        // Raised from 78/65/79/80, then 79/66/81/82, then 85/73/90/89 — each the previous
        // *measured* value rather than numbers chosen to be comfortable. The 85/73/90/89
        // step was the largest, and most of it came from **deleting** code: `Container`'s
        // factory tier, `Provider`, `memoizeAsync`, ten orphaned DAO methods and
        // `UpdateClause` were all uncovered, and removing them removed their statements
        // from the denominator. This step is the same shape on a smaller scale: a dead
        // constant, its duplicate, and three declared dependencies nothing imported. That
        // is the intended way for this number to move — a floor that has to be *lowered*
        // to admit code that nobody calls is a floor measuring the wrong thing. The floors
        // are whole percentages *below* the measurement rather than rounded to it, so a
        // tenth of a point of jitter does not turn the gate red.
        statements: 89,
        branches: 78,
        functions: 92,
        lines: 92,
      },
    },
  },
  resolve: {
    // One table, shared with `test/integration/vitest.config.mts` — see
    // `test/helpers/aliases.ts` for why the two are no longer maintained by hand.
    alias: aliasTable(),
  },
});
