# Edge-Sonic — Runtime And Configuration

Scope: wrangler bindings, build output, environment variables, DI. Parent index:
`../../../AGENTS.md`.

The invariants that used to sit in the root guide are split by audience. Each is written up
once, in the guide whose reader needs it:

| Guide | Covers |
| --- | --- |
| [`../protocol/AGENTS.md`](../protocol/AGENTS.md) | the Subsonic wire: ids, node model, serializers, the endpoint registry |
| [`../scanning/AGENTS.md`](../scanning/AGENTS.md) | the walk, the chunk budget, and what a status promises |
| [`../indexing/AGENTS.md`](../indexing/AGENTS.md) | D1, the DAOs, and the migrations |
| [`../albums/AGENTS.md`](../albums/AGENTS.md) | what an album **is**: grouping key, id, track order |
| [`../media/AGENTS.md`](../media/AGENTS.md) | tags, enrichment and artwork |
| [`../import/AGENTS.md`](../import/AGENTS.md) | moving a player's data in from another Subsonic server |
| [`../testing/AGENTS.md`](../testing/AGENTS.md) | the suite, the thresholds, and the doubles |
| this file | bindings, secrets, configuration, DI, the KV cache |

Four more were already written up in an area guide and are **not** repeated here: the
rate-limit registration order and the two error dialects (`apps/api/AGENTS.md`), the probe's
one-`try`-per-step taxonomy (`packages/backend-services/AGENTS.md`), and the library list's
scan summary (`apps/api/AGENTS.md`).

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
- Bindings: D1 `DB`, KV `CACHE`, three Secrets Store secrets, one Durable Object namespace
  (`SCAN`) and — for the import — a second (`IMPORT_DO`) plus a Workflow (`IMPORT_WORKFLOW`).
  **No Queues, no R2, no Vectorize in the templates.** The scan runs on a Durable Object when
  the `SCAN` binding is configured and is otherwise advanced by `getScanStatus`; nothing runs on
  a *cron*, though `backup-d1.yml` is one — it is a GitHub Actions schedule, not a Worker
  trigger.
- **The import's Durable Object is a second namespace, not a second name on `SCAN`.** A Durable
  Object's lifecycle *is* its alarm's, so one namespace would put an import's play-count walk
  and a library scan in the same object, where the walk's terminal `deleteAlarm` silently
  disarms the scan. The import *pauses* the scan rather than sharing its row budget, so the two
  must not be able to reach each other's alarms.
- **The Workflow and the Durable Object are one feature split by the step ceiling, not by
  convenience.** A Workflow step is *cached by name*, so `playlist <remoteId>` cannot write the
  same playlist twice — which is the whole reason an imported playlist's id is derived
  (`UUIDUtil.deterministicId`) as well. The play-count walk gets no such guarantee and needs
  ~1 step per album against a **1,024-step** ceiling on Free, so it runs in the Durable Object
  and each alarm gets a **fresh** 50-subrequest external budget. See
  `docs/issues/subrequest-budgets-are-two-not-one.md` for the measurement that makes an
  unbounded walk possible at all.
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
`DEMO_USER_EMAIL` (`demo@edge-sonic.invalid`) without verification. That constant is
reached through `config.getDemoUserEmail()`; it used to be a hardcoded literal in
`AccessAuthService` **and** a second, different one in `@edge-sonic/shared/constants`, while
the getter reading the variable had no caller at all — so this line described an answer
the auth path did not give.

**Both are honored only when `ENVIRONMENT` is in an allow-list** (`development`, `dev`,
`local`, `test`). That set is an allow-list on purpose: a deny-list (`!== 'production'`)
would enable the bypass for `staging`, `Preview`, and a typo like `prodcution`,
authenticating every unauthenticated request as a fixed identity. `validate()` warns when
one is present but inert, because that is the case one config edit from being live.

## Optional vars (defaults in `ConfigurationDefaults.ts`)

| Group  | Vars (default)                                                             |
| ------ | -------------------------------------------------------------------------- |
| App    | `LOG_LEVEL` (unset), `ENVIRONMENT` (`production`) |
| Scan   | `SCAN_CHUNK_FOLDERS` (`7`), `SCAN_CHUNK_MAX_REQUESTS` (`42`), `SCAN_CHUNK_DEADLINE_MS` (`20000`), `SCAN_ENRICH_MAX_PER_FOLDER` (`8`) |
| Media  | `TAG_READ_BYTES` (`131072`), `TAG_READ_TAIL_BYTES` (`65536`), `WEBDAV_TIMEOUT_MS` (`10000`) |
| Limits | `MAX_LIBRARIES` (`10`), `MAX_PAGE_SIZE` (`500`), `DEFAULT_PAGE_SIZE` (`20`) |
| Grouping | `ALBUM_GROUP_BY` (`album`), `DERIVED_MARKER` (`""`) |
| Auth   | `TEAM_DOMAIN`, `POLICY_AUD` (no default — see above)                       |
| SSRF   | `ALLOW_PRIVATE_WEBDAV_HOSTS` (unset)                                       |
| Stream | `STREAM_RATE_LIMIT` (`600`), `STREAM_TIMEOUT_MS` (`30000`)                  |
| Throttle | `AUTH_FAILURE_LIMIT` (`10`), `AUTH_FAILURE_WINDOW_SECONDS` (`900`)      |

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
return. `SCAN_CHUNK_FOLDERS` still bounds D1 row writes against the daily allowance as
well — **100,000 billed rows/day** less a 10% reserve, itself halved per registered library,
so **90,000** (`subrequests.ts`) — two resources, one number, which is why it is derived rather than typed.

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
| `SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET` | `edge-sonic-subsonic-remote-encryption-key` | `import_sources.password_ciphertext` |

Three keys, never fewer. Merging any two would make one of these true, and each is a
**different** merge:

- user + WebDAV: rotating the WebDAV credential would require re-entering every user's
  password, and a compromise of one store would yield both.
- remote + WebDAV: the WebDAV key is read on **every scan and every stream**, so it has the
  largest read surface in the product, while a remote credential is operator-supplied and
  re-entered per source.
- remote + user: a remote credential grants read access to a whole **other** library, and
  rotating the user key would require re-entering it.

All three live in one store, and `ensureSecretStore()` writes a single resolved id into every
entry, so rotating one key never has to move another.

**The third one needed no edit to `init-secrets.ts`**, and that is what the name shape buys:
a `*-encryption-key` name gets a generated 32-byte AES-GCM key. Adding an entry to
`secrets_store_secrets[]` used to require *also* editing a hardcoded list of known names, and
getting that wrong broke deployment — `init-secrets.ts` threw `Unknown secret`, the rejection
was swallowed, and the CD step reported success with the failure surfacing two steps later as
a 10182. **A provisioning script must exit non-zero on failure**: a guard that logs and
returns 0 is indistinguishable from a guard that passed.

**The test harness gives the three features three distinct values**, which it did not used
to. With one value for all three, no test in this repository could detect a merge — and
`test/user-api.test.ts` has asserted in those words, for both a user password and a library
password, that "the stored value must be the *user* key's output, so rotating the DAV key
does not log everyone out". That claim was in the comment and untestable. The rule is
`fakeKv`'s: **a double must model the platform's distinctions, not only its shapes.**

**Who creates what.** `scripts/deploy/prepare-wrangler-config.ts` (`provisionWranglerResources`)
creates the **store** and patches its id into the config. `scripts/deploy/init-secrets.ts` then
reads the patched config and creates each **secret value** in it. Two scripts, one
pipeline, in that order — a script that claims to do both has silently skipped one.

A secret's value is chosen by its **name shape**: `*-encryption-key` gets a generated
32-byte AES-GCM key (base64, which is what `isUsableKey` requires on the read side) and
`*-signing-secret` gets 32 random bytes.

`resolveKey(binding, rawVar, bindingName, varName)` resolves a key, memoizes a success,
and **fails closed**: no configuration is an error, a binding that throws is an error
rather than a fall-through to a var, and a value that is not 32 bytes is an error. Each
of those is asserted in `test/enrichment-config.test.ts`. The raw var is a test-only
escape hatch so `wrangler dev` works without a Secrets Store; the production template
does not declare it, and a broken binding must never be masked by one.

The schema carries `key_version` on both tables, and that is the rotation handle —
re-encrypt under a new version, then drop the old one.
`users` also **used to** carry `token_epoch`, bumped by a password change and read by
nothing; a previous version of this file called it "the only way to revoke a token". It is
not, and it could not be: `t` is `md5(password + salt)`, so a password change already
invalidates every issued token by changing what the token is computed *from*. Revocation is
real, and it never needed an epoch. Dropped in `migrations/0010_drop_token_epoch.sql`, which
also records why an epoch could not have worked even in principle: the column held how many
times the password had changed, and no credential ever held the count a client was minted
under, so there was nothing to compare. Asserted as an **absence**
(`test/schema.int.test.ts`) so a reintroduced `CREATE TABLE users` is caught, and nothing
should be written to read a replacement — the protocol has no field to compare one against.

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
  **unreachable**: all **30** registrations are `bindValue`, so `bind`, `resolve`,
  `createChild`, `has`, `dispose` and `get`'s own factory branch had no callers (23 of 33
  statements). That took the "no binding for token" throw with it — the only diagnostic
  for a correctly-spelled-but-unbound token. The throw is back and is asserted for every
  entry in `Tokens` in `test/rate-limit.test.ts`. There is **one** composition root —
  `createScanWorkerScope` is a one-line delegation to `createRequestScope`, so "both roots"
  was two entry names for one thing.
- **A binding that wraps another binding must not take a second meter.** `PlayCountImportWorker`
  needs a *narrower* budget than the invocation's 50, so it took the scan's approach — but it
  built a **local** `SubrequestCounter` for the batch loop's `canAfford` while its DAOs charged
  the **scope's** own counter. Two counters are two numbers that disagree, and the
  disagreement was silent and total: the loop saw 44 remaining on a meter nothing else had
  spent, the DAOs' `requireSubrequests` threw on album seven, and `alarm`'s catch swallowed it
  into "could not read the import source" and re-armed. **The walk reported progress and made
  none, for ever** — 1,024 steps of nothing, and every run of it a green suite.
  So it is `scope.get(Tokens.SubrequestMeter)` with `setCeiling(SCAN_CHUNK_SUBSREQUEST_BUDGET)`,
  exactly as `ScanBudget` does: one meter, narrowed, so the loop and every charge point below it
  read the same number. Asserted in `test/import-execution.test.ts` by walking twenty albums
  across several alarms to completion.
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
  `index_version` is read nowhere in `KvDomains` or `KvCache`, and there is no
  `versionScoped` field left to reintroduce it — a previous version of this file claimed
  `test/enrichment-config.test.ts` "asserted the live set so one cannot be added and
  quietly left unversioned", and that test asserts the domain **names** and nothing
  about versioning. A new aggregate-caching domain has to bring the key part itself.
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

## Invariants

Split out of the root guide. Each is a defect this repository shipped, and each names the
test that now holds it.

- **`await` the authorization check.** A `void`ed `requireForUser` starts the check and
  discards the rejection, so the write it was guarding proceeds. It shipped: a play
  queue accepted an id for a library the caller could not see.
- **The cache is never load-bearing.** D1 answers everything; KV only avoids a repeat.
  `KvCache` fails soft, and its circuit breaker is module-level so one outage opens it
  for the whole isolate rather than per request scope.
- **Cache keys carry `scan_state.index_version`.** A superseded entry becomes
  structurally unreachable, so invalidation costs zero writes — the free plan allots
  1,000 writes a day against 100,000 reads.
- **5xx bodies are masked.** `toSubsonicError` logs the cause and returns a localized
  generic message; a D1 error names tables and columns.
- **An unbounded quantifier before a character that can fail is quadratic in the _input_,
  and JavaScript cannot be told to stop backtracking.** Three CodeQL alerts, all
  `js/polynomial-redos`, all on data that arrived from an untrusted WebDAV origin:
  `/\/+$/` in `toLibraryPath` (twice — once per operand) and `/\s+[-–—]\s+/` in
  `fromFlatAlbumFolder`. The mechanism is not a nested quantifier, which is why it is easy to
  miss: an unanchored `/+$` over a run of *n* identical characters makes the engine retry every
  length the run could have, from each of the *n* start positions inside it. 16 KB costs ~200 ms
  and 100 KB costs ~8 s, against a **10 ms CPU limit on Workers Free**, and well inside the
  8 MiB body cap `MAX_METADATA_BYTES` already allows — so one hostile `PROPFIND` is an
  invocation the runtime kills. The rule is *unanchored quantifier, then something that can
  fail*, and `[gimsuy]` cannot fix it: JS has no possessive quantifier and no atomic group, so
  the fix is a scan. Five things, and each is how this one would have collapsed:
  - **A quadratic regex without a nested quantifier is invisible to every linter this
    repository runs.** Probed: `eslint-plugin-regexp`'s `no-super-linear-backtracking` and
    `sonarjs`'s `slow-regex` both fire on `^(a+)+$`, only `slow-regex` fires on
    `/\s+[-–—]\s+/`, and **neither fires on `/\/+$/`**. So the lint gate was green over a live
    DoS and CodeQL — not a test, and not on every commit — was the only instrument that found
    it. There is no lint rule for "quadratic in the input", so the guard is a measurement.
  - **The expensive shape is the _interior_ run, and the obvious test input is the cheap
    one.** A *leading* run is consumed by `replace(/^\/+/, '')` before `/+$/` runs; a
    *trailing* run matches, and V8 fast-paths a successful `/[/]+$/`. Measured at 16,000
    slashes: **0.0 ms leading, 0.0 ms trailing, 198 ms interior**. The first version of
    `test/redos-linear-parsing.test.ts` asserted the leading and trailing runs, and both
    passed against the regex it was written to catch — 48 of 48 green. So a guard built on the
    wrong shape of the input is indistinguishable from no guard, and a hostile `DAV:href` is
    `<base>/<path>`, so the expensive shape is also the ordinary one.
  - **The rewrite is only equivalent because the caller discards what the regex measured.**
    `findAlbumSeparator` returns the **dash's** index rather than the match index because both
    sides of the split are `.trim()`ed by the caller, so the *extent* of the whitespace runs
    cannot change the answer. Strip the trim and the equivalence argument goes with it.
  - **A fixture that disagrees with the reader is the finding, and it was the fixture twice.**
    The oracle is `split('/')`-based and was written *filtering every* empty segment, which
    silently normalises the middle of the string; the seeded fuzz caught it on the first
    interior run it met. An inverted `&&`/`||` in the whitespace test was caught the same way.
    Both were bugs in the check, not in the code — which is the argument for the fuzz, since
    "written from the spec" is a claim and the fuzz is the measurement.
  - **A test must not trip the query it exists to close.** CodeQL's default configuration scans
    `test/` as well as `packages/`, so the quadratic reference is built with `new RegExp` and
    `prefer-regex-literals` is disabled there with that reason attached. Asserted: reintroducing
    each original regex turns the file red, on the wall-clock bound and on nothing else — every
    equivalence assertion stays green, which is what makes the timing assertion the only thing
    distinguishing a linear implementation from a slow one.
- **A platform global is invoked bare, never as a stored field.** `WebDavClient` kept
  the global `fetch` in a field and called it as `this.fetchImpl(...)` — a *method call*,
  so the receiver was the client rather than the global scope. workerd validates that
  receiver and throws `TypeError: Illegal invocation: function called with incorrect
  'this' reference.` It broke every WebDAV path in the product — probe, scan, tree,
  enrichment, streaming — against a live origin answering `207`. Being a `TypeError`, it
  has no `status`, so it fell through every status-based branch and reached the operator
  as *"Library is unreachable."*: a fault in **this** server, described as a fault in
  theirs. The wrapper lives in the constructor, so no call site can reintroduce it, and
  the same mistake is worth grepping for after any refactor that stores a function.
- **An unawaited promise is not a cheaper version of an awaited one, it is a different
  one.** The artwork cache was the only KV write in the product issued as `void
  deps.cache.putBytes(...)`, and work a Workers handler does not await is not guaranteed
  to run — so the cover cache never populated, and every cell of an album grid re-read
  the origin at up to two ranged reads each against a 50-subrequest ceiling. Same defect
  as voiding `requireForUser`, one level down. Both writes are awaited now, and the
  double can tell the difference: `fakeKv`'s `put` used to settle on the microtask queue,
  so an abandoned write still landed in time and the suite proved a cache that production
  never filled. `deferPuts` holds every write until released, so the ordering — the
  response must not resolve before its write settles — is asserted rather than assumed.
  Asserted in `test/cover-art-embedded.test.ts`, which goes red on the `void` version.
- **A variable can be declared, parsed, validated, templated and read by nothing.**
  Five were, and they fail in three distinguishable ways, which is why one rule does not
  cover them. `STREAM_RATE_LIMIT` was inert: the limiter used a literal, so `600` lived in
  three places and an operator setting `50` got a clean validation pass and an unchanged
  limiter. `LOG_LEVEL` was inert for a structural reason — **both loggers are module-level
  constants**, so the level was resolved before `env` existed and `logger.debug` could never
  emit in a deployed Worker; the coverage report proved it rather than suggesting it, since
  every `console.*` call sat in an arm reachable only at `minLevel <= 0`. And
  `TAG_READ_TAIL_BYTES=0` was *reachable but inverted*: it read through a parser whose
  contract is `> 0`, so the documented "0 disables the second read" became the default.
  That parser's `>= 0` sibling had **no callers anywhere** in the repository — the helper
  for that value existing, unused, in the same layer, while the line beside it called the
  other one.

  **All three are fixed, and a reader should check rather than assume it**: the limiter
  reads `getStreamRateLimit()`, `requestScope` calls `setLogLevel()` on the one request that
  builds the scope, and the tail read goes through `nonNegativeInt`. The rule is the one that
  catches the next one — a variable that no caller reads is not a variable, and validation
  passing is not evidence that anything happened.

## Also canonical elsewhere

These three moved out of the root guide and are written up in
[`apps/api/AGENTS.md`](../../../apps/api/AGENTS.md), which is where the router is:

- **A `no-store` predicate must name a path the router serves.**
- **One surface speaks one error dialect.**
- **Untrusted names never reach a header unescaped.**
