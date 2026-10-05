# A spent D1 daily allowance takes the whole product down

## What the platform says

Since **2026-09-01**, a Workers Free account that exceeds its daily D1 row read or row write limit
has **every query fail** — reads included, through the binding API and the REST API alike — until the
limit resets at **midnight UTC**:

> Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait
> until tomorrow (midnight UTC) to continue.

The Free allowance is 5,000 rows written per day. So this is not a scan that slows down. Subsonic
authentication reads `users`; every endpoint does. **The product is down**, and it comes back on a
clock.

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

Even a **correct** chunk writes about 42 rows, and a chunk runs about once a second. So
**5,000 rows/day is roughly two minutes of scanning.** The runaway above was not the only way here,
and a fix that only made the outage survivable would leave the outage frequent.

So the scan paces itself:

- `SCAN_DAILY_ROW_WRITE_BUDGET` = the platform's 5,000 less a named reserve for non-scan writes
  (stars, ratings, playlists, the login throttle, `index_version` bumps).
- Divided by the number of **registered** libraries, not `MAX_LIBRARIES` — the allowance is per
  *account*, so a per-library cap is unsound the moment a second library exists, and using the
  configured maximum would give a one-library deployment a tenth of the budget it could have had.
- Counted from the chunk's own measured `rowsWritten`, so the number is a measurement rather than an
  estimate.
- Held in Durable Object storage, because **metering D1 writes must not itself spend D1 writes**. A
  counter in `scan_state` is a D1 row per chunk against the allowance it enforces.

The count is persisted at most once per 500 rows, which is what makes the placement cost Durable
Object storage rather than the D1 allowance — and which makes it a **lower bound** by up to one
chunk's worth beyond that interval. `D1_DAILY_ROW_WRITE_RESERVE` is what absorbs that.

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

`test/scan-do.test.ts` — a real `ScanWorker`: the pause, the alarm armed for midnight rather than one
second out, the pause held in storage, `getStatus` reporting it, the pause being dropped when D1
recovers, and the retry counter **not** being spent.

`test/user-api.test.ts` — the `503` on both dialects, beside the `500` a genuinely broken D1 still
gets.

Verified by mutation: making `isAdvancing` answer for both questions, deleting `setCeiling`, or
moving the retry-counter charge onto the pause each turn a case red.