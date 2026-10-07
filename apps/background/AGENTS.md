# Edge-Sonic — Background Workers

Scope: `apps/background/**`. Parent index: `../../AGENTS.md`. Bindings, secrets and the platform
limits are in `docs/agents/runtime/AGENTS.md`, which this file defers to.

Three Worker classes, and **the split between them is one decision**, not an accident of which file
was opened first.

| File | Owns |
| --- | --- |
| `ScanWorker.ts` | advancing one library's index, one bounded chunk per alarm |
| `LibraryImportWorkflow.ts` | the import's **bounded** phases: playlists, stars, bookmarks, queue |
| `PlayCountImportWorker.ts` | the import's **unbounded** half: walking a remote's albums for play counts |
| `ScanWorkerFactory.ts` | the composition root both classes build their scope through |
| `scanPause.ts` | the scan's day-row-write budget and the pause a spent allowance implies |
| `queueConsumers.ts` | the queue consumer and the cron fanout: pure dispatch, a scope factory injected |
| `scanIndexDrop.ts` | the two `ScanWorker` RPCs the Danger Zone's drop calls, and the ordering they must be called in |

## A drop stops this object **before** the D1 deletes, and charges it after

`ScanWorker.reset` and `ScanWorker.charge` exist for the Danger Zone's index drop, and the
**ordering** between them and the `DELETE`s is the entire reason they are separate RPCs.

- **The alarm is deleted first.** It fires every second. One that fires between the delete of
  `songs` and the delete of `nodes` finds a frontier describing rows that no longer exist,
  walks the origin and writes fresh song rows — landing *after* the delete meant to have removed
  them. The operator is told their index is empty and it is not, and nothing records that anything
  happened. The alarm has to be deleted from **this** object for the result to be a fact rather
  than a race.
- **The held pause is cleared with it.** `getStatus` overlays a pause over the stored status,
  because a pause is usually *caused* by D1 refusing writes and so cannot be recorded in the row
  it would override. One surviving a drop renders "paused until 00:00 UTC" over an empty library,
  and the operator's only conclusion is that the drop failed.
- **The day's billed-row count is deliberately kept, and then added to.** Deleting an index
  spends allowance like any other write — `songs` bills ten rows per row, so a 5,000-track drop
  is ~55,000 rows of a 100,000-row day. Forgetting that would let the next scan believe in
  headroom the platform has already refused, which is how an outage is reached rather than
  survived. `charge` takes what the deletes **measured**, not the projection the operator
  confirmed against, and it routes through `ScanPauseStore`'s own `pendingRows` because the
  `memory` key has three writers and a fourth would have to reproduce the interval and the
  day-rollover branches.
- **Nothing is seeded.** `start` is the only thing that seeds the frontier, and it exists
  because a scan needs a root row to descend from. A drop that reached for it would put every
  folder back on `is_scanned = 0` — which is the state `listFrontier` reads, so the next chunk
  would walk the whole origin and write back the index that was just deleted.
- **`libraryId` is accepted and ignored.** One object per library means the id is always the one
  this object holds, and re-pointing it is `startScan`'s job.

The reasoning lives in `scanIndexDrop.ts` and the two methods on `ScanWorker` are three-line
delegations, because `ScanWorker` is over the god-file limit and the answer to that is to move a
block that does not belong rather than to shorten the blocks that do.

## The scan's stored count is in *billed* rows

`scanPause.ts` holds the day's row-write count so the scan paces itself against D1's allowance, and
what it stores is `result.billedRows` — **not** `rowsWritten`. D1 bills a write as the row *plus
every index entry it rewrote*, so a `songs` row costs ten rows of allowance; counting table rows
told this budget it had ~10x its real headroom before the platform refused every query on the account
until midnight UTC.

The stored key is unchanged, deliberately: the unit was always *meant* to be D1's and was populated
with the wrong number by accident, and a stored counter whose meaning changes is a migration
question. `billedRows.ts` in `backend-data` owns the arithmetic.

## Why one is a Workflow and the other a Durable Object

**A Workflow step is cached by name**, so `playlist <remoteId>` cannot write the same playlist
twice — which is the whole problem, because "create this playlist" is not idempotent and
`PlaylistDAO.create` mints a v4. That is why an imported playlist's id is *derived*
(`UUIDUtil.deterministicId`) as well: the cache is the platform's half of the guarantee and the
derived id is this repository's half, and either alone would leave a retry writing a second
playlist.

The play-count walk gets **no** such guarantee and needs ~1 step per album against a **1,024-step**
ceiling on Free, so it runs in a Durable Object, where each alarm invocation gets a **fresh**
50-subrequest external budget. Measured — see `docs/issues/subrequest-budgets-are-two-not-one.md`.

So the workflow's play-count step only **starts** the walk, and the run stays `running` until the
object settles it. An operator told "imported" with half the play counts still walking has no way
to know, and nothing would correct them later.

`startPlayCountWorker` is deliberately **outside** a `step.do`: a step that "completed" but whose
object was never started would be cached and never re-run, and the walk would silently never
happen. The object's name **is** the run id, so a repeated call reaches the same object rather than
starting a second walk over the same albums.

Two facts about that call, and both shipped broken:

- **The payload is the run id, and the stub's type is the class's own.** It called
  `stub.start()` with no argument while `PlayCountImportWorker.start` read `request.runId` off
  the first parameter, which arrives `undefined` over RPC — so the object got no run id and **no
  alarm**, and the walk never began. The throw landed before the first `put`, so there was
  nothing to retry and nothing to resume. `stub.start()` is now `stub.start({ runId })` against
  `DurableObjectStub & PlayCountImportWorker`, the `scanStubs.ts` pattern: a hand-written
  `{ start(): Promise<unknown> }` declared *no* parameter, so the call that was wrong typechecked
  and the class was the only party that disagreed. A Durable Object's name is a routing
  decision; nothing turns it into an argument.
- **A start that fails settles the run `failed`, and the walk outcome is three answers.** A
  boolean could not carry it: "no binding configured" and "the start threw" both read `false`,
  so the throw escaped, `settle` never ran, and the run sat `running` with `last_error` **null**
  for ever with nothing scheduled to advance it — the wedge `runWorkflow` exists to prevent,
  arriving through the one call it cannot see. `WalkOutcome` is
  `not-configured | outstanding | failed`, one per terminal state, and the catch wraps `stub.start()`
  **alone**: `settle` sits outside it, so a fault in settling still reaches the engine. The
  recorded reason is a **literal** (`WALK_START_FAILED`) with the error logged beside it, for the
  same reason `runWorkflow` logs one.

The test double for that call reads `request.runId` rather than closing over the namespace's name,
which is what makes it a guard: the previous one took no argument and returned `{ runId: name }`,
so it agreed with the broken caller instead of the class. Both regressions are asserted in
`test/import-execution.test.ts` — reverting the payload fails the test with the production
`TypeError`, and removing the catch fails the other.

## Two meters would have been the whole defect

`PlayCountImportWorker` bounds a batch, so it needs a narrower ceiling than the invocation's 50 —
and the first version built a **local** `SubrequestCounter` for the loop while every DAO charged the
**scope's**. The loop's `canAfford` read a meter nothing else had spent, the DAOs threw on album
seven, and `alarm`'s catch swallowed it into a generic message and re-armed: **the walk reported
progress and made none, for ever.** It is `scope.get(Tokens.SubrequestMeter)` with
`setCeiling(...)` now, exactly as `ScanBudget` does. Asserted in `test/import-execution.test.ts`,
which walks twenty albums across several alarms.

## An alarm handler cannot reject, and a workflow `run` must rethrow

Both for the same reason and in the same direction: Cloudflare retries a throwing handler a bounded
number of times and then **drops** it, so a fault that escapes leaves the state saying `running`
with nothing scheduled to advance it. `PlayCountImportWorker.alarm` records the fault and re-arms;
`runWorkflow` logs and rethrows, because returning normally is how a Workflow reports **success**.

## The client is built per step and never held

It holds the plaintext password for its lifetime, and a Workflow instance hibernates between steps —
so a field would carry that password through storage the platform does not encrypt for us.
`ImportSourceService.clientFor` builds a fresh one per call for the same reason.

## These classes are unit-testable, and that is a deliberate property of the mock

`test/mocks/cloudflare-workers.ts` stores the `ctx` and `env` it is constructed with, so a test can
construct the real class over a fake context and call `alarm()` / `run()` itself. A base that only
knew about types would make every class here untestable outside Miniflare — and these two files are
where the import's *scheduling* lives, whose every defect is a **silent wedge** rather than an
error. The fakes model the two load-bearing platform facts: `setAlarm` is a **recorded schedule**
(a fake that fired immediately would make every batch loop run to exhaustion, the exact behaviour
the bound prevents) and `step.do` is **cached by name**.


## The queue is a bounded retry path, and poison is acked, failure is retried

`consumeQueueMessage` validates a message's **shape** and refuses anything it cannot use —
an unknown kind, a library that no longer exists. Those are *acked*: redelivery cannot fix
either, and acking is what keeps poison from re-queueing forever. A message whose
*processing* fails throws, so Cloudflare's `max_retries: 3` applies and an exhausted
message lands in `edge-sonic-scan-dlq`. The previous consumer caught every error and
acked, which dropped each failed chunk silently and never ran the budget. Import used to
have its own queue with the opposite defect: a producer that was never wired and a
consumer that acknowledged without doing the work — the Workflow is the import path, and
the dead binding was removed rather than left declared.

Cron enqueues one `scan-chunk` per library; it never walks. An alarm tick is the truth of
the scan's progress, and the queue is only a way to keep idle libraries moving when no
client polls.
