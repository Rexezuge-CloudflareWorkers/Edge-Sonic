# The Free-plan subrequest ceiling killed every scan chunk

## What was reported

A library of 110 tracks, on Workers Free. `startScan`, then:

> fails after ~20 tracks index, then retires. repeat the failure and retry pattern, until
> all 110 tracks are indexed.

The scan did finish. That is the part that made it survivable and also the part that made it
invisible: nothing reported a failure at the end, and the progress number moved. What actually
happened was that **no chunk ever completed**.

## What the platform says

Workers Free allows **50 subrequests per invocation**. Workers Paid allows 10,000, raiseable to
10M with `limits.subrequests`. Exceeding it does not slow a request down and does not raise a
catchable error — the runtime terminates the invocation:

```
Too many subrequests by single Worker invocation.
To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits
```

D1 counts against the same 50, and says so on its own limits page:

> **Queries per Worker invocation** (read [subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests))
> — 1000 (Workers Paid) / **50 (Free)**

A `fetch`, a D1 query, a KV operation, a Durable Object RPC and a Secrets Store read are all
subrequests. A redirect hop is counted too.

> **Measured 2026-10-05 — this document's central claim is half right, and the fix below is 21×
> more conservative than it needed to be.** There are **two** budgets, not one: external `fetch`
> is 50 and **D1 statements are 1,000**, and 1,000 D1 statements plus 50 outbound requests in one
> invocation survive together. The pessimism below was right about which error is worse and wrong
> about the platform forcing it. Nothing here is broken — a too-small ceiling costs throughput —
> but the _stated reason_ has been corrected in `subrequests.ts` and `SubrequestMeter.ts`, and the
> measurements are in
> [`subrequest-budgets-are-two-not-one.md`](./subrequest-budgets-are-two-not-one.md). Read that
> one before deciding whether to raise `SCAN_CHUNK_MAX_REQUESTS`.

### The two doc pages that disagree

Cloudflare's [Workers limits page](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
carries a second row:

| Limit                            | Workers Free | Workers Paid             |
| -------------------------------- | ------------ | ------------------------ |
| Subrequests per invocation       | 50           | 10,000 (up to 10M)       |
| Subrequests to internal services | 1,000        | Matches configured limit |

The second row reads as "D1 and KV have their own budget", and **this repository believed it**
for long enough to ship a broken scan. `docs/agents/runtime/AGENTS.md` stated it, `scanBudget.ts`
was written on it, and the scan's own header claimed the D1 backfill "cannot spend" the ceiling.

D1's page, which is the specific authority for D1 and which names the subrequest limit,
contradicts it.

**The fix takes the pessimistic reading and charges D1 and KV against the 50.** The asymmetry
decides it: a ceiling sized for 1,000 that is really 50 kills invocations; a ceiling sized for
50 that is really 1,000 only makes the scan slower. "Free must work, even if slow" resolves the
ambiguity in the direction that cannot take the product down.

> The asymmetry argument was sound and the premise it rested on was not. Measured, D1 has 1,000
> of its own, so this choice is **conservatism rather than correction** — see the banner above.
> The reasoning below is kept as written because _how the wrong number was arrived at correctly_
> is the transferable part; the banner is what stops the next reader acting on it.

## What the code was doing

`ScanBudget` metered `WebDavClient.request()` — a real measurement, wired to the client's single
private `request()`, and the right _place_. It was the wrong _resource_. Nothing else in the
product charged it anything.

A chunk at the shipped defaults — 40 folders, up to 20 enriched tracks per folder:

| What                                                                                  | Counted | Spent    |
| ------------------------------------------------------------------------------------- | ------- | -------- |
| `PROPFIND` per folder                                                                 | 40      | 40       |
| D1: frontier read, `listChildren` ×2, node upserts, song upserts, prune, `scan_state` | 0       | ~160     |
| KV: `songMeta` read + write per enriched track                                        | 0       | ~40      |
| **Total**                                                                             | **40**  | **~240** |

`MAX_REQUESTS_PER_TRACK` made it worse in the direction that mattered: it was `2`, counting a
prefix read and a tail read — the two **external** requests — while the same track also costs a
`songMeta` KV read, an `applyMetadata` and a `songMeta` KV write. Twenty tracks per folder
admitted on the cost of two each is ~100 subrequests of work onto a budget of 50.

So the chunk crossed the ceiling inside its **first album**, every time. `ScanWorker.alarm`
caught the rejection, logged it, and re-armed one second later; the rows written before the kill
persisted; the next chunk died the same way. About twenty tracks banked per attempt, which is
exactly the reported symptom, and the library "finished" because the frontier emptied rather
than because a chunk ever succeeded.

Two consequences beyond the outage:

- **`stoppedBy: 'requests'` was structurally unreachable.** The operator surface has a string
  for it — "Paused at the per-chunk request limit" — and it could never render, because the meter
  could not see the resource that ran out. A self-inflicted ceiling was indistinguishable from a
  credential failure and spent `MAX_CONSECUTIVE_FAILURES` on every attempt.
- **The guard that certified the fiction.** `test/scan-budget.test.ts` asserted
  `DEFAULT_SCAN_CHUNK_MAX_REQUESTS < 50`. True, and true while the chunk spent 240 — a tautology
  that read as a measurement. `ChunkResult.webdavRequests` was asserted to equal what the WebDAV
  double received, which was also true, and also blind.

## Why the existing knobs could not fix it

They only move the WebDAV half. `SCAN_CHUNK_MAX_REQUESTS=6` and `SCAN_ENRICH_MAX_PER_FOLDER=2`
land at ~6 external + ~39 D1 + ~6 KV ≈ **51**: the failure becomes rarer, not impossible.

And the operator surface made it worse. `stoppedBy: 'requests'` rendered as _"Raise
`SCAN_CHUNK_MAX_REQUESTS` to index more per poll."_ On Workers Free that advice walks an operator
into a chunk the runtime terminates instead of one that pauses.

## The fix

### One meter, at every choke point

`packages/shared/src/utils/SubrequestMeter.ts` — a counter owned by the **request scope**, because
that is the lifetime of an invocation and because the charge points are constructed once per
scope. Kinds are kept separate (`d1`, `kv`, `fetch`, `rpc`, `secret`) because an operator whose
scan keeps pausing needs to know _which_ resource ran out; the three have different fixes.

| Charge point          | File                                             | Charges           |
| --------------------- | ------------------------------------------------ | ----------------- |
| every D1 statement    | `backend-data/dao/BaseDAO.withRetry`             | 1 per statement   |
| every D1 write batch  | `BaseDAO.runWriteBatch`                          | 1 per statement   |
| every KV operation    | `backend-runtime/kv/KvCache.guard`               | 1 per issued call |
| every WebDAV request  | `WebDavClient` via the scope's `onRequest`       | 1                 |
| a Durable Object stub | `apps/api/src/workers/scanStubs.ts`              | 1 per stub        |
| a Secrets Store read  | `backend-services/composition/serviceFactory.ts` | 1                 |

Pessimistic about a D1 `batch()`: **one subrequest per statement**, because the platform does not
say whether a batch is 1 or N and over-counting costs throughput while under-counting costs
availability.

`BaseDAO.withRetry` is the single point every statement passes through — roughly a hundred call
sites — so charging there is one line rather than a hundred chances to forget one. A forgotten
charge is invisible: the statement still works, the rows are still right, and the invocation
still dies.

### One ceiling, derived, and every bound computed from it

`backend-runtime/src/config/subrequests.ts`. `WORKER_SUBSREQUEST_CEILING = 50`, minus a reserve of
8 for the invocation's own statements, gives the chunk budget; the folder count and the
per-folder enrich cap are floors of that. `MAX_PAGE_SIZE_CEILING` is re-derived too, from the
statement count a page actually issues rather than from its group count.

| Was                                          | Now   | Derived from                                     |
| -------------------------------------------- | ----- | ------------------------------------------------ |
| `SCAN_CHUNK_MAX_REQUESTS = 40` (WebDAV only) | `42`  | `50 − 8`                                         |
| `SCAN_CHUNK_FOLDERS = 40`                    | `7`   | `floor(42 / 6)` — a folder's base cost           |
| `SCAN_ENRICH_MAX_PER_FOLDER = 20`            | `8`   | `floor(42 / 5)` — a track's full cost            |
| `MAX_PAGE_SIZE_CEILING = 2200`               | `500` | the statement budget, capped at the protocol max |

All three scan vars are now **clamped** to their derived ceilings and `validate()` reports the
clamp, because the operator surface's advice was "raise this one".

### A chunk reserves a folder's whole cost, and a truncated folder stays on the frontier

`SUBSREQUESTS_PER_FOLDER_BASE = 6` is checked before each folder rather than one `PROPFIND`,
because a chunk that starts a folder it cannot finish does not get a slow folder — it gets a
terminated invocation.

A folder too large for one chunk is a real case (a 500-track album is ~1,000 statements), so
`runWriteBatch` splits by what is left of the budget and reports `truncated`. `reconcileFolder`
writes the children **first** and the folder's own row — the one carrying `is_scanned: true` —
**last, and only if nothing was truncated**. So a partially-written folder stays on the frontier,
and because both upserts are keyed on `path` and skip unchanged rows, the next chunk re-lists it
and writes only what is missing. Enrichment and the prune are skipped on a truncated folder; the
prune in particular would otherwise delete exactly the children the upsert could not write.

`TreeService`'s read-through browse cannot resume, so it does not try: when its writes do not fit
it persists nothing and answers from the listing it already holds in memory. The folder's own row
is never written, so the next browse re-lists rather than serving a half-materialized tree.

Writes that must be **all or nothing** — a play queue, a playlist's `song_count`, the derivation
backfill — pass `requireComplete` and get a `413` naming the limit instead of a partial write. A
play queue saved halfway is a _shorter queue_, which is a wrong answer rather than an unfinished
one.

### Reads: clamp what the caller chose, refuse what it did not

`listArtists` is clamped, because its callers ask for 500, 5,000 and 500 and "as many as you can
serve" is the question. `songsForAlbumDirs` and `listIdsIn` refuse with a `413`, because the key
list _is_ the answer and a subset is a wrong answer. `SongDAO` was also building its
`SongIdLookupDAO` with `new SongIdLookupDAO(this.database)` — dropping the meter, which is the
whole defect present in the code written to fix it.

### The budget running out is a pause, not a failure

`stopReason` asks the deadline first. `remaining > 0` does not mean the chunk could have done
anything: it may have had five subrequests left and needed six for the next folder, which is the
number stopping it and not a clock. Asking `remaining <= 0` reported `deadline` for that case, so
an operator was told a slow origin had ended the chunk when a number had.

## What the tests assert

- `test/subrequest-budget.test.ts` — the counter, every charge point individually, truncation
  paired with refusal, the derived relationships rather than the numerals, the config clamps, and
  three negatives so none of the guards can be quietly removed.
- `test/scan-budget.test.ts` — the store double now **charges** the meter and truncates batches as
  `runWriteBatch` does, at the real ceiling. A chunk is asserted under `WORKER_SUBSREQUEST_CEILING`
  end to end, the whole library drains in more chunks rather than dying partway through one, and
  the per-track reservation is asserted by _how many tracks were left behind_, which is the
  assertion that fails if it is set back to 2.

The store double is the load-bearing part. It previously answered every call on the next
microtask and charged nothing, so the suite could see the WebDAV half of a chunk precisely and the
half that killed the invocation not at all — and reported the product as comfortably inside a
ceiling of 50. A double is evidence only to the extent it models the platform's constraints.

## The generalisation

A budget has to name **the resource the platform limits**, not the one that was easiest to
instrument. `fetch` was easy to instrument because `WebDavClient` had a private `request()` and a
natural callback; D1 and KV were not counted because nothing forced them to be. And the test that
"verified" the budget asserted that a number was below 50 — which is a fact about the
configuration, not about the chunk.

Two rules, and each is how the previous one collapsed:

- **Every subrequest class goes through one counter, at the choke point, not at the call site.**
  A charge per call site is a hundred chances to forget one, and a forgotten charge produces no
  symptom at all until the platform kills the invocation.
- **A bound the operator can raise is not a bound until it is clamped to what the platform
  allows.** `MAX_PAGE_SIZE` learned that; the three scan vars had not, and the UI was actively
  advising people to break them.
