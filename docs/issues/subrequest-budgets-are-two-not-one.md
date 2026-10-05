# Subrequest budgets are two ceilings, not one — measured

## What was measured, and why it was measured at all

`docs/issues/free-plan-subrequest-ceiling.md` records the outage this file's subject
was born from: a chunk of 40 folders charged its budget 40 and spent the platform
~240, and every chunk on a Free account died at the ceiling. The fix took the
**pessimistic** reading of an ambiguity between two Cloudflare doc pages and
merged every subrequest class into one pool of 50.

That pessimism was defensible on the evidence available and it was the right call
for shipping. It was also, as of2026-10-05, **measurably wrong in the direction it
chose** — and this file records what a real Free account actually does, because the
whole argument for the pessimistic reading was that nobody had checked.

This is the account's own doctrine applied to itself: *a comment is not a
measurement*, and neither is a doc page quoted from a second one.

## Method

A throwaway Worker + Durable Object + Workflow + D1 database, deployed to a Free
account, measured, then deleted. Not committed: this is a one-off platform
measurement, and a committed harness would rot against a platform that changes.
Every figure below was reproduced at least twice.

The instrument is indirect, and necessarily so. **The platform exposes no
subrequest counter**, and an overrun terminates the invocation before any handler
runs, so there is nothing to read back. The observable is binary — did the
invocation complete — and the experiment is designed to make **one side die while
the other is known to be inside its own budget**, so the side that died identifies
the accounting model.

Two shapes of failure had to be told apart, and they are different ceilings:

| Shape | Meaning |
| --- | --- |
| `error code: 1101`, no handler output | invocation **killed**, uncatchable |
| `Too many API requests by single Worker invocation` | **thrown and catchable** |

### A measurement bug worth recording

The first pass reported a Workflow doing 700 D1 statements while a DO did 700
more as `killed`, at a combined 1,400. That was **the probe's fault, not the
platform's**. The poll used a fixed `sleep`, and "still running" and "killed" both
read as a missing outcome marker — so a slow probe was scored as a dead one.

Polling to a *final verdict* instead, the same probe survived 3/3.

This is `docs/agents/testing/AGENTS.md`'s rule about assertions and doubles applied
to a measurement harness, and it is worth stating because the wrong result was
*more alarming and therefore more believable* than the right one. A harness that
cannot distinguish "not finished" from "failed" does not produce a weak
conclusion; it produces a confident wrong one.

The instrument was then rebuilt so a throw is recorded before it propagates,
making all three states distinguishable: `survived`, `threw`, and killed-with-no-
marker.

## The finding

**External subrequests and internal-service calls are drawn from separate budgets.**

| Budget | Ceiling (Free) | Overrun |
| --- | --- | --- |
| External `fetch` | **50** | Kills the invocation, uncatchable |
| D1 statements | **1,000** | **Throws**, catchable |

Both are per *invocation*. A Durable Object RPC runs the callee on a **fresh**
budget, and the caller's ceiling is untouched by whatever the callee spent.

### Evidence: external fetch is 50, everywhere

| Probe | Result |
| --- | --- |
| Plain Worker, 50 fetches | survived |
| Plain Worker, 51 fetches | **killed** (`error code: 1101`) |
| DO via RPC, 50 fetches inside | survived |
| DO via RPC, 51 fetches inside | **threw** `Too many subrequests by single Worker invocation` |
| DO alarm chain, 50 per round × 3 rounds | all 3 rounds completed |
| DO alarm chain, 51 per round | round 1 threw |

### Evidence: D1 is 1,000, and it is a different ceiling

| Probe | Result |
| --- | --- |
| Plain Worker, 1,000 statements | survived |
| Plain Worker, 1,001 statements | **threw** `Too many API requests…` |
| Plain Worker, 1,000 D1 + 50 external, one invocation | survived |
| Workflow 700 D1 + DO 700 D1 (1,400 combined) | survived, 3/3 |
| Workflow 1,000 D1 + DO 1,000 D1 (2,000 combined) | survived |

The last two rows are decisive. Under a shared pool of 1,000, a combined 1,400
would have died. It did not, twice, and neither did 2,000.

### Evidence: the DO's spend does not propagate to the caller

| Probe | Result |
| --- | --- |
| Workflow 50 external + DO 40 external (90 combined) | survived, 2/2 |
| Workflow 50 external + DO 50 external (100 combined) | survived, 2/2 |
| Workflow 50 external + DO 51 external | threw **inside the DO**; the Workflow's own 50 unaffected |

`apps/api/src/workers/scanStubs.ts` charges `meter?.charge(1, 'rpc')` per DO stub.
**That charge is correct** — an RPC is one subrequest to the caller — and the
callee's internal spend does not add to it.

### It is the documented behaviour, confirmed

The Workers limits page states:

> Workers on the free plan remain limited to 50 external subrequests and 1,000
> subrequests to Cloudflare services per invocation.

So this is D1's own figure, in the "queries per invocation" wording, behaving as
written. The measurement's value is that it settles which of the two disagreeing
rows applies to **this** code, rather than leaving the repository to pick one on
the basis of an asymmetry argument.

## Two consequences

### The pessimism was in the wrong direction

`subrequests.ts` merges D1, KV, DO RPC and `fetch` into one pool of 50. Measured,
D1 has 20× the headroom the budget assumes. `SCAN_CHUNK_MAX_REQUESTS = 42` —
derived as `50 − 8` — is roughly 21× more conservative than the D1 statements it
actually bounds.

**The code is not wrong and nothing is broken by it.** A ceiling that is too
small costs throughput, and this one was chosen for exactly that reason. What is
wrong is the *stated reason*: `subrequests.ts` says it charges D1 and KV against
the 50 because that is the pessimistic reading, and the measurement shows the
pessimistic reading was not required. A future reader deciding whether to raise
the budget is being told the platform would kill invocations at 50 D1 statements,
which is false.

### The D1 overrun is catchable, and the repository's central premise is not

`packages/shared/src/utils/SubrequestMeter.ts` states:

> Exceeding it does not slow a request down and does not raise a catchable error:
> the runtime terminates the invocation with `Too many subrequests by single
> Worker invocation`.

True of the external ceiling. **False of the D1 one**, which throws and is caught
by an ordinary `try`.

This must not be read as licence to catch and continue. A catchable limit is
still a limit, and code that swallows it has converted a loud failure into a quiet
one — which is this repository's most repeated lesson. What it does mean is that a
**D1** overrun is *diagnosable*: classifiable, reportable, convertible into the
`paused` status the daily-allowance mechanism already models. An **external**
overrun is not, and remains the failure mode that must be avoided by
construction rather than handled.

Two ceilings, two behaviours, and only one of them is the un-catchable kill. Any
future statement of the form "an overrun kills the invocation" is true of one
budget and false of the other.

## What this changes about where the scan's real limits are

If D1 has 1,000 per invocation, the scan's 42-subrequest budget is not what ends a
chunk. In order:

1. **`D1_DAILY_ROW_WRITE_LIMIT` = 5,000 rows/day.** Still the real wall, and since
   2026-09-01 an account over it has **every** query fail until midnight UTC — so
   it is an outage boundary, not a throughput number.
2. The wall-clock deadline.
3. External `fetch` — real, but a scan spends one `PROPFIND` per folder.

The daily allowance being the binding constraint is worth stating plainly, because
it is the reason the subrequest ceiling got the attention and it is the cheaper of
the two problems: a chunk that runs out of subrequests pauses and resumes, while an
account that runs out of rows is **down** until midnight, `/rest` authentication
included.

## Scope and limits of this measurement

- One Free account, one region (APAC), one day.
- **KV was not measured.** The 1,000 figure is measured for **D1 only**. `KvCache`
  charges `'kv'` and is assumed to share the internal pool — that is an inference
  from the platform's own wording, not a result.
- **Secrets Store reads and DO storage were not measured.** `SubrequestKind`
  includes `'secret'`; whether a Secrets Store read draws from the internal pool
  is untested.
- **Workers Paid is not covered.** The external/internal split is what the Free row
  says; a Paid account's internal budget matches its configured limit per the same
  table, which was not confirmed by measurement.
- A D1 `batch()` of N statements was not separated from N individual statements.
  The pessimistic per-statement charge is therefore still an assumption, and it
  remains the safe one.

## Recommended follow-ups

1. Measure `kv` and `secret` against the internal 1,000. Both are cheap and both
   are charge points the product depends on.
2. Restate `subrequests.ts`'s rationale: keep the single conservative budget, but
   say it is conservatism rather than correction, and record the measured ceilings
   beside it. Otherwise the next reader re-derives the same wrong conclusion.
3. Keep `meter?.charge(1, 'rpc')`. Measured correct.
4. Do **not** add catch-and-continue for the D1 ceiling. Classify and report it —
   the mechanism already exists in `D1ErrorClassifier`.
5. Consider splitting the counter's ceiling by budget, so `canAfford` can admit
   work that fits the 1,000 while still respecting the 50. This is a behaviour
   change with a real risk of over-running the external ceiling, and is not
   implied by this finding.

## The generalisation

A budget has to name **the resource the platform limits**. This file's predecessor
discovered that `fetch` was easy to instrument and D1 was not, so only `fetch` got
counted. The failure mode that followed is not "the wrong number" but **"the
number was never checked against the thing it claims to measure"** — the
repository shipped a fix derived from one doc page's ambiguity, correctly reasoned,
and it was wrong by a factor of twenty.

The two-step rule that would have caught it: *quote the platform's figure*, then
*measure the figure this deployment actually gets*. The first was done twice, from
two pages that disagreed. The second was not done at all, on either reading, and
the asymmetry argument was offered in place of it — which is a reasonable thing to
do when a measurement is unavailable and not a substitute for one.

### And the fix was not wrong, which is the part worth keeping

`SCAN_CHUNK_SUBSREQUEST_BUDGET = 42` is ~21× more conservative than the D1 headroom
this deployment actually has. That is **not** a defect. A ceiling that is too small
costs throughput; a ceiling that is too large costs invocations, and the asymmetry
argument that produced this budget was correct about which error is worse.

What was wrong was narrower and more specific: the budget was justified as *forced*
by the platform when it was *chosen* in the face of an ambiguity. Those have
different consequences. A forced constraint is a wall to design around; a chosen
conservatism is a knob somebody will eventually be invited to turn, and the reason
it was not turned earlier is that the reasoning said it could not be.

So the correction here is to the **stated reason**, in the two files that carried it,
rather than to the arithmetic. The suite still asserts 42 and still asserts every
bound derived from it — deliberately unchanged, because a test that failed on the
conservatism would be pushing the product toward the ceiling that actually kills
invocations. The new assertion records the headroom being given up and says plainly
that giving it up is the safe direction.

The generalisation of *that*: **a conservative choice is still a choice, and
documenting it as a platform constraint transfers the decision to nobody.** The
next person who reads "the platform allows 50" will believe it, and act on it, in
perpetuity.