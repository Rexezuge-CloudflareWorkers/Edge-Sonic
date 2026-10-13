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
 * - `prettier/prettier` stays a **warning**: `format:check` is the failing
 *   gate, and `lint --fix --quiet` must repair rather than fail. The plugin
 *   itself is no longer registered here — the kit's factory ships it from
 *   v1.6.0, and registering the same plugin twice is a `ConfigError`.
 * - `sonarjs/cognitive-complexity` stays an **error**: it was a warning once
 *   and the improvement never arrived, because `lint` runs `--quiet`.
 * - `react-hooks` for `apps/web`: the kit stays JSX-free by design, so the
 *   plugin belongs to the app (four lines, per the kit README).
 * - Three rules the family table does not switch off: `unicorn/no-useless-undefined`,
 *   `unicorn/no-array-from-fill` and `sonarjs/super-linear-regex` (the tag
 *   readers' field patterns run over a bounded prefix read, never over a
 *   request parameter).
 * - The five family offs this repo used to re-assert (`sonarjs/void-use`,
 *   `sonarjs/different-types-comparison`, `sonarjs/use-type-alias`,
 *   `sonarjs/redundant-type-aliases`, `sonarjs/no-nested-assignment`) are gone.
 *   They worked around an ordering bug in `defineRepoLintConfig` that the kit
 *   fixed in v1.5.1, and carrying the workaround past the fix would read as a
 *   live decision rather than the tombstone it is.
 */
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

  // --- Gate severities this repo holds differently from the family table ---
  {
    rules: {
      // The kit's factory registers `eslint-plugin-prettier` itself and makes this
      // rule an **error**; the family README argues that a warning is a silent
      // no-op. This repo disagrees on purpose: `lint` runs `--fix --quiet`, so an
      // error here fails a repair pass instead of repairing, while `format:check`
      // is the gate that actually fails. The plugin is therefore *not*
      // re-registered here — at v1.3.0 the factory omitted it and this block had
      // to; from v1.6.0 it ships, and re-registering the same plugin is a
      // `ConfigError`.
      'prettier/prettier': 'warn',
      // An error here, where the family leaves it a warning: `lint --quiet`
      // reports errors only, so a warning against a 500-line scan-budget function
      // was never reported and never improved.
      'sonarjs/cognitive-complexity': ['error', 20],
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

  // --- Family offs ---
  //
  // These five were re-asserted here to work around a bug in
  // `defineRepoLintConfig`: the kit's `UNICORN_RULES` block was assembled
  // *before* the sonarjs `recommended` preset, so the preset re-enabled them
  // and every consumer had to carry the workaround. The kit fixed the ordering
  // in v1.5.1 (`FIX(tooling): Assemble Both Presets Before The Family Off-Blocks`),
  // so re-asserting them now would be cargo-culting a workaround for a defect
  // that no longer exists — and the block would read as a live decision when it
  // is a tombstone.
  //
  // They stay **off** rather than being deleted from the family's intent: the kit
  // lists each of them in its own `UNICORN_RULES` with a reason, and this repo
  // agrees with those reasons. What is deleted is the *ordering* claim.
];

export default [...config, ...repoDeltas];
