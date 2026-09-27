# Edge-Sonic — Runtime And Configuration

Scope: wrangler bindings, build output, environment variables, DI. Parent index:
`../../../AGENTS.md`.

- pnpm workspaces: `apps/*`, `packages/*`, and **`test`** — `test` is a workspace
  project, so `pnpm -r typecheck` and `pnpm run lint` both reach it. It sat outside the
  workspace once while holding ~200 KB of test code, and `eslint.config.mjs` ignored
  `test/**` outright; both are fixed, and the ignore is gone.
- `apps/web/vite.config.ts` proxies `/admin` and `/rest` to `http://localhost:8787` in
  dev, and its `closeBundle` embeds `dist/index.html` into
  `apps/api/src/generated/spa-shell.ts` as `SPA_HTML`.
  `scripts/verify-spa-shell.mjs` runs in `checks` and rejects a missing, stubbed, or
  half-refreshed artifact — so a frontend change is not inert until `pnpm run build`.
- `apps/api/wrangler.template.jsonc` is the deployment template; `wrangler.jsonc` at the repository root is
  local only (`ENVIRONMENT=development`). The template sets `ENVIRONMENT=production` and
  deliberately omits `DEV_AUTH_EMAIL`/`DEMO_MODE`; site values go through the
  `WRANGLER_VARS_PATCH_JSON` repo variable.
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
(`AccessAuthService`). Without them `/admin` returns 401; `/rest` is unaffected, because
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
| Limits | `MAX_LIBRARIES_PER_USER` (`20`), `SCAN_CHUNK_FOLDERS`, `SCAN_FETCH_TIMEOUT_MS`, `MEDIA_READ_BYTES` |
| Auth   | `TEAM_DOMAIN`, `POLICY_AUD` (no default — see above)                       |
| SSRF   | `ALLOW_PRIVATE_WEBDAV_HOSTS` (unset)                                       |

`ALLOW_PRIVATE_WEBDAV_HOSTS` gates whether a library may be registered at a private,
loopback, or link-back address. The Worker fetches `baseUrl` with the library's **stored
DAV password**, so without the gate an operator registration form is a way to send that
credential to cloud metadata (`169.254.169.254`) or to an internal service. Unset follows
the environment: allowed outside production so a co-located `wrangler dev` works,
denied in production. An explicit value always wins. The cloud metadata address is
asserted in `test/admin-api.test.ts`.

Plaintext `http` is allowed only for a loopback host, because a Basic credential is
base64 rather than encryption and must not cross a network in the clear. A `base_url`
carries no path, query, fragment, or embedded credential: the root path is a separate
field, and an embedded credential would be stored, returned by the admin API, and logged.

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
re-entering every user's password, and a compromise of one store would yield both.

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
