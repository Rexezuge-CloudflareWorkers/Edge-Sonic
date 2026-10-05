#!/usr/bin/env node

/**
 * Writes a placeholder `apps/api/src/generated/spa-shell.ts` when it is absent.
 *
 * `pnpm install` runs this before `typegen` so the API worker typechecks in a
 * fresh clone, where the real file has not been produced by the Vite build yet.
 * Exits immediately when the file already exists, so the real build output is
 * never overwritten. The file is gitignored.
 *
 * `node` and not `tsx`: this runs from `postinstall`, where the dependency tree is
 * still being installed, so it cannot rely on anything having been fetched. It runs
 * under `scripts/package.json`'s `type: module` and Node's own type stripping,
 * which is why a `.ts` file is safe here without a loader.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(here, '..', '..', 'apps', 'api', 'src', 'generated', 'spa-shell.ts');

if (existsSync(outPath)) process.exit(0);

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  `// Auto-generated stub — real content is produced by \`pnpm run build\` via the Vite plugin.
export const SPA_HTML: string = '';
`,
);
console.log(`ensure-spa-shell-stub: created stub at ${outPath}`);
