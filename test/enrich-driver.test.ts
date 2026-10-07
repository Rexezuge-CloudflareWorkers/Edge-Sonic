/**
 * `EnrichDriver` — one decision, two strategies, and the read-versus-advance split named.
 *
 * The scan's `scan-driver.test.ts` for the enrichment loop, and separate from it for the
 * reason the ports are separate: the two answer different questions about what is running,
 * and one routing assertion covering both would pass while the wrong loop advanced. What
 * is asserted is the routing — `readState` must not advance, `advance` must — because
 * both strategies return an `EnrichChunkResult` either way and a shape comparison passes
 * against either.
 */
import { describe, expect, it, vi } from 'vitest';
import { InProcessEnrichDriver } from '@edge-sonic/backend-services/library';
import type { EnrichDriver, EnrichRunner } from '@edge-sonic/backend-services/library';
import type { EnrichChunkResult } from '@edge-sonic/backend-services/index';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { resolveEnrichDriver, DurableObjectEnrichDriver } from '../apps/api/src/workers/enrichDriver';

/**
 * An `EnrichChunkResult` whose `lastError` names **which** call answered.
 *
 * Not shape: both strategies return one, so a shape comparison passes against either.
 */
function enrichResult(label: string): EnrichChunkResult {
  return {
    status: 'idle',
    enriched: 0,
    remaining: 0,
    lastError: label,
    subrequests: { d1: 0, kv: 0, fetch: 0, rpc: 0, secret: 0, total: 0 },
    rowsWritten: 0,
    billedRows: 0,
    stoppedBy: null,
    resumeAt: null,
  };
}

const LIBRARY = { id: 'L1', slug: 'music' } as unknown as LibraryRow;

function recordingEnrichRunner() {
  const calls: string[] = [];
  const runner: EnrichRunner = {
    step: vi.fn(async () => {
      calls.push('step');
      return enrichResult('step');
    }),
  };
  return { runner, calls };
}

/**
 * A namespace whose `getByName` answers one stub per name, recording which method was reached.
 *
 * `env` carries an `ENRICH` binding so `hasEnrichBinding` is true, which is the whole
 * precondition for the object-backed strategy.
 */
function enrichNamespace(calls: string[]) {
  const stub = {
    startEnrich: vi.fn(async () => {
      calls.push('startEnrich');
      return enrichResult('startEnrich');
    }),
    stepOnce: vi.fn(async () => {
      calls.push('stepOnce');
      return enrichResult('stepOnce');
    }),
    getStatus: vi.fn(async () => {
      calls.push('getStatus');
      return enrichResult('getStatus');
    }),
  };
  const env = { ENRICH: { getByName: () => stub } as unknown as DurableObjectNamespace };
  return { env, stub };
}

function resolveInProcess(runner: EnrichRunner, remaining = async () => 0): EnrichDriver {
  return resolveEnrichDriver({}, () => runner, remaining);
}

describe('EnrichDriver: the in-process strategy', () => {
  it('routes each named operation to the service step', async () => {
    const { runner, calls } = recordingEnrichRunner();
    const driver = resolveInProcess(runner);

    await driver.start(LIBRARY);
    await driver.advance(LIBRARY);

    // In this order, so a swap between the two cannot pass.
    expect(calls).toStrictEqual(['step', 'step']);
  });

  it('reads the remaining count for the list, and reports null while tracks remain', async () => {
    // Unlike the scan's overlay — which is always `null` without an object, because a
    // pause lives in the object — the remaining count is a live measurement, so the list
    // can tell "never started" from "nothing owing" with no run at all.
    const { runner } = recordingEnrichRunner();
    await expect(resolveInProcess(runner, async () => 3).stateForLibraryList('L1')).resolves.toBeNull();
    await expect(resolveInProcess(runner, async () => 3).readState('L1')).resolves.toBeNull();
  });

  it('reports idle for the list once nothing remains', async () => {
    const { runner } = recordingEnrichRunner();
    const result = await resolveInProcess(runner, async () => 0).stateForLibraryList('L1');
    expect(result?.status).toBe('idle');
    expect(result?.remaining).toBe(0);
  });

  it('reads the service lazily, because it is bound into a scope that is still being built', async () => {
    let resolutions = 0;
    const driver: EnrichDriver = new InProcessEnrichDriver(
      () => {
        resolutions += 1;
        return recordingEnrichRunner().runner;
      },
      async () => 0,
    );
    expect(resolutions).toBe(0);
    await expect(driver.stateForLibraryList('L1')).resolves.not.toBeNull();
  });
});

describe('EnrichDriver: the object-backed strategy', () => {
  it('routes each named operation to the matching RPC', async () => {
    const calls: string[] = [];
    const { env } = enrichNamespace(calls);
    const { runner } = recordingEnrichRunner();
    const driver = resolveEnrichDriver(env, () => runner, async () => 0);

    await driver.start(LIBRARY);
    await driver.advance(LIBRARY);
    await driver.readState('L1');

    expect(calls).toStrictEqual(['startEnrich', 'stepOnce', 'getStatus']);
  });

  it('never touches the in-process service, so a deployment with a binding spends nothing twice', async () => {
    const calls: string[] = [];
    const { env } = enrichNamespace(calls);
    const { runner } = recordingEnrichRunner();
    const driver = resolveEnrichDriver(env, () => runner, async () => 0);

    await driver.start(LIBRARY);
    await driver.advance(LIBRARY);
    await driver.readState('L1');
    await driver.stateForLibraryList('L1');

    expect(runner.step).not.toHaveBeenCalled();
  });

  it('answers the library list from the object, where the run progress actually lives', async () => {
    const calls: string[] = [];
    const { env } = enrichNamespace(calls);
    const { runner } = recordingEnrichRunner();
    const result = await resolveEnrichDriver(env, () => runner, async () => 0).stateForLibraryList('L1');
    expect(result?.lastError).toBe('getStatus');
    expect(calls).toStrictEqual(['getStatus']);
  });
});

describe('EnrichDriver: the choice itself', () => {
  it('picks the strategy from the binding, and the binding is the only thing that picks it', () => {
    const { runner } = recordingEnrichRunner();
    const calls: string[] = [];
    const { env } = enrichNamespace(calls);

    expect(resolveEnrichDriver({}, () => runner, async () => 0)).toBeInstanceOf(InProcessEnrichDriver);
    expect(resolveEnrichDriver({ ENRICH: undefined }, () => runner, async () => 0)).toBeInstanceOf(InProcessEnrichDriver);
    expect(resolveEnrichDriver(env, () => runner, async () => 0)).toBeInstanceOf(DurableObjectEnrichDriver);
  });

  it('charges one subrequest per RPC, and none for the in-process branch', async () => {
    const charges: string[] = [];
    const meter = { charge: (_n?: number, kind?: string): void => void charges.push(kind ?? '?') } as unknown as Parameters<typeof resolveEnrichDriver>[3];
    const calls: string[] = [];
    const { env } = enrichNamespace(calls);
    const { runner } = recordingEnrichRunner();

    await resolveEnrichDriver({}, () => runner, async () => 0).readState('L1');
    expect(charges, 'an RPC that did not happen spent nothing').toStrictEqual([]);

    await resolveEnrichDriver(env, () => runner, async () => 0, meter).readState('L1');
    expect(charges).toStrictEqual(['rpc']);
  });
});
