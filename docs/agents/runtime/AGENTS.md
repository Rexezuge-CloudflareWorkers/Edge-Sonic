# Edge-Sonic — Runtime And Configuration

Scope: wrangler bindings, build output, environment variables, DI. Parent index:
`../../../AGENTS.md`.

- pnpm workspaces: `apps/*`, `packages/*`, and **`test`** — `test` is a workspace
  project, so `pnpm -r typecheck` and `pnpm run lint` both reach it. It sat outside the
  workspace once while holding ~200 KB of test code, and `eslint.config.mjs` ignored
  `test/**` outright; both are fixed, and the ignore is gone.
- `apps/web/vite.config.ts` proxies `/user` and `/rest` to `http://localhost:8787` in
  dev, and its `closeBundle` embeds `dist/index.html` into
  `apps/api/src/generated/spa-shell.ts` as `SPA_HTML`.
  `scripts/verify-spa-shell.mjs` runs in `checks` and rejects a missing, stubbed, or
  half-refreshed artifact — so a frontend change is not inert until `pnpm run build`.
- `apps/api/wrangler.template.jsonc` is the **Worker** deployment template. The template
  sets `ENVIRONMENT=production` and deliberately omits `DEV_AUTH_EMAIL`/`DEMO_MODE`; site
  values go through the `WRANGLER_VARS_PATCH_JSON` repo variable. The `wrangler.jsonc` at
  the repository root is **local only** (`ENVIRONMENT=development`) and is **gitignored**,
  so it is a working file rather than a committed artifact.
- **`apps/web/wrangler.template.jsonc` is the second deployment target, Cloudflare
  Pages**, and the `deploy-pages` job `cp`s it over the root config before
  `wrangler pages deploy apps/web/dist`. Two hosts deploy the same SPA:
  - The **Worker** serves the SPA and the API from one origin, so the client is
    same-origin with `API_BASE = '/user'` and no token in JavaScript.
  - **Pages** serves `dist/` as static files and would 404 every `/user`, `/rest`, and
    `/health` call. `functions/[[path]].ts` is what makes that target work: a catch-all
    that forwards to the `edge-sonic` Worker over the `API_WORKER` service binding. Its
    presence in the Pages log is `Uploading Functions bundle`; without it the operator UI
    renders a shell that can never load anything.
  - The two templates are coupled in exactly one place: `services[].service` here must
    equal `name` in the Worker template. A typo is a deploy-time failure, not a runtime
    one.
- **A placeholder in a template must be the exact sentinel, not a readable stand-in.**
  `scripts/prepare-wrangler-config.ts` patches a D1 `database_id` only when it equals
  `DEFAULT_UUID`, a KV `id` and a Secrets Store `store_id` only when they equal
  `DEFAULT_HEX_ID` (32 zeros) — see `scripts/wrangler-config/types.ts`. A friendlier
  placeholder such as `REPLACE_WITH_YOUR_SECRETS_STORE_ID` is skipped **silently**, the
  unpatched value reaches `wrangler deploy`, and it fails there as Cloudflare error
  10182 rather than at the step that caused it.
- Bindings: D1 `DB`, KV `CACHE`, and two Secrets Store secrets. **No Durable Objects, no
  cron triggers, no queues, no R2.** The scan is advanced by `getScanStatus`, so nothing
  runs on a schedule.
- `AppConfiguration.validate()` runs **once per isolate** on the first request and logs
  to `console.error`. It is the only place unsafe configuration is reported, because
  every failure mode it checks is silent at request time: a malformed numeric var falls
  back to its default, and a `TEAM_DOMAIN` typo presents as an Access outage. Call it at
  startup, never per request.

## Required vars (no defaults)

`POLICY_AUD`, `TEAM_DOMAIN` — Cloudflare Access JWT verification
(`AccessAuthService`). Without them `/user` returns 401; `/rest` is unaffected, because
it authenticates against the `users` table.

## Local-only (no default, absent from the production template)

`DEV_AUTH_EMAIL` — bypasses Cloudflare Access locally. `DEMO_MODE` — authenticates as
`DEMO_USER_EMAIL` without verification.

**Both are honored only when `ENVIRONMENT` is in an allow-list** (`development`, `dev`,
`local`, `test`). That set is an allow-list on purpose: a deny-list (`!== 'production'`)
would enable the bypass for `staging`, `Preview`, and a typo like `prodcution`,
authenticating every unauthenticated request as a fixed identity. `validate()` warns when
one is present but inert, because that is the case one config edit from being live.

## Optional vars (defaults in `ConfigurationDefaults.ts`)

| Group  | Vars (default)                                                             |
| ------ | -------------------------------------------------------------------------- |
| App    | `DEBUG_MODE` (`false`), `SITE_URL` (`""`), `ENVIRONMENT` (`development`) |
| Scan   | `SCAN_CHUNK_FOLDERS` (`40`), `SCAN_CHUNK_MAX_REQUESTS` (`40`), `SCAN_CHUNK_DEADLINE_MS` (`20000`), `SCAN_ENRICH_MAX_PER_FOLDER` (`20`), `WEBDAV_TIMEOUT_MS` (`10000`), `TAG_READ_BYTES`, `TAG_READ_TAIL_BYTES` |
| Limits | `MAX_LIBRARIES` (`10`), `MAX_PAGE_SIZE` (`500`), `DEFAULT_PAGE_SIZE` (`20`) |
| Auth   | `TEAM_DOMAIN`, `POLICY_AUD` (no default — see above)                       |
| SSRF   | `ALLOW_PRIVATE_WEBDAV_HOSTS` (unset)                                       |

### Size a subrequest budget against the plan that runs it

Cloudflare retired the 1,000-subrequest-per-invocation ceiling on **2026-02-11**. The
current limits are **50 external** subrequests on Workers **Free** and 10,000 on Paid,
raiseable to 10M with `limits.subrequests` in the wrangler config; internal service
subrequests (D1, KV) are 1,000 on Free.

Every other quota in this codebase is sized against the free tier, so
`SCAN_CHUNK_MAX_REQUESTS` defaults to **40** — ten under the ceiling, for redirect
chains, which the platform also counts. A default of 1,000 is not a slow chunk, it is a
**failed** chunk on a Free-plan account. A deployment on Workers Paid should raise it, or
set `limits.subrequests`; scans then finish in proportionally fewer polls. The
conservative default is the one that cannot fail on an account that never raised it.

`SCAN_CHUNK_FOLDERS` is a **different** bound — D1 work, against the 5,000-rows/day
allowance — and `SCAN_CHUNK_DEADLINE_MS` a third: wall clock, so a poll returns on a slow
origin. All three guard different resources, so none of them is redundant with the others.

`ALLOW_PRIVATE_WEBDAV_HOSTS` gates whether a library may be registered at a private,
loopback, or link-back address. The Worker fetches `baseUrl` with the library's **stored
DAV password**, so without the gate an operator registration form is a way to send that
credential to cloud metadata (`169.254.169.254`) or to an internal service. Unset follows
the environment: allowed outside production so a co-located `wrangler dev` works,
denied in production. An explicit value always wins. The cloud metadata address is
asserted in `test/user-api.test.ts`.

Plaintext `http` is allowed only for a loopback host, because a Basic credential is
base64 rather than encryption and must not cross a network in the clear. A `base_url`
carries no path, query, fragment, or embedded credential: the root path is a separate
field, and an embedded credential would be stored, returned by the user API, and logged.

**Adding a variable**: declare it in `ServiceEnv`, give it a default in
`ConfigurationDefaults.ts`, read it through `EnvParser` (add a section object under
`config/sections/` if it belongs with others), and add a getter on `AppConfiguration`.
Never read `env.X` inline. A variable missing from `ServiceEnv` can be added anywhere
without a type error and silently never reach the config layer.

## Secrets: one per feature

| Secret name                            | Binding                                | Guards                        |
| -------------------------------------- | -------------------------------------- | ----------------------------- |
| `SUBSONIC_USER_ENCRYPTION_KEY_SECRET`  | `edge-sonic-subsonic-user-encryption-key` | `users.password_ciphertext` |
| `WEBDAV_ENCRYPTION_KEY_SECRET`         | `edge-sonic-webdav-encryption-key`     | `libraries.password_ciphertext` |

Two keys, never one. Merging them would make rotating the WebDAV credential require
re-entering every user's password, and a compromise of one store would yield both. Both
live in one store, and `ensureSecretStore()` writes a single resolved id into every entry,
so rotating one key never has to move the other.

**Who creates what.** `scripts/prepare-wrangler-config.ts` (`provisionWranglerResources`)
creates the **store** and patches its id into the config. `scripts/init-secrets.ts` then
reads the patched config and creates each **secret value** in it. Two scripts, one
pipeline, in that order — a script that claims to do both has silently skipped one.

A secret's value is chosen by its **name shape**: `*-encryption-key` gets a generated
32-byte AES-GCM key (base64, which is what `isUsableKey` requires on the read side) and
`*-signing-secret` gets 32 random bytes. This used to be a hardcoded list of known names,
and adding an entry to `secrets_store_secrets[]` without also editing the list broke
deployment: `init-secrets.ts` threw `Unknown secret`, and because the rejection was
swallowed the CD step reported success and the failure surfaced two steps later as a
10182. **A provisioning script must exit non-zero on failure** — a guard that logs and
returns 0 is indistinguishable from a guard that passed.

`resolveKey(binding, rawVar, bindingName, varName)` resolves a key, memoizes a success,
and **fails closed**: no configuration is an error, a binding that throws is an error
rather than a fall-through to a var, and a value that is not 32 bytes is an error. Each
of those is asserted in `test/enrichment-config.test.ts`. The raw var is a test-only
escape hatch so `wrangler dev` works without a Secrets Store; the production template
does not declare it, and a broken binding must never be masked by one.

The schema carries `key_version` on both tables and `token_epoch` on `users`.
`key_version` is the rotation handle — re-encrypt under a new version, then drop the old
— and `token_epoch` is bumped by a password change, because a Subsonic token is valid
forever and there is no other way to revoke one.

**A store that is recreated is a new key, and the rows are not.**
`provisionWranglerResources` mints a *new* `store_id` when the store has to be created,
and `init-secrets` generates a *new* value into it, while every
`libraries.password_ciphertext` is still ciphertext under the old one. GCM authenticating
makes that a decryption failure rather than a garbage password, which is the correct
behaviour - but it makes every library unusable at once, and the only remedy is
re-entering each password. `init-secrets` deliberately skips an existing secret, so
re-running the pipeline in place is safe; it is a *new store* that rotates the key. This
is why `probe` names a decryption failure separately from a network one: it is the fault
an operator is most likely to meet, and the one whose message misleads most if it borrows
the origin's.

## Dependency injection

- `AppConfiguration` — an injectable view over env parsing: a facade over the section
  objects (`AuthConfig`, `LibraryLimits`), one method per setting. Inject it in new
  services; mock through constructor deps.
- `Container` — a minimal Factory + Singleton DI. `createRequestScope(env)` in
  `backend-services/composition` is the composition root: table-driven lazy DAO wiring
  plus service bindings, one scope per request, resolved with `scope.get(Tokens.X)`.
  `scopeMiddleware` installs it; `BaseRoute.getScope` falls back to a fresh scope for
  helpers and tests.
- `EnvParser` is defensive about the env shape on purpose: it is reached from fail-soft
  paths where `env` may be null or partial, and a `TypeError` there turns a default into
  a 500.

## The KV cache

One namespace, one closed set of domains (`libIndex`, `libTree`, `songMeta`,
`davRoute`), and keys of the form `domain:v1:<parts...>`.

- **The library's `index_version` is part of the key.** A superseded entry becomes
  structurally unreachable, so invalidation costs **zero** KV writes. The free plan
  allots 1,000 writes and 1,000 deletes a day against 100,000 reads, so a design that
  deletes-then-puts on every miss spends the whole budget in minutes while answering
  every request correctly.
- **`KvCache` fails soft.** A missing binding and a throwing binding are the same code
  path, and the responses are byte-identical to a warm cache; D1 is what answers.
- **The circuit breaker is module-level**, so one outage opens it for the isolate rather
  than giving each request scope its own three failures to get through. It opens after
  three consecutive failures, cools down for 5 s, and half-opens with a probe.
  `resetBreakerForTests()` is the only escape hatch.
- Values over the KV size limit are reported as not stored rather than thrown, which
  turns a wasted round trip into a skipped one.
