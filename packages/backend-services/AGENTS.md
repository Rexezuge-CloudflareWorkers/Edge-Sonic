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

`index/ScanService.ts` is a state machine advanced one chunk at a time. In
production the advancer is `ScanWorker` (`apps/background`, one Durable Object per
library, alarm-chained); without the `SCAN` binding the advancer is a direct
`step()` call (tests, local dev).

- A **`Depth: 0` root probe** settles "is anything new" in one subrequest: if the root
  mtime matches the stored one, the scan is over — 1 subrequest, 0 rows.
- Otherwise only folders whose mtime moved are descended. The `is_scanned` flag is written
  by the node upsert, so the frontier is the database's, not memory's.
- **A chunk is bounded three ways, and the three are not redundant** — they guard
  different resources. `chunkMaxRequests` (default 42) is the platform's subrequest ceiling
  **less an invocation reserve**: Workers Free allows **50 subrequests per invocation**, and
  a subrequest is a `fetch`, a **D1 statement**, a KV operation, a DO RPC or a Secrets Store
  read — D1 states its own limit as *queries per Worker invocation — 50 (Free)*.
  `chunkDeadlineMs` (default 20 s) is what makes a poll *return* on a slow origin.
  `chunkFolders` (default 7) bounds D1 work against the 5,000-rows/day allowance, and is
  **derived** from the ceiling rather than typed beside it: 40 folders is ~240 subrequests.
  The loop checks `budget.canAfford()` before each folder — at a folder's whole base cost of
  6, not at its one `PROPFIND`, because a chunk that starts a folder it cannot finish does
  not get a slow folder, it gets a terminated invocation — and before each enriched track at
  five, and **leaves early** rather than running itself out. A cold scan of 1,000 folders /
  5,000 tracks is roughly 6,100 row writes against a 5,000/day allowance, survivable because
  the scan is chunked and resumable and because every later scan writes zero rows.
- **Every subrequest is measured, not asserted.** `WebDavClient` charges a caller supplied
  `onRequest` inside its private `request()` — the single path `propfind`, `get`,
  `readPrefix` and `readTail` share — and the composition root makes the **scope's**
  `SubrequestCounter` the default `onRequest`, so a cover-art probe and a scan's `PROPFIND`
  are counted by the same object. D1 charges that same counter inside `BaseDAO`, KV inside
  `KvCache`. It used to be `+= 1` in the walk's loop, which counted nothing the enrichment
  did and under-reported by up to 40x; then it counted WebDAV and nothing else, which
  under-reported by ~5x and killed every chunk on a Free account. `ScanBudget` **wraps**
  the scope's counter rather than owning one, because a budget reading a second, private
  number while the DAOs write to the first is the same defect one layer up.
  `ChunkResult.subrequests` replaced `webdavRequests`, and the rename is the fix rather
  than cosmetics: a field called `webdavRequests` on a chunk that spends most of its budget
  on D1 is a field whose name contradicts its value, and the test that guarded it asserted
  the value equalled the WebDAV double's count — green while the chunk spent five times the
  ceiling.
- **`stoppedBy: 'requests'` is a normal, resumable return, and it was unreachable.**
  `stopReason` asks the **deadline first**: `remaining > 0` does not mean the chunk could
  have done anything, because it may have had five subrequests left and needed six for the
  next folder. Asking `remaining <= 0` reported `deadline` for that case, so an operator was
  told a slow origin had ended the chunk when a number had. And while the meter was blind
  to D1 the state could not occur at all — the operator surface had a string for it and could
  never render it, so a self-inflicted ceiling spent `MAX_CONSECUTIVE_FAILURES` as though it
  were a credential failure.
- **A folder larger than the invocation is resumable, not truncated-and-forgotten.**
  `runWriteBatch` splits a write batch by what is left of the budget and reports
  `truncated`; `reconcileFolder` writes the children first and the folder's own row — the
  one carrying `is_scanned: true` — last and only if nothing was truncated, and skips
  enrichment and the prune there, because the prune derives its delete set from the rows D1
  holds and would delete exactly the children the upsert could not write. A 500-track album
  is ~1,000 statements against a ceiling of 50, so this is the expected case on Free rather
  than an edge case.
- **The operator surface can advance a scan.** `POST /user/libraries/:id/scan/step`
  runs one chunk. `/rest/getScanStatus` was the only caller of `step`, so an operator
  clicking "Rescan" started a scan that only progressed while some *Subsonic client*
  happened to be polling. That route is also the only place `stoppedBy` is readable,
  because the Subsonic `scanStatus` element carries just `scanning` and `count`.
- **A poll backfills the derived grouping before it does anything else.** `step` runs
  `deriveBackfill` *ahead of* `decideStep`, and that placement is the fix rather than a
  detail. Every writer of `album`/`artist` is gated on a file having changed, so a library
  nobody has touched since it was indexed has nothing left to change and never derives its
  grouping — and a fully scanned library is `idle`, which returns without touching the
  walk at all. A backfill placed after the status check therefore never runs for exactly
  the libraries that need it, which is what the first attempt did: 113 rows, all indexed
  before the deploy, all with `album_ci` NULL, and every aggregate answering `[]`.
  It reads `dir_path` off the row, so it spends **no WebDAV subrequests** — one indexed read
  and one bounded write batch. Once a library is current the read returns no rows and the
  write batch is never issued, so a poll on a healthy library stays free.
- **`deriveFor` is the store's method, not a `map` and not a static.** Reading a page and
  deciding on that same page is one step, and a caller that did half of it would stamp rows it
  derived nothing for — which is how a backfill that re-selects its own work for ever is built.
  It is also on the `ScanDerivationStore` port rather than called as
  `SongDerivationDAO.deriveFor` because the marker it appends is `DERIVED_MARKER`
  configuration, and only the store was built with it: `deriveFromPath` takes the marker as a
  parameter, so a `static` method could only have read a module constant — the value the
  operator is explicitly no longer forced to take. `backend-services` is above `backend-data`,
  so the value is read once at the composition root and threaded down by constructor.
- **The backfill shares the chunk's budget, and its page is sized from it.** It runs
  *first*, so it competes with the walk for the same 42 statements, and its write is **one
  `UPDATE` per row** with `requireComplete` — it refuses rather than truncating, because the
  selection is on `derived_version` and a partial page leaves rows re-selected for ever.
  A page of `200` therefore fitted on **no chunk under any configuration**, so every library
  past ~48 owing rows threw `SubrequestBudgetExhaustedError` out of `derivePending` — which
  runs *before* `listFrontier`, so the walk never ran a folder, `step`'s catch recorded a scan
  failure, `isAdvancing('failed')` is `true`, and `getScanStatus` answered `scanning: true`
  for ever on a library of ~100 tracks. Four rules, and each is how the others collapse:
  - **The page is `SCAN_DERIVE_MAX_ROWS_PER_CHUNK`**, derived in `subrequests.ts` as
    `42 − SUBSREQUESTS_PER_CHUNK_OVERHEAD(4) − SUBSREQUESTS_PER_FOLDER_BASE(6) = 32`. A number
    typed beside the loop is wrong by the time the ceiling moves.
  - **`SUBSREQUESTS_PER_CHUNK_OVERHEAD` counts the two statements that *bracket* the walk**
    (`listFrontier` and `saveProgress`), not only the ones before it. Leave them out and the
    page is 35, which leaves 5 of a folder's 6 — the loop's `canAfford` refuses, and the
    chunk returns `scanning` having visited **zero** folders. Same symptom as the throw, no
    error anywhere, and what a fix that only deleted the throw would have shipped.
  - **`derivePending` checks `canAfford(rows.length)` and returns `0`.** The derived size
    bounds a chunk that has spent nothing; what decides whether *this* chunk can take the
    page is what it has already spent. Returning rather than throwing is the difference
    between a slow repair and a dead scan, and the rows are exactly the next poll's.
  - **It is charged against both bounds** — the wall-clock deadline, because D1 latency is
    real, and the subrequest ceiling, because a D1 statement *is* one. The claim that this
    phase "cannot spend" the ceiling is what let the oversized batch exist at all.
- **`saveProgress` takes a delta: `scanned_count = scanned_count + ?`.** It was `= ?`,
  read-modify-written by every chunk, while `fail` one method below already incremented its
  own counter in its own statement. A chunk can be overlapped — an operator
  `POST /user/libraries/:id/scan/step` while the alarm is live — so two chunks publishing the
  same read left the counter permanently **under-reported**. The work is done (`is_scanned`
  moves with the same statements); the count went backwards, which is exactly the "a row says
  one thing while its children say another" shape `test/scan-do.test.ts` is written against.
  It passed by an accident of interleaving: the losing order needs two chunks to read the
  same value, and the backfill's extra `await` at the top of every chunk was what finally
  made that order reachable. A guard that passes only because of a timing coincidence is not
  a guard.
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
- **`is_scanned` has two writers and one key, and a matching mtime cannot say which.**
  `reconcileFolder` used to write `isScanned: !changed`, reading a child's stored mtime as
  proof the child had been reconciled. But `nodes.mtime_ms` is written by the scan *and* by
  `TreeService`'s read-through browse, from the same `Depth: 1` PROPFIND — and the scan
  writes it having descended, while the browse writes it having read nothing below. So a
  browse-materialized library closed every one of its own folders on the first scan chunk
  and never indexed a track: 80 albums, none opened, `songs` empty, `scan_state` `idle`.
  `is_scanned` is now an **input** to `needsDescent` and not only its output, and
  "does this row need rewriting" is separated from "does this folder need descending".
  `start`'s incrementality short-circuit got the matching floor, because a completed scan
  that indexed nothing is not evidence the library is current — `scanned_count` counts
  folders *visited*, so that walk leaves it at `1`. See the parent index.
  - **The flag has two writers, so the flag's *values* are a decision and not a default.**
    `persistChildren` wrote `0` for every child, which meant a client merely looking at the
    root put all eighty album folders back on the frontier and the scan re-walked them — once
    per browse, on a `GET`. It now **preserves** the stored value and writes `0` only for a row
    it creates, which is what keeps `needsDescent`'s invariant intact for a folder discovered by
    browsing alone. Its *own*-row write is the opposite case and stays `0`: that folder's mtime
    moved, so its contents moved, so it genuinely has not been reconciled.
  - **The compare is one function, and the two writers are the reason.** `nodeWrite.ts` owns
    it because `reconcileFolder` described one in a comment without having it, which made a
    folder of ≥45 entries un-closable — 231,620 rows and a permanent `scanning`. Asserted as
    **convergence** in `test/scan-convergence.test.ts`, over real SQLite and a real counter,
    because every status- and shape-level assertion passes on both the broken and fixed code.
- **A spent D1 allowance is a `pause`, and `failed` and `stalled` are both the wrong answer.**
  `failed` retries within a bound; `stalled` never retries and needs an operator. A spent daily
  allowance does neither: it resolves at **midnight UTC**, by itself. It shipped as a loop —
  `step` caught the refusal, tried to record it with a write that could not succeed, returned
  `failed`, and the alarm re-armed a second later, ~86,400 times before the reset.
  - **`willResumeWithoutAPoll` and `isAdvancing` are two questions, and `paused` splits them.**
    The alarm asks *will this resume by itself?* (`true`); `getScanStatus`'s `scanning` asks
    *will my poll buy anything?* (`false` — polling cannot move a clock). One predicate for both
    is the mirror of the defect that made `scanning` mean "did this call do work".
  - **`step`, `start` and `status` all branch on it before touching `scan_state`**, because the
    fault *is* a refusal to write. Recording it costs a statement that cannot succeed and spends
    a retry budget meant for faults.
  - **It is paced *before* the platform refuses, not only survived after.** A correct chunk
    writes ~42 rows at ~1/second, so 5,000 rows/day is two minutes of scanning — the limit is
    reached by design. `SCAN_DAILY_ROW_WRITE_BUDGET` is the platform allowance less a reserve,
    divided by the number of *registered* libraries because D1's is per account.
  - Full account: `docs/issues/d1-daily-write-limit.md`. Asserted in `test/d1-daily-limit.test.ts`
    and `test/scan-do.test.ts`.
- **A listing that placed nothing is not a listing that found nothing.** `toLibraryPath`
  refusals are silent `continue`s, so a listing whose hrefs all fail containment empties
  `childPaths` and `songPaths` and the prune deletes the library as a mass deletion before
  reporting `idle`. RFC 4918 §8.3 makes that reachable on a healthy origin — a server may
  anchor `DAV:href` as `/owner/volume/…` or `/dir/file.txt` and both are correct.
  `reconcileFolder` throws before writing a row, counted **excluding the folder's own
  entry**, because an empty folder's `Depth: 1` listing is exactly one entry and failing
  those turned healthy scans into `stalled`.

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
  retried. The split is `isTransientEnrichmentFailure` in `index/enrichmentRetry.ts`,
  beside `shouldEnrich` because the two are one decision — what "already read" means and
  what earns the stamp — and it covers the tail read too: a prefix whose tags parsed and
  a tail that 503'd writes nothing, not even the good tags, because writing them would
  strand the duration at `0` with the same permanence. It shipped the other way round:
  every failure stamped the row, and four tracks of a live library caught a flapping
  origin during the scan and reported duration `0` for ever.
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

The chunk admits a track on the cost of **five** subrequests — the two external range reads
plus a `songMeta` KV read, an `applyMetadata` and a `songMeta` KV write — derived in
`subrequests.ts` rather than written beside the loop. It was `2`, which counted the external
reads alone, and admitting twenty tracks per folder on that reservation is ~100 subrequests of
work onto a budget of 50.

Per-folder enrichment is capped by `SCAN_ENRICH_MAX_PER_FOLDER` because a cold scan of
5,000 tracks is 5,000 subrequests against a 50 limit. What does not fit keeps
`enriched_at = null` and is enriched on first play — a degraded answer rather than a chunk
that fails. Failures are swallowed for the same reason: the scan's rows are already
written, and one unavailable origin must not discard them.

## Import

Bringing one user's player data in from **another Subsonic server**. Operator-triggered from
`/user/import/*`; the execution is `apps/background`'s `LibraryImportWorkflow` (a Workflow) and
`PlayCountImportWorker` (a Durable Object).

| File | Owns |
| --- | --- |
| `remoteOrigin.ts` | the SSRF gate on an operator-supplied host, and the mount path |
| `remoteParse.ts` | the **pure** parse rules for a response this repository does not control |
| `remoteClient.ts` | the transport: URL, token auth, timeout, body limit, subrequest charge |
| `sourceService.ts` | registering an instance, and the one reader of its stored credential |
| `matchRemoteIds.ts` | turning a foreign id into a local one — path, then metadata |
| `albumIdentity.ts` | the album and artist id matchers, under the configured grouping |
| `phases.ts` | playlists, stars, bookmarks, the play queue |
| `playCountPhases.ts` | the album and page halves of the play-count walk |
| `phaseShared.ts` | the two decisions every phase makes: grant-filtering, and naming failures |
| `report.ts` | the per-phase report, with every unresolved item **named** |
| `importPause.ts` | refusing to run beside a scan |

### The invariant the module exists to hold

**An unresolved id is reported, never substituted, and never silently dropped.** Every phase
returns the *named* items it could not match, with the reason. A playlist that lost three tracks
is a **wrong answer** rather than an unfinished one, and it is indistinguishable from one the user
deliberately shortened — so the operator gets a list rather than a count, and the cap
(`MAX_REPORTED_UNRESOLVED`) bounds the names while the count stays exact.

### Path first, then metadata — and the order is backwards from the intuition

Path is *exact*; metadata is a *guess*. So path is tried first and the guess is a fallback, and
the report says which strategy fired, because telling an operator an exact match is a guess is
its own kind of wrong.

`Child.path` is emitted by Navidrome and **not by this server** — it deliberately is not,
because publishing it leaks the storage layout of someone's WebDAV bucket. So path matching works
against third-party sources and **never** against another Edge-Sonic, and the fallback is what
carries a same-product migration.

### An ambiguous match is refused, not resolved

Two local songs can share an artist, album and title: a compilation, a live cut beside the studio
one, an `.flac` beside its `.mp3`. Choosing one is a coin flip that writes a star onto the wrong
track with no way to find out, so a key matching more than one local row resolves to nothing and is
reported as `ambiguous` — which is **recoverable information**, where a wrong match is not. Disc and
track narrow the candidates when the remote publishes them, and the narrowing is **skipped** rather
than applied against `null`, because a library with no disc tags has `disc = NULL` everywhere and
filtering for `1` would turn a resolvable match into a reported one.

### An album id is derived through the *same* key this server publishes

`albumKeyFor` calls `subsonic/albumKey.ts`'s `albumKeySpec` and nothing else, and
`SongMatchDAO.findPresentAlbumKeys` **confirms existence** before an id is minted. Two
implementations of "what is an album" would be free to disagree over a separator or over whether a
missing album artist is a value or a wildcard — and a disagreement is invisible until a star lands
on an album `getAlbum` cannot resolve, which **no client can see**, because the row exists.
Existence is checked because the release may simply not be indexed here yet.

### `remoteParse` is separate from `remoteClient` because it is pure

No `fetch`, no credential, no state — so every rule is testable from the Node suite with no Workers
runtime and no double, which is the same reason `packages/subsonic` is Layer 0. The two shapes it
must survive are a **single-element list collapsing to a bare object** (a one-track playlist read
naively imports as an *empty* one) and a **protocol error arriving as HTTP 200** (a wrong password
reads as "no playlists", and the import reports success having imported nothing).

Token auth, never `p=`: a password in a query string lands in the remote's access log and every
proxy's between here and there, and that is invisible from here.

### `sourceService` owns the credential, because `apps/api` may not

Two readers of one stored secret is two implementations of "decrypt it", free to disagree about
which key — and the credential *is* read twice: the route lists the remote's playlists before the
Workflow starts, and the Workflow reads it per step. A Workflow payload is persisted by the
platform, so a password can never be part of one. The client is built **per call**, never cached:
it holds the plaintext password for its lifetime.

## Errors

`errors/ErrorMapper.ts` has two dialects, and the split is **by surface, not by
convenience**:

- `toSubsonicError` → the protocol envelope, HTTP 200 for every protocol error,
  including `code=40`. `NotFoundError` becomes `70`; `UnauthorizedError` becomes `50`
  and **never** `40`,
  because a request that authenticated fine and was then refused is a different thing, and
  reporting it as 40 sends a user with valid credentials to re-enter their password. A
  5xx is masked completely: the cause is logged, and a D1 error names tables and columns.
  The one exception is a  `429` emitted by the rate limiter, which keeps its status so a
  client backs off — still in the envelope on `/rest`, so the dialect does not split.
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
