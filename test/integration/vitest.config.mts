import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to a package's `src` directory, **with a trailing slash**.
 *
 * Paths here are relative to this file (`test/integration/`), so each one climbs
 * two levels to the repo root before descending again. `fileURLToPath` drops the
 * trailing slash, which would turn `${path}index.ts` into `srcindex.ts`.
 */
const srcPath = (pkg: string) => `${fileURLToPath(new URL(pkg, import.meta.url))}/`;

/**
 * The integration suite: `test/helpers/harness.ts` drives the real
 * `EdgeSonicWorker` through its own `fetch` over a real D1 (`node:sqlite`) and a
 * doubled KV and WebDAV origin.
 *
 * ## Why this is a separate config, and not the Workers integration pool
 *
 * `@cloudflare/vitest-pool-workers` builds the worker with Miniflare, whose module
 * locator resolves a bare specifier in its *entry* file and not one reached through
 * a relative import. A monorepo worker and a monorepo's tests therefore both fail to
 * load with "Cannot find package" for packages that resolve under `tsc`, under Vite,
 * and under `esbuild` alike. It was tried and removed; see
 * `docs/agents/testing/AGENTS.md`.
 *
 * ## Why it runs under the plain Node pool
 *
 * Because nothing here needs workerd, the same `.int.test.ts` files run green in the
 * root suite. So this config is not a *different* run of the same tests — it is the
 * same tests, scoped and named, so the integration job reports its own pass/fail
 * instead of a copy of the unit job's.
 *
 * ## Why the root suite still includes these files
 *
 * The root config's include glob (every `.test.ts` under `test`)
 * matches `*.int.test.ts` too, and these two files are the only coverage of
 * the worker's composition and the DAOs' SQL. Excluding them drops the root suite to
 * 70.58/60.79/68.66/73.29 against thresholds of 78/65/79/80 — the gate would fail
 * on all four. So they run in both, and the coverage floor stays a single honest
 * number. `pnpm run test:coverage` is the gate; this is the integration signal.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.int.test.ts'],
    // A custom `exclude` replaces Vitest's defaults, so `node_modules` must be
    // re-listed: `test` is a workspace project and therefore has its own.
    exclude: ['**/node_modules/**', '**/dist/**'],
    // No coverage thresholds here, deliberately. The coverage floor belongs to the
    // root suite, which is the one that runs every file; a second set of numbers
    // measured over two files would be a floor nobody acts on.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage-integration',
    },
  },
  resolve: {
    // Identical to the root config. `srcPath` is duplicated rather than imported so
    // this config stays readable on its own; a shared helper would mean a second
    // file whose only job is eleven aliases, and the two lists must be kept in step
    // by hand anyway.
    alias: [
      { find: /^@edge-sonic\/backend-data$/, replacement: `${srcPath('../../packages/backend-data/src')}index.ts` },
      { find: /^@edge-sonic\/backend-errors$/, replacement: `${srcPath('../../packages/backend-errors/src')}index.ts` },
      { find: /^@edge-sonic\/backend-runtime$/, replacement: `${srcPath('../../packages/backend-runtime/src')}index.ts` },
      { find: /^@edge-sonic\/backend-services$/, replacement: `${srcPath('../../packages/backend-services/src')}index.ts` },
      { find: /^@edge-sonic\/subsonic$/, replacement: `${srcPath('../../packages/subsonic/src')}index.ts` },
      { find: /^@edge-sonic\/media-tags$/, replacement: `${srcPath('../../packages/media-tags/src')}index.ts` },
      { find: /^@edge-sonic\/webdav$/, replacement: `${srcPath('../../packages/webdav/src')}index.ts` },
      { find: /^@edge-sonic\/shared$/, replacement: `${srcPath('../../packages/shared/src')}index.ts` },
      { find: '@edge-sonic/backend-data', replacement: srcPath('../../packages/backend-data/src') },
      { find: '@edge-sonic/backend-errors', replacement: srcPath('../../packages/backend-errors/src') },
      { find: '@edge-sonic/backend-runtime', replacement: srcPath('../../packages/backend-runtime/src') },
      { find: '@edge-sonic/backend-services', replacement: srcPath('../../packages/backend-services/src') },
      { find: '@edge-sonic/subsonic', replacement: srcPath('../../packages/subsonic/src') },
      { find: '@edge-sonic/media-tags', replacement: srcPath('../../packages/media-tags/src') },
      { find: '@edge-sonic/webdav', replacement: srcPath('../../packages/webdav/src') },
      { find: '@edge-sonic/shared', replacement: srcPath('../../packages/shared/src') },
      { find: /^@edge-sonic\/backend-data\/dao$/, replacement: `${srcPath('../../packages/backend-data/src')}dao/index.ts` },
      { find: /^@edge-sonic\/backend-data\/crypto$/, replacement: `${srcPath('../../packages/backend-data/src')}crypto/index.ts` },
      { find: /^@edge-sonic\/backend-data\/utils$/, replacement: `${srcPath('../../packages/backend-data/src')}utils/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/base$/, replacement: `${srcPath('../../packages/backend-runtime/src')}base/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/config$/, replacement: `${srcPath('../../packages/backend-runtime/src')}config/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/di$/, replacement: `${srcPath('../../packages/backend-runtime/src')}di/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/kv$/, replacement: `${srcPath('../../packages/backend-runtime/src')}kv/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/logger$/, replacement: `${srcPath('../../packages/backend-runtime/src')}logger.ts` },
      { find: /^@edge-sonic\/backend-services\/auth$/, replacement: `${srcPath('../../packages/backend-services/src')}auth/index.ts` },
      { find: /^@edge-sonic\/backend-services\/composition$/, replacement: `${srcPath('../../packages/backend-services/src')}composition/index.ts` },
      { find: /^@edge-sonic\/backend-services\/errors$/, replacement: `${srcPath('../../packages/backend-services/src')}errors/index.ts` },
      { find: /^@edge-sonic\/backend-services\/index$/, replacement: `${srcPath('../../packages/backend-services/src')}index/index.ts` },
      { find: /^@edge-sonic\/backend-services\/library$/, replacement: `${srcPath('../../packages/backend-services/src')}library/index.ts` },
      { find: /^@edge-sonic\/shared\/utils$/, replacement: `${srcPath('../../packages/shared/src')}utils/index.ts` },
      { find: /^@edge-sonic\/shared\/i18n$/, replacement: `${srcPath('../../packages/shared/src')}i18n/index.ts` },
      { find: /^@edge-sonic\/shared\/constants$/, replacement: `${srcPath('../../packages/shared/src')}constants/index.ts` },
    ],
  },
});
