# Edge-Sonic — Backend Services

Scope: `packages/backend-services/**`. Parent index: `../../AGENTS.md`.

Layer 3: layers 0–2, and never `apps/*`.

## Auth: two systems, on purpose

- `auth/SubsonicAuthService` authenticates `/rest/*` against the `users` table, because a
  Subsonic client can only speak `u` + `t` + `s` and has no way to present an Access
  cookie. `t` is `md5(password + salt)` and is compared in constant time; `p` (the legacy
  cleartext password) is accepted as a fallback because the protocol allows it; an empty
  salt is **refused**, because computing `md5(password + "")` would accept a token the
  caller chose by supplying nothing. Bumping `token_epoch` on a password change is what
  revokes an already-issued token.
- `auth/AccessAuthService` authenticates `/admin/*` behind Cloudflare Access. The bypass
  chain is `DEMO_MODE` → `DEV_AUTH_EMAIL` → JWT → the **`ACCESS` binding**, and the first
  two are gated on an **environment allow-list**. A deny-list would enable the bypass for
  `staging`, `Preview`, and a misspelled `prodcution`.

  It is a token (`Tokens.AccessAuthService`), resolved from the request scope like every
  other service. It was previously a `new` at the call site, which is the one construction
  in the app outside the composition root — and it re-derived an `AppConfiguration` per
  request. The constructor now takes the scope's config, so the whole request shares one.

  ### The binding is `env.ACCESS`, not `ctx.access`

  `getIdentity` lives on a **binding**, and Cloudflare provisions it for a Worker behind
  an Access application, so it **cannot be declared in a wrangler config** — `wrangler types`
  never emits it and `worker-configuration.d.ts` has no `ACCESS`. The shape is therefore
  hand-declared in `AccessAuthEnv` (and on `RequestScopeEnv`, so it survives the trip from
  `c.env` through the scope). `RequestScopeEnv` has no index signature, so the hand-written
  shape is load-bearing rather than decorative.

  This service used to read the identity off a cast `c.executionCtx`, which has only
  `waitUntil` and `passThroughOnException`. The branch could never execute: the fallback was
  documented in two `AGENTS.md` files and "tested" by six tests, none of which reflected the
  deployed path. `getIdentity` resolves **`undefined`**, not `null`, when no Access
  application is in front of the request, and the tests now assert that value.

Keeping them separate is a security property, not a convenience: an operator's Access
identity must not work as a streaming credential, and a Subsonic password must not open
the admin API.

**`Cf-Access-Authenticated-User-Email` is never trusted.** Cloudflare documents it as a
*response* header it sets; read back as a *request* header, any caller can name
themselves. Asserted in `test/admin-auth.test.ts` with a forged header, and again with a
forged `Cookie` beside it.

An unverified identity **inside** the trusted binding still does not authenticate — both
`emailVerified: false` and `email_verified: false` are refused. Cloudflare has used both
spellings, and accepting one is a fail-open that only shows up in production. Every JWT
failure collapses to one message: "signature verification failed" versus "expired" tells an
unauthenticated caller which part of the token they got right.

## Library

`library/LibraryService.ts` owns registration, the SSRF gate, and credential decryption.
`base_url` is stored as a **bare origin** — no path, query, fragment, or embedded
credential — because the root path is a separate field and an embedded credential would be
stored, returned by the admin API, and written to logs.

The gate refuses private, loopback, and link-local addresses unless
`ALLOW_PRIVATE_WEBDAV_HOSTS` opts in, because the Worker fetches `base_url` with the
library's **stored DAV password**: without the gate, an operator registration form is a
way to send that credential to `169.254.169.254` or to an internal service. Plaintext
`http` is allowed only for loopback.

## Scanning

`index/ScanService.ts` is a state machine advanced by `getScanStatus`. No cron, no Durable
Object, no trigger.

- A **`Depth: 0` root probe** settles "is anything new" in one subrequest: if the root
  mtime matches the stored one, the scan is over — 1 subrequest, 0 rows.
- Otherwise only folders whose mtime moved are descended. The `is_scanned` flag is written
  by the node upsert, so the frontier is the database's, not memory's.
- The chunk size is sized against the **1,000-subrequest limit**, not against
  convenience. A cold scan of 1,000 folders / 5,000 tracks is roughly 6,100 row writes
  against a 5,000/day allowance — survivable because the scan is chunked and resumable,
  and because every later scan writes zero rows.
- A failure leaves the frontier where it was, so the next poll resumes.

`index/TreeService.ts` does the read-through materialization: `getMusicDirectory` on an
uncached folder issues a live `PROPFIND` **and persists** what it found, so the second
client to ask is answered from D1.

## Enrichment

`index/EnrichmentService.ts` reads a **bounded prefix** of a file's bytes — never the whole
file — and derives duration, bitrate, sample rate, and channels from the container header.

- It short-circuits on `enriched_at`, which is why the scan must clear that column when a
  file's bytes change.
- A `WEBDAV` failure or an unreadable container resolves to "no enrichment" and is
  **recorded as an attempt**, so a format this server cannot read is not retried on every
  play. A transient error is deliberately *not* recorded, so a recovered origin is
  retried.
- It is best-effort about the cache and authoritative about D1: a dead `CACHE` costs
  latency and nothing else.

## Errors

`errors/ErrorMapper.ts` has two dialects, and the split is **by surface, not by
convenience**:

- `toSubsonicError` → the protocol envelope, HTTP 200, except `code=40` which is 401.
  `NotFoundError` becomes `70`; `UnauthorizedError` becomes `50` and **never** `40`,
  because a request that authenticated fine and was then refused is a different thing, and
  reporting it as 40 sends a user with valid credentials to re-enter their password. A
  5xx is masked completely: the cause is logged, and a D1 error names tables and columns.
- `toAdminResponse` → `{Exception:{Type,Message}}` with the status the SPA reads. A 4xx
  keeps its message; a 5xx is masked to the generic one.

**The reference project's argument against `Exception` applies to `/rest` only.** A
Subsonic client branches on the envelope, so a 401 with an unrecognized body renders as
"server error" instead of "wrong password". An SPA reads the HTTP status, so the same
shape is correct on `/admin` — and matching it is what removed a split-brain where the
rate limiter's 429 emitted `Exception` while every other admin error emitted
`{error:{code,message}}`. One surface, one dialect, one decoder.

## Composition

`composition/requestScope.ts` (`createRequestScope`) is the composition root: table-driven
lazy DAO wiring plus the service bindings, one scope per request. `composition/tokens.ts`
is the token set. `resolveKey` is the whole per-feature key policy and it **fails closed** —
see `docs/agents/runtime/AGENTS.md`.
