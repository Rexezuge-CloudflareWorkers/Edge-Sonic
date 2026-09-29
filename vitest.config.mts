import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to a package's `src` directory, **with a trailing slash**.
 *
 * `fileURLToPath(new URL('packages/x/src', base))` has no trailing slash, so
 * `${path}index.ts` silently becomes `srcindex.ts` and every aliased import fails
 * to resolve with a confusing "cannot find package" error.
 */
const srcPath = (pkg: string) => `${fileURLToPath(new URL(pkg, import.meta.url))}/`;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    // A custom `exclude` replaces Vitest's defaults, so `node_modules` must be
    // re-listed: `test` is a workspace project and therefore has its own. Without
    // this, `test/**/*.test.ts` reaches into `test/node_modules` and tries to run
    // other packages' own suites.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['apps/api/src/**/*.ts', 'packages/**/src/**/*.ts'],
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
        // Set from a measurement of 80/67/82/83 (statements/branches/functions/lines).
        // The branch floor is the closest to its measured value because branch coverage
        // is the one that moves most when code is added, and a floor that a routine PR
        // trips is a floor people learn to ignore.
        //
        // Raised from 78/65/79/80, which was the previous *measured* value rather than a
        // number chosen to be comfortable. The probe-diagnosis change added classified
        // failure paths that are each asserted, and a floor left where it was would have
        // stopped the gate from noticing the difference.
        statements: 79,
        branches: 66,
        functions: 81,
        lines: 82,
      },
    },
  },
  resolve: {
    alias: [
      { find: /^@edge-sonic\/backend-data$/, replacement: `${srcPath('packages/backend-data/src')}index.ts` },
      { find: /^@edge-sonic\/backend-errors$/, replacement: `${srcPath('packages/backend-errors/src')}index.ts` },
      { find: /^@edge-sonic\/backend-runtime$/, replacement: `${srcPath('packages/backend-runtime/src')}index.ts` },
      { find: /^@edge-sonic\/backend-services$/, replacement: `${srcPath('packages/backend-services/src')}index.ts` },
      { find: /^@edge-sonic\/subsonic$/, replacement: `${srcPath('packages/subsonic/src')}index.ts` },
      { find: /^@edge-sonic\/media-tags$/, replacement: `${srcPath('packages/media-tags/src')}index.ts` },
      { find: /^@edge-sonic\/webdav$/, replacement: `${srcPath('packages/webdav/src')}index.ts` },
      { find: /^@edge-sonic\/shared$/, replacement: `${srcPath('packages/shared/src')}index.ts` },
      { find: '@edge-sonic/backend-data', replacement: srcPath('packages/backend-data/src') },
      { find: '@edge-sonic/backend-errors', replacement: srcPath('packages/backend-errors/src') },
      { find: '@edge-sonic/backend-runtime', replacement: srcPath('packages/backend-runtime/src') },
      { find: '@edge-sonic/backend-services', replacement: srcPath('packages/backend-services/src') },
      { find: '@edge-sonic/subsonic', replacement: srcPath('packages/subsonic/src') },
      { find: '@edge-sonic/media-tags', replacement: srcPath('packages/media-tags/src') },
      { find: '@edge-sonic/webdav', replacement: srcPath('packages/webdav/src') },
      { find: '@edge-sonic/shared', replacement: srcPath('packages/shared/src') },

      // Subpath exports are listed explicitly rather than relying on a prefix rewrite.
      // A string alias turns `@edge-sonic/backend-runtime/base` into
      // `.../src/base`, and whether that then resolves to `index.ts` depends on
      // `resolve.extensions` — which the Workers pool's own config sets. Naming each
      // subpath removes that dependency instead of leaving it to a later failure.
      { find: /^@edge-sonic\/backend-data\/dao$/, replacement: `${srcPath('packages/backend-data/src')}dao/index.ts` },
      { find: /^@edge-sonic\/backend-data\/crypto$/, replacement: `${srcPath('packages/backend-data/src')}crypto/index.ts` },
      { find: /^@edge-sonic\/backend-data\/utils$/, replacement: `${srcPath('packages/backend-data/src')}utils/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/base$/, replacement: `${srcPath('packages/backend-runtime/src')}base/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/config$/, replacement: `${srcPath('packages/backend-runtime/src')}config/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/di$/, replacement: `${srcPath('packages/backend-runtime/src')}di/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/kv$/, replacement: `${srcPath('packages/backend-runtime/src')}kv/index.ts` },
      { find: /^@edge-sonic\/backend-runtime\/logger$/, replacement: `${srcPath('packages/backend-runtime/src')}logger.ts` },
      { find: /^@edge-sonic\/backend-services\/auth$/, replacement: `${srcPath('packages/backend-services/src')}auth/index.ts` },
      { find: /^@edge-sonic\/backend-services\/composition$/, replacement: `${srcPath('packages/backend-services/src')}composition/index.ts` },
      { find: /^@edge-sonic\/backend-services\/errors$/, replacement: `${srcPath('packages/backend-services/src')}errors/index.ts` },
      { find: /^@edge-sonic\/backend-services\/index$/, replacement: `${srcPath('packages/backend-services/src')}index/index.ts` },
      { find: /^@edge-sonic\/backend-services\/library$/, replacement: `${srcPath('packages/backend-services/src')}library/index.ts` },
      { find: /^@edge-sonic\/shared\/utils$/, replacement: `${srcPath('packages/shared/src')}utils/index.ts` },
      { find: /^@edge-sonic\/shared\/i18n$/, replacement: `${srcPath('packages/shared/src')}i18n/index.ts` },
      { find: /^@edge-sonic\/shared\/constants$/, replacement: `${srcPath('packages/shared/src')}constants/index.ts` },
      // The `@/` alias is deliberately absent. `apps/api` uses relative imports
      // because the Workers integration pool bundles the worker with Miniflare,
      // whose resolver knows nothing about tsconfig `paths` — an alias here would
      // pass typecheck and Vite, and fail only in `pnpm run test:integration`.
    ],
  },
});
