import { defineUnitVitestConfig } from '@rexezuge/tooling/vitest';
import { aliasTable } from './test/helpers/aliases';

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
// percent (statements/branches/functions/lines).
//
// The branch floor is the one left behind, because 80 would sit above the measurement.
// Branch coverage is what moves most when code is added, so a floor a routine PR trips is
// a floor people learn to ignore.
export default defineUnitVitestConfig({
  // No `scope`: the workspace table comes from `test/helpers/aliases.ts`
  // verbatim (anchored root entries plus explicit subpath files — a generated
  // prefix table resolves `.../src/dao` to a directory only by accident of
  // `resolve.extensions`, and the alias-table suite pins the explicit form).
  // The factory still contributes the `cloudflare:*` mocks, `@/` + `~/`, and —
  // load-bearing since the kit arrived — `KIT_NO_EXTERNAL` plus inlined
  // server deps, which keep `@rexezuge/*` inside Vite's pipeline so the
  // `cloudflare:workers` import in the kit's runtime dist resolves to the
  // test mock instead of reaching Node's ESM loader.
  mocks: ['workers', 'workflows'],
  aliases: aliasTable(),
  // A custom `exclude` replaces Vitest's defaults, so `node_modules` must be
  // re-listed: `test` is a workspace project and therefore has its own. Without
  // this, `test/**/*.test.ts` reaches into `test/node_modules` and tries to run
  // other packages' own suites.
  //
  // `*.int.test.ts` is **included**, and there is no second suite.
  include: ['test/**/*.test.{ts,tsx}'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  coverageInclude: ['apps/api/src/**/*.ts', 'apps/background/src/**/*.ts', 'packages/**/src/**/*.ts'],
  coverageExclude: [
    // `packages/backend-errors` is a pure taxonomy shim: one subclass of the
    // kit's `PayloadTooLargeError` carrying a constant type and the message it
    // was constructed with. There is no branching to exercise, so a 0% here
    // measures the file count, not the risk. What is load-bearing — that the
    // refusal reaches the mapper as a 413 — is tested through the suites that
    // throw it. Re-include this package if the shim ever grows a decision.
    'packages/backend-errors/**',
  ],
  thresholds: {
    statements: 89,
    branches: 78,
    functions: 92,
    lines: 92,
  },
  root: new URL('.', import.meta.url).href,
});
