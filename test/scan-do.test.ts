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
    expect(status.webdavRequests).toBe(0);
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
