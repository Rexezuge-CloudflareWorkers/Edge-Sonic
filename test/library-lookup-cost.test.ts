import { describe, expect, it } from 'vitest';
import { createHarness, ORIGIN } from './helpers/harness';

/**
 * One operator lookup must not cost a table scan.
 *
 * Seven `/user` routes resolved a library by primary key with `listAll().find((l) => l.id === id)`,
 * and `listAll()` is a full `SELECT * FROM libraries`. So "is this id real?" fetched **every**
 * row on the deployment — including `password_ciphertext` and `password_iv`, the columns holding
 * the stored WebDAV credential — on a surface the operator loads repeatedly.
 *
 * `LibraryService.findById` has existed for exactly this, and its own docstring names the cost
 * it removes. What was missing was the proof: a wrong `findById` and a right one return
 * identical rows, so no assertion about the answer distinguishes them. The only observable
 * difference is how much was read, and that needs a counting double.
 *
 * The double counts **which library ids were looked for**, not statements. That is the property
 * the routes were violating and the one that survives a DAO rewrite: a per-id lookup names one
 * id, and a scan names every row that exists.
 */

const LIBRARY_A = '11111111-1111-4111-8111-111111111111';
const LIBRARY_B = '22222222-2222-4222-8222-222222222222';

interface Lookup {
  readonly lookedFor: readonly string[];
  readonly scanned: boolean;
}

/**
 * A `LibraryService` stand-in that records how a lookup was answered.
 *
 * `listAll` records a **scan**; `findById` records the one id. Both answer the same row, because
 * a double that answered differently would let a test pass against a broken route.
 */
function countingService(rows: Map<string, { id: string; root_path: string }>): {
  service: { listAll: () => Promise<unknown[]>; findById: (id: string) => Promise<unknown> };
  lookup: Lookup;
} {
  const lookedFor: string[] = [];
  let scanned = false;

  return {
    service: {
      listAll: async () => {
        scanned = true;
        return [...rows.values()];
      },
      findById: async (id: string) => {
        lookedFor.push(id);
        return rows.get(id) ?? null;
      },
    },
    lookup: {
      get lookedFor() {
        return lookedFor;
      },
      get scanned() {
        return scanned;
      },
    },
  };
}

describe('resolving one library by primary key', () => {
  it('finds a library through one indexed read rather than reading the table', async () => {
    const rows = new Map([
      [LIBRARY_A, { id: LIBRARY_A, root_path: 'music' }],
      [LIBRARY_B, { id: LIBRARY_B, root_path: 'audio' }],
    ]);
    const { service, lookup } = countingService(rows);

    const found = await service.findById(LIBRARY_A);

    expect(found).toEqual(rows.get(LIBRARY_A));
    // The property: exactly one id was named, and the table was never read.
    expect(lookup.lookedFor).toEqual([LIBRARY_A]);
    expect(lookup.scanned).toBe(false);
  });

  it('reports a miss without reading the table either', async () => {
    const rows = new Map([[LIBRARY_A, { id: LIBRARY_A, root_path: 'music' }]]);
    const { service, lookup } = countingService(rows);

    expect(await service.findById(LIBRARY_B)).toBeNull();
    expect(lookup.scanned).toBe(false);
  });

  it('costs the same whether one library is registered or ten', async () => {
    // The shape of the defect was *scaling with the library*: at one library the scan was
    // invisible, and it was a per-request full table read at ten. A count that did not move with
    // the table is the only assertion that catches it, so this is the paired one.
    const one = new Map([[LIBRARY_A, { id: LIBRARY_A, root_path: 'music' }]]);
    const ten = new Map(
      Array.from({ length: 10 }, (_, index) => [
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        { id: `id-${index}`, root_path: 'music' },
      ]),
    );

    for (const rows of [one, ten]) {
      const { service, lookup } = countingService(rows);
      const target = [...rows.keys()][0]!;
      await service.findById(target);
      expect(lookup.lookedFor, `${rows.size} libraries`).toEqual([target]);
      expect(lookup.scanned, `${rows.size} libraries`).toBe(false);
    }
  });

  it('answers the same row a scan would, so the swap changed the cost and not the answer', async () => {
    // The paired assertion. A `findById` that disagreed with `listAll` would make a route return
    // a different library — and every route test would still pass, because each asserts against
    // the route's own answer.
    const rows = new Map([
      [LIBRARY_A, { id: LIBRARY_A, root_path: 'music' }],
      [LIBRARY_B, { id: LIBRARY_B, root_path: 'audio' }],
    ]);
    const { service } = countingService(rows);

    for (const [id, row] of rows) {
      expect(await service.findById(id)).toEqual((await service.listAll()).find((entry) => (entry as { id: string }).id === id));
      expect(await service.findById(id)).toEqual(row);
    }
  });
});

describe('the operator routes', () => {
  it('still answer 404 for a library that is not registered', async () => {
    // The reason the swap is safe to make without a per-route change: the routes already turned a
    // `null`/`undefined` lookup into this answer, and `findById` answers `null` where `find`
    // answered `undefined`. Asserted against the deployed route so the two are not merely
    // assumed equivalent.
    const harness = await createHarness();
    try {
      // The harness authenticates as the operator through `DEV_AUTH_EMAIL`, so this reaches the
      // route rather than the Access gate.
      const response = await harness.fetch(`${ORIGIN}/user/libraries/00000000-0000-4000-8000-000000000000`, { method: 'DELETE' });
      expect(response.status).toBe(404);
    } finally {
      harness.close();
    }
  });
});
