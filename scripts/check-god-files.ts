#!/usr/bin/env -S npx tsx
/**
 * Run the god-file ratchet, and exit non-zero when it fails.
 *
 * A thin wrapper over [`lib/godFiles.ts`](./lib/godFiles.ts), for the same reason
 * `verify-migrations.ts` wraps `lock-check.ts`: the rules are pure and belong in a module a test
 * can import, while this file is the entrypoint that turns a verdict into an exit code and prints
 * it.
 *
 * The baseline's path is passed in rather than read from the rules, so `lib/godFiles.ts` does not
 * have to know where it is recorded from — and it is derived from this file rather than from
 * `process.cwd()`, so the gate finds the same baseline whatever directory it is invoked from,
 * which is the difference between a gate and a gate that passes because nobody ran it elsewhere.
 */
import path from 'node:path';
import { runGodFileCheck } from './lib/godFiles';

const REPOSITORY_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

const result = runGodFileCheck({
  root: REPOSITORY_ROOT,
  baselinePath: path.join(REPOSITORY_ROOT, 'scripts', 'god-files.baseline.json'),
  writeBaseline: process.argv.includes('--update'),
});

for (const regression of result.regressions.slice(0, 30)) {
  console.error(`ERROR ${regression.lines} ${regression.file} — ${regression.reason} (limit ${regression.limit})`);
}
console.log(result.reported);

process.exit(result.passed ? 0 : 1);
