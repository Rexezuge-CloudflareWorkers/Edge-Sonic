# A spent D1 daily allowance takes the whole product down

## What the platform says

Since **2026-09-01**, a Workers Free account that exceeds its daily D1 row read or row write limit
has **every query fail** — reads included, through the binding API and the REST API alike — until the
limit resets at **midnight UTC**:

> Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait
> until tomorrow (midnight UTC) to continue.

The Free allowance is **100,000** rows written per day (pricing page, billing metrics table, page
last updated 2026-04-21). So this is not a scan that slows down. Subsonic authentication reads
`users`; every endpoint does. **The product is down**, and it comes back on a clock.

## What this server did with it

`step` caught the refusal and treated it as a scan failure:

1. `ensure` threw, so `state` was `null`.
2. `scanState.fail` threw too — the fault **is** a refusal to write, so the write that would record
   it could not succeed.
3. The result was `unrecordedFailure(...)`, whose status is `failed`.
4. `isAdvancing('failed')` is `true`, so `ScanWorker` re-armed **one second later**.
5. Repeat: roughly **86,400 times** before the reset, each attempt a failed statement and a failed
   write.

Meanwhile:

- `getScanStatus` reported `scanning: true` throughout, which every client reads as *keep polling*.
- `toSubsonicError` masked the cause into `code=0`, so the one fact an operator needed — a clock — was
  in an exception nobody could read.
- The retry counter was charged for a condition it was never meant to bound, so eventually the scan
  would have reached `stalled`, deleted its alarm, and needed an operator.

Three of those are separate defects, and only the first is about the platform.

## Why `failed` could not carry it

`failed` means *retried within a bound that the retry counter supplies*, and `stalled` means *not
retried at all — an operator must act*. Neither is true of a spent allowance: it resolves by
itself, at a known moment, and needs no operator and no attempt.

Collapsing it into either produces a loop (retry) or a wedge (stall). So `paused` is a third answer:
**retried by itself, at a known time, needing no operator.**

## Two questions, and one predicate could not answer both

`isAdvancing` is what `getScanStatus`'s `scanning` is built from, and it answers *"will more work
happen if I poll again?"* — which every client reads as *stop polling* when the answer is false.

The alarm needs a different question: *"will this resume without a client?"* For `paused` the answers
are **opposite**:

| caller | question | `paused` |
| --- | --- | --- |
| `ScanWorker`'s alarm | will this resume by itself? | **true** |
| `getScanStatus` | will my poll buy anything? | **false** |

So `willResumeWithoutAPoll` and `isAdvancing` are separate functions. One predicate for both is the
same shape of defect as `scanning` once answering *"did this call do work"*, which is what stopped
every scan in the product from ever finishing — and its mirror here would delete the alarm and leave
an allowance spent until somebody noticed.

## Where a pause has to be stored, and why that is the whole mechanism

**In Durable Object storage**, and it is the only store still accepting writes when D1 is refusing
them. A pause held in `scan_state` would be unwritable exactly when it is needed, and the operator's
page — which reads D1 — could not see it either. So:

- `ScanPauseStore` holds it, and `getStatus` reads it back and lets it **override** the stored
  status. D1 cannot know about a pause entered *because* it was refusing writes, so its row is
  guaranteed stale about it: it says `scanning`, which an operator reads as working.
- The alarm is armed for `resumeAt`, so the chain sleeps through the window rather than re-running
  the refusal a second at a time.
- It is dropped the moment a chunk runs, so it cannot report a condition that has ended.

This is a stated exception to "D1 stays authoritative; DO storage holds the library id and the
alarm" — and the exception is narrow: the frontier, every indexed row, the retry counter and the
index version are all still D1's.

## The preventive half, because the limit is reached by design

A **correct** chunk bills a few hundred rows, and a chunk runs about once a second. So a day of
scanning on a 5,000-track library is a couple of hours: the allowance is reached by design, and a
fix that only made the outage survivable would leave it frequent.

So the scan paces itself:

- `SCAN_DAILY_ROW_WRITE_BUDGET` = the platform's 100,000 less a **10%** reserve for non-scan writes
  (stars, ratings, playlists, the login throttle, `index_version` bumps). A share rather than a flat
  figure, so it moves when the platform's number does — the flat `1,000` it replaced was 20% of the
  old `5,000` and 1% of the real one.
- Divided by the number of **registered** libraries, not `MAX_LIBRARIES` — the allowance is per
  *account*, so a per-library cap is unsound the moment a second library exists, and using the
  configured maximum would give a one-library deployment a tenth of the budget it could have had.
- **Counted in billed rows**, not table rows — see the next section. The number is a measurement
  taken off each statement's own result, never a figure declared at a call site.
- Held in Durable Object storage, because **metering D1 writes must not itself spend D1 writes**. A
  counter in `scan_state` is a D1 row per chunk against the allowance it enforces.

The count is persisted at most once per 500 rows, which is what makes the placement cost Durable
Object storage rather than the D1 allowance — and which makes it a **lower bound** by up to one
chunk's worth beyond that interval. `D1_DAILY_ROW_WRITE_RESERVE` is what absorbs that.

## The allowance is not denominated in rows, and neither is the guard

Pricing page, definition 6:

> Indexes will add an additional written row when writes include the indexed column, as there are
> two rows written: one to the table itself, and one to the index.

So the unit is a **billed row**, and the multiplier is a property of the *table*. `songs` carries
**nine** indexes — eight declared plus the implicit unique index SQLite creates for
`id TEXT PRIMARY KEY` — so one insert is ten rows of allowance; `nodes` is four, and `scan_state`,
which declares no index at all, is two.

The guard was counting **table rows**. `BaseDAO.runWriteBatch` summed `result.meta.changes`, which is
SQLite's count of rows touched and knows nothing about indexes, and the one writer outside it
declared its own figure: `EnrichmentService` hardcoded `rowsWritten = 1` for every enrichment
because `applyMetadata` returned `void` — against a statement billing ten. So the budget believed it
had roughly ten times its real headroom on the dominant write path, and the platform's refusal came
first.

Three consequences, and each is a separate defect:

1. **The two counts are different numbers, so they are two fields.** `rowsWritten` is progress and
   is what `test/scan-convergence.test.ts` measures; `billedRows` is cost and is what the daily budget
   is charged. `ScanDailyBudget.rowsWrittenToday` was renamed `billedRowsWrittenToday` for the same
   reason — a field whose name does not say which unit it is in cannot be compared against a limit
   without anyone checking.
2. **The multiplier is derived from the schema, not typed beside a query.** `billedRows.ts` declares
   it and `test/schema.int.test.ts` asserts it against `sqlite_schema`, so a migration adding an
   index turns the suite red. This is the `migrations.lock.json` mechanism applied to a different
   fact: a number nothing checks is a number that drifts.
3. **Neither writer is a second implementation.** `runWriteStatement` measures the single-statement
   path and `runWriteBatch` measures the batched one, both through `billedRowsFor`, so
   `applyMetadata` cannot disagree with `upsertFileFacts` about what a `songs` write costs. Both are
   asserted separately, because a mutation to either one leaves every status- and budget-level
   assertion in the scan suites green — those meter doubles that report their own `billedRows` and
   never execute the DAO.

### What it cost, and what raising the ceiling would have cost alone

Correcting the constant from 5,000 to 100,000 *by itself* would have multiplied a ten-fold
under-count by twenty — an outage, not a slow scan. The two corrections only make sense together,
which is why they are one change.

The reserve became a **share** for the same reason a flat number did not survive: 1,000 rows is 1% of
100,000 and covers neither a few hundred stars on a busy day nor the counter's own 500-row overshoot.

### A Paid account is throttled by a number it cannot detect

D1 Paid is billed monthly (50 million rows included) with no daily cliff and no midnight-UTC refusal,
so the Free number is not its allowance — and the plan is not visible from inside a Worker. So
`dailyRowWriteShare` takes the limit as a parameter and `0` disables the pacing entirely, which
`dailyWriteAllowanceSpent` already treated as "no limit". The default stays the Free plan because that
is the one that fails loudly.

## What a client is told

`scanning: false` for a paused scan, because polling cannot move a clock, and the reason on the
operator's row with the hour it resumes. `getScanStatus` has nowhere to put a reason — `scanStatus`
carries only `scanning` and `count`, and a reason there would be a non-standard attribute strict
clients reject — so it is on `/user/libraries`, which is also where an operator is looking.

`/user/libraries` cannot render a **list** while D1 is refusing every query: `libraries` is itself a
read, so there is nothing to enumerate. That is a `503` naming the limit and the hour it resumes —
not a partial list, and not an empty one, because "No libraries yet" is the one sentence on that page
that means something is genuinely absent.

## The negative that matters

`isD1ErrorRetryable` already answered `false` for this message, **by accident of vocabulary**:
`too many` is in its retryable list and `exceeded` is not. So today there is no retry storm *inside*
the DAO, and nothing enforces that. It is asserted, because adding `/exceeded/` is an entirely
reasonable-looking change that would turn a refusal which cannot change for hours into three attempts
with backoff per statement, per chunk, per alarm.

And the classifier matches on Cloudflare's **exact** wording rather than a paraphrase — because
`executeD1WithRetry` throws `Failed to ${context}: ${errorMessage}`, so a classifier requiring the
bare sentence would answer "not a quota" for a quota and the whole branch would be reachable only
from a test.

## What is asserted, and where

`test/d1-daily-limit.test.ts` — the classifier with its negatives, the pause beside the ordinary
fault, the two predicates, and the budget's derivation including the day/month/leap-day arithmetic.
Also the **unit**: the limit pinned to the published 100,000 rather than derived from anything, the
reserve asserted as a *share* rather than as a numeral, and `0` disabling the pacing.

`test/schema.int.test.ts` — the billed-row model against `sqlite_schema`, in both directions. The
load-bearing pair is the one that runs the **real DAO**: reverting either `runWriteBatch`'s batch
branch or `runWriteStatement` to `sum(changes)` turns exactly one case red and leaves the whole scan
suite green, because those suites meter doubles rather than executing the DAO.

`test/scan-do.test.ts` — a real `ScanWorker`: the pause, the alarm armed for midnight rather than one
second out, the pause held in storage, `getStatus` reporting it, the pause being dropped when D1
recovers, and the retry counter **not** being spent.

`test/user-api.test.ts` — the `503` on both dialects, beside the `500` a genuinely broken D1 still
gets.

Verified by mutation: making `isAdvancing` answer for both questions, deleting `setCeiling`, or
moving the retry-counter charge onto the pause each turn a case red.