# Edge-Sonic — Import

Scope: moving a player's data out of another Subsonic server and into one chosen local
user — `packages/backend-services/src/import` (pure) and `apps/background`'s
`LibraryImportWorkflow` (a Workflow) and `PlayCountImportWorker` (a Durable Object).
Operator-triggered from `/user/import/*`.

Five phases, in order: `playlists`, `stars`, `bookmarks`, `playQueue`, `playCounts`
(`IMPORT_PHASES`, `dao/imports.ts`). There is **no ratings phase** — the protocol has one
and this import does not move it, which is a fact about the product rather than an
oversight, and it is asserted rather than left to be inferred.

The split that matters: `remoteParse.ts` is pure and imports nothing but types, while
`remoteClient.ts` owns transport and `sourceService.ts` owns the credential. `apps/api`
may not hold that credential, so `ImportSourceService.clientFor` is its only reader.

## Invariants

Violating any of these reintroduces a fixed defect. The suite asserts each one.

- **An import refuses to start rather than sharing the daily row allowance, because the
  allowance is an outage.** `SCAN_DAILY_ROW_WRITE_BUDGET` exists because the daily row-write
  allowance is per **account**, so N libraries each capped at the whole allowance would write N
  times it. The argument is *stronger* for an import, because since 2026-09-01 an account over its
  allowance has **every query fail** until midnight UTC — reads included. Two writers racing for the
  last rows do not each get slower: the second takes the whole product down, `/rest` authentication
  with it, and the remedy is a clock rather than a change. So there is **one writer at a time**,
  and the two refusals are about *not writing rows* rather than a conflict in the usual sense.
  Both are asserted through the HTTP surface in `test/import-routes.test.ts`, each with the case
  that proves the gate has teeth, and `assertScansIdle` is asserted **both ways** — because a
  precondition that passes when it should fail looks exactly like a guard.
  Three answers rather than two, and each asks the operator for something different: `paused`
  resumes without a poll, `failed` needs a look, and `stalled` is neither.
- **A boolean outcome is a claim, and a claim nothing measures is not an invariant.** What the
  play-count half did was a `boolean` — `startPlayCountWorker` answered `false` for both "no
  `IMPORT_DO` binding is configured" and "the start threw". The two lead to different terminal
  states and ask the operator for different things, and the second one shipped: `stub.start()`
  was called with no payload, so `PlayCountImportWorker.start` read `request.runId` off
  `undefined` and threw *before* its `put` and *before* its `setAlarm`. The fault escaped, so
  `settle` never ran, and the run stayed `running` with `last_error` **null** for ever with
  nothing scheduled to advance it — the operator's page said the import was still going, and the
  only record of the fault was the Workflow instance in the Cloudflare dashboard. `WalkOutcome`
  is `not-configured | outstanding | failed`, one per terminal state, and a start that fails is
  **caught and recorded** rather than thrown, because the catch has to wrap the one call
  `runWorkflow` cannot see while leaving `settle` outside it — a fault in settling must still
  reach the engine, or a `run` that returns normally reports success.
  The same failure reached the compiler too: the stub was hand-typed
  `{ start(): Promise<unknown> }`, declaring **no** parameter, so the wrong call typechecked. It
  is now `DurableObjectStub & PlayCountImportWorker` — the `scanStubs.ts` pattern — because a
  signature beside a class is a second claim and nothing compared the two. Asserted in both
  directions in `test/import-execution.test.ts`, and the double it holds reads `request.runId`
  rather than closing over the namespace's name, because a double that shares the caller's
  assumption is a second copy of the bug.
- **Two refusals that mean different things must not be one answer, and a caller must not be
  left to guess.** `ImportSourceService.clientFor` returns `{ok:true, client}` or
  `{ok:false, reason}` because there are **two** refusals — the row is gone, or the host is no
  longer permitted because an operator tightened `ALLOW_PRIVATE_WEBDAV_HOSTS` after the run
  started — and a method answering `null` for one and *throwing* for the other left the Durable
  Object writing `=== null` and so believing it covered both, while a tightening arrived as a
  thrown `NotFoundError` that its `alarm` catch swallowed into a generic message. It then re-armed
  and retried a host the policy had just refused, for ever, with the real reason discarded.
  Over HTTP the two **do** collapse to one 404, deliberately — the distinction is not actionable
  there and saying which it is would leak that a row exists whose URL the caller may no longer
  use, the same reasoning `assertRemoteReachable` applies. What each caller does with each is
  stated at each caller.
- **An error class is not a status, and a route must not re-decide one.** `createSource` mapped
  every `BadRequestError` to a 409, which made "that URL is not allowed by the SSRF gate" and
  "that remote account is already registered" arrive under one number — and an operator reading a
  rejected URL as a conflict would go looking for a duplicate to rename. The class carries the
  status (`ConflictError` → 409, `BadRequestError` → 400) and `BaseRoute.toErrorResponse` is the
  single path, so a route has nothing to map.
- **A derived id needs an *injective* encoding, because a separator proves nothing.**
  An imported playlist's id must be stable across a retried Workflow step, so it is a hash of
  `(namespace, run, remotePlaylistId)`. The first version joined the parts with NUL and its
  docstring claimed the delimiter "cannot appear in a part" — which is false: joining
  `['ns','a','b']` and joining `['ns', 'a' + NUL + 'b']` produce the same string, so **any** delimiter is
  forgeable and two different playlists hash to one id, one overwriting the other. Length-prefixing
  each part (`3:ns1:a1:b`) is injective because the length is recoverable from the bytes. The
  comment was the false part and the test that caught it was written *because* the comment made a
  claim; asserted in `test/import-phases.test.ts`.

## See also

- [`packages/backend-services/AGENTS.md`](../../../packages/backend-services/AGENTS.md) —
  the module inventory and the matching rules
- [`apps/background/AGENTS.md`](../../../apps/background/AGENTS.md) — why one phase is a
  Workflow and another is a Durable Object
- [`docs/issues/subrequest-budgets-are-two-not-one.md`](../../issues/subrequest-budgets-are-two-not-one.md)
