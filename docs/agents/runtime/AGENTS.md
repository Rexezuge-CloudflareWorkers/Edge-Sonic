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
  `scripts/build/verify-spa-shell.ts` runs in `checks` and rejects a missing, stubbed, or
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
  `scripts/deploy/prepare-wrangler-config.ts` patches a D1 `database_id` only when it equals
  `DEFAULT_UUID`, a KV `id` and a Secrets Store `store_id` only when they equal
  `DEFAULT_HEX_ID` (32 zeros) — see `scripts/lib/wrangler-config/types.ts`. A friendlier
  placeholder such as `REPLACE_WITH_YOUR_SECRETS_STORE_ID` is skipped **silently**, the
  unpatched value reaches `wrangler deploy`, and it fails there as Cloudflare error
  10182 rather than at the step that caused it.
- **Provisioning reports what it created, because a caller has to act on the difference.**
  `provisionWranglerResources()` returns the resources it had to create as `<kind>:<name>`,
  and `prepare-wrangler-config.ts` publishes them as a step output. The backup workflow needs
  to know whether the D1 database **existed** or was created moments ago: one created now holds
  no user data, and uploading its empty dump nightly is a false sense of safety. Re-reading the
  placeholder id out of `wrangler.jsonc` instead is checking an artefact the same call has
  already rewritten, so the guard could never fire — a check that cannot fail is
  indistinguishable from the absence of data. `scripts/backup/resolve-d1-target.ts` is where
  it is consumed.
- **The D1 database is backed up daily, and the backup is encrypted by construction.**
  `.github/workflows/backup-d1.yml` exports at 04:15 UTC → xz → AES-256-CBC → S3 and/or
  WebDAV, with a `check-secrets` preflight that fails when a destination is configured
  without `BACKUP_ENCRYPTION_KEY`. That is mandatory rather than advisory because
  `migrations/0008_squash.sql` describes the in-database credential encryption as *"obfuscation
  against a D1 dump"* — an unencrypted backup inverts that assumption — and because the dump is
  a listening history (`play_counts`, `now_playing`, `stars`, `ratings`) plus the whole library
  topology. Playbook: `docs/db-backup-recovery.md`.
- Bindings: D1 `DB`, KV `CACHE`, and two Secrets Store secrets. **No Queues, no R2, no
  Vectorize in the templates.** The scan runs on a Durable Object when the `SCAN` binding is
  configured and is otherwise advanced by `getScanStatus`; nothing runs on a *cron*, though
  `backup-d1.yml` is one — it is a GitHub Actions schedule, not a Worker trigger.
- `AppConfiguration.validate()` runs **once per isolate** on the first request and logs
  to `console.error`. It is the only place unsafe configuration is reported, because
  every failure mode it checks is silent at request time: a malformed numeric var falls
  back to its default, and a `TEAM_DOMAIN` typo presents as an Access outage. Call it at
  startup, never per request.
- **The checks are in `config/validate.ts`, not on the class.** `AppConfiguration` is a facade
  with one getter per setting, and the checks had grown to a hundred and eighty lines on top of
  it — enough to push the file over the god-file limit, which is how this came to be noticed.
  `validateConfiguration(library, scan, requests, auth, env)` takes the same section objects the
  class holds, so **a check reads a setting through the section that owns its parsing**: a check
  that re-read `env` with its own parser is a second answer to the same question, which is the
  defect the whole method exists to catch. `DERIVED_MARKER_MAX_LENGTH` lives beside its check and
  is re-exported on the class, because a limit and the check that enforces it have to move
  together.

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
| Scan   | `SCAN_CHUNK_FOLDERS` (`7`), `SCAN_CHUNK_MAX_REQUESTS` (`42`), `SCAN_CHUNK_DEADLINE_MS` (`20000`), `SCAN_ENRICH_MAX_PER_FOLDER` (`8`), `WEBDAV_TIMEOUT_MS` (`10000`), `TAG_READ_BYTES`, `TAG_READ_TAIL_BYTES` |
| Limits | `MAX_LIBRARIES` (`10`), `MAX_PAGE_SIZE` (`500`), `DEFAULT_PAGE_SIZE` (`20`) |
| Grouping | `ALBUM_GROUP_BY` (`album`), `DERIVED_MARKER` (`""`) |
| Auth   | `TEAM_DOMAIN`, `POLICY_AUD` (no default — see above)                       |
| SSRF   | `ALLOW_PRIVATE_WEBDAV_HOSTS` (unset)                                       |

`DERIVED_MARKER` is appended to an artist or album name this server derived from a file's
**path** rather than from its tags. Empty by default, and empty is a **decision**: it makes a
derived `X` and a tagged `X` the same album, so a half-enriched library shows one release
instead of two spellings of it — and it is the only reason `search3` can match a track the scan
has not tag-read, since the `_ci` twin no longer carries the suffix. `' (derived)'` keeps the
guess visible and pays for it with a duplicate entry.

Two things it is *not*, and both were defects before it was a variable:

- **It is not trimmed.** It lands in `album_ci` and in a base64url album id, and a marker
  silently trimmed is a marker the operator did not write.
- **`%` and `_` are not wildcards, and `validate()` does not refuse them.** The derivation
  backfill's guard used to be `col LIKE '%' || marker`, so an empty marker matched every row —
  overwriting every real `ALBUMARTIST` in the library — and `_ (guess)` matched nothing, so the
  guard stopped recognising its own guesses. Provenance now lives in `songs.grouping_source` and
  the comparison is a column equality against a **bound** constant, so both characters are
  ordinary text. Refusing them in validation would preserve the confusion the column removed.

`validate()` does refuse a **control character**, because of the album id rather than the SQL:
`decodeId` runs `normalizeRelativePath` over a decoded payload, so a marker carrying one mints
an `alk:` id this server cannot read back — `getAlbum` answers `code=70` and `getCoverArt`
serves the placeholder with nothing naming a cause. And it refuses a marker over
`AppConfiguration.DERIVED_MARKER_MAX_LENGTH`, which is a cap rather than a preference because
the marker is appended to every derived name and therefore reaches every sort order, every
`WHERE` clause and every id this server mints.

**Changing it is a migration, not a toggle.** It re-derives every wholly-derived row, so
`album_ci` moves, the album grouping key moves, and `alk:` album ids move with it — stars and
ratings on those albums are lost. That is stated in `migrations/0008_squash.sql`
beside the `' (derived)'` literal that is now the only place the old value is written down
(introduced in `0006`, which that file absorbs).

### Size a subrequest budget against the plan that runs it — and count *everything*

Workers **Free** allows **50 subrequests per invocation**; Paid allows 10,000, raiseable
to 10M with `limits.subrequests`. A subrequest is any request a Worker makes with the
Fetch API **or to a Cloudflare service — R2, KV and D1 included**. D1 says so on its own
limits page:

> **Queries per Worker invocation** (read [subrequest limits]) — 1000 (Workers Paid) / **50 (Free)**

So a D1 statement, a KV operation, a Durable Object RPC and a Secrets Store read each
spend one of the same 50, and exceeding it does not slow a request down — it **terminates
the invocation**, with an error no `catch` in this codebase can see.

> **Measured 2026-10-05, and there are two budgets.** External `fetch` is 50; **D1 statements are
> 1,000**, in a separate pool — 1,000 D1 statements plus 50 outbound requests in one invocation
> survive together, and a DO reached by RPC runs on a fresh budget the caller's ceiling cannot see.
> Charging D1 against the 50 is therefore **conservatism, not correction**, and it remains the
> right direction: an *external* overrun kills the invocation, so bounding both by that one is
> what cannot take the product down. `SCAN_CHUNK_MAX_REQUESTS = 42` is ~21× stricter than the D1
> headroom this deployment has. A **D1** overrun also *throws* (`Too many API requests by single
> Worker invocation`) rather than killing the invocation, so it is diagnosable where an external
> one is not — which is what `D1ErrorClassifier` exploits. KV, Secrets Store reads and DO storage
> were **not** measured. Full account, method and limits:
> `docs/issues/subrequest-budgets-are-two-not-one.md`.

**This deployment targets Workers Free, and there is deliberately no plan switch.** One
ceiling, in `config/subrequests.ts`, with every bound below computed from it by arithmetic
rather than typed beside the code that has to honour it — the same rule `bindChunkSize`
follows from D1's 100-parameter ceiling.

| Var                            | Default | Derived as                        |
| ------------------------------ | ------- | --------------------------------- |
| `SCAN_CHUNK_MAX_REQUESTS`      | `42`    | `50 − 8` for the invocation's own |
| `SCAN_CHUNK_FOLDERS`           | `7`     | `floor(42 / 6)`, a folder's base   |
| `SCAN_ENRICH_MAX_PER_FOLDER`   | `8`     | `floor(42 / 5)`, a track's full cost |
| `MAX_PAGE_SIZE_CEILING`        | `500`   | the statement budget, capped at the protocol maximum |

The reserve is for authentication, the library grant and `scan_state`, which are spent
before the walk begins and are not the chunk's to skip. **All three scan vars are clamped
to their derived ceilings and `validate()` reports the clamp** — a configured maximum is
not a permission, and the operator surface was actively telling people to raise one of them
(`stoppedBy: 'requests'` rendered as *"Raise `SCAN_CHUNK_MAX_REQUESTS` to index more per
poll"*), which on Free converts a chunk that pauses into a chunk the runtime terminates.

`SCAN_CHUNK_DEADLINE_MS` is a different resource and still needed: the ceiling bounds
*count*, the deadline bounds *time*, and on a slow origin the deadline is what makes a poll
return. `SCAN_CHUNK_FOLDERS` still bounds D1 row writes against the 5,000-rows/day
allowance as well — two resources, one number, which is why it is derived rather than typed.

**Never trust the Workers limits page's "subrequests to internal services: 1,000 on Free"
row over D1's own page.** This repository did, for long enough to ship a scan that died in
its first album on every chunk: the budget metered `fetch` and nothing else, so a chunk
charged 40 and spent ~240. Full account, including why the pessimistic reading was chosen
because the cost of being wrong is asymmetric:
`docs/issues/free-plan-subrequest-ceiling.md`.

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

**Who creates what.** `scripts/deploy/prepare-wrangler-config.ts` (`provisionWranglerResources`)
creates the **store** and patches its id into the config. `scripts/deploy/init-secrets.ts` then
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
- `Container` — a per-request registry of already-constructed services.
  `createRequestScope(env)` in `backend-services/composition` is the composition root:
  table-driven lazy DAO wiring plus service bindings, one scope per request, resolved with
  `scope.get(Tokens.X)`. `scopeMiddleware` installs it; `BaseRoute.getScope` falls back to
  a fresh scope for helpers and tests — narrowly, on the named missing-scope error only,
  because a bare `catch` there would silently re-mint a scope **per call site**, which is
  the defect the middleware ordering exists to prevent.
  It used to be described as a "Factory + Singleton" DI, and the factory tier was
  **unreachable**: all 22 registrations are `bindValue`, so `bind`, `resolve`,
  `createChild`, `has`, `dispose` and `get`'s own factory branch had no callers (23 of 33
  statements). That took the "no binding for token" throw with it — the only diagnostic
  for a correctly-spelled-but-unbound token. The throw is back and is asserted for every
  entry in `Tokens` against **both** composition roots, in `test/rate-limit.test.ts`.
- `EnvParser` is defensive about the env shape on purpose: it is reached from fail-soft
  paths where `env` may be null or partial, and a `TypeError` there turns a default into
  a 500.
  It has **two** integer parsers and the distinction is load-bearing, not tidiness:
  `positiveInt` requires `> 0`, `nonNegativeInt` allows `0`. `TAG_READ_TAIL_BYTES=0`
  disables the Ogg tail read — documented as "a supported configuration and not a degraded
  one" — and reading it through `positiveInt` silently produced the default instead, so an
  operator who set it got a 64 KB ranged read per Ogg track for ever. `nonNegativeInt` had
  **no callers anywhere** at that point: the helper for that value existing, unused, in the
  same layer, while the line beside it called the other one.

## The KV cache

One namespace, one closed set of domains — `songMeta` and `albumArt`, nothing else — and
keys of the form `domain:v1:<parts...>`.

- **Invalidation is in the key, never a delete.** A `delete`-then-`put` on a value the
  re-resolution already produced spends two scarce operations per request to move a key to
  the value it already had, and a client that 404s on every inner path used to exhaust a
  whole day's budget in ~40 minutes while answering every request correctly.
- **Both live domains key on the file's own `mtimeMs`+`size`, not on `index_version`.**
  Re-tagging a track changes its picture and its tags without moving anything else in the
  library, so the file's revision is what actually invalidates; a rescan that finds nothing
  new bumps `index_version` and would orphan every cached image for no reason.
- **The stronger rule exists and has no user.** A domain caching a *derived aggregate*
  should take `scan_state.index_version` as its first key part, so a completed scan makes
  every entry under the old version **structurally unreachable** and invalidation costs
  zero writes rather than a TTL. `libIndex` and `libTree` were the two such domains and
  neither had a production caller, so the strategy was documented over dead code — a worse
  state than not having it, because the next reader takes it as evidence it is in force.
  `index_version` is read nowhere in `KvDomains` or `KvCache`. A new aggregate-caching
  domain should reintroduce it, and `test/enrichment-config.test.ts` asserts the live set
  so one cannot be added and quietly left unversioned.
- **`KvCache` fails soft.** A missing binding and a throwing binding are the same code
  path, and the responses are byte-identical to a warm cache; D1 is what answers.
- **Every read states its `type`, because `get()`'s default is `text`.** That default is
  the platform's, it is documented, and it is a *lossy* codec for binary: a stored JPEG
  read back as text has every invalid UTF-8 sequence replaced by U+FFFD and comes back
  three bytes per replacement. `getBytes` therefore asks for `'arrayBuffer'` and
  `getText` for `'text'`, and `KvNamespaceLike.get` carries the parameter so the
  `arrayBuffer` overload can be expressed at all. This is not a tidiness rule: it took
  the entire embedded-artwork feature with it on a live 100%-Opus library — 42 covers on
  the first sweep of 80 albums, **0 of 80** on the second, every one a `200` with a
  decodable placeholder — and the suite stayed green because `fakeKv` returned stored
  values verbatim. A byte-exact double cannot see a lossy platform, which is the same
  class of defect as the D1 double that lowercased both sides of a predicate. Asserted in
  `test/kv-outage.test.ts`; full account:
  `docs/issues/kv-default-text-read-corrupts-artwork.md`.
- **The circuit breaker is module-level**, so one outage opens it for the isolate rather
  than giving each request scope its own three failures to get through. It opens after
  three consecutive failures, cools down for 5 s, and half-opens with a probe.
  `resetBreakerForTests()` is the only escape hatch.
- Values over the KV size limit are reported as not stored rather than thrown, which
  turns a wasted round trip into a skipped one.
