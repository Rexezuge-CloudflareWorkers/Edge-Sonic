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
  `EXPLAIN QUERY PLAN` is an assertion rather than a hope. The adapter preserves the
  SQL and is honest about what it does not emulate: D1's `bind()` coercion, and
  anything that depends on `meta.changes` beyond what SQLite reports.
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
  `webdavRequests` is charged inside `WebDavClient.request()`, so a test whose
  `clientFor` ignored the caller's `onRequest` reported **zero** for a chunk that had
  done real work. That is not a service defect — it is the double being structurally
  unable to observe the thing, which is precisely how the real under-counting survived:
  the field was `+= 1` in the walk's loop, so it charged the `PROPFIND`s and nothing the
  scan's own enrichment caused, under-reporting by up to 40x while its comment described
  it as instrumented "so the budget is testable". **A comment is not a measurement**, and
  `test/scan-budget.test.ts` now asserts `webdavRequests` against what the double
  actually received.

Two more rules that are easy to get wrong:

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
- **A fake's input shape is part of its contract.** `EnrichmentService` decides whether
  to read a file from `enriched_at !== null`; a camelCase stand-in leaves that `undefined`,
  `undefined !== null` is true, and the service correctly concludes every row is already
  enriched and does nothing. A test that passes while asserting nothing.

- **A checker that only compares things to each other checks nothing when there is one of
  them.** `scripts/validate_locales.mjs` compared every locale bundle against `en`, so with
  `SUPPORTED_LANGUAGES = ['en']` its entire per-tag body was skipped by
  `if (tag === 'en') continue` and it printed `ALL OK` having examined the application not at
  all. It could not see `libraries.scanPausedRequests` being used and absent — the string in
  the bundle did not exist to be wrong *about* anything. It reads the `t()` call sites now, in
  both directions (a referenced key must exist; an unreferenced one is warned), which is the
  comparison a bundle-to-bundle diff cannot express. It is in CI; it was not, and it is a
  check that fails on a merge rather than on a machine.

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
| `endpoint-registry.test.ts`              | The `/rest` registry as a contract: `code=70` for all 33, no name in two maps, the exact error key set |
| `spa-decisions.test.ts`                  | The SPA's error decoder across both dialects and a non-JSON body, and `describeStopReason` |

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
