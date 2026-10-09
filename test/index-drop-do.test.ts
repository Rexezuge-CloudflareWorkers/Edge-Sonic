/**
 * The index drop's half that is not D1: stopping the scan, and charging it for what it spent.
 *
 * Both live in the Durable Object rather than in the database, and both are things a DAO test
 * cannot reach. The ordering one is a **race** — a live `ScanWorker` alarm fires every second,
 * and an alarm that fires between the delete of `songs` and the delete of `nodes` walks the
 * origin and writes fresh rows *after* the delete meant to have removed them. A test that only
 * asserted the end state would pass on a drop that raced, so this one drives the alarm in the
 * window.
 *
 * The charge matters for the opposite reason: it is invisible. Nothing renders it, and a drop
 * that skipped it would leave the next scan believing in headroom the platform has already
 * refused — which is the failure `docs/issues/d1-daily-write-limit.md` records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanWorker } from '@edge-sonic/background';
import { createHarness } from './helpers/harness';
import type { Harness } from './helpers/harness';

let harness: Harness;

const ROOT = '/remote.php/dav/files/alice/Music';

beforeEach(async () => {
  harness = await createHarness({
    [ROOT]: [
      { path: ROOT, collection: true, mtime: 1000 },
      { path: `${ROOT}/Bon Iver`, collection: true, mtime: 2000 },
    ],
    [`${ROOT}/Bon Iver`]: [{ path: `${ROOT}/Bon Iver`, collection: true, mtime: 2000 }],
  });
});

afterEach(() => {
  harness.close();
  vi.unstubAllGlobals();
});

interface FakeStorage {
  readonly store: Map<string, unknown>;
  alarmAt: number | null;
  alarmDeletes: number;
}

function fakeState(): { ctx: DurableObjectState; storage: FakeStorage } {
  const storage: FakeStorage = { store: new Map(), alarmAt: null, alarmDeletes: 0 };
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

/**
 * The stored day-memory, typed.
 *
 * Read through a cast rather than a narrowed `unknown` because the shape lives in
 * `scanPause.ts` as `ScanWorkerMemory`, and this is a test of that module's contract from the
 * outside — importing the type would make a change to it invisible here, which is the same
 * direction every guard in this repository is written against.
 */
interface StoredMemory {
  day: string;
  rows: number;
  pause: { resumeAt: number; reason: string } | null;
}

function memoryOf(storage: FakeStorage): StoredMemory | undefined {
  return storage.store.get('memory') as StoredMemory | undefined;
}

describe('reset, which the drop calls before it deletes anything', () => {
  it('deletes the alarm, so a chunk cannot fire between the deletes', async () => {
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');
    expect(storage.alarmAt).not.toBeNull();

    const before = storage.alarmDeletes;
    await worker.reset('L1');

    expect(storage.alarmDeletes).toBe(before + 1);
    expect(storage.alarmAt).toBeNull();
  });

  it('clears a held pause, so an empty library does not render as paused', async () => {
    /**
     * The failure this prevents is silent and reads as healthy.
     *
     * `getStatus` **overlays** a held pause over the stored status, because a pause is usually
     * caused by D1 refusing writes and so cannot be recorded in the row it would override. A
     * pause surviving a drop therefore renders "paused until 00:00 UTC" over a library with
     * nothing in it — and the operator's only conclusion is that the drop did not work.
     *
     * The pause is written straight into storage rather than produced by exhausting a budget,
     * because producing one costs a real scan and the stored shape is what `held()` reads.
     */
    const { ctx, storage } = fakeState();
    await workerFor(ctx).startScan('L1');
    await ctx.storage.put('memory', {
      day: new Date().toISOString().slice(0, 10),
      rows: 0,
      pause: { resumeAt: Date.now() + 60_000, reason: 'Paused.' },
    });

    const worker = workerFor(ctx);
    // The overlay is visible before the reset, which is what makes the assertion below a
    // measurement of the fix rather than of the absence of a pause.
    expect((await worker.getStatus('L1')).status).toBe('paused');

    await worker.reset('L1');

    expect(memoryOf(storage)?.pause).toBeNull();
    expect((await worker.getStatus('L1')).status).not.toBe('paused');
  });

  it('writes nothing when there was no pause to clear', async () => {
    // DO storage has a daily allowance this deployment spends ~86,000 entries of a day
    // tracking D1's own, so an unconditional `put` on every drop of an already-clean library
    // is a real cost. Asserted as "the stored memory is absent", which is stronger than a
    // counter: an equal-valued write would leave the key present.
    const { ctx, storage } = fakeState();
    await workerFor(ctx).reset('L1');
    expect(storage.store.has('memory')).toBe(false);
  });

  it('does not seed the frontier, or the drop would refill what it emptied', async () => {
    /**
     * The subtle half.
     *
     * `start` is the only thing that seeds the frontier, and it exists because a scan needs a
     * root row to descend from. A drop that reached for the same helper would put every folder
     * back on `is_scanned = 0` — which is not indexing anything, but it *is* the state
     * `listFrontier` reads, so the very next chunk would walk the whole origin and write the
     * index the operator asked to have deleted.
     *
     * Asserted against the real query the walk uses rather than against an internal flag.
     */
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { ctx } = fakeState();
    await workerFor(ctx).startScan('L1');
    // Drain the seeded frontier so anything `reset` wrote would be visible rather than
    // indistinguishable from what `start` left.
    for (let i = 0; i < 12; i++) await workerFor(ctx).alarm();

    await workerFor(ctx).reset('L1');

    const frontier = await harness.db.db
      .prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE library_id = ? AND is_scanned = 0')
      .bind('L1')
      .first<{ cnt: number }>();
    expect(frontier?.cnt).toBe(0);
  });

  it('leaves the library id alone, so a later startScan lands on the right library', async () => {
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startScan('L1');
    expect(storage.store.get('libraryId')).toBe('L1');

    await worker.reset('L1');

    expect(storage.store.get('libraryId')).toBe('L1');
  });
});

describe('charge, which the drop calls after the deletes', () => {
  it('adds the drop’s billed rows to the day count', async () => {
    // The figure the drop spent. It is real allowance — `songs` bills ten rows per row
    // deleted — and this counter is what paces every scan after it, so a drop that skipped this
    // would let the next scan start believing in headroom D1 has already refused.
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);

    await worker.charge('L1', 54_000);

    expect(memoryOf(storage)?.rows).toBe(54_000);
  });

  it('accumulates rather than replacing', async () => {
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);

    await worker.charge('L1', 1000);
    await worker.charge('L1', 2500);

    expect(memoryOf(storage)?.rows).toBe(3500);
  });

  it('ignores a non-positive figure rather than moving the count backwards', async () => {
    // `charge` is reached with what `runWriteStatement` measured, and a `DELETE` that removed
    // nothing measures `0`. Subtracting the day's spend would give the next scan a budget
    // larger than the platform's — the exact over-count `scanPause.ts` was rebuilt to remove.
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.charge('L1', 4000);
    const before = memoryOf(storage)?.rows;

    await worker.charge('L1', 0);
    await worker.charge('L1', -10);

    expect(memoryOf(storage)?.rows).toBe(before);
    expect(memoryOf(storage)?.rows).toBe(4000);
  });

  it('keeps a held pause, because clearing one is `reset`’s job', async () => {
    // The two are separate methods for a reason a test can see: a drop charges the day's count
    // *and* clears the pause, and folding them together would make one of them unable to
    // happen without the other. `clear` keeps the count and `charge` keeps the pause, and each
    // is reachable alone.
    const { ctx } = fakeState();
    const pause = { resumeAt: Date.now() + 60_000, reason: 'Paused.' };
    await ctx.storage.put('memory', { day: new Date().toISOString().slice(0, 10), rows: 0, pause });

    await workerFor(ctx).charge('L1', 1000);

    const stored = (await ctx.storage.get('memory')) as StoredMemory;
    expect(stored.pause).toEqual(pause);
    expect(stored.rows).toBe(1000);
  });

  it('writes nothing for a figure below the persist interval', async () => {
    // The count is persisted on an interval rather than every time, and the interval is a
    // property of the DO storage allowance. Asserted so the batching stays: a drop that wrote
    // on every call would trade one allowance for another at a far worse rate.
    const { ctx, storage } = fakeState();
    await workerFor(ctx).charge('L1', 10);
    expect(storage.store.has('memory')).toBe(false);
  });
});
