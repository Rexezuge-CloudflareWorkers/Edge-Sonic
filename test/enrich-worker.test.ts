/**
 * The per-library enrichment worker: alarm-driven progress without client polling.
 *
 * Without the `ENRICH` binding the fetch isolate advances the run itself, one chunk per
 * operator step (the path every other suite exercises). With it, `getStatus` is a
 * read-only status and the DO alarm does the work — so this suite drives a real
 * `EnrichWorker` against the harness database and asserts the alarm chain drains the
 * remaining set while a status read enriches nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnrichWorker } from '@edge-sonic/background';
import { ConflictError } from '@edge-sonic/backend-errors';
import { SongDAO } from '@edge-sonic/backend-data/dao';
import { SubrequestCounter } from '@edge-sonic/shared';
import { createHarness } from './helpers/harness';
import type { Harness } from './helpers/harness';

let harness: Harness;

const encoder = new TextEncoder();

function flacPrefix(seconds: number): Uint8Array {
  const streamInfo = new Uint8Array(34);
  const view = new DataView(streamInfo.buffer);
  view.setUint16(0, 4096);
  view.setUint16(2, 4096);
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let index = width - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  };
  push(44_100, 20);
  push(1, 3);
  push(15, 5);
  push(44_100 * seconds, 36);
  for (let index = 0; index < 64; index += 1) {
    if (bits[index]) streamInfo[10 + (index >> 3)]! |= 1 << (7 - (index & 7));
  }
  return new Uint8Array([...encoder.encode('fLaC'), 0x80, 0, 0, 34, ...streamInfo]);
}

const ROOT = '/remote.php/dav/files/alice/Music';

/**
 * Mark every seeded track unenriched and serve a body the tag read can parse.
 *
 * The harness seeds two enriched tracks; the run needs tracks owing a read. The update
 * is the whole setup — no scan has to run, because enrichment reads rows, not folders.
 */
async function makeOwing(): Promise<void> {
  await harness.db.db.prepare('UPDATE songs SET enriched_at = NULL, reader_version = 0').run();
  const rows = (await harness.db.db.prepare('SELECT path, size FROM songs').all<{ path: string; size: number }>()).results ?? [];
  const tree: Record<string, Array<{ path: string; size: number; contentType: string; body: Uint8Array }>> = {};
  for (const song of rows) {
    const full = `${ROOT}/${song.path}`;
    tree[full] = [{ path: full, size: song.size, contentType: 'audio/flac', body: flacPrefix(180) }];
  }
  harness.dav.setTree(tree);
}

/**
 * Add `count` further unenriched tracks, so a run spans several alarms.
 */
async function addTracks(count: number): Promise<void> {
  const songs = new SongDAO(harness.db.db, '', new SubrequestCounter(10_000));
  const tree: Record<string, Array<{ path: string; size: number; contentType: string; body: Uint8Array }>> = {};
  const inputs = [];
  for (let index = 1; index <= count; index += 1) {
    const name = `extra-${index}.flac`;
    const full = `${ROOT}/Bon Iver/For Emma/${name}`;
    tree[full] = [{ path: full, size: 4096, contentType: 'audio/flac', body: flacPrefix(200) }];
    inputs.push({
      id: `extra-${index}`,
      libraryId: 'L1',
      path: `Bon Iver/For Emma/${name}`,
      dirPath: 'Bon Iver/For Emma',
      name,
      size: 4096,
      mtimeMs: 5000 + index,
      contentType: 'audio/flac',
      suffix: 'flac',
    });
  }
  await songs.upsertFileFacts(inputs);
  harness.dav.setTree(tree);
}

beforeEach(async () => {
  harness = await createHarness({});
  vi.stubGlobal('fetch', harness.dav.fetch);
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

function workerFor(ctx: DurableObjectState): EnrichWorker {
  return new EnrichWorker(ctx, harness.env() as unknown as Cloudflare.Env);
}

describe('EnrichWorker', () => {
  it('reports null before a run starts while tracks remain', async () => {
    await makeOwing();
    const { ctx } = fakeState();

    expect(await workerFor(ctx).getStatus('L1')).toBeNull();
  });

  it('starts a run and disarms when the first chunk finishes it', async () => {
    await makeOwing();
    const { ctx, storage } = fakeState();

    const started = await workerFor(ctx).startEnrich('L1');

    expect(started.status).toBe('idle');
    expect(started.enriched).toBe(2);
    expect(started.remaining).toBe(0);
    expect(storage.store.get('libraryId')).toBe('L1');
    // Terminal: nothing is scheduled to resume a finished run, so the alarm is deleted
    // rather than left armed to wake the object once more to do nothing.
    expect(storage.alarmDeletes).toBeGreaterThan(0);
    expect(storage.alarmAt).toBeNull();
  });

  it('advances across alarms to idle, then disarms', async () => {
    await makeOwing();
    await addTracks(9);
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);

    const first = await worker.startEnrich('L1');
    expect(first.status).toBe('enriching');
    expect(first.remaining).toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) {
      const status = await worker.getStatus('L1');
      if (status?.status === 'idle') break;
      await worker.alarm();
    }
    const done = await worker.getStatus('L1');
    expect(done?.status).toBe('idle');
    expect(done?.remaining).toBe(0);
    expect(storage.alarmAt).toBeNull();
  });

  it('reads status without enriching anything', async () => {
    await makeOwing();
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    await worker.startEnrich('L1');

    const before = harness.dav.gets.length;
    const status = await worker.getStatus('L1');

    expect(status?.enriched).toBe(2);
    expect(harness.dav.gets).toHaveLength(before);
  });

  it('refuses a manual step while the scan is advancing, and the alarm waits silently', async () => {
    await makeOwing();
    await harness.db.db
      .prepare("INSERT INTO scan_state (library_id, status, scanned_count, total_count, index_version, consecutive_failures, updated_at) VALUES ('L1', 'scanning', 0, 0, 1, 0, 0)")
      .run();
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    await worker.startEnrich('L1').catch(() => undefined);

    await expect(worker.stepOnce('L1')).rejects.toThrow(ConflictError);

    // The alarm does not count the refusal as a failure: it re-arms behind the scan and
    // the run resumes when the scan goes idle.
    const sets = storage.alarmSets;
    await worker.alarm();
    expect(storage.alarmSets).toBeGreaterThan(sets);
    const progress = storage.store.get('enrichProgress') as { consecutiveFailures: number } | undefined;
    expect(progress?.consecutiveFailures ?? 0).toBe(0);
  });

  it('refuses an unknown library on every RPC', async () => {
    const { ctx } = fakeState();
    const worker = workerFor(ctx);
    await expect(worker.startEnrich('L-nope')).rejects.toThrow();
    await expect(worker.stepOnce('L-nope')).rejects.toThrow();
  });

  it('pauses without writing when the day’s share is spent', async () => {
    await makeOwing();
    const { ctx, storage } = fakeState();
    const today = new Date().toISOString().slice(0, 10);
    await ctx.storage.put('memory', { day: today, rows: 1_000_000, pause: null });

    const result = await workerFor(ctx).startEnrich('L1');

    expect(result.status).toBe('paused');
    expect(result.resumeAt).not.toBeNull();
    expect(result.enriched).toBe(0);
    expect(storage.alarmAt).toBe(result.resumeAt);
  });

  it('stalls after repeated chunk failures and disarms', async () => {
    await makeOwing();
    const { ctx, storage } = fakeState();
    const worker = workerFor(ctx);
    // Every chunk fails before any track: the selection itself cannot run.
    await harness.db.db.prepare('DROP TABLE songs').run();
    await worker.startEnrich('L1');

    for (let i = 0; i < 3; i++) await worker.alarm();

    const status = await worker.getStatus('L1');
    expect(status?.status).toBe('stalled');
    expect(status?.lastError).not.toBeNull();
    expect(storage.alarmAt).toBeNull();
  });
});
