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
