# Edge-Sonic — Testing

Scope: the whole suite. Parent index: `../../../AGENTS.md`.

Everything runs under **Node**. There is no workerd, no pool, and no second toolchain.

Thresholds (`vitest.config.mts`): **85 / 73 / 90 / 89** (statements / branches /
functions / lines), against a measured 85.95 / 73.96 / 90.98 / 89.61. These are a
**measured floor**, not an aspiration: lower one to make CI green and the gate stops saying
anything. Raise them as coverage grows.

The floors sit *below* the measurement rather than rounded to it, so a tenth of a point of
jitter does not turn the gate red — and the largest recent raise came from **deleting**
code. `Container`'s unreachable factory tier, `Provider`, `memoizeAsync`, ten orphaned DAO
methods and `UpdateClause` were all uncovered; removing them removed their statements from
the denominator. That is the intended way for this number to move: a floor that has to be
*lowered* to admit code nobody calls is a floor measuring the wrong thing.

## Why there is no Workers integration pool

`@cloudflare/vitest-pool-workers` was tried and removed. It builds the worker with
Miniflare, whose module locator resolves a bare specifier in its *entry* file and not one
reached through a relative import — so a monorepo worker and a monorepo's tests both
failed to load with "Cannot find package" for packages that resolve under `tsc`, Vite,
and `esbuild` alike. The available workarounds (a pre-bundled entry with esbuild, an
alias table derived from the manifests, a second `wrangler` config at the repo root) each
fixed one half of the problem, and none survived a package being added.

What replaced it is better for the assertions that matter:

- **D1 is SQLite, so the DAOs run against `node:sqlite`** through a `D1Queryable`
  adapter (`test/helpers/sqlite.ts`). Same engine, real collation, real
  `ON DELETE CASCADE`, real `PRAGMA foreign_key_check`, and a real planner — so
  `EXPLAIN QUERY PLAN` is an assertion rather than a hope. The adapter is honest about
  what it does not emulate: D1's `bind()` coercion, and anything that depends on
  `meta.changes` beyond what SQLite reports. It is **also** held to the platform's
  *shape* — `prepare()` returns exactly workerd's four members and `bind()` returns a
  new statement — because an adapter one member wider than the platform is what made the
  whole write half of this product throw for a deployment, through a green suite.
- **The Worker is driven through its own `fetch`** (`test/helpers/harness.ts`) with a
  real D1 and a real KV double. That covers route order, the envelope, and HTTP status —
  the three things that only exist in the composition and that every isolated test
  passes without noticing.

What is genuinely lost is workerd-specific behaviour: `executionCtx` timing, worker's own
`Response` quirks, and KV's eventual consistency. That is stated in the harness rather
than papered over. The one omission that had already cost a production outage — workerd
validating the receiver of its globals — is now modelled by `withReceiverCheck`, because a
behaviour that can take the product down does not have to wait for the integration pool to
be worth reproducing.

## Test doubles must model the platform

A double that shares a wrong assumption with the code it tests makes both look right.
Four from this repository's own history, all of which shipped:

- **A D1 double that lowercased both sides** of a comparison is why the reference project
  carried `lower(owner_email) = lower(?)` through a full green suite. The predicate was
  wrong in SQL, right in the double, and the rows were identical — the plan was the only
  observable difference.
- **A FLAC fixture and a FLAC reader that shared a wrong byte offset.** Every duration was
  wrong by 2^16 and nothing failed. When a fixture and a reader can both be wrong the same
  way, only the spec breaks the tie, so the fixture is written from the spec and the
  offsets are spelled out in both.
- **A `Range`-ignoring WebDAV double.** `fakeDav` used to answer any range with the whole
  file and a `Content-Range` header claiming a prefix, which models a server lying about
  what it served — and it hid the one bug this product exists to avoid. It truncates now,
  answers `416` past the end, and `test/streaming.test.ts` asserts the recorded range
  *and* the received bytes.
- **A `fetch` double that was an arrow function**, and therefore had no `this` binding at
  all. `WebDavClient` was calling the platform global as `this.fetchImpl(...)`, which
  workerd rejects with `Illegal invocation` — so the double was *structurally incapable*
  of seeing the bug it existed to catch, and Node's own `globalThis.fetch` does not check a
  receiver either, so the `vi.stubGlobal` suites inherited the same blind spot. 423 tests
  were green while every WebDAV path in the product was broken. `fakeDav` now returns
  `withReceiverCheck(impl)`, which throws on a foreign receiver the way workerd does; 33
  tests across 5 suites go red against that bug.

  The generalisable form: **a double that cannot observe a failure is worse than no
  double**, because it lends the failure a passing test. Ask what the double is
  *incapable* of noticing — an arrow cannot see a receiver, a mock cannot see a
  collation, a hand-written XML fixture cannot see a namespace the parser mishandles.

Two more from the scan's subrequest budget, and the second is the subtler one:

- **A double that answers instantly cannot see a deadline.** `fakeDav` returned with no
  latency, so a chunk finished in microseconds however slow the origin was, and a
  deadline that did *nothing* looked exactly like a deadline that worked. It takes
  `latencyMs` now, a **real** `setTimeout` rather than a fake clock, so the bound is
  exercised through the same `Date.now` production uses and a test cannot pass by mocking
  away the thing under test. Such a test asserts on **counts and folders visited**, never
  on elapsed milliseconds: a wall-clock assertion is a flaky assertion, and a bound is a
  decision rather than a duration.
- **A double that drops a callback cannot see what the callback counts.** The scan's
  subrequest total is charged inside `WebDavClient.request()`, so a test whose `clientFor`
  ignored the caller's `onRequest` reported **zero** for a chunk that had done real work.
  That is not a service defect — it is the double being structurally unable to observe the
  thing, which is precisely how the real under-counting survived: the field was `+= 1` in
  the walk's loop, so it charged the `PROPFIND`s and nothing the scan's own enrichment
  caused, under-reporting by up to 40x while its comment described it as instrumented "so
  the budget is testable". **A comment is not a measurement**, and `test/scan-budget.test.ts`
  now asserts the `fetch` half against what the double actually received.
- **A double that does not charge a subrequest cannot see a chunk that exceeds one.** The
  same mistake one level up, and it shipped: `ScanBudget` counted `fetch` alone, because D1
  was a double whose calls answered on the next microtask and cost nothing. So the suite saw
  the WebDAV half of a chunk precisely and the half that killed the invocation not at all,
  and reported the product as comfortably inside a ceiling of 50 while a chunk spent ~240.
  `test/scan-budget.test.ts`'s store double now **charges** the meter and truncates batches as
  `runWriteBatch` does, at the real ceiling, and a test asserts the whole library drains in
  more chunks rather than dying partway through one. The generalisation: a double must model
  the platform's *constraints*, not just its results — `bindChunkSize` for 100 parameters,
  the receiver check for `Illegal invocation`, and now the subrequest ceiling.

Seven more rules, and the first is a limit rather than a rule:

- **Only KV and WebDAV are doubled**, because they are exactly the two things that are
  modellable without lying. D1 is real.
- **A double may not be free where the thing being bounded costs something.**
  `scan-budget.test.ts` keeps its in-memory index — the chunk's *decisions* are above the
  SQL, and `schema.int.test.ts` runs the SQL against a real planner. But it answered every
  store call on the next microtask, so **D1 was free**, and the chunk's wall-clock deadline
  was asserted in the one world where a deadline does nothing and looks like one that
  works: the only way a chunk could be slow was the origin, which `fakeDav`'s `latencyMs`
  already modelled. The store now has a latency of its own and a test stops the chunk on
  the deadline with the origin answering instantly.
- **A double may not disagree with production about the column under repair.**
  That suite's `upsertFileFacts` wrote `album: null, artist: null` with no
  `derived_version` — *verbatim* the defect the parent index records as shipped and fixed
  in `scan-incremental.test.ts`. A double that shares an assumption with the code it tests
  makes both look right, and this one was the suite cited as the model for budget
  measurement.
- **A guard needs a test that proves it has teeth.** `withReceiverCheck` is asserted twice
  in `webdav-client.test.ts`: once that the client behaves, and once that the guard
  actually rejects a method call. Without the second, the guard could be removed in a
  "simplification" and the first test would keep passing — which is the same blindness one
  level up.
- **A diagnostic is tested where the operator reads it.** `probe-notice.test.ts` imports
  from `apps/web` for one reason: the decisions that were wrong lived inside a
  component, and a component with no test is a decision with no evidence. A pure
  function in the SPA is importable from here without a DOM harness, so "the SPA is
  not in the coverage gate" must not quietly become "the SPA has no tests at all".
- **A 401 the server asserts is not a 401 the client renders.** `web-landing.test.tsx`
  exists because the whole signed-out branch is invisible to the server suite:
  `user-auth.test.ts` and `worker.int.test.ts` prove `/user/*` refuses a caller, and the
  browser's response to that refusal — the landing page, the `Unauthorized` gate, the
  nav disappearing — is asserted nowhere. Deleting the entire gate leaves both server
  suites green, because `useCurrentUser`'s contract is only "set `authorized: false`".
  So **a server-level assertion does not cover a client-level branch**, and the two need
  separate evidence. Each guard there is paired with a mutation check, which is how one of
  them was caught reading back its own `sessionStorage` setup instead of testing the write.
- **A fake's input shape is part of its contract.** `EnrichmentService` decides whether
  to read a file from `enriched_at !== null`; a camelCase stand-in leaves that `undefined`,
  `undefined !== null` is true, and the service correctly concludes every row is already
  enriched and does nothing. A test that passes while asserting nothing.

- **A checker that only compares things to each other checks nothing when there is one of
  them.** `scripts/i18n/validate_locales.ts` compared every locale bundle against `en`, so with
  `SUPPORTED_LANGUAGES = ['en']` its entire per-tag body was skipped by
  `if (tag === 'en') continue` and it printed `ALL OK` having examined the application not at
  all. It could not see `libraries.scanPausedRequests` being used and absent — the string in
  the bundle did not exist to be wrong *about* anything. It reads the `t()` call sites now, in
  both directions (a referenced key must exist; an unreferenced one is warned), which is the
  comparison a bundle-to-bundle diff cannot express. It is in CI; it was not, and it is a
  check that fails on a merge rather than on a machine.

- **A parser with no test is a parser that ships broken, and the symptoms are silent.**
  `locale-checks.ts` — the pure half of the locale validator — shipped three wrong shapes of
  its `t()` call parser in one afternoon, and **no test caught any of them**, because until the
  rules were split out of the entrypoint there was nothing to call. A shared `[^\\]` class
  matches a string literal's own closing quote, so the capture ran past its terminator and
  returned pages of source as a "default". Excluding `'` as well fixed that and broke the
  reverse case, and this repository has one: a double-quoted default containing an unescaped
  apostrophe. That failure is the worse of the two, because the affected call site simply
  **stopped being checked** — which looks identical to a passing run. A third, found by a test
  written after the fact, matched the default by searching forward from the key and picked up
  a *later* call's comma.

  So the rule the parser now follows is **one delimiter per concern**: the key closes on a
  backreference (`(['"])([\w.]+)\1`, sound because `[a-zA-Z0-9_.]` cannot contain a quote) and
  the default is a separate **sticky** match anchored where the key ended. Each is far under
  the repo's `sonarjs/regex-complexity` ceiling, which a single alternated pattern is not — it
  scored 30 against a limit of 20. Reintroducing any of the three shapes turns
  `test/scripts/locale-checks.test.ts` red (1, 10 and 10 failures), and a fourth candidate
  regression correctly does *not*, because it is equivalent.

- **A rule module with no test is a rule nothing measures.** Every rule under `scripts/` —
  `scripts/i18n/locale-checks.ts`, `scripts/migrations/lock-check.ts`, `scripts/lib/cli-args.ts`,
  `scripts/build/spa-shell-checks.ts`, `scripts/backup/*` — is split from its entrypoint precisely so it can
  be tested without touching the filesystem. Each has a paired case that runs the comparison
  against a value that is **wrong** and asserts the finding names the file or key it is about.
  A test asserting only "no drift" would pass forever against a check that had been removed,
  which is the shape of defect this repository has already shipped twice.

One more, and it is the same rule applied to an *expectation* rather than to a double: an
assertion written from our own reading of the spec shares that reading with the code it
checks, so the pair can be wrong together and green. `user.folder` was asserted as
`[{"id": 0}]` by a test that read the element as a record, while the schema types it as
`Array of int` — and a client modelling `folder: List<Int>` threw on it inside its login
path, so the report was "failed to connect, check your credentials" from a server that had
answered `ping` and authenticated correctly.

- **When the failure mode is a client's decoder, decode with a model of *theirs*.**
  `test/client-decoding.test.ts` decodes our real answers with a strict reader written
  from the schema, carrying the same strictness the client uses — a JSON *string* is as
  fatal as a JSON *object* where a number is declared, because the client's `Json` is not
  lenient. Its expectations are therefore not a shape of ours, which is the whole point:
  `test/endpoints.test.ts` asserted the shape we chose, and the shape we chose was wrong.
  The suite pairs it with the case that must **reject** the record and the quoted forms,
  because a decoder that accepted anything would let both tests pass forever.

## Invariants

Five cross-cutting rules, split out of the root guide. Each is a defect this repository
shipped with a green suite, so each names the test that now holds it.

- **A double that cannot observe a failure is worse than no double.** 423 tests were green
  throughout the `Illegal invocation` incident, because `fakeDav`'s `fetch` was an **arrow
  function** and an arrow has no `this` binding — structurally incapable of detecting the
  one class of bug it existed to catch. Node's real `globalThis.fetch` does not check its
  receiver either, so the `vi.stubGlobal` suites inherited the blind spot.
  `withReceiverCheck` models the receiver, and 33 tests across 5 suites go red against the
  bug — including a paired test proving the guard has teeth, without which the guard could
  be removed and the first test would pass for ever. **A passing test is evidence only to
  the extent the double shares the platform's assumptions.**
- **A double that compensates for a bug hides it.** `test/scan-incremental.test.ts`'s
  `listRoots` filtered `node.path !== ''` while `NodeDAO.listRoots` did not, so the library
  root's own row reached `getIndexes` as a `shortcut` with an empty `name` — an unlabelled
  entry whose id then failed with `code 70` — and the suite stayed green. Here the double
  shared the *correct* behaviour and the DAO did not. The DAO now runs against real
  `node:sqlite` for this predicate, where a wrong query and a double cannot disagree.
- **A double that models *an* implementation of the platform is not modelling the
  platform.** The DAOs run against `node:sqlite` precisely so a wrong predicate and a right
  one differ in the query plan, and that instinct was right. But D1 is SQLite with a
  **different build**: `SQLITE_MAX_VARIABLE_NUMBER` is 32,766 in Node's and **100** in D1's.
  So the double was structurally incapable of failing the way the product fails — and
  `songsForAlbumKeys` bound two variables per album group, so **any** request for 50+ albums
  raised `too many SQL variables` and answered a masked `code=0` on the endpoint a player
  draws its album list from. `listArtists` bound one per artist against callers asking for
  500, 5,000 and 500, so `getArtists`, `getArtist` and `getCoverArt` were each a guaranteed
  failure on a library with 100+ artists. 500+ tests were green throughout. `listIdsIn` was
  the sharpest, because it *did* guard: it batched at 200 under a comment reading "SQLite's
  limit (999 by default)" — a real guard whose stated budget was fiction, at twice the
  ceiling. The generalization is the transferable part. Being the same *engine* earned this
  double the trust that being the same *build* requires, and that trust is what hid the
  bug. `helpers/sqlite.ts` now enforces the ceiling on every statement, and the batch sizes
  are **derived** from one measured constant (`bindChunkSize`) rather than chosen per query
  — a number typed beside a query is wrong by the time someone raises a page size. **Those
  figures are historical**: the album-key rewrite since made `songsForAlbumKeys` bind *one*
  variable per group under `folder` and `album` (two under `album_artist`), so the 50-album
  ceiling no longer applies to it — but the rule is the one that caught it, and
  `bindChunkSize(2)` is still what `album_artist` derives. Asserted: removing the batching
  from any of the three sites, dropping the re-sort that makes a chunked fetch
  order-independent, raising the constant to 999, or removing the double's own enforcement
  each turn tests red.
- **A double may disagree with production about the very column under repair.** The
  `upsertFileFacts` double in `test/scan-incremental.test.ts` wrote `artist: null,
  album: null` while the real `UPSERT_FILE_FACTS` *derived* them. That is the same failure
  as the one above, and it is why the grouping fix appeared to do nothing: the suite agreed
  with itself and with neither production, so every test passed against a deployment whose
  aggregates stayed empty. The double now calls `deriveFromPath` and stamps
  `DERIVED_VERSION`. **It then happened again, on the same column and in the same files, in
  the opposite direction**: both doubles stamped `derived_version` and each one's comment
  asserted that `UPSERT_FILE_FACTS` did — which it did not, because that statement omitted
  the column entirely. So the *fix* for the first occurrence was applied to the doubles
  only, agreeing with a statement that did not exist. Which platform a double models
  matters as much as whether it models one.
- **A double with a member the platform does not have is not a double, it is a bug with a
  green suite.** `test/helpers/sqlite.ts`'s `prepare()` returned a statement carrying a
  `sql`. **workerd's `D1PreparedStatement` has no such member** — `types/defines/d1.d.ts`
  declares `bind`, `first`, `run`, `all`, `raw`, and Cloudflare's `prepare()` reference
  calls the return value *"an object which only contains methods"* — so `billedRowsFor`
  read `undefined`, `stripLeadingNoise` threw `TypeError: Cannot read properties of
  undefined (reading 'replace')`, and **every write in the product died**: the frontier
  seed, the index write, enrichment, the derived-grouping backfill, playlist totals, play
  counts, the play queue. The scan could neither seed nor advance a chunk, and
  `scan_state` kept reporting `scanning` because `markScanning` does not bill. Reads were
  entirely unaffected, so the library browsed fine and nothing had ever been indexed. 1,270
  tests were green throughout.
  - **The same double also returned `this` from `bind()`, where Cloudflare returns a new
    statement.** That is the second half and it is the reason the obvious fix was not
    available: anything that hangs the SQL off the statement object — a `WeakMap`, a
    `defineProperty` — resolves *before* `bind()` and misses *after* it, so it would have
    passed this suite and failed in production. **A double's object identity is part of the
    platform's contract**, and nothing about a method's return value announces that it
    matters.
  - **The repository's own type asserted the platform had it.** `D1PreparedStatement`
    declared `sql: string` as *required*, under a comment claiming *"Real D1Database
    satisfies these structurally"* — false — and `env.DB as D1Queryable` is what let it
    compile, because the local type is a **superset** so the cast is legal in that
    direction. So the double was written to satisfy a type that was itself a claim, and
    `wrangler types` — which emits the platform's real declaration into
    `worker-configuration.d.ts`, in this repository, today — was never consulted.
  - **The guard asserts the member list in both directions**, against a written-out copy of
    workerd's declaration rather than one derived from the adapter, which would compare the
    adapter with itself. Adding a property to the double to satisfy a caller now fails a
    test instead of re-hiding the defect the suite once shared. And the SQL reaches
    `billedRowsFor` beside the statement, from `BaseDAO.prepare`.
  - **One coincidence has to be stated, or the guard looks stronger than it is**: `songs`
    bills ten rows and `MAX_BILLED_ROWS_PER_ROW` *is* ten, so on the dominant write path a
    statement whose SQL was lost and a correct one are charged **the same number**. Every
    `songs` assertion stays green against a lost SQL. The assertions that catch it are on
    `nodes` (four), and that is why they are on `nodes` — not because `nodes` is the more
    interesting table.

## Suites

| File                                     | Covers                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `subsonic-md5.test.ts`                   | MD5 against RFC 1321 and the spec's own `sesame`/`c19b2d` worked example                   |
| `subsonic-protocol.test.ts`              | The node model, all three serializers, the error envelope, id round-trips                  |
| `kv-outage.test.ts`                      | Fail-soft reads/writes, the breaker, the version-in-key policy                            |
| `webdav-client.test.ts`                  | The 207 parser, the credential boundary, `Range` forwarding, the URL guard, the receiver of the injected `fetch` |
| `media-tags.test.ts`                     | MP3, FLAC, and Ogg readers against fixtures written from the specs                         |
| `library-ssrf.test.ts`                   | The private-host classifier, the URL canonicalizer, the client's own refusals              |
| `scan-incremental.test.ts`               | The root probe, mtime-driven descent, the prune, chunk accounting                         |
| `scan-budget.test.ts`                    | A chunk's request ceiling and deadline, measured against a double that can see both     |
| `enrichment-config.test.ts`              | Lazy enrichment, `AppConfiguration.validate()`, `resolveKey`, both error mappers           |
| `user-auth.test.ts`                     | The Access strategy chain, the allow-list, and the never-trust-the-header rule            |
| `schema.int.test.ts`                     | The real schema, cascades, `EXPLAIN QUERY PLAN` on every hot lookup, DAO round-trips       |
| `worker.int.test.ts`                     | The Worker end to end: route order, auth, the envelope, error surface, the cache          |
| `streaming.test.ts`                      | `stream`/`download`/`getCoverArt`: no transcoding, no buffering, upstream failures        |
| `user-api.test.ts`                      | The operator API: the SSRF gate, quotas, key separation, credentials, the probe verdict   |
| `probe-notice.test.ts`                  | The operator surface's decisions: probe classification, scan reason, patch shape          |
| `endpoints.test.ts`                      | The rest of `/rest`: lists, state, users, ratings, scrobbling, the scan controls          |
| `music-folder-index.test.ts`             | The two folder publishers agree, and a published position resolves back to its library   |
| `client-decoding.test.ts`                | Our answers decode as a client modelling the schema's types — and the reader has teeth   |
| `cover-art-embedded.test.ts`             | Artwork from the tracks' own tags: every extracted format re-served from cache, the negative cache, and the un-awaited write |
| `embedded-art.test.ts`                   | The three container formats' picture locators, against fixtures written from the specs  |
| `ogg-packet-layout.test.ts`              | The lacing table, and a fixture that decodes its own framing back before asserting on the reader |
| `rate-limit.test.ts`                     | The token bucket, the identity key, both error dialects, and the `/rest` 429 envelope   |
| `scan-do.test.ts`                        | The alarm chain: the `try` guard, the re-arm, and the overlap with a manual step         |
| `security-headers.test.ts`               | The header baseline, and that the `no-store` predicate names a path this router serves   |
| `endpoint-registry.test.ts`              | The `/rest` registry as a contract: each entry's answer through the real dispatcher, no name in two maps, the exact error key set |
| `alias-table.int.test.ts`                | That the one shared alias table resolves every package root and subpath export, and mocks `cloudflare:` modules |
| `d1-daily-limit.test.ts`                 | A spent daily allowance as `paused`: the classifier, the two predicates, and DO storage as the only store still accepting writes |
| `import-routes.test.ts`                  | The operator's import surface: both refusals, each paired with the case that proves the gate has teeth |
| `import-phases.test.ts`                  | Each phase in isolation, and the injective id encoding a retried step depends on |
| `import-matching.test.ts`                | Path before metadata, and an ambiguous match refused rather than resolved |
| `import-execution.test.ts`               | Twenty albums across several alarms to completion — the only assertion that reaches the second batch |
| `import-client.test.ts`                  | `remoteParse` against real Subsonic envelopes, including the single-element collapse and `code=70` inside a 200 |
| `subrequest-budget.test.ts`              | Every charge point, with negatives — a counter that charges nothing passes a suite that never crosss the ceiling |
| `scan-convergence.test.ts`               | Each reconciliation pass writes **strictly less** than the one before, over real SQLite with a real meter |
| `scan-progress.test.ts`                  | `storedStatus`, `willResumeWithoutAPoll` against `isAdvancing`, and what the SPA renders for each |
| `redos-linear-parsing.test.ts`           | The linear rewrites on a wall-clock bound, against `new RegExp` copies of the three originals |
| `web-library-row.test.tsx`               | The library row's decisions: a stale poll, `stoppedBy`, the i18n values against their inline defaults |
| `spa-decisions.test.ts`                  | The SPA's error decoder across both dialects and a non-JSON body, and `describeStopReason` |
| `web-landing.test.tsx`                   | The signed-out surface: all three `authorized` states, and the sign-in-that-changed-nothing hint |
| `test/scripts/locale-checks.test.ts`          | The locale rules as rules, and the `t()` parser's three wrong shapes — each pinned |
| `test/scripts/migration-lock.test.ts`         | Every lock finding kind, `--write` add-only behaviour, and the duplicate-prefix rule |
| `test/scripts/cli-args.test.ts`               | Flag parsing rejects rather than ignores: unknown, repeated, and valueless |
| `test/scripts/spa-shell-checks.test.ts`       | Each way a served shell can be wrong, and the shell that is fine passing |
| `backup/naming-and-prune.test.ts`        | Where a backup lands, and every object the retention prune may **not** delete |
| `backup/resolve-d1-target.test.ts`       | The export target, the empty-database refusal, and the fail-closed encryption policy |

## Rules for writing an assertion here

- **Assert the count, not the shape.** `songCount`, `playCount`, and `position` are
  numbers clients display and arithmetic on. Assert them even when the expected value is
  `0`; a field that is *absent* and a field that is `0` are different answers.
- **Assert the empty case, not just the populated one.** Every list can be empty, and the
  JSON shape of an empty list is where a client breaks.
- **Assert a property, not an implementation.** "The response is byte-identical with a
  dead cache" is a property. "the cache was not written" is an implementation detail that
  stops being true when the cache is replaced.
- **Assert what a client reads, not what the code returns.** A `getScanStatus` that
  ignores `libraryId` is correct because the protocol has no such parameter — the
  assertion is that it only ever reaches a library the caller already has.
- **Do not assert a global count to prove an upper bound.** Assert the bound.
- **Watch the clock and the boundaries.** A minute-resolution age that lands on a bucket
  edge is a flaky assertion, not a product bug — assert the unit or a range.
