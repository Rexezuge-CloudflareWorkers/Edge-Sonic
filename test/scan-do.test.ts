/**
 * The per-library scan worker: alarm-driven progress without client polling.
 *
 * Without the `SCAN` binding the fetch isolate advances the scan itself (the
 * path every other suite exercises). With it, `getScanStatus` is a read-only
 * `getStatus` and the DO alarm does the work — so this suite drives a real
 * `ScanWorker` against the harness database and asserts the alarm chain moves
 * the frontier while a status read issues no requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanWorker } from '@edge-sonic/background';
import { getScanStub, hasScanBinding } from '../apps/api/src/workers/scanStubs';
import { createHarness } from './helpers/harness';
import type { Harness } from './helpers/harness';

let harness: Harness;

beforeEach(async () => {
  const root = '/remote.php/dav/files/alice/Music';
  harness = await createHarness({
    [root]: [
      { path: root, collection: true, mtime: 1000 },
      { path: `${root}/Bon Iver`, collection: true, mtime: 2000 },
    ],
    [`${root}/Bon Iver`]: [{ path: `${root}/Bon Iver`, collection: true, mtime: 2000 }],
  });
});

afterEach(() => {
  harness.close();
  vi.unstubAllGlobals();
});

interface FakeStorage {
  readonly store: Map<string, unknown>;
  alarmAt: number | null;
  alarmSets: number;
  alarmDeletes: number;
}

function fakeState(): { ctx: DurableObjectState; storage: FakeStorage } {
  const storage: FakeStorage = { store: new Map(), alarmAt: null, alarmSets: 0, alarmDeletes: 0 };
  const ctx = {
    storage: {
      get: async (key: string) => storage.store.get(key),
      put: async (key: string, value: unknown) => {
        storage.store.set(key, value);
      },
      delete: async (key: string) => storage.store.delete(key),
      getAlarm: async () => storage.alarmAt,
      setAlarm: async (at: number | Date) => {
        storage.alarmAt = typeof at === 'number' ? at : at.getTime();
        storage.alarmSets += 1;
      },
      deleteAlarm: async () => {
        storage.alarmAt = null;
        storage.alarmDeletes += 1;
      },
    },
  } as unknown as DurableObjectState;
  return { ctx, storage };
}

function workerFor(ctx: DurableObjectState): ScanWorker {
  return new ScanWorker(ctx, harness.env() as unknown as Cloudflare.Env);
}

describe('ScanWorker', () => {
  it('starts a scan and schedules the alarm chain', async () => {
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    const started = await worker.startScan('L1');
    expect(started.status).toBe('scanning');
    expect(storage.store.get('libraryId')).toBe('L1');
    expect(storage.alarmSets).toBeGreaterThan(0);
  });

  it('advances to idle through alarms with no client polling', async () => {
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');
    for (let i = 0; i < 10; i++) {
      const status = await worker.getStatus('L1');
      if (status.status === 'idle') break;
      await worker.alarm();
    }
    const done = await worker.getStatus('L1');
    expect(done.status).toBe('idle');
    expect(storage.alarmAt).toBeNull();
  });

  it('reads status without issuing requests', async () => {
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    const before = harness.dav.propfinds.length;
    const status = await worker.getStatus('L1');
    expect(status.foldersVisited).toBe(0);
    expect(status.subrequests.total).toBe(0);
    expect(harness.dav.propfinds).toHaveLength(before);
  });

  it('enriches a known track and answers null for an unknown one', async () => {
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    const enriched = await worker.enrichSong('L1', harness.ids.skinnyLove);
    expect(enriched?.id).toBe(harness.ids.skinnyLove);
    await expect(worker.enrichSong('L1', 's:bm8=')).resolves.toBeNull();
  });

  it('answers no artwork for an empty candidate list without touching the origin', async () => {
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    const before = harness.dav.propfinds.length;
    await expect(worker.coverArt('L1', 'Bon Iver/For Emma', [], 10_000)).resolves.toBeNull();
    expect(harness.dav.propfinds).toHaveLength(before);
  });

  it('refuses an unknown library on every RPC', async () => {
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    await expect(worker.startScan('L-nope')).rejects.toThrow();
    await expect(worker.stepOnce('L-nope')).rejects.toThrow();
    await expect(worker.enrichSong('L-nope', harness.ids.skinnyLove)).rejects.toThrow();
  });

  it('clears the alarm when the library is gone', async () => {
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');
    await harness.db.db.prepare('DELETE FROM libraries WHERE id = ?').bind('L1').run();
    await worker.alarm();
    expect(storage.alarmAt).toBeNull();
  });

  it('keeps the chain armed when a chunk throws, so a transient fault does not end the scan', async () => {
    // ### The wedge this closes
    //
    // `alarm()` had no handler at all, and `ScanService.step` had five awaited calls —
    // `ensure`, `derivePending`, `listFrontier`, `fail`, `complete` — *outside* its own
    // `try`. So a D1 error in any of them propagated out of `alarm`, the re-arm never
    // ran, and the alarm was consumed with nothing scheduled behind it. D1 still held
    // `scan_state.status = 'scanning'`, so `getStatus` answered `scanning: true` **for
    // ever** — which every client reads as *keep polling*.
    //
    // Nothing could have reported it. The alarm lives in DO storage, the status in D1,
    // and `getAlarm()` is called from nowhere in this repository, so the two were never
    // reconciled. Cloudflare retries a throwing alarm a bounded number of times and then
    // drops it, and each retry hit the same fault. `startScan` was the only recovery and
    // it runs at client startup, not while browsing.
    //
    // The assertion is that `alarm` **does not reject** and the chain is still armed —
    // not that the chunk succeeded. A rejected alarm is the defect; an armed one is the
    // bound, because `consecutive_failures` decides when the retries stop.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');

    // Every chunk's *read* of `scan_state` fails, which is the pre-`try` region this test
    // exists for: the throw happens before any walk work and before any counter is read.
    // The write that records the failure is left working, because that is the realistic
    // case — a read replica briefly unavailable — and because blocking it as well would
    // test the "could not even record it" branch rather than the one under test.
    const realPrepare = harness.db.db.prepare.bind(harness.db.db);
    let failing = true;
    vi.spyOn(harness.db.db, 'prepare').mockImplementation((query: string) => {
      if (failing && /^SELECT/i.test(query.trim()) && query.includes('scan_state')) throw new Error('D1 unavailable');
      return realPrepare(query);
    });

    // Not `rejects.toThrow()`. The whole point is that it *cannot* throw — a handler that
    // rejects is what ended the chain.
    await expect(worker.alarm()).resolves.toBeUndefined();
    expect(storage.alarmAt, 'the chain must stay armed').not.toBeNull();

    // And the failure was recorded rather than dropped, so an operator sees a reason
    // instead of a scan that claims to be running. This is the same rule as persisting a
    // probe outcome: a diagnosis nobody can retrieve is the same as never computing it.
    //
    // Read through the un-spied handle: the assertion is about what the **database** holds,
    // and asking the mock about the database is the shape of assertion that passes because
    // the mock agrees with itself.
    failing = false;
    vi.restoreAllMocks();
    const state = await harness.db.db.prepare('SELECT status, last_error FROM scan_state WHERE library_id = ?').bind('L1').first<{ status: string; last_error: string | null }>();
    expect(state?.last_error, 'the reason must be readable by the operator surface').toContain('D1 unavailable');

    // Recovery: D1 and the origin are back, and the chain that survived the fault is the
    // one that finishes the scan. Without the re-arm this loop would never be entered —
    // the alarm was consumed by the very handler that has to run again.
    for (let i = 0; i < 10; i++) {
      const status = await worker.getStatus('L1');
      if (status.status === 'idle') break;
      await worker.alarm();
    }
    expect((await worker.getStatus('L1')).status).toBe('idle');
  });

  it('re-arms rather than stopping when the failure is outside the walk entirely', async () => {
    // The pair for the test above, and it is the one that keeps the catch honest. The
    // previous test's fault is *inside* `step`, so `step` could record it and the retry
    // budget could bound it. This one is a storage read failing before `step` is ever
    // called — there is nothing to record against, so the only thing left to do is not
    // stop.
    //
    // If the handler treated a recorded failure as the terminal case it would
    // `deleteAlarm` here, and a one-off storage fault would end a scan for ever with the
    // frontier intact in D1 — the same shape as the shipped "one bad chunk ended a scan
    // permanently" defect, one layer up.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');
    storage.alarmAt = null;

    // `DurableObjectStorage.get` is overloaded (single key vs batch), so `spyOn` resolves to
    // the batch overload and a single-key implementation does not satisfy it. The cast is
    // to the single-key shape the class actually calls — stated rather than worked around
    // with `as never`, which would hide a signature change behind a passing suite.
    const singleKeyGet = ctx.storage.get as unknown as (key: string) => Promise<unknown>;
    const realGet = singleKeyGet.bind(ctx.storage);
    vi.spyOn(ctx.storage, 'get').mockImplementation((async (key: string) => {
      if (key === 'libraryId') throw new Error('storage read failed');
      return await realGet(key);
    }) as unknown as typeof ctx.storage.get);

    await expect(worker.alarm()).resolves.toBeUndefined();
    expect(storage.alarmAt, 'a fault outside the walk must not stop the chain').not.toBeNull();
    expect(storage.alarmDeletes).toBe(0);
  });

  it('does not lose progress when a manual step and an alarm overlap', async () => {
    // `stepOnce` is reachable from an operator `POST` at any moment, including while the
    // alarm is live, and a Durable Object interleaves the two at every `await`. Both read
    // `scanned_count`, add their own folder count, and write the sum back — so the smaller
    // write landing last leaves the counter permanently **under-reported**, and the scan
    // finishes having walked less than it reports having walked.
    //
    // The counter is the only thing the walk persists, so a lost update is not a cosmetic
    // race. And because `is_scanned` is advanced by the same statements, the work is done
    // — it is the count that goes backwards, which is exactly the shape of "a row says one
    // thing while its children say another".
    //
    // The fixture tree has two folders (the root and `Bon Iver`), so each chunk that sees a
    // full frontier walks both. Three overlapping steps must therefore leave `scanned` at
    // least as high as the number of chunks that actually ran; a lost update shows up as a
    // count below that.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');

    const results = await Promise.all([worker.stepOnce('L1'), worker.stepOnce('L1'), worker.stepOnce('L1')]);
    const finished = results.filter((result) => result.status !== 'idle' && result.status !== 'stalled');
    const walked = finished.reduce((sum, result) => sum + result.foldersVisited, 0);

    const persisted = (await worker.getStatus('L1')).scanned;
    // Every folder any of the three chunks walked must be counted. This is the assertion
    // that goes red on a lost update: the counter is the *sum* of the chunks, and a read-
    // modify-write race publishes the smallest of them instead.
    expect(persisted).toBeGreaterThanOrEqual(walked);
    // And never fewer than a single chunk's own count, which is the degenerate case of the
    // same race where the only write to land is the last one to start.
    for (const result of finished) expect(persisted).toBeGreaterThanOrEqual(result.scanned);
  });
});

describe('a spent D1 daily allowance', () => {
  /**
   * Cloudflare's refusal, verbatim, wrapped the way `executeD1WithRetry` wraps it.
   *
   * D1 enforces the Free plan's daily row allowance by failing **every** query — reads included —
   * until midnight UTC, so the whole product is down and Subsonic authentication goes with it.
   * That is what the two answers below are about.
   */
  const LIMIT_ERROR = "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

  /**
   * Make every D1 statement fail with the platform's message.
   *
   * `prepare` is the choke point every statement in this repository passes through — the same
   * reason the subrequest meter is charged there — so one replacement is enough, and replacing
   * anything narrower would leave a path where a write quietly succeeds inside a "write-refused"
   * deployment, which is the state this file must not be able to construct.
   */
  function refuseEveryD1Statement(): void {
    vi.spyOn(harness.db.db, 'prepare').mockImplementation((sql: string) => {
      const real = (harness.db.db as unknown as { prepare: (s: string) => unknown }).prepare.bind(harness.db.db);
      void real;
      const stub = {
        bind: () => stub,
        run: async () => {
          throw new Error(`Failed to statement: ${LIMIT_ERROR}`);
        },
        first: async () => {
          throw new Error(`Failed to statement: ${LIMIT_ERROR}`);
        },
        all: async () => {
          throw new Error(`Failed to statement: ${LIMIT_ERROR}`);
        },
      };
      void sql;
      return stub as never;
    });
  }

  it('pauses, and arms the alarm for the reset rather than a second later', async () => {
    // The defect this is about, in one assertion. D1 refused every query, so the chunk could not
    // even read its own state; the old path caught that, tried to record it with a write that
    // could not succeed, returned `failed`, and `isAdvancing('failed')` re-armed the alarm one
    // second later — roughly 86,400 times before the reset, each attempt a failed statement and a
    // failed write, with the reason in an exception `toSubsonicError` masked.
    //
    // So the assertions are: `paused`, a resume time at midnight UTC rather than now, and an alarm
    // set to that time rather than to `now + 1000`.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');

    refuseEveryD1Statement();
    const before = Date.now();
    const paused = await worker.stepOnce('L1');

    expect(paused.status).toBe('paused');
    expect(paused.resumeAt).not.toBeNull();
    // Strictly in the future, and at a UTC midnight — a reset an hour out, or already past, is
    // the boundary where a "pause" becomes the one-second loop again.
    expect(paused.resumeAt as number).toBeGreaterThan(before);
    expect(new Date(paused.resumeAt as number).getUTCHours()).toBe(0);
    expect(new Date(paused.resumeAt as number).getUTCMinutes()).toBe(0);

    // The alarm sleeps through the window. A re-arm one second out is the loop.
    expect(storage.alarmAt).toBe(paused.resumeAt);
    expect(storage.alarmDeletes).toBe(0);
  });

  it('holds the pause in storage, where D1 cannot reach it', async () => {
    // The placement is the mechanism, not a convenience. A pause is usually *caused by* D1 refusing
    // writes, so a pause held in `scan_state` would be unwritable exactly when it is needed, and
    // the operator's page — which reads D1 — could not see it either.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');

    refuseEveryD1Statement();
    const paused = await worker.stepOnce('L1');

    const memory = storage.store.get('memory') as { pause: { resumeAt: number; reason: string } | null } | undefined;
    expect(memory?.pause?.resumeAt).toBe(paused.resumeAt);
    expect(memory?.pause?.reason).toContain('00:00 UTC');
  });

  it('reports the pause from a status read, and keeps its counters measured', async () => {
    // `getStatus` is what `getScanStatus` and the operator page both call, so a pause it cannot
    // report is a pause no surface can see. The counters come from D1 when D1 answers — here it
    // cannot, so they are zero, which is honest rather than a fabricated count about a library the
    // call never looked at.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');

    refuseEveryD1Statement();
    await worker.stepOnce('L1');
    const status = await worker.getStatus('L1');

    expect(status.status).toBe('paused');
    expect(status.scanned).toBe(0);
    expect(status.lastError).toContain('00:00 UTC');
  });

  it('drops the pause as soon as D1 answers again', async () => {
    // The other half, and without it the pause is permanent: a stale `paused` in storage would keep
    // reporting over a healthy scan, and the alarm would sleep to midnight for a library that had
    // finished hours ago.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');

    refuseEveryD1Statement();
    await worker.stepOnce('L1');
    expect((storage.store.get('memory') as { pause: unknown }).pause).not.toBeNull();

    vi.restoreAllMocks();
    for (let i = 0; i < 10; i++) {
      const status = await worker.getStatus('L1');
      if (status.status === 'idle') break;
      await worker.alarm();
    }

    expect((await worker.getStatus('L1')).status).toBe('idle');
    expect((storage.store.get('memory') as { pause: unknown }).pause).toBeNull();
    expect(storage.alarmAt).toBeNull();
  });

  it('does not spend the retry budget on a pause', async () => {
    // `consecutive_failures` bounds retries of a *fault*. A spent allowance is not a fault — it
    // resolves at midnight and needs no attempt — so charging it there is how one condition would
    // eventually be declared `stalled`, which deletes the alarm and leaves the scan unrecovered
    // until an operator noticed.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');

    refuseEveryD1Statement();
    await worker.stepOnce('L1');
    await worker.stepOnce('L1');
    await worker.stepOnce('L1');

    // Restore D1 **before** reading the row back: the refusal replacement is on `prepare`, so the
    // assertion's own query would fail and say nothing about the counter. Asserting the *absence*
    // of a write needs the store to be answering.
    vi.restoreAllMocks();
    const row = await harness.db.db
      .prepare('SELECT consecutive_failures, status FROM scan_state WHERE library_id = ?')
      .bind('L1')
      .first<{ consecutive_failures: number; status: string }>();
    // The seeded row says `scanning`: a pause left it alone, where the old path would have written
    // `failed` and counted three times over — which is what would eventually have deleted the alarm.
    expect(row?.status).toBe('scanning');
    expect(row?.consecutive_failures ?? 0).toBe(0);
  });

  it('lets a scan pace itself before the platform refuses, rather than after', async () => {
    // The preventive half. Even a *correct* chunk writes ~42 rows, so a 5,000-rows/day allowance
    // is about two minutes of scanning — the limit is reached by design, not only by the runaway.
    // The pair for the cases above: they are the backstop for a breach the pacing missed, and this
    // is what makes the backstop rare.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');

    const before = harness.dav.propfinds.length;
    // A budget already spent: the chunk must issue no request at all.
    const paused = await worker.stepOnce('L1', () => ({ rowsWrittenToday: 5000, limit: 4000, now: Date.now }));

    expect(paused.status).toBe('paused');
    expect(paused.lastError).toContain('4000-row share');
    expect(harness.dav.propfinds, 'a paced scan must not open the origin').toHaveLength(before);
    expect(storage.alarmAt).toBe(paused.resumeAt);
  });
});

describe('scan stubs', () => {
  it('reports no binding in the harness env, and throws when a stub is demanded', () => {
    expect(hasScanBinding(harness.env())).toBe(false);
    expect(() => getScanStub(harness.env(), 'L1')).toThrow();
  });

  it('resolves one stub per library id', () => {
    const seen = new Map<string, object>();
    const ns = {
      getByName: (name: string) => {
        let stub = seen.get(name);
        if (!stub) {
          stub = {};
          seen.set(name, stub);
        }
        return stub;
      },
    };
    const env = { ...harness.env(), SCAN: ns };
    expect(hasScanBinding(env)).toBe(true);
    expect(getScanStub(env, 'L1')).toBe(getScanStub(env, 'L1'));
    expect(getScanStub(env, 'L1')).not.toBe(getScanStub(env, 'L2'));
  });
});
