# `getScanStatus` is unbounded work, not a progress read — and enrichment made it worse

**Status:** resolved
**Severity:** high — correctness of a shipped default, not a latency nit
**Blocks:** the scan-enrichment change in `fix/ogg-packet-framing-and-duration`
**Found:** 2026-09-29, probing a live instance (`sonic.550441.xyz`, 81 artists)
**Fixed:** a scan chunk is now bounded by a measured request count and a wall-clock
deadline, and leaves the frontier rather than running itself out. See
`packages/backend-services/src/index/scanBudget.ts` and `test/scan-budget.test.ts`.

## Summary

`getScanStatus` is not a query about scan progress — it _is_ the scan. One call descends
into up to `SCAN_CHUNK_FOLDERS` folders **sequentially**, with no wall-clock deadline and
no subrequest budget. Chunk duration is therefore `folders × per-request latency`, which on
the origin this was found on is roughly **88 seconds typical and 400 seconds worst case**.

The client gives up long before that. The work still completes server-side, so the scan is
not lost — it is invisible, and a client that backs off is a client that stops advancing the
scan.

Worse: the scan-enrichment change on the branch above moved per-track range reads **inside
that same sequential loop**, taking a full chunk from 40 subrequests to up to 1,640 — past
the 1,000-subrequest ceiling. At the shipped defaults that is a chunk which _fails_ rather
than one which is slow.

## Mechanism

```ts
// packages/backend-services/src/index/ScanService.ts:181
for (const folder of frontier) {
  webdavRequests += 1;
  const listed = await this.listFolder(library, folder.path);   // one round trip
  ...
  rowsWritten += await this.absorb(library, folder, listed);    // may enrich, too
}
```

No concurrency, and **no bound that is checked**. `webdavRequests` is incremented and
returned in `ChunkResult`, but nothing anywhere compares it to a limit or uses it to leave
the loop early. The chunk ends when the folder list ends or something throws.

## Evidence

Measured against the live origin, 5 samples of a single ranged read:

| sample  | 1    | 2    | 3    | 4    | 5    |
| ------- | ---- | ---- | ---- | ---- | ---- |
| seconds | 2.26 | 2.20 | 2.41 | 2.25 | 1.98 |

> **Caveat.** These were issued with `cf-ray: ...-NRT`, so part of ~2.2 s is
> Tokyo↔origin distance rather than intrinsic origin latency. The _shape_ of the problem is
> origin-independent; the magnitude is not, and the numbers below should be read as "this
> origin is slow enough to break the default", not as a constant.

|                      |                                                                         |
| -------------------- | ----------------------------------------------------------------------- |
| `SCAN_CHUNK_FOLDERS` | `40` (`ConfigurationDefaults.ts:23`, and `wrangler.template.jsonc:113`) |
| `WEBDAV_TIMEOUT_MS`  | `10000` (`ConfigurationDefaults.ts:13`)                                 |
| chunk, typical       | 40 × 2.2 s ≈ **88 s**                                                   |
| chunk, worst case    | 40 × 10 s = **400 s**                                                   |

Observed against the live instance while a scan was running:

```
poll 1:  HTTP 000  t=45.000862s   client gave up
poll 2:  HTTP 000  t=45.001753s   client gave up
poll 3:  HTTP 200  t=3.648370s    scanning=true  count=2
poll 4:  HTTP 200  t=1.635291s    scanning=false count=2
```

The scan completed. The two `HTTP 000` polls are a Worker still working that nobody was
watching.

## Why it matters beyond "slow"

1. **Polling is the scan.** The root `AGENTS.md` states it as a design property: _"with no
   client polling, the scan does not advance."_ A client that times out and backs off stops
   advancing the scan by construction.
2. **Progress cannot be observed without incurring it.** There is no read-only progress
   endpoint on the `/rest` surface — `getScanStatus` always calls `step`. Asking "how far
   along am I?" _is_ doing more of the scan, and may be why it times out. `ScanService.status`
   exists and is unused by this surface.
3. **A client-side timeout is indistinguishable from a dead server.** Nothing in the
   protocol response says "this call did a lot of work".

The `getScanStatus` rate limit (120/min, `rateLimitConfig.ts:68`) is generous enough that
rate limiting is not the binding constraint here.

## The regression introduced on this branch

`packages/backend-services/src/index/ScanService.ts:364` calls `enrichChanged` from inside
`absorb`, which is called from the sequential loop above. Per folder, that is now:

```
1 PROPFIND  +  up to 20 prefix reads  +  up to 20 tail reads (Ogg)  =  up to 41
```

A full chunk becomes `40 × 41 = 1,640` subrequests — **over the 1,000 ceiling** — at roughly
`40 × 41 × 2.2 s ≈ 1 hour` of wall clock. On a real Ogg library that chunk aborts or throws
rather than completing slowly.

Two further gaps make this invisible:

- **`webdavRequests` under-reports.** It is incremented once per `PROPFIND` (line 182) and
  never for enrichment reads. `scanTypes.ts:145` describes the field as _"instrumented so the
  write/subrequest budget is testable, not just asserted"_ — it is now an undercount by up to
  40×, so a test asserting the budget would assert the wrong number.
- **No test exercises either bound.** `fakeDav` answers instantly, so neither the subrequest
  count nor the wall clock was ever observed. The budget lived in comments and in the choice
  of default numbers.

That is the `AGENTS.md` rule about a double that cannot observe a failure, hit while writing
it down: the "measured" budget was arithmetic in a comment, and a comment is not a
measurement.

## Proposed direction

1. **Bound the chunk by subrequests, not by folders.** Count every WebDAV call, including
   enrichment, and leave the loop when the running count reaches a ceiling — returning what
   it completed and leaving the rest of the frontier for the next poll. The frontier is
   already resumable, so this is a small change; it makes the ceiling real instead of
   aspirational.
2. **Add a wall-clock deadline as a second bound.** A fast origin and a slow one differ by
   two orders of magnitude per request, and neither a folder count nor a subrequest count is
   right for both.
3. **Consider sizing the default in time rather than folders.** `40` is defensible for a
   50 ms origin and indefensible for a 2 s one.
4. **Give the tests an origin that can be slow**, and assert the real subrequest count per
   chunk. Counting subrequests in the double is cheap; wall clock would want fake timers.
5. **Give the surface a read-only progress read** (or document that `getScanStatus` is a
   work trigger, so clients should not treat a timeout as "stuck").

## Acceptance criteria

- A chunk's subrequest count is asserted in a test against a `fakeDav` that counts, and the
  assertion is below the platform ceiling at the shipped defaults.
- `ChunkResult.webdavRequests` counts enrichment reads.
- A chunk with a slow origin (`fakeDav` delayed, or fake timers) returns rather than
  exceeding its budget.
- A chunk exceeding either bound resumes correctly on the next poll, with no lost or
  double-counted folders.
- The regression is covered by a test that would have been red on the branch as committed.

## Out of scope

`getScanStatus` was also observed exceeding 45 s on a _cold_ chunk before any enrichment
existed. That is the original form of this issue; the enrichment regression is an
amplification of it, not a separate defect.

## Resolution

Every acceptance criterion is met, and one correction to the issue's own numbers turned
out to matter more than the fix.

**The 1,000-subrequest premise was stale, and the correction was itself half wrong.** Cloudflare
retired that ceiling on 2026-02-11. Workers **Free** allows **50 subrequests per invocation** and
Paid 10,000, raiseable to 10M via `limits.subrequests`. A chunk of 1,640 was therefore not
"past 1,000": on a Free-plan account it was **33× past 50**.

This resolution originally read D1 and KV as having a _separate_ 1,000-subrequest allowance on
Free, on the strength of a second row on Cloudflare's Workers limits page, and set
`DEFAULT_SCAN_CHUNK_MAX_REQUESTS` to 40 on that basis. **That was wrong**, and the correction
introduced the defect the next issue records: D1's own limits page counts _queries per Worker
invocation_ against the same 50, so the budget has to be a total rather than a WebDAV count. The
ceiling is now 50, the chunk budget is `50 − 8`, and every other scan bound is derived from it —
see `docs/issues/free-plan-subrequest-ceiling.md`. The measurement work below was still the right
work and is kept: it is what made the budget _measurable_, which is what the second fix needed.

1. **Bounded by subrequests, not folders** — `ScanBudget` carries `maxRequests` and the
   loop checks `canAfford()` before each folder. The count is **measured**:
   `WebDavClient` takes an `onRequest` callback invoked inside its private `request()`,
   the single path `propfind`/`get`/`readPrefix`/`readTail` share, and `ScanService`
   threads one meter through both `clientFor` and `enrichSong`. A caller-incremented
   counter is a claim about work; one incremented at the choke point is a measurement of
   it, and only the second can bound anything.
2. **A wall-clock deadline** — `SCAN_CHUNK_DEADLINE_MS`, default 20 s, checked between
   units of work so a chunk overruns by at most one in-flight request.
3. **The default is sized in time and requests, not folders** — `chunkFolders` remains a
   _separate_ bound on D1 work, because a folder count, a request count and a duration
   guard three different resources and none is redundant with the others.
4. **The tests can see both bounds** — `fakeDav` gained `latencyMs` (a real
   `setTimeout`, not a fake clock) and `requestCount()`. The suite asserts
   `webdavRequests` equals what the double actually received, which is red on the branch
   as committed.
5. **Documented, and the operator surface can drive a scan** — the driver semantics are
   now on `getScanStatus` in `system.ts` and in `apps/api/AGENTS.md`. The Subsonic
   protocol has no read-only scan-status method, so nothing was invented on `/rest`; but
   the operator surface had **no way to advance a scan at all** (`start` and `status`
   only, while `step` was reachable solely from `/rest`), so `POST
/user/libraries/:id/scan/step` was added. It is also the only place
   `ChunkResult.stoppedBy` is readable, which is what the SPA renders when a chunk pauses.

Two smaller corrections while in here:

- `foldersVisited` reported `frontier.length`, which claimed work a truncated chunk had
  not done. It is now the count actually visited.
- `failChunk` reported a hardcoded `webdavRequests: 1`; it now reports what the failed
  chunk actually issued, which is what an operator needs to tell a credential failure
  from a ceiling.

`ScanService.ts` was at 394 lines against the 400-line hard god-file limit, so this
change would have failed `pnpm run checks` outright. `absorb` moved to
`index/scanFolder.ts` — a different concern from the chunk that drives it, and the same
split `scanEnrichment.ts` already made. The service is now 323 lines.
