# A folder too large for one invocation could never be closed

## What was reported

One library, ~110 tracks, 80 album folders, Workers Free. A single `startScan`, and the Cloudflare
D1 dashboard showing:

```
231.62k  rows written
```

against this statement, per day — on a library whose whole index is a few hundred rows. And the
scan never completed: `getScanStatus` reported `scanning: true` for as long as anybody watched.

## The arithmetic

Workers Free allows **50 subrequests per invocation**, and a D1 statement is one of them — D1 states
its own limit as _queries per Worker invocation — 1000 (Paid) / 50 (Free)_. A chunk is capped at
`50 − 8` = 42. Before one folder's own row can be written, a chunk has spent:

| spent | statement                                    |
| ----: | -------------------------------------------- |
|     1 | `scanState.ensure`                           |
|     1 | the derivation backfill's read               |
|     1 | `listFrontier`                               |
|     1 | `PROPFIND Depth: 1`                          |
|     1 | `listChildren`, to diff against              |
|    45 | the node write batch — `fitCount` = `50 − 5` |

So a folder with **45 or more entries** cannot have its own row written in the chunk that walks it:
the batch is truncated at exactly the point where the last statement would fit.

Truncation is the expected case and it is supposed to be resumable. The next chunk re-lists the
folder and writes only what is missing. **It did not**, because `reconcileFolder` built one input
per child of the folder and had no comparison of its own — so the rows it had already written were
the rows it re-offered _first_, the truncation landed on the same offset every time, and the
progress available on the next pass was zero.

| pass | rows written | root `is_scanned` | frontier |
| ---: | -----------: | ----------------: | -------- |
|    1 |           48 |                 0 | 7        |
|    2 |           48 |                 0 | 7        |
|    3 |           48 |                 0 | 7        |
|    … |              |                   |          |

Measured, driving the real `reconcileFolder` and the real `NodeDAO` over `node:sqlite` with a real
`SubrequestCounter(50)`. `231,620 ÷ 45 ≈ 5,147` chunks, which at the alarm's one-second cadence is
about 86 minutes — and the two numbers are the same measurement. Neither of them was progress.

Nothing reported it. `stoppedBy` answered `'frontier'` (the chunk did consume the whole frontier it
was handed, which had exactly one folder in it), and `rowsWritten` is only visible through
`POST /user/libraries/:id/scan/step`.

## Three causes, each of which hid the others

### 1. The scan had no comparison, and said it did

`scanFolder.ts` documented the decision in its own header:

> **Does this node row need rewriting?** Answered by the child's own mtime and etag.

There was no such branch. `TreeService.persistChildren` _did_ have one — and the two disagreed, so
even a test importing both would have found two answers.

`TreeService`'s header claimed the invariant that would have caught it:

> Both go through `persistChildren`, which is the only place a node row is written.

The scan never went through it. **A comment describing an invariant is not the invariant**, and here
it named the exact property whose absence caused the bug.

### 2. The statement rewrote every row it was offered

`NodeDAO.UPSERT` had no `WHERE` on its `DO UPDATE`, so an upsert that changed nothing still wrote
the row and reported one change — because `updated_at` is `nowSeconds()` and therefore always
different. So even a caller-side comparison would have been a second line of defence rather than the
fix: `runWriteBatch.truncated` is about statements **issued**, so a caller that offered 80 rows for a
45-statement budget would still livelock with zero rows written.

The two halves are load-bearing in this order, and the order is why neither fix alone was enough.

### 3. A read-through browse put every folder back on the frontier

`persistChildren` wrote `is_scanned = 0` for every child, so a client merely _looking at_ the root
put all 80 album folders back on the scan frontier and the scan re-walked them — once per browse, on
a `GET`, spending the same daily allowance. The flag means "someone descended into this", and that
path demonstrably has not: it read a `Depth: 1` listing and nothing below it.

## A fourth, independent

`BaseDAO.fitCount` read `meter.remaining` — the **platform's** ceiling — rather than the chunk's own,
so a write batch could issue up to 50 statements while the chunk budget said 42. That spends the
invocation's 8-statement reserve, after which the post-walk `saveProgress` crosses 50 and the runtime
terminates the invocation with an error nothing in this repository can catch. Measured at 52
subrequests against a ceiling of 50.

The fix is `SubrequestCounter.setCeiling`, and its home is not arbitrary: `ScanBudget` is in layer 3
while every charge point that matters is below it and holds only the meter, so the meter is the one
place the two can meet.

## Why 500+ tests were green

Two doubles, each blind in a different direction.

`test/scan-budget.test.ts`'s `nodes.upsertMany` double **skipped** rows whose mtime, etag and
`is_scanned` matched — a faithful model of the statement _with_ the guard this adds, and an
unfaithful model of the one that shipped. Every row-write count in that suite was therefore fiction,
in the optimistic direction. `test/scan-incremental.test.ts` runs with `chunkMaxRequests: 10_000` and
a double that always reports `truncated: false`, so truncation never happens there at all.

A double that models the fixed implementation proves nothing about the broken one, and a double
whose ceiling is high enough that the bound never fires cannot see the bound.

## What holds now

- One comparison, `nodeRowNeedsWrite`, used by both writers — and the two writers' _descent_ logic
  stays separate, because "does this row need writing" and "does this folder need opening" are
  different questions.
- `NodeDAO.UPSERT` carries a `WHERE` naming every column it writes except `updated_at`, so the
  statement's cost is a function of what changed rather than of how often it was called.
- `ScanBudget` narrows the meter's ceiling, so a write batch cannot spend the invocation's reserve.
- A browse **preserves** `is_scanned` for rows it finds and writes `0` for rows it creates.

Measured after: 49 rows, then 31, then the folder closes, then **0** — 81 rows written for 81 rows
of tree.

## What a guard is for here

`test/scan-convergence.test.ts` asserts convergence, which is the only shape that distinguishes
progress from repetition: each pass writes strictly less than the one before, and a completed folder
writes nothing at all. Shape assertions pass on both implementations.

It runs against `node:sqlite` with a real `SubrequestCounter`, and removing either the comparison or
the `WHERE` turns seven of its cases red — while every status- and shape-level assertion in the
suite stays green. That asymmetry is the finding.
