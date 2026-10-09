# Edge-Sonic — Scanning

Scope: `packages/backend-services/src/index` (the state machine, the budget, the
derivation backfill) and `apps/background` (the Durable Object that drives it). Reads
for: anyone changing the walk, the budget, or what a scan status means.

The scan is the only unbounded work in the product: it is a whole library, an origin that
answers at its own pace, and an invocation ceiling of **50 external subrequests**. Every
invariant here is either about **bounding** that work or about **what a client is told
when the bound is reached** — and the second half is where it has repeatedly gone wrong,
because "no progress" and "failed" and "paused" are three different promises.

The `paused` mechanism is deliberately split across layers: `scanRetry.ts`
(`backend-services`) decides the status and `ScanPauseStore` (`apps/background`) stores
it and lets it override the row. The reason is in the invariant below — it is the only
store still accepting writes when D1 is refusing them.

## The numbers

All derived in `packages/backend-runtime/src/config/subrequests.ts` from one platform
number, `WORKER_SUBSREQUEST_CEILING = 50`:

| Constant                          |  Value | Derivation                                              |
| --------------------------------- | -----: | ------------------------------------------------------- |
| `SCAN_CHUNK_SUBSREQUEST_BUDGET`   |     42 | `50 − 8` the invocation's own statements                |
| `SUBSREQUESTS_PER_FOLDER_BASE`    |      6 | one folder's **whole** cost, not its one PROPFIND       |
| `SUBSREQUESTS_PER_ENRICHED_TRACK` |      5 | prefix + tail + KV read + write + apply                 |
| `SUBSREQUESTS_PER_CHUNK_OVERHEAD` |      4 | `ensure`, backfill read, `listFrontier`, `saveProgress` |
| `SCAN_CHUNK_FOLDER_LIMIT`         |      7 | `floor(42 / 6)`                                         |
| `SCAN_ENRICH_MAX_PER_FOLDER`      |      8 | `floor(42 / 5)`                                         |
| `SCAN_DERIVE_MAX_ROWS_PER_CHUNK`  |     32 | `42 − 4 − 6`                                            |
| `SCAN_DAILY_ROW_WRITE_BUDGET`     | 90,000 | `100,000 − 10%`, divided by library count at use        |

A chunk is bounded by **both** a request ceiling and a wall-clock deadline, and
`canAfford` is checked **before** each unit of work.

## Invariants

Violating any of these reintroduces a fixed defect. The suite asserts each one.

- **A chunk is bounded by a _measured_ request count, not by a folder number.**
  `getScanStatus` is not a progress read — it _is_ the scan — so one call descending
  `SCAN_CHUNK_FOLDERS` folders sequentially is unbounded work on a surface whose
  clients time out. It shipped: a chunk on a 2.2 s origin took ~88 s while clients
  gave up at ~45 s, so the work finished server-side where nobody was watching, and
  a client that backed off stopped advancing the scan _by construction_. Enrichment
  then moved per-track range reads inside that same loop, taking a chunk from 40
  subrequests to 1,640 — past the ceiling, so a chunk that **fails** rather than one
  that is slow. Two rules, and each is how the previous one collapsed:
  - **The count is taken where the request is issued.** `WebDavClient` takes an
    `onRequest` callback invoked inside its private `request()`, the one path
    `propfind`/`get`/`readPrefix`/`readTail` all funnel through. `webdavRequests`
    used to be `+= 1` inside the walk's loop, which charged the `PROPFIND`s and
    nothing the scan's own enrichment caused — an undercount of up to 40x, on a field
    whose comment claimed it was instrumented "so the budget is testable". A
    caller-incremented counter is a _claim_ about work; one incremented at the choke
    point is a measurement of it, and only the second can bound anything.
  - **A bound that is not checked is not a bound.** `webdavRequests` was returned in
    `ChunkResult` and compared against nothing anywhere. There is now a request
    ceiling _and_ a wall-clock deadline, the loop checks `canAfford` **before** each
    unit of work, and the remainder of the frontier is simply left for the next poll.
    Asserted in `test/scan-budget.test.ts`: `webdavRequests` is compared against what
    the `fakeDav` double actually received, a `fakeDav` gained a real `latencyMs` so a
    deadline is observable at all, and every bound test is paired with one that shows
    the guard has teeth. The same rule the previous invariant records, one level up: the
    budget lived in a comment and in the choice of default numbers, and **a comment is
    not a measurement**.
- **A subrequest is not only `fetch`, and budgeting the easy one to measure kills the
  invocation.** Workers Free allows **50 subrequests per invocation**, and D1 counts
  its own queries against the same 50 — _"Queries per Worker invocation — 1000 (Workers
  Paid) / 50 (Free)"_ — as do KV, Durable Object RPCs and Secrets Store reads. Cloudflare's
  own two limits pages disagree on the internal-service question (the Workers page carries a
  _subrequests to internal services: 1,000 on Free_ row), and this repository believed the
  wrong one for long enough to ship a broken scan: `ScanBudget` metered
  `WebDavClient.request()` and nothing else, so a chunk of 40 folders charged its budget
  **40** and spent the platform **~240**. It crossed the ceiling inside its first album,
  `ScanWorker.alarm` caught an error nothing in the scan can see, re-armed a second later,
  and each dead invocation banked ~20 tracks — which is why a 110-track library _finished_
  while no chunk ever completed. **The belief was itself wrong, and is now measured:**
  external `fetch` and internal-service calls are drawn from **separate** budgets —
  50 external, 1,000 to Cloudflare services — confirmed on a Free account on 2026-10-05.
  Charging D1 against the 50 is therefore **conservatism, not correction**, roughly 21×
  over the figure it bounds, and kept because a ceiling that is too small costs throughput
  while one that is too large takes the product down. Full account:
  `docs/issues/subrequest-budgets-are-two-not-one.md`. Four rules, and each is how the
  previous one collapsed:
  - **One counter, owned by the request scope, charged at the choke point.** `fetch` was
    easy to instrument because `WebDavClient` has a private `request()`; D1 and KV were not
    counted because nothing forced them to be, and a forgotten charge has **no symptom at
    all** until the platform kills the invocation — the statement works, the rows are
    right, the suite is green. `BaseDAO.withRetry` is the one path every D1 statement
    takes, so charging there is one line rather than a hundred chances to forget one.
  - **Charge pessimistically where the platform is ambiguous.** A D1 `batch()` of N
    statements is 1 or N subrequests and the docs do not say; charging N costs throughput
    if N is wrong and costs availability if 1 is.
  - **The per-unit reservation is the unit's whole cost.** `MAX_REQUESTS_PER_TRACK = 2`
    counted a prefix read and a tail read — the two _external_ requests — while the same
    track also costs a `songMeta` KV read, an `applyMetadata` and a `songMeta` KV write.
    Admitting 20 tracks per folder on the cost of two each is ~100 subrequests of work onto
    a budget of 50. Likewise a folder: the walk checked one `PROPFIND`, and a chunk that
    starts a folder it cannot finish does not get a slow folder, it gets a terminated
    invocation.
  - **Every bound is derived from the one platform number, and clamped to it.**
    `subrequests.ts` holds `WORKER_SUBSREQUEST_CEILING = 50` and computes the chunk budget
    (`50 − 8` for the invocation's own statements), the folder count (`floor(42/6)`), the
    enrich cap (`floor(42/5)`) and `MAX_PAGE_SIZE_CEILING`. The three scan vars are
    **clamped**, because the operator surface was telling people to raise one of them: on
    Free the ceiling cannot be raised, and following that advice converts a chunk that
    pauses into a chunk the runtime terminates.
    A budget that ran out is a **pause**, not a failure — `stoppedBy: 'requests'` was
    structurally unreachable while the meter could not see D1, so a self-inflicted ceiling
    spent the retry budget on every attempt and the operator surface had a string for a state
    it could never render. Asserted in `test/subrequest-budget.test.ts` (per charge point,
    with negatives) and `test/scan-budget.test.ts` (a whole chunk, against a store double
    that charges). Full account: `docs/issues/free-plan-subrequest-ceiling.md`.
- **A write that is larger than the invocation must be resumable, or it must be refused.**
  A 500-track album is ~1,000 statements against a ceiling of 50, so truncation is the
  _expected_ case on Free rather than an edge case. `runWriteBatch` splits by what is left
  and reports `truncated`; `reconcileFolder` writes the children **first** and the folder's
  own row — the one carrying `is_scanned: true` — **last and only if nothing was
  truncated**, so a half-written folder stays on the frontier and the next chunk finishes it.
  The prune is skipped there, because it derives its delete set from the rows D1 holds and
  would otherwise delete exactly the children the upsert could not write. A browse cannot
  resume, so `TreeService` persists nothing and answers from the listing it already holds. And
  a write that has no partial form — a play queue, a playlist's `song_count`, the derivation
  backfill — refuses with a `413` instead, because half a queue is a _shorter queue_, which
  is a wrong answer rather than an unfinished one.
- **A stored failure is read back, or it was never written.** `scan_state.last_error`
  was populated on every scan failure and read by nothing, and `apps/web` declared a
  `ScanStateSummary.lastError` the server never sent — so a failed scan rendered the
  bare word "failed" while the reason sat in the database. Persisting a diagnosis
  nobody can retrieve is the same defect as never computing it, and the type declared
  the field, so nothing ever reported the gap. Wiring it up is what named the
  `Illegal invocation` above: the reason had been in the database the whole time.
- **A failed scan is retried, and the retry is bounded.** `ScanService.step` used to
  short-circuit on any status other than `scanning`, and `fail` sets `failed` — so **one bad
  chunk ended a scan permanently** with the frontier sitting intact and unread in D1. A
  library of eighty albums stayed at one scanned folder for the life of the deployment,
  and `getScanStatus` reported `{"scanning": false, "count": 1}` because it derived
  `scanning` from the status, which is exactly what a client reads as _stop polling_. Only
  `startScan` recovered, and `startScan` runs at client startup, not while browsing. The
  module header claimed the opposite and the claim was true of the frontier and false of
  the code reading it. So: a `failed` scan is re-entered, bounded by
  `scan_state.consecutive_failures` — a bound, because unbounded is the opposite defect
  (a revoked credential re-attempted for ever, spending the operator's subrequest budget to
  reach the same conclusion each poll). `stalled` is separated from `failed` because they
  mean **opposite things about what happens next**, and `getScanStatus` answers
  "will more work happen if I poll again", not "did this call do work". Asserted in
  `test/scan-incremental.test.ts` (resumes; gives up; `startScan` resets) and
  `test/endpoints.test.ts` (the wire shape, since the mapping is the client-facing claim).
- **A row with no tags is absent from every aggregate, not shown with a blank name.**
  `listAlbums` filters `album_ci IS NOT NULL AND album_ci <> ''`, `listArtists` filters
  `artist_ci IS NOT NULL`, `listGenres` filters `genre_ci IS NOT NULL` — and those columns
  are written _only_ by a tag read, which costs one ranged request per track and is bounded
  twice over. So for a library of any size most rows are unenriched for a long time, and
  the whole tag-organized half of the protocol answers `[]` while `getRandomSongs`, which
  does not group, returns rows happily. It shipped. The fix is to derive `album`/`artist`
  from `dir_path` at index time (`pathConvention.ts`, handling both `Artist/Album` and the
  flat `Artist - Album` layout), written through the existing upsert rather than as extra
  statements. `genre`, `track` and `year` are deliberately **not** derived: a guessed genre
  is offered to the user as fact, and `getGenres` would publish it with a song count. An
  uninformative path yields NULL, never `''`, because `''` groups under a blank name — the
  same defect `NodeDAO.listRoots` had with the root.
- **A folder too large for one invocation must be _closable_, or the scan writes the same
  rows for ever.** `runWriteBatch` truncates a folder's children against the
  invocation's subrequest ceiling — 45 statements on the Free plan — and `reconcileFolder`
  writes the folder's own `is_scanned: true` **only if nothing was truncated**. That is the
  resumability mechanism, and it only resumes if the next pass offers strictly fewer rows.
  It did not: `reconcileFolder` had no comparison, so the rows it had already written were
  the rows it re-offered _first_, the truncation landed on the same offset every time, and
  progress on the next pass was zero. So **any folder with ≥45 entries could never be
  closed**, and every chunk rewrote the same ~45 rows. It shipped: **231,620 rows written on
  `nodes`** for one 80-album, 110-track library, `is_scanned` never reaching 1, the frontier
  never draining, and `getScanStatus` reporting `scanning` throughout — 231,620 ÷ 45 ≈ 5,147
  chunks, and the two numbers are the same measurement. Nothing reported it: `stoppedBy`
  answered `'frontier'` because the chunk did consume its whole (one-folder) frontier, and
  `rowsWritten` is only readable through `POST /user/libraries/:id/scan/step`. Full account:
  `docs/issues/nodes-upsert-livelock.md`. Four rules, and the second is why the first alone
  was not enough:
  - **The compare exists, it is one function, and it was already written — elsewhere.**
    `TreeService.persistChildren` had it; `reconcileFolder` described it in its own docstring
    and had no such branch. Two writers and two answers, and the second answer was _no
    comparison at all_. `nodeWrite.ts` owns it now, and its caller-side and statement-side
    halves are **both** required: `runWriteBatch.truncated` counts statements **issued**, not
    rows changed, so `NodeDAO.UPSERT`'s new `WHERE` makes redundant writes free but does not
    make a caller that offers 80 rows for a 45-statement budget converge. The `WHERE` is
    defence in depth; the compare is the fix.
  - **`updated_at` is excluded from the statement's `WHERE`, and that is why.**
    It is `nowSeconds()`, so it is the one column that _always_ differs — including it would
    make every comparison true and the guard a comment. It is consequently the one column a
    no-op upsert does not move, which is what keeps "when was this row last actually touched"
    answerable. The other half: `IS NOT`, not `!=`, because `NULL != NULL` is `NULL` and in a
    `WHERE` that is false — so a row whose etag went from a value to none looked unchanged and
    its subtree froze. That permissive direction is the dangerous one.
  - **A browse does not get to say a folder was descended into.** `persistChildren` wrote
    `is_scanned = 0` for every child, so a client merely _looking at_ the root put all 80
    album folders back on the frontier and the scan re-walked them — once per browse, on a
    `GET`, spending the same allowance. The flag means "someone descended into this" and that
    path demonstrably has not. It now **preserves** the stored value and writes `0` only for
    rows it creates — which is what keeps `needsDescent`'s invariant intact for a folder
    discovered by browsing alone.
  - **A ceiling the write batch cannot see is a ceiling it spends.** `BaseDAO.fitCount` read
    `meter.remaining`, the **platform's** 50, rather than the chunk's own 42 — so a batch spent
    the invocation's 8-statement reserve and the post-walk `saveProgress` then crossed 50 and
    the runtime terminated the invocation. Measured at 52 against a ceiling of 50. The fix is
    `SubrequestCounter.setCeiling` and `ScanBudget` calling it, because `ScanBudget` is layer 3
    while every charge point that matters is below it holding only the meter — so the meter is
    the one place the two can meet.
  - **A guard is convergence, and convergence is a measurement no status assertion makes.**
    `test/scan-convergence.test.ts` drives the real DAO over `node:sqlite` with a real
    `SubrequestCounter` and asserts each pass writes **strictly less** than the one before.
    Removing either the compare or the `WHERE` turns seven of its cases red while every
    status- and shape-level assertion in the suite stays green — which is the finding, because
    the two doubles that hid this (`scan-budget`'s `upsertMany`, which _skipped_ unchanged
    rows, and `scan-incremental`'s `chunkMaxRequests: 10_000` with a double that never
    truncates) each modelled the fixed implementation or a bound that never fires.
- **A compare must read the table the row it guards lives in.** This is the same rule as
  `nodeRowNeedsWrite` above, one column further out, and it cost a track on a live library:
  **117 `nodes` rows against 116 `songs` rows**, one song absent from every album list while its
  `nodes` row sat there current.
  `reconcileFolder` gates both writers on `changed`, which is `mtimeMoved || etagMoved` read off
  the **`nodes`** row — so the song writer was answering a node's question about a song's row. The
  two upserts are separate batches and `runWriteBatch` truncates each against the meter's
  remaining budget **independently**, so a pass can land every node row and truncate the song rows.
  `truncated` then correctly kept the folder on the frontier — and the next pass read the node
  rows, found every mtime already current, computed `changed === false` for all of them, offered
  nothing, saw no truncation, and closed the folder.
  Nothing else reaches that state, which is what makes it permanent rather than merely unlikely:
  `songPaths.push` runs _before_ the gate, so the prune keeps the path and never deletes a row that
  was never written; and `startScan`'s root-mtime probe means the folder is not re-listed at all.
  No error, no retry, no operator — one chunk boundary in the wrong place, once. Three rules:
  - **The gate names its own table's answer.** `songRowMissing = known?.has_song !== 1`, beside
    `changed` rather than merged with it, because they are different questions and only one of them
    is about the file. Asserted in both directions: a folder with a song row for every child and
    nothing moved still writes **zero** rows, or adding a second reason to write quietly takes the
    "an unchanged rescan is free" invariant with it.
  - **The read is one statement, not two.** `NodeDAO.listChildrenWithSongPresence` is
    `listChildren` plus a `LEFT JOIN songs … ON (library_id, path)`, riding
    `idx_songs_library_path` and leaving the driving predicate on `idx_nodes_parent_ci` alone. The
    obvious alternative — a second `SELECT path FROM songs` per folder — also works, and costs a
    subrequest per folder against a ceiling of 50, so `SUBSREQUESTS_PER_FOLDER_BASE` and both
    constants derived from it would have to rise. **The bound is unchanged at 6**, and
    `test/scan-convergence.test.ts` asserts a folder still fits inside it, so a future change that
    does spend a statement here turns red rather than quietly taking a folder's share.
    `EXPLAIN QUERY PLAN` is asserted in `test/schema.int.test.ts` because a wrong join and a
    right one return identical rows.
  - **The audio test runs before the gate, and that ordering is load-bearing.** `has_song` is `0`
    for every non-audio child, so reading it first would offer `cover.jpg` to the song upsert on
    every pass, for ever — an album of art that never converges and art in `search3`. Asserted with
    a cover in the fixture; the count is the assertion.
  - **Reordering the two batches is not a fix**, and that is worth recording because it looks like
    the cheap one. Whichever batch truncates, the other can still land, so the asymmetry survives
    any order — only reading the row's own table removes it. Asserted by mutation: reverting the
    gate to `if (changed)` fails four cases, and moving the audio test below it fails three more.
    This is the third instance of the file's own recurring shape — **a compare standing in for a
    measurement** — and the reason it recurs is that `changed` reads correctly and reads _the wrong
    table_: a predicate nobody can distinguish from the right one by reading it.
- **A spent D1 daily allowance is a _pause_, and it is not `failed`.** Since 2026-09-01 a
  Free account over its daily row allowance has **every query fail** — reads included — until
  **midnight UTC**, so the whole product is down (Subsonic auth reads `users`) and the remedy
  is a clock. It shipped as a loop: `step` caught the refusal, tried to record it with a D1
  write that _could not succeed_ (the fault **is** a refusal to write), returned `failed`,
  `isAdvancing('failed')` is true, and the alarm re-armed one second later — ~86,400 times
  before the reset, each attempt two failed statements, with `getScanStatus` reporting
  `scanning: true` and the cause masked into `code=0`. `paused` is the third answer: retried
  **by itself, at a known time, needing no operator**. Neither existing status could carry it —
  `failed` retries (a loop) and `stalled` never does (a wedge until an operator acts). Four
  rules:
  - **Two questions, so two predicates.** The alarm asks _will this resume by itself?_
    (`true`); `getScanStatus`'s `scanning` asks _will my poll buy anything?_ (`false` — polling
    cannot move a clock). One predicate for both is the shape of defect that once made
    `scanning` mean "did this call do work" and stopped every scan; its mirror deletes the
    alarm and leaves an allowance spent. `willResumeWithoutAPoll` and `isAdvancing` are
    separate, agree on every other status, and are asserted to.
  - **The pause lives in Durable Object storage, and that is the mechanism rather than a
    convenience.** It is the only store still accepting writes when D1 is refusing them, so a
    pause in `scan_state` would be unwritable exactly when needed — and `/user/libraries`, which
    reads D1, could not see it either. `getStatus` reads it back and lets it **override** the
    stored row, because D1's row is _guaranteed_ stale about it: it says `scanning`, which an
    operator reads as working. The stated exception to "D1 stays authoritative"; the frontier,
    every indexed row, the retry counter and the index version are all still D1's.
  - **The limit is reached by design, so the scan paces itself before the platform refuses.**
    A correct chunk bills a few hundred rows at ~1/second, so the Free plan's 100,000-row day is
    **a couple of hours** of scanning on a 5,000-track library — the runaway above was not the
    only way there, and a fix that only made the outage survivable would leave it frequent.
    `SCAN_DAILY_ROW_WRITE_BUDGET` is the platform's allowance less a **10%** reserve for
    non-scan writes, **divided by the number of registered libraries** (the allowance is per
    _account_, so a per-library cap is unsound the moment a second library exists, and
    `MAX_LIBRARIES` would give a one-library deployment a tenth of what it could have had).
    Counted in **billed** rows, held in DO storage because **metering D1 writes must not itself
    spend D1 writes**, and persisted at most once per 500 rows — which makes it a lower bound,
    absorbed by the reserve.
  - **The metered unit is a billed row, and the multiplier is the schema.** D1 bills a write as
    the row _plus every index entry it rewrote_ (pricing page, definition 6), so `songs` is **ten**
    per row — nine indexes, one of them the implicit `sqlite_autoindex` for `id TEXT PRIMARY KEY`,
    which is why counting `CREATE INDEX` statements by eye undercounts every table in this schema by
    one. The guard was counting table rows: `runWriteBatch` summed `meta.changes`, and
    `EnrichmentService` declared `1` because `applyMetadata` returned `void`. So the budget believed
    it had ten times its headroom on the dominant write path. Three rules:
    - **Two fields, not one corrected one.** `rowsWritten` is progress and is what
      `scan-convergence` measures; `billedRows` is cost and is what the daily budget is charged.
      `ScanDailyBudget.rowsWrittenToday` became `billedRowsWrittenToday` — a field that does not
      say which unit it is in cannot be compared against a limit without someone checking.
    - **Derived from `sqlite_schema`, not typed beside a query.** `billedRows.ts` declares the
      per-table counts and `test/schema.int.test.ts` asserts them against the real schema in both
      directions, so a migration adding an index turns the suite red: the `migrations.lock.json`
      mechanism applied to a different fact.
    - **Both writers are one implementation.** `runWriteStatement` (single) and `runWriteBatch`
      (batched) both go through `billedRowsFor`, so `applyMetadata` cannot disagree with
      `upsertFileFacts`. Each is asserted over real SQLite, because reverting either leaves the
      whole scan suite green — those meter _doubles_ that report their own `billedRows` and never
      execute the DAO, so a mutation to the arithmetic is invisible there by construction.
    - The constant was also wrong — `5,000`, under a comment claiming to be _"the platform number,
      not a choice"_, which is this file's own recorded shape of defect and the only reason a wrong
      number sits in a file for ever. Correcting it **alone** would have multiplied the ten-fold
      under-count by twenty; the two are one change.
  - **A flat reserve is not a reserve, and a Paid account is throttled by a number it cannot
    detect.** The reserve became a **share** because the flat `1,000` was 20% of the old `5,000`
    and 1% of the real one — covering neither a few hundred stars nor the counter's own 500-row
    overshoot. And D1 Paid is monthly (50M rows included) with no daily cliff, while the plan is
    invisible from inside a Worker, so `dailyRowWriteShare` takes the limit as a parameter and `0`
    disables the pacing, which `dailyWriteAllowanceSpent` already treated as "no limit". The
    default stays the Free plan because that is the one that fails loudly.
  - **A classifier that matches a paraphrase has never met the platform.** `isD1DailyLimitError`
    matches Cloudflare's exact wording, because `executeD1WithRetry` throws
    `Failed to ${context}: ${errorMessage}` — a classifier wanting the bare sentence would
    answer "not a quota" for a quota, and the branch would be reachable only from a test. And
    `isD1ErrorRetryable` answers `false` for it **by accident of vocabulary** (`too many` is
    retryable, `exceeded` is not), which is asserted rather than left to the next person who
    adds `/exceeded/`. Full account: `docs/issues/d1-daily-write-limit.md`.
- **Indexing only happens on change, so deriving there is not enough — and the symptom
  hides in the one endpoint that does not group.** Every writer of the grouping columns is
  gated on the file having _moved_: the `Depth: 0` root probe, `isScanned: !changed`,
  `if (changed)` in `reconcileFolder`, and the read-through `getMusicDirectory` path. That
  gating is correct — it is what makes a rescan of an unchanged library cost one
  subrequest — and the consequence is that the derivation is **unreachable for an
  already-indexed library**, so its aggregates never recover without a file changing. It
  shipped _twice_, the second time as a fix that changed nothing: 113 rows on a live
  library, all indexed before the deploy, all with `album_ci`/`artist_ci` NULL, and
  `getArtists`/`getAlbumList2`/`getGenres`/`search3` answering `[]` after a redeploy that
  carried the derivation. Per-track everything looked fine, because `rest/mappers.ts`
  falls back to the folder name when `album` is NULL — **the one endpoint that does not
  group in SQL was the only one that looked healthy**, which is why this took a whole
  deployment to name. Four rules, and the first two are why the second attempt worked:
  - **The backfill runs where the rows are, not where the files are.**
    `SongDerivationDAO` re-runs the _same_ `deriveFromPath` over rows the walk will never
    revisit. Deriving the same fact in SQL was rejected: a second implementation of the
    convention, free to disagree over the separator rules and the marker, and a
    disagreement between two naming conventions is invisible until a client groups a
    library wrongly.
  - **It runs on every poll, ahead of the status check.** A fully scanned library is
    `idle`, and `idle` returns from `step` without touching the walk — so a backfill
    placed after the status check never runs for precisely the libraries that need it.
  - **The selection is on `derived_version`, not on NULL**, and the write is a `CASE` on
    `songs.grouping_source`: replace a value a derivation is recorded as owning, fill a
    NULL, leave a real tag. `NULL` alone cannot express a _corrected_ convention — this
    is the `reader_version` invariant one layer down, and a plain `COALESCE` would
    re-select the row and then decline to change it, which is a version column that buys
    nothing. **It never stamps `enriched_at`**, so `EnrichmentService` does not read the
    claim as "these bytes were read": a backfill that repairs the grouping by breaking
    enrichment is the opposite of a repair.
- **A page a chunk cannot write whole is a permanent failure, not a slow one.** The
  derived-grouping backfill reads a page of rows and writes them **one `UPDATE` per row**
  with `requireComplete`, so it refuses rather than truncating — correctly, because the
  selection is on `derived_version` and a partial page leaves rows re-selected for ever.
  That makes the page size a bound the chunk budget _imposes_. It was
  `DERIVE_MAX_ROWS_PER_CHUNK = 200`, against a chunk budget of `42` and a platform ceiling
  of `50`: it fitted on **no chunk under any configuration**, so every library with more
  than ~48 rows owing a derivation threw `SubrequestBudgetExhaustedError` out of
  `derivePending` — which runs _before_ `listFrontier` — so the walk never ran, `step`'s
  catch recorded a scan failure, `isAdvancing('failed')` is `true`, and `getScanStatus`
  answered `scanning: true` for ever. Reported as _"stuck on Scanning after 2 hours with
  ~100 tracks"_. Three rules, and each is how the other two collapse:
  - **Both the debt and its repayment have to be bounded.** `UPSERT_FILE_FACTS` stamped no
    `derived_version`, so every row the walk wrote took the migration's `DEFAULT 0` and was
    _immediately owed_ — permanently, since the selection is `derived_version < 1`. Neither
    half produces the wedge alone: with the stamp and a `200` page it is a slow repair; with
    a `32` page and no stamp it is a scan that re-stamps every row it wrote, every poll.
  - **The bound is derived, and it holds a folder back.**
    `SCAN_DERIVE_MAX_ROWS_PER_CHUNK = SCAN_CHUNK_SUBSREQUEST_BUDGET −
SUBSREQUESTS_PER_CHUNK_OVERHEAD − SUBSREQUESTS_PER_FOLDER_BASE` (`42 − 4 − 6 = 32`).
    `SUBSREQUESTS_PER_CHUNK_OVERHEAD` is the four statements a chunk spends belonging to no
    folder (`ensure`, the backfill's read, `listFrontier`, `saveProgress`) and the count
    matters: size the page without the two that _bracket_ the walk and the loop's
    `canAfford(SUBSREQUESTS_PER_FOLDER_BASE)` refuses, so the chunk returns `scanning`
    having visited **zero** folders — the same stuck scan with the throw removed, and what a
    fix that only deleted the throw would have shipped.
  - **A guard that passes by an accident of interleaving is not a guard.** Making the page
    fit cost one extra `await` at the top of every chunk, which moved the interleaving in
    `test/scan-do.test.ts` and exposed a latent lost update: `saveProgress` wrote
    `scanned_count = ?` where `fail` one method below increments in its own statement, so
    two overlapped chunks published the smaller of the two. The work was done — the counter
    went backwards. Now a delta, and the test that was written for it passes for the
    reason it was written.

  Asserted in `test/schema.int.test.ts` (the real statement over real SQLite: a scanned row
  is owed nothing, on both the `INSERT` and the `ON CONFLICT` clause), `test/scan-budget.test.ts`
  (a chunk that drains a 100-row backlog **and** still visits a folder — either assertion
  alone passes against the other failure), and `test/subrequest-budget.test.ts` (the
  relationship, not the numeral).

- **The reported state and the scheduled work are two stores, and they must be reconciled.**
  `ScanWorker.alarm` had no handler and `ScanService.step` had five awaited calls outside
  its own `try`, so a D1 error in any of them rejected `step`, the re-arm never ran, the
  alarm was consumed, and D1 still recorded `scanning` — which `getStatus` reports as _keep
  polling_, for ever, with nothing scheduled to answer. `getAlarm()` is called from nowhere
  in this repository, so the two stores were never compared. A handler that can reject is a
  permanent wedge, and `stalled` is the wrong answer for a failure it could not record: it
  is the terminal status, so `isAdvancing` is false for it and the chain is deleted — the
  same wedge reached by handling "cannot record" the obvious way.
- **A unit of work bounded by a budget must hold the budget's own meter.** `PlayCountImportWorker`
  needs a narrower ceiling than the invocation's 50, so it took `ScanBudget`'s approach — and then
  built a **local** `SubrequestCounter` for the batch loop's `canAfford` while every DAO charged
  the **scope's** own counter. Two counters are two numbers that disagree, and the disagreement
  was silent and total: the loop saw 44 remaining on a meter nothing else had spent, `requireSubrequests`
  threw on album seven, and `alarm`'s catch swallowed it into "could not read the import source"
  and re-armed. **The walk reported progress and made none, for ever.** So the rule is
  `scope.get(Tokens.SubrequestMeter)` with `setCeiling(...)` — one meter, narrowed, so the loop
  and every charge point below it read the same number. `test/import-execution.test.ts` walks
  twenty albums across several alarms to completion, which is the only assertion that would have
  seen it: a fixture of one page settles after one album and never reaches the branch.
- **A comparison written twice is two answers, and the one that was _absent_ is the one that
  shipped.** `nodes` has two writers: the scan's `reconcileFolder` and `TreeService`'s
  read-through `persistChildren`. Only the browse had a "does this row need writing" check;
  `reconcileFolder` **described** one in its own docstring and had no such branch. So the scan
  re-offered every row it had already written, `runWriteBatch` truncated that against the
  invocation's ceiling, and a folder with ≥45 entries could never be closed — 231,620 rows on
  one 80-album library, and a scan reporting `scanning` for ever. Meanwhile `persistChildren`'s
  header claimed _"both go through `persistChildren`, which is the only place a node row is
  written"_ — **false**, and the false sentence is what made the invariant look enforced.
  `nodeWrite.ts` owns the comparison now. See `docs/issues/nodes-upsert-livelock.md`.
- **A column with two writers needs both writers in its key.** `nodes.mtime_ms` is written
  by the scan _and_ by `TreeService`'s read-through browse, from the same `Depth: 1`
  PROPFIND, so a stored mtime cannot say which of them wrote it — and the two mean opposite
  things. The scan writes it having _descended into that folder_; the browse writes it
  having read nothing at all below it. `reconcileFolder` read `!changed` as "already
  reconciled", so it closed every folder a browse had materialized. It shipped: a library
  of 80 albums where **none was ever opened**, `songs` empty, `scan_state` `idle`, and the
  page reporting "Up to date. 0 tracks indexed." Three things then made it permanent, and
  each is its own rule:
  - **`is_scanned` is an input to the descent decision, not only its output.** It is the
    only one of the two that says "someone actually descended", so `needsDescent` consults
    it: `known?.is_scanned !== 1 || mtimeMoved || etagMoved`. The browse path writes `0`
    (`isScanned` is optional and `undefined` binds to `0`), so `0` and "absent" both descend.
    This is the `reader_version` invariant one level up — the bytes _and_ the thing that
    read them, or the second is unreachable.
  - **"Does this row need rewriting" and "does this folder need descending" are different
    questions**, and one `changed` flag was answering both. Pairing matters: the same cases
    assert that a folder the _scan_ reconciled with an unchanged mtime is still closed, so
    the guard cannot be satisfied by disabling incrementality — which would cost one
    PROPFIND per folder per rescan against the day's row-write allowance.
  - **A completed scan that indexed nothing is not evidence the library is current.**
    `start`'s cheap path compared the root mtime and reported `idle`, which is only sound if
    the previous scan read something — and `scanned_count` counts folders _visited_, so a
    walk that visited the root and closed every child unread leaves it at `1`. With no floor,
    that library could never be re-walked: the origin's root mtime had to change, or the
    library be deleted, which cascades the index away. `start` now also requires
    `songs.countByLibrary > 0`, one indexed read, on `startScan` only.
  - **The chunk boundary is what makes it visible, so the test needs one.** `step` reads the
    frontier _once_ and walks all of it, so at the default 40 a root chunk that wrongly
    closes its children still visits them in the same chunk and the library indexes fine.
    The case needs `chunkFolders: 1`, which is also what a root with 80 albums gets in
    practice.
- **A listing that placed nothing is not a listing that found nothing.** Every `toLibraryPath`
  refusal is a silent `continue`, so a listing whose hrefs none sit under the configured root
  path empties `childPaths` and `songPaths` — and the prune then concludes every existing
  child **vanished** and deletes the library recursively, on both planes, before reporting
  `idle`. "We could not place these paths" and "the operator deleted their music" were one
  observation. `reconcileFolder` now throws before a single row is written, so the folder
  stays on the frontier and `step`'s catch records the reason against the retry budget.
  **RFC 4918 §8.3 makes this reachable on a healthy origin**: a server may anchor `DAV:href`
  differently (`/owner/volume/…` vs `/dir/file.txt`), and both are correct. Two rules, and
  the second is how the first collapsed:
  - **The count excludes the folder's own entry.** A `Depth: 1` listing of an empty folder
    is exactly one entry — itself — so `resources.length > 0 && childPaths.length === 0` is
    true of every empty leaf directory, and the guard failed scans that were fine. Caught by
    `test/scan-do.test.ts` through a fixture whose album folder holds no tracks, surfacing as
    `stalled` where `idle` was expected.
  - **`probe` is the surface that can catch it, and it was discarding the evidence.** It
    threw away the `207` it had just received, so a reachable-but-unindexable library probed
    **perfectly clean**. It now reports `207` with a message naming the root path, and it is
    narrow on purpose — a `Depth: 0` listing holds one entry, so it asks only "could the root
    be placed?" An empty listing stays a success, because an empty folder is a legitimate
    library with zero tracks.

## See also

- [`packages/backend-services/AGENTS.md`](../../../packages/backend-services/AGENTS.md) —
  the state machine's methods and the enrichment path it calls
- [`apps/background/AGENTS.md`](../../../apps/background/AGENTS.md) — the DO, the alarm,
  and the two meters
- [`docs/issues/d1-daily-write-limit.md`](../../issues/d1-daily-write-limit.md),
  [`docs/issues/nodes-upsert-livelock.md`](../../issues/nodes-upsert-livelock.md),
  [`docs/issues/scan-chunk-unbounded-work.md`](../../issues/scan-chunk-unbounded-work.md),
  [`docs/issues/free-plan-subrequest-ceiling.md`](../../issues/free-plan-subrequest-ceiling.md),
  [`docs/issues/subrequest-budgets-are-two-not-one.md`](../../issues/subrequest-budgets-are-two-not-one.md)
