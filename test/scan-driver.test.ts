/**
 * `ScanDriver` — one decision, two strategies, and the read-versus-advance asymmetry named.
 *
 * ### Why this suite exists
 *
 * "Is a Durable Object carrying this scan?" is a property of the **deployment**, and it was being
 * asked at seven call sites. Five were `hasScanBinding(...) ? stub : service` shapes.
 *
 * Worse, two of those five gave the **same question different answers**. Asking "what is this
 * library's scan state?" reached `ScanWorker.getStatus` *and* `ScanService.step` from
 * `/rest/getScanStatus`, and `ScanWorker.getStatus` *and* `ScanService.status` from
 * `GET /user/libraries/:id/scan`. Both compiled, both returned a `ChunkResult`, and the two
 * endpoints disagreed about whether reading a scan also performs one — which is this repository's
 * most-repeated shape of defect, *a comparison written twice is two answers*, except that here
 * both answers were present rather than one missing.
 *
 * The port makes the difference a **method name**, and this suite pins what each name reaches.
 *
 * ### The double records **which** method was called
 *
 * Not how many times, and not the returned value — the returned value is a `ChunkResult` from both
 * sides and comparing it would pass on either. What is being asserted is the routing decision:
 * `readState` must reach `status` and `advance` must reach `step`, and `pollStatus` must reach one
 * on the object-backed strategy and the *other* on the in-process one. A spy on the fake service
 * is the only place that difference is visible, which is why the fake exists rather than a count.
 */
import { describe, expect, it, vi } from 'vitest';
import { InProcessScanDriver } from '@edge-sonic/backend-services/library';
import type { ScanDriver, ScanRunner } from '@edge-sonic/backend-services/library';
import type { ChunkResult, ScanDailyBudget } from '@edge-sonic/backend-services/index';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { resolveScanDriver, DurableObjectScanDriver } from '../apps/api/src/workers/scanDriver';

/**
 * A `ChunkResult` whose `lastError` names **which** call answered.
 *
 * Not shape: both strategies return a `ChunkResult`, so a shape comparison passes against either.
 * Putting the label in a field keeps the assertion on the returned value rather than on a side
 * channel the fake maintains alongside it.
 */
function chunkResult(label: string): ChunkResult {
  return {
    status: 'idle',
    scanned: 0,
    indexVersion: 1,
    lastError: label,
    foldersVisited: 0,
    subrequests: { d1: 0, kv: 0, fetch: 0, rpc: 0, secret: 0, total: 0 },
    rowsWritten: 0,
    billedRows: 0,
    stoppedBy: null,
    resumeAt: null,
  };
}

const LIBRARY = { id: 'L1', slug: 'music' } as unknown as LibraryRow;

/**
 * A `ScanRunner` that records the method each call reached and answers with its own name.
 *
 * Typed as the **port**, not as `ScanService`, which is what lets it satisfy the parameter with no
 * cast. `ScanService` carries private members, so a fake could only be handed to a driver typed
 * against the class through `as unknown as` — a hole where the fake and the real thing can
 * disagree with nothing measuring the pair.
 */
function recordingScanRunner() {
  const calls: string[] = [];
  const runner: ScanRunner = {
    start: vi.fn(async (_library: LibraryRow, _budget?: () => ScanDailyBudget) => {
      calls.push('start');
      return chunkResult('start');
    }),
    step: vi.fn(async (_library: LibraryRow, _budget?: () => ScanDailyBudget) => {
      calls.push('step');
      return chunkResult('step');
    }),
    status: vi.fn(async (_libraryId: string) => {
      calls.push('status');
      return chunkResult('status');
    }),
  };
  return { runner, calls };
}

/**
 * A namespace whose `getByName` answers one stub per name, recording which method was reached.
 *
 * `env` carries a `SCAN` binding so `hasScanBinding` is true, which is the whole precondition for
 * the object-backed strategy — and it is the *only* thing that selects it, so a test that forgot
 * it would silently exercise the other branch and pass for the wrong reason.
 */
function scanNamespace(calls: string[]) {
  const stub = {
    startScan: vi.fn(async () => {
      calls.push('startScan');
      return chunkResult('startScan');
    }),
    stepOnce: vi.fn(async () => {
      calls.push('stepOnce');
      return chunkResult('stepOnce');
    }),
    getStatus: vi.fn(async () => {
      calls.push('getStatus');
      return chunkResult('getStatus');
    }),
  };
  const env = { SCAN: { getByName: () => stub } as unknown as DurableObjectNamespace };
  return { env, stub };
}

describe('ScanDriver: the in-process strategy', () => {
  it('routes each named operation to exactly one walk method', async () => {
    const { runner, calls } = recordingScanRunner();
    const driver = resolveScanDriver({}, () => runner);

    await driver.start(LIBRARY);
    await driver.advance(LIBRARY);
    await driver.readState('L1');

    // In this order, so a swap between two of them cannot pass.
    expect(calls).toStrictEqual(['start', 'step', 'status']);
  });

  it('reads on `readState` and advances on `advance`, which is the pair that used to be one ternary twice', async () => {
    // The invariant, stated as its own case rather than as a side effect of the one above: a
    // `readState` that reached `step` would make an operator's polled page *advance* the scan, and
    // an `advance` that reached `status` would make the manual "step" button do nothing while
    // reporting success.
    const { runner, calls } = recordingScanRunner();
    const driver = resolveScanDriver({}, () => runner);

    await driver.readState('L1');
    expect(calls).toStrictEqual(['status']);

    calls.length = 0;
    await driver.advance(LIBRARY);
    expect(calls).toStrictEqual(['step']);
  });

  it('advances on `pollStatus`, because with no object nothing else would', async () => {
    // The asymmetry, and the reason `pollStatus` is a third name rather than an overload. With an
    // object, `pollStatus` is a read. Without one there is nothing advancing the scan except a
    // poll, so answering passively would be a library that never indexes anything — the shipped
    // defect this port exists to end.
    const { runner, calls } = recordingScanRunner();
    await resolveScanDriver({}, () => runner).pollStatus(LIBRARY);
    expect(calls).toStrictEqual(['step']);
  });

  it('reports nothing for the library list, because a pause lives in the object it does not have', async () => {
    const { runner, calls } = recordingScanRunner();
    const driver = resolveScanDriver({}, () => runner);
    await expect(driver.stateForLibraryList('L1')).resolves.toBeNull();
    expect(calls, 'a pause overlay must not fabricate a claim of its own').toStrictEqual([]);
  });

  it('reads the service lazily, because it is bound into a scope that is still being built', () => {
    // The driver is constructed by `scopeMiddleware` while `createRequestScope` runs, so the
    // service does not exist yet. A test that supplied a value instead of a thunk would be
    // exercising a construction this file cannot perform.
    let resolutions = 0;
    const driver: ScanDriver = new InProcessScanDriver(() => {
      resolutions += 1;
      return recordingScanRunner().runner;
    });
    expect(resolutions).toBe(0);
    void driver;
  });
});

describe('ScanDriver: the object-backed strategy', () => {
  it('routes each named operation to the matching RPC', async () => {
    const calls: string[] = [];
    const { env } = scanNamespace(calls);
    const { runner } = recordingScanRunner();
    const driver = resolveScanDriver(env, () => runner);

    await driver.start(LIBRARY);
    await driver.advance(LIBRARY);
    await driver.readState('L1');

    expect(calls).toStrictEqual(['startScan', 'stepOnce', 'getStatus']);
  });

  it('reads on `pollStatus`, which is where the two strategies differ in kind', async () => {
    const calls: string[] = [];
    const { env } = scanNamespace(calls);
    const { runner } = recordingScanRunner();
    await resolveScanDriver(env, () => runner).pollStatus(LIBRARY);
    expect(calls).toStrictEqual(['getStatus']);
  });

  it('never touches the in-process service, so a deployment with a binding spends nothing twice', async () => {
    const calls: string[] = [];
    const { env } = scanNamespace(calls);
    const { runner } = recordingScanRunner();
    const driver = resolveScanDriver(env, () => runner);

    await driver.start(LIBRARY);
    await driver.advance(LIBRARY);
    await driver.pollStatus(LIBRARY);
    await driver.stateForLibraryList('L1');

    expect(runner.start).not.toHaveBeenCalled();
    expect(runner.step).not.toHaveBeenCalled();
    expect(runner.status).not.toHaveBeenCalled();
  });

  it('answers the library list from the object, where a pause can actually be held', async () => {
    const calls: string[] = [];
    const { env } = scanNamespace(calls);
    const { runner } = recordingScanRunner();
    const result = await resolveScanDriver(env, () => runner).stateForLibraryList('L1');
    expect(result?.lastError).toBe('getStatus');
    expect(calls).toStrictEqual(['getStatus']);
  });
});

describe('ScanDriver: the choice itself', () => {
  it('picks the strategy from the binding, and the binding is the only thing that picks it', () => {
    const { runner } = recordingScanRunner();
    const calls: string[] = [];
    const { env } = scanNamespace(calls);

    expect(resolveScanDriver({}, () => runner)).toBeInstanceOf(InProcessScanDriver);
    expect(resolveScanDriver({ SCAN: undefined }, () => runner)).toBeInstanceOf(InProcessScanDriver);
    expect(resolveScanDriver(env, () => runner)).toBeInstanceOf(DurableObjectScanDriver);
  });

  it('charges one subrequest per RPC, and none for the in-process branch', async () => {
    // A DO RPC is a subrequest and `getScanStub` charges it at resolution. The in-process branch
    // has no RPC and must charge nothing: inventing a charge for a call the platform never made
    // would make the ceiling describe work that did not happen.
    const charges: string[] = [];
    const meter = { charge: (_n?: number, kind?: string): void => void charges.push(kind ?? '?') } as unknown as Parameters<typeof resolveScanDriver>[2];
    const calls: string[] = [];
    const { env } = scanNamespace(calls);
    const { runner } = recordingScanRunner();

    await resolveScanDriver({}, () => runner).readState('L1');
    expect(charges, 'an RPC that did not happen spent nothing').toStrictEqual([]);

    await resolveScanDriver(env, () => runner, meter).readState('L1');
    expect(charges).toStrictEqual(['rpc']);
  });
});