#!/usr/bin/env node

/**
 * Write the empty `spa-shell.ts` placeholder a fresh clone needs, so `postinstall`
 * succeeds and a worker with no SPA build still answers `/` instead of failing to
 * import. The rules are `@rexezuge/tooling`'s `ensureSpaShellStub`; an existing
 * file is left untouched, because a real build's output must never be clobbered by
 * the stub that stands in for one.
 */
import { ensureSpaShellStub } from '@rexezuge/tooling/scripts/spa-shell';

const result = ensureSpaShellStub({ root: process.cwd() });

if (result.created) {
  console.log(`ensure-spa-shell-stub: created stub at ${result.path}`);
} else {
  console.log(`ensure-spa-shell-stub: ${result.path} already present, left untouched`);
}
