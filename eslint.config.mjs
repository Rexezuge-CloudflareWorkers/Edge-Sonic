/**
 * The repo lint config, assembled from the kit factory plus this repo's deltas.
 *
 * `defineRepoLintConfig` (from `@rexezuge/tooling`) owns the plugin set, the
 * layered `no-restricted-imports` boundary table (the family superset — a repo
 * without a domain package never triggers its ban) and the dynamic-`import()`
 * guard generated from the same table. The blocks below are only what this
 * repo holds differently, each with its reason:
 * - `scripts/**` re-included: the factory ignores it, and ~500 KB of tooling
 *   was never linted once before this repo covered it.
 * - `sonarjs/cognitive-complexity` stays an **error**: it was a warning once
 *   and the improvement never arrived, because `lint` runs `--quiet`.
 * - `prettier/prettier` stays a **warning**: `format:check` is the failing
 *   gate, and `lint --fix --quiet` must repair rather than fail.
 * - `react-hooks` for `apps/web`: the kit stays JSX-free by design, so the
 *   plugin belongs to the app (four lines, per the kit README).
 * - Three rules the family table does not switch off: `unicorn/no-useless-undefined`,
 *   `unicorn/no-array-from-fill` and `sonarjs/super-linear-regex` (the tag
 *   readers' field patterns run over a bounded prefix read, never over a
 *   request parameter).
 * - Five family offs the factory's ordering re-enables (`sonarjs/void-use`,
 *   `sonarjs/different-types-comparison`, `sonarjs/use-type-alias`,
 *   `sonarjs/redundant-type-aliases`, `sonarjs/no-nested-assignment`): the kit
 *   lists them as off before its own sonarjs preset, so the preset wins;
 *   re-asserted after the factory.
 */
import prettier from 'eslint-plugin-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineRepoLintConfig } from '@rexezuge/tooling/eslint';

const config = defineRepoLintConfig({ scope: '@edge-sonic' });

const repoDeltas = [
  // Re-include what the factory ignores: `scripts/` is linted here, like the
  // rest of the workspace.
  {
    ignores: ['!scripts/**'],
  },

  // --- React Hooks: rules of hooks for the SPA ---
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },

  // --- Gates this repo holds differently from the family table ---
  {
    rules: {
      'sonarjs/cognitive-complexity': ['error', 20],
    },
  },
  {
    plugins: { prettier },
    rules: {
      'prettier/prettier': 'warn',
    },
  },

  // --- Rules the family table does not switch off ---
  {
    rules: {
      // Template literals throughout the codebase are fine as-is.
      'unicorn/no-useless-undefined': 'off',
      // `Array.from({ length: n }, ...)` over a manual loop: the loops are
      // clearer where the index is used for more than one field.
      'unicorn/no-array-from-fill': 'off',
      // Backtracking risk in the tag readers' field patterns. They run over a
      // bounded prefix read of a file the server chose to fetch, never over a
      // request parameter, and they mirror how the format lays the fields out.
      'sonarjs/super-linear-regex': 'off',
    },
  },

  // --- Family offs the factory's own ordering re-enables ---
  //
  // The kit lists these as off in `UNICORN_RULES`, but that block is assembled
  // *before* the sonarjs `recommended` preset, so the preset re-enables the
  // four `sonarjs/*` entries. Re-asserted here, after the factory, so the
  // family's decisions hold. Each matches the reason the kit gives beside its
  // own entry.
  {
    rules: {
      // `void promise` where initiating the call is the point and the rejection
      // is handled at a named site elsewhere.
      'sonarjs/void-use': 'off',
      // `x === undefined` guards under `noUncheckedIndexedAccess`, and narrow
      // unions the rule cannot see through — each site is exactly right.
      'sonarjs/different-types-comparison': 'off',
      // A `type` alias over an inline union, where the name is what makes the
      // signature and its doc comment readable.
      'sonarjs/use-type-alias': 'off',
      // A short local alias for a type imported from another package; spelling
      // it out at each use is clearer than a renamed local type.
      'sonarjs/redundant-type-aliases': 'off',
      // An assignment nested in a fixture expression (the scan-budget mtime
      // ladder), where extracting it would separate the increment from the row
      // it stamps.
      'sonarjs/no-nested-assignment': 'off',
    },
  },
];

export default [...config, ...repoDeltas];
