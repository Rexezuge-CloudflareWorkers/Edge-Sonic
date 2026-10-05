# Edge-Sonic — Background Worker

Scope: `apps/background/**`. Parent index: `../../AGENTS.md`.

- `src/index.ts` — re-exports `ScanWorker` (also re-exported by `apps/api/src/index.ts` for DO bindings).
- `ScanWorker` (`src/ScanWorker.ts`) — thin facade (routing + composition only): one Durable Object per library (`SCAN.getByName(libraryId)` — the library `id` is already stable, so no key normalization); alarm-driven chunk loop over the same `ScanService` the fetch isolate used to call directly, plus `enrichSong`/`coverArt` RPCs over the same `EnrichmentService`/`embeddedAlbumArt` a `getSong` uses. Factory wiring in `ScanWorkerFactory`.
- `scanPause.ts` (`ScanPauseStore`) — the pause and the day's row-write budget, **kept out of `ScanWorker` because it is a decision with a state machine in it** and `ScanWorker` is a router under a god-file guard. It owns when each storage write happens (a pause immediately, the day rolling over, the row count at most once per 500 rows) and which alarm time a result implies.

## Storage holds the pause, and that is the mechanism rather than a convenience

The stated invariant is *"D1 stays authoritative; DO storage holds only the library id and the
alarm."* It now also holds **the day's row-write count and any pause**, for one reason: **a pause is
usually caused by D1 refusing writes**, so it has nowhere to be written. Since 2026-09-01 a Free
account over its daily allowance has every query fail until midnight UTC; `step` catches the
refusal, returns `paused`, and the only place that can be recorded is Durable Object storage. Held
in `scan_state` it would be unwritable exactly when needed — and `/user/libraries`, which reads D1,
could not see it either.

`getStatus` reads it back and lets it **override** the stored row, because D1's row is
*guaranteed* stale about it: it says `scanning`, which an operator reads as working and a client reads
as poll-me. The overlay is dropped the moment a chunk runs, so it cannot report a condition that has
ended, and it fills in nothing else — a fabricated `scanned` count on a page an operator reads as
progress is the failure this file has spent three separate fixes on.

Three things this file got wrong before, each recorded because the fix reads as an obvious
refactor:

- **`isAdvancing` armed the alarm.** It answers *"will my poll buy anything?"*, and says `false` for
  a paused scan — right for a client, fatal for the alarm, which is the only thing that advances a
  scan in production. `willResumeWithoutAPoll` is the alarm's question and is `true`. One predicate
  for both is the mirror of the defect that made `scanning` mean "did this call do work".
- **The retry counter was charged for a pause.** `consecutive_failures` bounds retries of a *fault*;
  a spent allowance is not a fault, it resolves at midnight. Charging it would eventually produce
  `stalled`, which deletes the alarm and leaves the scan unrecovered until an operator notices.
- **The library lookup is itself a D1 read**, so it is the *first* thing a spent allowance refuses —
  before any of `ScanService` runs. `librariesOrPause` returns `null` for that one condition and
  throws for everything else, because a thrown refusal reaching `alarm`'s catch cannot be told from
  any other fault without re-classifying, and would be re-armed at `RETRY_ARM_DELAY_MS`: ~86,400
  invocations before the reset, each one a failed read.
- Composition: resolve per-request state via `createRequestScope(env).get(Tokens.X)`; never `new XDAO(env.DB)` inline.
