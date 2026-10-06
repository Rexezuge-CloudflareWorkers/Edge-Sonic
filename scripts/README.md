# scripts/

Repo tooling, grouped by **who runs it**. Every script is TypeScript except
`check-god-files.mjs`, and all of them are covered by `pnpm run lint` and
`pnpm run typecheck:scripts`.

| Directory     | Runs from             | Purpose                                                                              |
| ------------- | --------------------- | ------------------------------------------------------------------------------------ |
| `lib/`        | imported              | Reusable helpers. No side effects on import.                                          |
| `build/`      | `pnpm install`, CI    | Keeps a fresh clone typecheckable, and checks the built shell before it is deployed. |
| `deploy/`     | `deploy-worker` job   | Materialize `wrangler.jsonc` and provision its resources and secrets.                 |
| `i18n/`       | a human, or CI        | Web locale validation (also in `pnpm run checks` and the `locales` CI job).           |
| `migrations/` | a human, or CI        | The migration checksum lock. See `../docs/agents/indexing/AGENTS.md`.                 |
| `backup/`     | `backup-d1` job       | Export, encrypt, upload and prune the nightly dump. The preflight fails a configured
  destination with no `BACKUP_ENCRYPTION_KEY`. See `../docs/db-backup-recovery.md`.          |

`check-god-files.mjs` and `compare-reference.ts` sit at the root: the first is run by
`node` from three places and has no siblings, the second is an operator tool for
comparing this server's answers against a reference Subsonic deployment.

## Entrypoint vs module convention

- An **entrypoint** starts with `#!`, runs at top level, and exports nothing.
  `unicorn/no-exports-in-scripts` fires only on files whose first line is `#!`, so
  keeping exports out of entrypoints is what lets these files be linted at all.
- A **module** has no `#!` and exports freely. Testable guards and shared helpers live
  here, and are imported by both the entrypoint and `test/scripts/`.

`prepare-wrangler-config.ts` is the clearest example: it is five ordered calls into
`lib/wrangler-config/` and has nothing else in it.

## `lib/`

| Module                         | Contents                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `wrangler-config/types.ts`     | `wrangler.jsonc` paths, placeholder ids (`DEFAULT_UUID`, `DEFAULT_HEX_ID`), config interfaces.        |
| `wrangler-config/cli.ts`       | `runWrangler`, `parseJsonArray`.                                                                      |
| `wrangler-config/patches.ts`   | Read/rewrite `wrangler.jsonc`; `WRANGLER_JSONC` / `WRANGLER_PATCH_JSON` / `WRANGLER_VARS_PATCH_JSON`. |
| `wrangler-config/resources.ts` | Create missing D1 / KV / Queues / Vectorize / Secrets Store resources and patch their ids in.           |
| `wrangler-table.ts`            | Parses the `cli-table3` output `wrangler` prints for `secrets-store …`.                                 |
| `github-actions.ts`            | `setOutput`, `logError`, `fail`. No `@actions/*` dependency, so scripts stay runnable locally.        |
| `cli-args.ts`                  | Flag parsing, for scripts that take flags.                                                             |

`DEFAULT_UUID` is the single definition of the placeholder D1 id. `deploy/` writes a real
id over it, and the backup workflow's `resolve-d1-target.ts` refuses to export while it
is still present, so the empty-database guard cannot drift from what provisioning emits.

`wrangler-table.ts` exists because `wrangler secrets-store …` renders through
`cli-table3`, which draws a box frame and pads cells with U+2502 rather than aligning
them with spaces. A parser written for aligned output matches nothing, and "matched
nothing" reads as "the resource does not exist" — which for a store id means creating a
duplicate.

## Running one locally

CI entrypoints are runnable from a local shell with the same flags Actions uses:

```bash
pnpm run check:god-files
pnpm run validate:locales
pnpm run validate:migrations
pnpm exec tsx scripts/deploy/prepare-wrangler-config.ts
```

After adding a migration, `pnpm run migrations:lock` records it. It is add-only for
incremental migrations and refreshes the squashed baseline, so it will not adopt the new
digest of one that has already been applied — and there is no `--force`, deliberately: a
`--write` that could bless a drift would be the operator blessing their own edit, and
they are by definition the one making it.

`validate:migrations` and `validate:locales` both run from `pnpm run checks` and from
their own CI jobs, so the local gate and CI agree.

**`tsx` vs `node`.** An entrypoint that imports a sibling module must run under `tsx`:
each import is extensionless, and Node's ESM resolver will not resolve one.
`ensure-spa-shell-stub.ts` is the exception — it imports nothing, and it runs from
`postinstall` where the dependency tree is still being installed, so it cannot rely on a
loader having been fetched. It runs under `scripts/package.json`'s `type: module` and
Node's own type stripping.

There is no committed `wrangler.jsonc` in a deployment. `deploy/prepare-wrangler-config.ts`
creates it, and both `deploy/` and the backup workflow expect it to exist. The committed
root `wrangler.jsonc` is local development only and carries a `DEV_AUTH_EMAIL` bypass
plus the two raw placeholder ids.

## Adding a script

1. Put pure logic in a module next to the entrypoint, or in `lib/` if more than one
   script needs it.
2. Give the entrypoint a `#!` and no exports.
3. Cover the module with a test in `test/scripts/`, and **check the guard can fail** —
   see below.
4. Export nothing that only the entrypoint needs. If a test needs it, that is a signal
   the logic belongs in the module.

## A check that cannot fail is not a check

Every rule in `i18n/` and `migrations/` has a paired test that runs the comparison
against a value that is *wrong*, and asserts the finding names the file or key it is
about. The reason is not theoretical: `locale-checks.ts`'s parser shipped two broken
shapes while this directory was being laid out, and **neither was caught by a test**,
because the parser had no test.

- A shared `[^\\]` character class matches a string literal's own closing quote, so the
  capture ran past its terminator and returned pages of source as a "default".
- Excluding `'` as well fixed that and broke the reverse case — a double-quoted default
  containing an unescaped apostrophe — and that failure is the worse one, because the
  affected call site simply stopped being checked.

Both are now pinned, along with a third found by a test written afterwards: a default
matched by searching forward rather than at the position the key ended at picks up a
*later* call's comma and default. If you add a rule, add the case that makes it go red.