/**
 * `IndexDropService`: the ordering, and the split of a global drop's cost.
 *
 * The DAO tests cover what a drop removes and the DO tests cover what it does to the scan
 * object. What neither can see is **the sequence**, and the sequence is the whole reason this
 * is a service rather than three lines in a route:
 *
 * - `reset` must reach the scan object **before** the first `DELETE`, or an alarm fires into the
 *   window between them and writes the index back.
 * - `charge` must come **after**, because it needs the figure the `DELETE`s actually billed.
 * - a global drop must charge each object its **share** of the bill, not the whole of it —
 *   `dailyRowWriteShare` divides the allowance by library count, so an object told the total
 *   would pause itself at a quarter of a budget sized for a quarter.
 *
 * Every store and scan object here is a recording double, because the assertions are about
 * **order and attribution** — a double that reports the right numbers and the wrong sequence
 * is the point, and a real database cannot be asked which came first.
 */
import { describe, expect, it } from 'vitest';
import { IndexDropService } from '@edge-sonic/backend-services/library';
import type { IndexDropResult, IndexStats, LibraryIndexStats } from '@edge-sonic/backend-data/dao';

type Event = string;

interface Harness {
  readonly service: IndexDropService;
  readonly events: Event[];
  readonly charges: Map<string, number>;
}

/**
 * A drop result, parameterised by what it removed.
 *
 * `billedRows` is the **measured** figure `IndexDropDAO` reports — `songs` at ten per row,
 * `nodes` at four, `scan_state` at two — rather than a round number, so an attribution assertion
 * that happened to divide evenly could not pass.
 */
function measured(songs: number, nodes: number, scanStates = 0): IndexDropResult {
  return {
    songs,
    nodes,
    scanStates,
    changes: songs + nodes + scanStates,
    billedRows: songs * 10 + nodes * 4 + scanStates * 2,
  };
}

/**
 * The projection for one set of per-library figures.
 *
 * Totalled from the entries rather than declared, so a test cannot state a total the code would
 * disagree with — the aggregation is the code's job and the test's job is the attribution.
 */
function projected(perLibrary: Readonly<Record<string, LibraryIndexStats>>): IndexStats {
  const libraries = Object.entries(perLibrary).map(([libraryId, stats]) => ({ libraryId, stats }));
  const total = libraries.reduce<LibraryIndexStats>(
    (sum, entry) => ({
      songs: sum.songs + entry.stats.songs,
      nodes: sum.nodes + entry.stats.nodes,
      scanStates: sum.scanStates + entry.stats.scanStates,
      billedRows: sum.billedRows + entry.stats.billedRows,
    }),
    { songs: 0, nodes: 0, scanStates: 0, billedRows: 0 },
  );
  return { libraries, total };
}

/**
 * Build a service over recording doubles.
 *
 * `projectedStats` and `measured` are separate parameters because the divergence between them
 * is a real scenario: the projection is read while the operator reads the dialog, and the index
 * can grow in the minutes before they type the phrase.
 */
function harnessFor(options: {
  projectedStats: IndexStats;
  dropLibraryResult?: IndexDropResult;
  dropAllResult?: IndexDropResult;
  libraryIds?: readonly string[];
  noScanObject?: readonly string[];
}): Harness {
  const events: Event[] = [];
  const charges = new Map<string, number>();
  const absent = new Set(options.noScanObject);

  const scanFor = (libraryId: string) =>
    absent.has(libraryId)
      ? null
      : {
          reset: async () => {
            events.push(`reset:${libraryId}`);
          },
          charge: async (_id: string, billedRows: number) => {
            events.push(`charge:${libraryId}:${billedRows}`);
            charges.set(libraryId, (charges.get(libraryId) ?? 0) + billedRows);
          },
        };

  const service = new IndexDropService(
    {
      statsForLibrary: async () => options.projectedStats.total,
      statsAcrossLibraries: async () => options.projectedStats,
      dropLibrary: async (libraryId) => {
        events.push(`dropLibrary:${libraryId}`);
        return options.dropLibraryResult ?? measured(0, 0);
      },
      dropAll: async () => {
        events.push('dropAll');
        return options.dropAllResult ?? measured(0, 0);
      },
    },
    scanFor,
  );

  void options.libraryIds;
  return { service, events, charges };
}

describe('the order, which is the reason this is a service', () => {
  it('stops the scan before it deletes, and charges it after', async () => {
    // The race, stated as a sequence assertion. A live `ScanWorker` alarm fires every second;
    // if it fires between the delete of `songs` and the delete of `nodes`, `step` finds a
    // frontier describing rows that no longer exist, walks the origin and writes fresh song rows
    // — landing *after* the delete meant to have removed them. The operator is told their index
    // is empty and it is not, with nothing anywhere recording that anything happened.
    const harness = harnessFor({
      projectedStats: projected({ L1: { songs: 500, nodes: 200, scanStates: 1, billedRows: 5802 } }),
      dropLibraryResult: measured(500, 200, 1),
    });

    await harness.service.dropLibrary('L1');

    expect(harness.events).toEqual(['reset:L1', 'dropLibrary:L1', 'charge:L1:5802']);
  });

  it('stops every scan before the first delete of a global drop', async () => {
    // Times every library. A library whose object is still armed when its songs are deleted
    // re-indexes itself, so an operator who asked for a clean database across three libraries
    // would get one of them quietly refilling — and the *global* button is the one most likely
    // to be pressed while a scan is running.
    const stats = projected({
      L1: { songs: 10, nodes: 4, scanStates: 1, billedRows: 118 },
      L2: { songs: 20, nodes: 8, scanStates: 1, billedRows: 234 },
      L3: { songs: 30, nodes: 12, scanStates: 1, billedRows: 350 },
    });
    const harness = harnessFor({ projectedStats: stats, dropAllResult: measured(60, 24, 3) });

    await harness.service.dropAll(['L1', 'L2', 'L3']);

    const firstDrop = harness.events.indexOf('dropAll');
    expect(harness.events.slice(0, firstDrop)).toEqual(['reset:L1', 'reset:L2', 'reset:L3']);
  });

  it('charges the measured figure rather than the projection', async () => {
    // The index grew while the dialog was open. The operator consented to one number and the
    // database spent another; the counter must hold the second, because that is what will
    // exhaust the allowance. A charge of the projection would leave the day's real spend
    // under-reported by exactly the amount the index moved.
    const harness = harnessFor({
      projectedStats: projected({ L1: { songs: 100, nodes: 40, scanStates: 1, billedRows: 1162 } }),
      dropLibraryResult: measured(180, 40, 1),
    });

    await harness.service.dropLibrary('L1');

    expect(harness.charges.get('L1')).toBe(1800 + 160 + 2);
  });

  it('charges nothing when nothing was billed', async () => {
    // A second click, or a library that was never scanned. Charging `0` is harmless but would
    // be a storage write per library against the DO allowance, for an action that changed
    // nothing.
    const harness = harnessFor({
      projectedStats: projected({ L1: { songs: 0, nodes: 0, scanStates: 0, billedRows: 0 } }),
      dropLibraryResult: measured(0, 0),
    });

    await harness.service.dropLibrary('L1');

    expect(harness.charges.has('L1')).toBe(false);
  });
});

describe('the global drop divides the bill rather than charging it whole', () => {
  it('gives each library a share in proportion to what it held', async () => {
    /**
     * The defect this prevents is arithmetic, not cosmetic.
     *
     * `dailyRowWriteShare` divides the platform allowance by the number of **registered**
     * libraries, so each object paces itself against a quarter of the day on a three-library
     * deployment. Charging one object the whole bill would take it straight past that share —
     * so three of the three scans would refuse immediately after an operator emptied their
     * index, which is the opposite of what the action is for.
     */
    const stats = projected({
      L1: { songs: 300, nodes: 100, scanStates: 1, billedRows: 3402 },
      L2: { songs: 100, nodes: 40, scanStates: 1, billedRows: 1162 },
      L3: { songs: 100, nodes: 40, scanStates: 1, billedRows: 1162 },
    });
    const total = stats.total.billedRows;
    const harness = harnessFor({ projectedStats: stats, dropAllResult: measured(500, 180, 3) });

    await harness.service.dropAll(['L1', 'L2', 'L3']);

    expect(harness.charges.get('L1')).toBe(Math.floor((3402 / total) * total));
    expect(harness.charges.get('L2')).toBe(Math.floor((1162 / total) * total));
    // And the third picked up the rounding remainder, so the parts sum to the whole.
    const summed = [...harness.charges.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(harness.charges.get('L1')! + harness.charges.get('L2')! + harness.charges.get('L3')!);
    expect(harness.charges.get('L1')! + harness.charges.get('L2')! + harness.charges.get('L3')!).toBeGreaterThanOrEqual(total);
  });

  it('sums to exactly what the deletes billed', async () => {
    /**
     * The correction is not tidiness.
     *
     * Each share is floored, so without a correction the counters would under-report the day's
     * real spend by up to `libraryIds.length - 1` rows — and the drift compounds across every
     * drop and every scan in the day, which is precisely the under-count that
     * `docs/issues/d1-daily-write-limit.md` says cost a library its day's allowance.
     *
     * The measured total here is chosen so the three exact shares do **not** divide it evenly,
     * so an uncorrected implementation fails here rather than passing by luck.
     */
    const stats = projected({
      L1: { songs: 7, nodes: 3, scanStates: 1, billedRows: 84 },
      L2: { songs: 11, nodes: 5, scanStates: 1, billedRows: 132 },
      L3: { songs: 13, nodes: 9, scanStates: 1, billedRows: 168 },
    });
    const measuredTotal = 701;
    const harness = harnessFor({ projectedStats: stats, dropAllResult: { ...measured(31, 17, 3), billedRows: measuredTotal } });

    await harness.service.dropAll(['L1', 'L2', 'L3']);

    const summed = [...harness.charges.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(measuredTotal);
    // Three separate charges, not one lump — each object paces its own library.
    expect(harness.charges.size).toBe(3);
  });

  it('charges the whole bill to one object when the projection says nothing was indexed', async () => {
    /**
     * The projection and the measurement disagreeing, which is reachable: the dialog was read
     * while the library was empty and the scan filled it before the operator typed the phrase.
     *
     * The weights are all zero, so the ratio is undefined. Charging the whole figure to one
     * object is the least wrong answer available **and** it is the pessimistic one — an
     * over-count costs throughput, and an under-count costs the outage the whole allowance
     * mechanism exists to prevent.
     */
    const stats = projected({
      L1: { songs: 0, nodes: 0, scanStates: 0, billedRows: 0 },
      L2: { songs: 0, nodes: 0, scanStates: 0, billedRows: 0 },
    });
    const harness = harnessFor({ projectedStats: stats, dropAllResult: measured(500, 200, 2) });

    await harness.service.dropAll(['L1', 'L2']);

    const summed = [...harness.charges.values()].reduce((a, b) => a + b, 0);
    expect(summed).toBe(500 * 10 + 200 * 4 + 2 * 2);
  });

  it('does nothing at all when no library is registered', async () => {
    // The zero-libraries case, which the Danger Zone renders as a message rather than a button.
    // Asserted because "divide by an empty total" is the other way the ratio is undefined.
    const harness = harnessFor({ projectedStats: projected({}), dropAllResult: measured(0, 0) });

    const outcome = await harness.service.dropAll([]);

    expect(outcome.libraries).toBe(0);
    expect(harness.charges.size).toBe(0);
    expect(harness.events).toEqual(['dropAll']);
  });
});

describe('a deployment with no scan binding still drops', () => {
  it('performs the deletes when no scan object resolves', async () => {
    /**
     * The `SCAN` binding is not always configured — tests and local dev without workerd take the
     * direct-service path, which every other scan route already does.
     *
     * The D1 deletes are the whole point of the operation, so a missing scan object must leave
     * it working. The alternative is a `TypeError` from a stub the caller never supplied, on
     * the one surface whose failure destroys nothing and completes nothing.
     */
    const harness = harnessFor({
      projectedStats: projected({ L1: { songs: 5, nodes: 2, scanStates: 1, billedRows: 60 } }),
      dropLibraryResult: measured(5, 2, 1),
      noScanObject: ['L1'],
    });

    const outcome = await harness.service.dropLibrary('L1');

    expect(outcome).toMatchObject({ songs: 5, nodes: 2, libraries: 1 });
    expect(harness.events).toEqual(['dropLibrary:L1']);
  });

  it('drops every library when none of them resolve an object', async () => {
    const harness = harnessFor({
      projectedStats: projected({ L1: { songs: 5, nodes: 2, scanStates: 1, billedRows: 60 } }),
      dropAllResult: measured(5, 2, 1),
      noScanObject: ['L1'],
    });

    const outcome = await harness.service.dropAll(['L1']);

    expect(outcome).toMatchObject({ songs: 5, libraries: 1 });
    expect(harness.events).toEqual(['dropAll']);
  });
});

describe('what the caller is told', () => {
  it('names one library for a per-library drop and the count for a global one', async () => {
    // The notice says "3 libraries" rather than "everything", because a message naming a scope
    // is the difference between a notice and a shrug.
    const single = harnessFor({
      projectedStats: projected({ L1: { songs: 2, nodes: 1, scanStates: 1, billedRows: 26 } }),
      dropLibraryResult: measured(2, 1, 1),
    });
    const global = harnessFor({
      projectedStats: projected({
        L1: { songs: 2, nodes: 1, scanStates: 1, billedRows: 26 },
        L2: { songs: 3, nodes: 1, scanStates: 1, billedRows: 36 },
        L3: { songs: 4, nodes: 1, scanStates: 1, billedRows: 46 },
      }),
      dropAllResult: measured(9, 3, 3),
    });

    expect((await single.service.dropLibrary('L1')).libraries).toBe(1);
    expect((await global.service.dropAll(['L1', 'L2', 'L3'])).libraries).toBe(3);
  });

  it('reports the measured billed rows, not the projected ones', async () => {
    // The projection describes something that is no longer happening. Reporting it after the
    // fact would be reporting a number about a past state as though it were the cost.
    const harness = harnessFor({
      projectedStats: projected({ L1: { songs: 100, nodes: 40, scanStates: 1, billedRows: 1162 } }),
      dropLibraryResult: measured(180, 40, 1),
    });

    const outcome = await harness.service.dropLibrary('L1');

    expect(outcome.billedRows).not.toBe(1162);
    expect(outcome.billedRows).toBe(180 * 10 + 40 * 4 + 2);
  });
});
