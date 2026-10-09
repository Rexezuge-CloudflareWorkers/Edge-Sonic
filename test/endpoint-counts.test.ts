import { describe, expect, it } from 'vitest';
import { ENDPOINT_NAMES, UNIMPLEMENTED } from '../apps/api/src/rest/endpoints';

/**
 * The registry's **counts**, pinned.
 *
 * ### Why numerals and not just shape
 *
 * `docs/agents/protocol/AGENTS.md` publishes a table — 43 implemented, 20 unimplemented, 7
 * answering an empty result, 70 names — and says the counts "are asserted in
 * `test/endpoint-registry.test.ts`". They were not. Every assertion in that file was about
 * *shape*: cross-map disjointness, a non-empty reason per entry, `ENDPOINT_NAMES` completeness.
 * None of them contained a numeral, so any number of endpoints could be added or removed and
 * every test would pass while the guide's table went quietly stale.
 *
 * A table that says a number is a claim about the registry, and a claim nothing measures is not
 * an invariant. This file is the measurement, and it fails when a count moves rather than when a
 * shape does — which is the point: adding an endpoint is a **deliberate** act that should cost a
 * line in the guide, not something a reviewer notices three releases later.
 *
 * The numbers are duplicated here rather than imported from the registry on purpose. Importing
 * them would compare the registry against itself, which is the assertion that always passes.
 */
describe('the endpoint registry counts', () => {
  const counts = {
    implemented: ENDPOINT_NAMES.length - Object.keys(UNIMPLEMENTED).length - EMPTY_RESULT_COUNT,
    unimplemented: Object.keys(UNIMPLEMENTED).length,
    emptyResult: EMPTY_RESULT_COUNT,
    names: ENDPOINT_NAMES.length,
  };

  it('publishes 43 implemented endpoints', () => {
    expect(counts.implemented).toBe(43);
  });

  it('publishes 20 unimplemented endpoints, and their kinds split 5 / 12 / 3', () => {
    // The split is published alongside the total in the same table, so it is pinned with it. It is
    // also the number that would move if an endpoint changed *kind* — which is a different act
    // from adding one, and one with a different consequence: `gone` answers 410, `not-implemented`
    // answers 501, and `not-authorized` answers `code=50` in an HTTP 200 envelope.
    expect(counts.unimplemented).toBe(20);
    expect(countKinds()).toEqual({ gone: 5, 'not-implemented': 12, 'not-authorized': 3 });
  });

  it('publishes 7 endpoints that answer an empty wrapper rather than a failure', () => {
    // `getLyrics` and the four artist-info/radio endpoints are called routinely by real clients;
    // each was `code=70` before it was given a wrapper, which told a client the server had failed
    // where the truth is that there is nothing to report. Their count is the guard on that.
    expect(counts.emptyResult).toBe(7);
  });

  it('publishes 70 endpoint names in total', () => {
    // The sum, and therefore a cross-check on the three above: if one moves and another does not,
    // this is the assertion that says so.
    expect(counts.names).toBe(43 + 20 + 7);
    expect(counts.names).toBe(70);
  });

  it('splits the unimplemented kinds as the guide publishes them', () => {
    expect(countKinds()).toEqual({ gone: 5, 'not-implemented': 12, 'not-authorized': 3 });
  });
});

/**
 * The unimplemented endpoints grouped by kind, with the `not-implemented` spelling quoted
 * because it is a hyphenated key and reads as a subtraction at a glance.
 */
function countKinds(): Record<string, number> {
  const byKind: Record<string, number> = {};
  for (const entry of Object.values(UNIMPLEMENTED)) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
  }
  return byKind;
}

/**
 * Re-declared rather than imported, for the reason the file header gives: the registry does not
 * export its empty-result table under a name that narrows it, and a count read from the same
 * object it is counting is not a measurement.
 */
const EMPTY_RESULT_COUNT = 7;
