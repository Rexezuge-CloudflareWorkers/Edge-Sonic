/**
 * The alias table both Vitest configs resolve `@edge-sonic/*` with.
 *
 * ### Why this is a module and not a duplicated array
 *
 * There were two lists, and the comment said "the two lists must be kept in step by hand
 * anyway". They were **not** in step: the root config had gained `cloudflare:workers` and
 * `@edge-sonic/background`, and the integration config had not. Harmless that day, because
 * neither `.int.test.ts` reaches `apps/background` — so the first test that imports
 * `@edge-sonic/background` would pass in the root suite and fail in CI's integration job
 * with an unresolvable-specifier error, on a task whose only content is "did CI pass".
 *
 * That is this repository's own rule about a comment claiming an invariant nothing
 * measured, in the place where the comment was standing in for the thing itself. A
 * two-element drift is not a near-miss; it is the failure mode, already realised.
 *
 * ### Why the list has both regex and bare-string forms
 *
 * A **string** alias turns `@edge-sonic/backend-runtime/base` into `.../src/base`, and
 * whether that then resolves to `index.ts` depends on `resolve.extensions` — which the
 * Workers pool's own config sets. Naming each subpath with a regex removes that
 * dependency instead of leaving it to a later failure.
 *
 * ### The `@/` alias is deliberately absent
 *
 * `apps/api` uses relative imports because the Workers integration pool bundles the worker
 * with Miniflare, whose resolver knows nothing about tsconfig `paths`. An alias here would
 * pass typecheck and Vite, and fail only in `pnpm run test:integration`.
 */
import { fileURLToPath } from 'node:url';

/**
 * The repository root, as a URL.
 *
 * Derived from **this file's** location — two directories above `test/helpers/` — rather
 * than from a caller-supplied base. A base relative to the importing config is a trap that
 * only fires when the helper moves: `new URL('.', import.meta.url)` inside
 * `test/helpers/aliases.ts` is `test/helpers/`, so every path resolved one directory too
 * deep and every import failed with a confusing "cannot find package".
 */
const REPO_ROOT = new URL('../../', import.meta.url);

/**
 * Absolute path to a file inside the repository.
 *
 * No trailing slash, so `${repoPath('…/src')}index.ts` composes; a directory path is
 * given one at the call site that needs it.
 */
function repoPath(relative: string): string {
  return fileURLToPath(new URL(relative, REPO_ROOT));
}

/**
The subpath exports, named explicitly rather than by prefix rewrite.
*/
const SUBPATH_EXPORTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^@edge-sonic\/backend-data\/dao$/, 'packages/backend-data/src/dao/index.ts'],
  [/^@edge-sonic\/backend-data\/crypto$/, 'packages/backend-data/src/crypto/index.ts'],
  [/^@edge-sonic\/backend-data\/utils$/, 'packages/backend-data/src/utils/index.ts'],
  [/^@edge-sonic\/backend-runtime\/base$/, 'packages/backend-runtime/src/base/index.ts'],
  [/^@edge-sonic\/backend-runtime\/config$/, 'packages/backend-runtime/src/config/index.ts'],
  [/^@edge-sonic\/backend-runtime\/di$/, 'packages/backend-runtime/src/di/index.ts'],
  [/^@edge-sonic\/backend-runtime\/kv$/, 'packages/backend-runtime/src/kv/index.ts'],
  [/^@edge-sonic\/backend-runtime\/logger$/, 'packages/backend-runtime/src/logger.ts'],
  [/^@edge-sonic\/backend-services\/auth$/, 'packages/backend-services/src/auth/index.ts'],
  [/^@edge-sonic\/backend-services\/composition$/, 'packages/backend-services/src/composition/index.ts'],
  [/^@edge-sonic\/backend-services\/errors$/, 'packages/backend-services/src/errors/index.ts'],
  [/^@edge-sonic\/backend-services\/index$/, 'packages/backend-services/src/index/index.ts'],
  [/^@edge-sonic\/backend-services\/library$/, 'packages/backend-services/src/library/index.ts'],
  [/^@edge-sonic\/shared\/utils$/, 'packages/shared/src/utils/index.ts'],
  [/^@edge-sonic\/shared\/i18n$/, 'packages/shared/src/i18n/index.ts'],
  [/^@edge-sonic\/shared\/constants$/, 'packages/shared/src/constants/index.ts'],
];

/**
 * Every aliased specifier and the `src/` directory it resolves to.
 *
 * The root is stated **per entry** rather than assumed to be `packages/`. `background` is
 * the exception — it lives in `apps/`, because it is the Durable Object the API worker's
 * `SCAN` binding names — and an entry that assumed `packages/${name}/src` produced a
 * replacement one tree too deep. That is the whole failure mode of this file: an alias
 * that does not resolve is a startup error in whichever job runs first, so the table has to
 * be readable rather than generated.
 */
const PACKAGE_ROOTS: Readonly<Record<string, string>> = {
  background: 'apps/background/src',
  'backend-data': 'packages/backend-data/src',
  'backend-errors': 'packages/backend-errors/src',
  'backend-runtime': 'packages/backend-runtime/src',
  'backend-services': 'packages/backend-services/src',
  'media-tags': 'packages/media-tags/src',
  shared: 'packages/shared/src',
  subsonic: 'packages/subsonic/src',
  webdav: 'packages/webdav/src',
};

/**
 * Mock for the `cloudflare:workers` module specifier.
 *
 * Listed here rather than in one config because the *other* config is the one that runs
 * `apps/background`. Both need it; a list only one of them has is the drift above.
 */
const CLOUDFLARE_WORKERS_MOCK: { readonly find: string; readonly file: string } = {
  find: 'cloudflare:workers',
  file: 'test/mocks/cloudflare-workers.ts',
};

/**
 * The alias list, resolved against the repository root.
 *
 * The bare-string forms come **after** the anchored regexes deliberately: a string alias
 * matches by prefix, so `@edge-sonic/backend-runtime/di` would be rewritten to
 * `.../src/di` — which happens to be right, but only by accident, and only while
 * `resolve.extensions` still resolves a directory to its `index.ts`.
 */
export function aliasTable(): ReadonlyArray<{ find: string | RegExp; replacement: string }> {
  const table: Array<{ find: string | RegExp; replacement: string }> = [];

  for (const [name, root] of Object.entries(PACKAGE_ROOTS)) {
    table.push({ find: new RegExp(`^@edge-sonic/${name}$`), replacement: `${repoPath(`${root}/`)}index.ts` });
  }
  table.push({ find: CLOUDFLARE_WORKERS_MOCK.find, replacement: repoPath(CLOUDFLARE_WORKERS_MOCK.file) });
  for (const [name, root] of Object.entries(PACKAGE_ROOTS)) {
    table.push({ find: `@edge-sonic/${name}`, replacement: `${repoPath(`${root}/`)}/` });
  }
  for (const [pattern, file] of SUBPATH_EXPORTS) {
    table.push({ find: pattern, replacement: repoPath(file) });
  }
  return table;
}