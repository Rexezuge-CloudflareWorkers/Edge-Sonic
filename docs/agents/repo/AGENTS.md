# Edge-Sonic — Working In This Repository

Scope: the workspace layout, the commands, the layer rules, and the gates a change has to
pass. Parent index: `../../../AGENTS.md`.

Nothing here is a design decision — those live in the area guides. This is the mechanical
part: what exists, what runs it, and what refuses to merge.

## The workspace

`pnpm-workspace.yaml` globs `apps/*`, `packages/*`, and `test`. That is **12 projects**:

| Layer | Projects | May import |
| --- | --- | --- |
| 0 | `shared`, `backend-errors`, `subsonic`, `media-tags`, `webdav` | nothing |
| 1 | `backend-runtime` | layer 0 |
| 2 | `backend-data` | layer 0 |
| 3 | `backend-services` | layers 0–2, never `apps/*` |
| app | `background` | layers 0–3, never `apps/api` |
| app | `api` | layers 0–3 + `background`; `backend-data` **types only** |
| app | `web` | the browser |

Enforced by `no-restricted-imports` in `eslint.config.mjs`, not by convention — and the
enforcement has gaps worth knowing: there is **no** layer block for `subsonic` or
`media-tags`, and `apps/api`'s `backend-data` block sets `allowTypeImports: true`, which is
the one permitted value import. `apps/web` now has the block the table implies — it bans every `@edge-sonic/*`
import, which the SPA's zero-backend-dependency rule previously was by convention
only.

**`scripts/` and `functions/` are not workspace packages.** `pnpm run typecheck` reaches them
through `typecheck:scripts` and `typecheck:functions`, so a new directory there needs its
own script or nothing checks it at all. `functions/` is a deployed Cloudflare Pages
entrypoint whose `service` binding is the one place the two wrangler templates are coupled,
which is why it needed a tsconfig of its own.

`test/` **is** a workspace project, so `pnpm -r typecheck` and `pnpm run lint` both reach it.
It has its own `node_modules`, which is why both Vitest configs re-list
`**/node_modules/**` in `exclude` — a custom `exclude` replaces Vitest's defaults.

## Commands

```bash
pnpm install --ignore-scripts
pnpm run checks          # checks:fast, then coverage, then integration
pnpm run checks:fast     # typecheck + lint + god-files + migrations + locales + SPA shell
pnpm run typecheck       # -r, plus scripts/ and functions/
pnpm run lint            # eslint --fix --quiet
pnpm run check:god-files # 300 warn / 400 error
pnpm run validate:migrations   # read-only; refuses an edited or unlocked migration
pnpm run migrations:lock       # records a NEW migration; never re-hashes an applied one
pnpm run validate:locales
pnpm run verify:spa-shell      # needs `pnpm run build` first
pnpm run test
pnpm run test:coverage   # with the coverage gate
pnpm run test:integration
pnpm run build           # apps/web -> apps/api/src/generated/spa-shell.ts
pnpm run typegen         # wrangler types from the template
pnpm exec wrangler dev
```

`pnpm run build` resolves to exactly one thing — `apps/web`'s `vite build` — so `pnpm -r build`
running "successfully" can still mean the artifact is a stale stub. `verify:spa-shell` is the
check for that, and it is in `checks:fast`.

No package has a `test` script. Every test runs from the root, through one of three Vitest
configs: the main one, `--coverage`, and `test/integration/vitest.config.mts`. Only the
integration config has no thresholds, deliberately.

## The gates

**Coverage floors are `89 / 78 / 92 / 92`** (statements / branches / functions / lines),
against a measured 89.62 / 79.08 / 92.46 / 92.74. They are a **measured** floor: lower one
to make CI green and the gate stops saying anything. `apps/web` is deliberately *not* in the
coverage `include`, and `packages/backend-errors` is excluded because it is a pure taxonomy
whose mapping out is tested.

**The god-file guard** is 300 warn / 400 error, counting `split('\n').length`. It skips
`node_modules`, `dist`, `.wrangler`, coverage directories, `.git`, `locales/`, `generated/`,
`__tests__`/`__mocks__`, `scripts/`, `*.config.*`, and every `.md`, `.json` and `.sql`. Only
the top 30 offenders print.

**`validate:migrations` is read-only and fails on an edit.** D1 records applied migrations
by *filename*, so a migration that has run is skipped silently by every later
`wrangler d1 migrations apply`. `migrations/migrations.lock.json` records the sha256 of
everything applied and `test/schema.int.test.ts` asserts both directions. There is
deliberately **no `--force`**: a write that could adopt a new digest for an already-applied
file *is* the bug, offered as a flag. See
[`../indexing/AGENTS.md`](../indexing/AGENTS.md).

**`validate:locales`** compares bundles *and* reads the `t('key', 'default')` call sites in
both directions, because a bundle-to-bundle diff cannot see a key that is used and absent.
It reported 130 compared defaults when this line was written.

## What is generated, and what is not

| Path | Generated |
| --- | --- |
| `worker-configuration.d.ts` | `pnpm run typegen`; **gitignored** |
| `apps/api/src/generated/spa-shell.ts` | `pnpm run build`; **gitignored**, verified by a check |
| `migrations/migrations.lock.json` | `pnpm run migrations:lock`, on adding a migration only |
| `coverage/`, `coverage-integration/` | the test run; gitignored |

The root `wrangler.jsonc` is **local development only** and is the one config carrying a
`DEV_AUTH_EMAIL` bypass and two raw 32-zero placeholder keys. A deployment starts from
`apps/api/wrangler.template.jsonc`, which omits both. See
[`../runtime/AGENTS.md`](../runtime/AGENTS.md).

## CI

`.github/workflows/` runs one job per check, so a red pipeline names its failure:
`continuous-integration.yml` for the gates above, `continuous-deployment.yml` for the Worker
and the two SPA targets, and `backup-d1.yml` for the nightly export. The job names are the
documentation of what each one proves.

## Adding a directory

A new `apps/*` or `packages/*` directory needs: a `package.json` with `typecheck`, a
`tsconfig.json`, and a layer decision — which is a decision about what it may import, so add
the `no-restricted-imports` block with it rather than after. `test/helpers/aliases.ts` holds
the one alias table both Vitest configs read, and a new package root or subpath export goes
there; the test that asserts it resolves is `test/alias-table.int.test.ts`.