#!/usr/bin/env node

/**
 * Fail when the SPA shell the API worker serves is missing or self-inconsistent.
 *
 * The rules are `@rexezuge/tooling`'s `verifySpaShell`, converged from this
 * file's three-module split plus Durable-DAV's `mjs` pair. What it catches and its
 * one known limit are unchanged:
 *
 * - the `postinstall` stub (or no build at all) still in place;
 * - `spa-shell.ts` referencing `/assets/...` bundles that were not emitted (a
 *   partially cleaned or half-copied `dist/`, which serves a shell whose JS 404s
 *   and therefore renders no operator UI at all);
 * - `spa-shell.ts` and `apps/web/dist/index.html` disagreeing, i.e. only one of the
 *   two halves of the build was refreshed.
 *
 * **Known limit, deliberately stated rather than papered over:** this cannot detect
 * a *stale but self-consistent* pair. A `dist/` and a `spa-shell.ts` built together
 * from last week's source agree with each other, and that is precisely the failure
 * this script was added after — the checked-in bundle was scaffolded from another
 * repository's build and predated every change to `apps/web/src`. That class is
 * covered at the source level by `test/web-davxml.test.ts` and
 * `test/web-davclient.test.ts`. The remaining duty is operational: run
 * `pnpm run build` after touching `apps/web`, before `wrangler deploy`.
 *
 * **The build is a precondition of this check, not a convenience.** Both paths are
 * gitignored and `postinstall` writes a deliberately empty stub, so verifying
 * without building cannot pass.
 */
import { verifySpaShell } from '@rexezuge/tooling/scripts/spa-shell';

const { problems } = verifySpaShell({ root: process.cwd() });

if (problems.length > 0) {
  console.error('SPA shell check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('SPA shell check passed (apps/api/src/generated/spa-shell.ts matches apps/web/dist).');
