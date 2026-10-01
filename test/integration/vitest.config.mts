import { defineConfig } from 'vitest/config';
import { aliasTable } from '../helpers/aliases';

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
    // The **same table** as the root config, from `test/helpers/aliases.ts`. This used to
    // be a hand-copied array with a comment saying the two "must be kept in step by hand" —
    // and they had already drifted by two entries, harmless only because neither
    // `.int.test.ts` reaches `apps/background`. The first test that imports
    // `@edge-sonic/background` would have passed here and failed in CI, on a job whose only
    // content is "did CI pass".
    alias: aliasTable(),
  },
});
