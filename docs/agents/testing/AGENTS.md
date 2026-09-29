# Edge-Sonic — Testing

Scope: the whole suite. Parent index: `../../../AGENTS.md`.

Everything runs under **Node**. There is no workerd, no pool, and no second toolchain.

Thresholds (`vitest.config.mts`): **79 / 66 / 81 / 82** (statements / branches /
functions / lines), against a measured 80 / 67 / 82 / 83. These are a **measured
floor**, not an aspiration: lower one to make CI green and the gate stops saying
anything. Raise them as coverage grows.

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
than papered over.

## Test doubles must model the platform

A double that shares a wrong assumption with the code it tests makes both look right.
Three from this repository's own history, all of which shipped:

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

Two more rules that are easy to get wrong:

- **Only KV and WebDAV are doubled**, because they are exactly the two things that are
  modellable without lying. D1 is real.
- **A diagnostic is tested where the operator reads it.** `probe-notice.test.ts` imports
  from `apps/web` for one reason: the decisions that were wrong lived inside a
  component, and a component with no test is a decision with no evidence. A pure
  function in the SPA is importable from here without a DOM harness, so "the SPA is
  not in the coverage gate" must not quietly become "the SPA has no tests at all".
- **A fake's input shape is part of its contract.** `EnrichmentService` decides whether
  to read a file from `enriched_at !== null`; a camelCase stand-in leaves that `undefined`,
  `undefined !== null` is true, and the service correctly concludes every row is already
  enriched and does nothing. A test that passes while asserting nothing.

## Suites

| File                                     | Covers                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `subsonic-md5.test.ts`                   | MD5 against RFC 1321 and the spec's own `sesame`/`c19b2d` worked example                   |
| `subsonic-protocol.test.ts`              | The node model, all three serializers, the error envelope, id round-trips                  |
| `kv-outage.test.ts`                      | Fail-soft reads/writes, the breaker, the version-in-key policy                            |
| `webdav-client.test.ts`                  | The 207 parser, the credential boundary, `Range` forwarding, the URL guard                 |
| `media-tags.test.ts`                     | MP3, FLAC, and Ogg readers against fixtures written from the specs                         |
| `library-ssrf.test.ts`                   | The private-host classifier, the URL canonicalizer, the client's own refusals              |
| `scan-incremental.test.ts`               | The root probe, mtime-driven descent, the prune, chunk accounting                         |
| `enrichment-config.test.ts`              | Lazy enrichment, `AppConfiguration.validate()`, `resolveKey`, both error mappers           |
| `user-auth.test.ts`                     | The Access strategy chain, the allow-list, and the never-trust-the-header rule            |
| `schema.int.test.ts`                     | The real schema, cascades, `EXPLAIN QUERY PLAN` on every hot lookup, DAO round-trips       |
| `worker.int.test.ts`                     | The Worker end to end: route order, auth, the envelope, error surface, the cache          |
| `streaming.test.ts`                      | `stream`/`download`/`getCoverArt`: no transcoding, no buffering, upstream failures        |
| `user-api.test.ts`                      | The operator API: the SSRF gate, quotas, key separation, credentials, the probe verdict   |
| `probe-notice.test.ts`                  | The operator surface's decisions: probe classification, scan reason, patch shape          |
| `endpoints.test.ts`                      | The rest of `/rest`: lists, state, users, ratings, scrobbling, the scan controls          |

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
