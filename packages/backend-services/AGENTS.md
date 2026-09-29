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
- `auth/AccessAuthService` authenticates `/user/*` behind Cloudflare Access. The bypass
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
the user API.

**`Cf-Access-Authenticated-User-Email` is never trusted.** Cloudflare documents it as a
*response* header it sets; read back as a *request* header, any caller can name
themselves. Asserted in `test/user-auth.test.ts` with a forged header, and again with a
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
stored, returned by the user API, and written to logs.

The gate refuses private, loopback, and link-local addresses unless
`ALLOW_PRIVATE_WEBDAV_HOSTS` opts in, because the Worker fetches `base_url` with the
library's **stored DAV password**: without the gate, an operator registration form is a
way to send that credential to `169.254.169.254` or to an internal service. Plaintext
`http` is allowed only for loopback.

### `probe` has one `try` per step, and the wording lives in `probeOutcome.ts`

`probe` is the only place an operator can find out why a library does not work, and it
used to wrap all three steps in one `try`, so every failure without an HTTP status
collapsed into *"Library is unreachable."* That is a claim about the operator's WebDAV
server, and it is false for three of the four causes: `resolveKey` refusing (a
misconfigured deployment), `decryptData` failing (a rotated key over an existing row),
and `assertReachable` refusing (an SSRF-policy decision, where the origin was never
contacted at all). It shipped against a live origin answering `207` with a correct
password.

So the three steps are three `try` blocks, and each `catch` can only mean the thing it
wraps. The messages are constructors in `library/probeOutcome.ts` rather than branches
in the service, because the taxonomy is the thing worth reading in one place, and
because a wording change should not be a diff through three call sites. Two rules keep
it honest: **no cause text and no upstream body ever reaches the operator** — a GCM
failure message names the operation and nothing else — and *"unreachable"* is produced by
exactly one branch, so the word means something when it appears.

`assertReachable`'s own `NotFoundError` is unchanged. Its indistinguishability from a
missing row is deliberate on `/rest`; only the way the *operator* surface renders it
changed, and the operator can already see the row in their own list.

A timeout arrives as a `WebDavError(408)` rather than a bare abort — see
`packages/webdav`. That translation is what makes this classification possible at all,
since an `AbortSignal.timeout` rejection is neither an `Error` shape callers classify
nor an HTTP status.

## Scanning

`index/ScanService.ts` is a state machine advanced by `getScanStatus`. No cron, no Durable
Object, no trigger.

- A **`Depth: 0` root probe** settles "is anything new" in one subrequest: if the root
  mtime matches the stored one, the scan is over — 1 subrequest, 0 rows.
- Otherwise only folders whose mtime moved are descended. The `is_scanned` flag is written
  by the node upsert, so the frontier is the database's, not memory's.
- **A chunk is bounded three ways, and the three are not redundant** — they guard
  different resources. `chunkMaxRequests` (default 40) is the platform's *external*
  subrequest ceiling, which is **50 on the Free plan** and 10,000 on Paid; the 1,000
  these were originally sized against was retired on 2026-02-11. `chunkDeadlineMs`
  (default 20 s) is what makes a poll *return* on a slow origin. `chunkFolders`
  (default 40) bounds D1 work against the 5,000-rows/day allowance. The loop checks
  `budget.canAfford()` before each folder and before each enriched track, and **leaves
  early** rather than running itself out — a cold scan of 1,000 folders / 5,000 tracks
  is roughly 6,100 row writes against a 5,000/day allowance, survivable because the
  scan is chunked and resumable and because every later scan writes zero rows.
- **The subrequest count is measured, not asserted.** `WebDavClient` charges a caller
  supplied `onRequest` inside its private `request()` — the single path `propfind`,
  `get`, `readPrefix` and `readTail` share — and `ScanService` threads one meter
  through `clientFor` *and* through `enrichSong`, so a range read the scan causes is
  charged to the same ceiling as the `PROPFIND` that found the file. It used to be
  `+= 1` in the walk's loop, which counted nothing the enrichment did and
  under-reported by up to 40x.
- **The operator surface can advance a scan.** `POST /user/libraries/:id/scan/step`
  runs one chunk. `/rest/getScanStatus` was the only caller of `step`, so an operator
  clicking "Rescan" started a scan that only progressed while some *Subsonic client*
  happened to be polling. That route is also the only place `stoppedBy` is readable,
  because the Subsonic `scanStatus` element carries just `scanning` and `count`.
- A failure leaves the frontier where it was, and the next poll **resumes** — bounded.
  `step` re-enters a `failed` scan rather than treating the status as terminal, because it
  used to, and that made one bad chunk permanent: the frontier sat intact in D1 and
  nothing read it again, so 80 albums stayed at one scanned folder for the life of the
  deployment. It was invisible because `getScanStatus` derived `scanning` from the status,
  which is what a client reads as *stop polling* — so the client stopped too. Bounded by
  `scan_state.consecutive_failures` (`MAX_CONSECUTIVE_FAILURES`), because unbounded is the
  opposite defect: a revoked credential re-attempted on every poll for ever, spending the
  operator's subrequest budget to reach the same conclusion each time. `stalled` is a
  separate status from `failed` because the two mean **opposite things about what happens
  next**; `startScan` clears the counter, so the operator's escape hatch needs no surface
  of its own. `scanRetry.ts` owns the decision and the `scanning` mapping — `step` used to
  answer both inline, and the tangle is what shipped.
  The counter lives in D1 rather than in a module variable because it must survive the
  isolate: a counter that resets when a different isolate serves the next poll is not a
  bound.

`ChunkResult` is declared in `index/scanTypes.ts` beside the service's inputs, because
it is a contract a test writes against — and a field added to the result with no fake
that produces it is a field nothing exercises. It carries **`lastError`**: the
`scan_state.last_error` the DAO has always written and that nothing ever read back. A
failed scan told an operator "failed" and no reason, which is the same defect as a probe
reporting "unreachable" — the diagnosis existed and was not on the screen. It is bounded
in the service as well as in the DAO, so what an operator is shown is exactly what was
persisted rather than a longer string the database never held.

`index/TreeService.ts` does the read-through materialization: `getMusicDirectory` on an
uncached folder issues a live `PROPFIND` **and persists** what it found, so the second
client to ask is answered from D1.

## Enrichment

`index/EnrichmentService.ts` reads a **bounded prefix** of a file's bytes — never the whole
file — and derives duration, bitrate, sample rate, and channels from the container header.
For Ogg it then reads a bounded **tail** (`readTail`, `TAG_READ_TAIL_BYTES`), because the
granule position that carries the file's length is in the *last* page's header. Two range
reads over one file, not two parses: the sample rate, channels and pre-skip come from the
prefix read and the tail reuses them. Without the tail read the duration is `null` rather
than wrong, because a client seeks by it.

- It short-circuits on `enriched_at` **and** `reader_version`, which is why the scan must
  clear both when a file's bytes change. `shouldEnrich` is a pair, not one predicate, and
  the second half is not optional bookkeeping: keying on `enriched_at` alone makes this
  whole file inert on an existing library, because a corrected reader cannot reach a row an
  older one wrote. It shipped — the reader was fixed, deployed, and every existing row
  kept its wrong duration, bitrate and missing tags through a `getSong`, a rescan and a
  re-index. `enrichFacts` takes an `EnrichFacts` (id, path, size, mtimeMs) rather than a
  `SongRow`, so the scan does not fabricate one; a fabricated row is a copy of the schema
  that rots silently when a column is added.
- **Enrichment is not what makes a library browsable, and treating it as though it were
  is why it shipped broken.** The aggregates filter on the `_ci` columns in SQL, so a
  track this module has not read is *absent* from `getArtists`, `getAlbumList2` and
  `search3` — not shown with a blank name. Since the read is one ranged request per track
  and is bounded twice over, most rows of a real library are unenriched for a long time,
  and the whole tag-organized half of the protocol answers `[]` while `getRandomSongs`,
  which does not group, returns rows happily. So the artist and album the WebDAV *path*
  already carries are derived at index time instead (`pathConvention.ts` in
  `backend-data`), and this module's real tags overwrite that fallback when it runs.
  The two are the same fact read by two means, and the path is always available while the
  ranged read is not.
- A `WEBDAV` failure or an unreadable container resolves to "no enrichment" and is
  **recorded as an attempt**, so a format this server cannot read is not retried on every
  play. A transient error is deliberately *not* recorded, so a recovered origin is
  retried.
- It is best-effort about the cache and authoritative about D1: a dead `CACHE` costs
  latency and nothing else.

### The scan enriches what it changed

Enrichment is reachable from two places, and they share one read path (`readAndPersist`)
so a row enriched by a scan and a row enriched on first play are identical: `getSong`, and
`index/scanEnrichment.ts` from the scan. Without the second caller, a browsing client saw
`duration: 0` and no artist on every track until it happened to open one — and the
aggregates were empty because there was nothing to group.

The scan passes a four-field `EnrichFacts` rather than a `SongRow`. It has no row in hand,
and a fabricated one is a copy of the schema that rots silently when a column is added:
the failure is a wrong answer, not a type error.

The per-folder cap (`SCAN_ENRICH_MAX_PER_FOLDER`) and the chunk's request ceiling are
**different bounds**, and each collapses into the other if one is removed. The cap shapes
one album: without it, an album of 500 changed tracks takes the whole chunk budget and
the folders behind it are never walked. The ceiling spends what the `PROPFIND`s leave, and
enrichment takes the remainder — so a wide-changed album can end its own chunk, which is
the trade made deliberately, because a chunk that ends early is resumable and a chunk that
exceeds the platform's ceiling is not.

Per-folder enrichment is capped by `SCAN_ENRICH_MAX_PER_FOLDER` because a cold scan of
5,000 tracks is 5,000 subrequests against a 1,000 limit. What does not fit keeps
`enriched_at = null` and is enriched on first play — a degraded answer rather than a chunk
that fails. Failures are swallowed for the same reason: the scan's rows are already
written, and one unavailable origin must not discard them.

## Errors

`errors/ErrorMapper.ts` has two dialects, and the split is **by surface, not by
convenience**:

- `toSubsonicError` → the protocol envelope, HTTP 200, except `code=40` which is 401.
  `NotFoundError` becomes `70`; `UnauthorizedError` becomes `50` and **never** `40`,
  because a request that authenticated fine and was then refused is a different thing, and
  reporting it as 40 sends a user with valid credentials to re-enter their password. A
  5xx is masked completely: the cause is logged, and a D1 error names tables and columns.
- `toUserResponse` → `{Exception:{Type,Message}}` with the status the SPA reads. A 4xx
  keeps its message; a 5xx is masked to the generic one.

**The reference project's argument against `Exception` applies to `/rest` only.** A
Subsonic client branches on the envelope, so a 401 with an unrecognized body renders as
"server error" instead of "wrong password". An SPA reads the HTTP status, so the same
shape is correct on `/user` — and matching it is what removed a split-brain where the
rate limiter's 429 emitted `Exception` while every other user error emitted
`{error:{code,message}}`. One surface, one dialect, one decoder.

## Composition

`composition/requestScope.ts` (`createRequestScope`) is the composition root: table-driven
lazy DAO wiring plus the service bindings, one scope per request. `composition/tokens.ts`
is the token set. `resolveKey` is the whole per-feature key policy and it **fails closed** —
see `docs/agents/runtime/AGENTS.md`.
