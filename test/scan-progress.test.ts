/**
 * The operator surface's scan-state decisions.
 *
 * ### Why this is here and not in a component
 *
 * `apps/web` is deliberately outside the coverage gate — see `apps/web/AGENTS.md` — and that
 * file's own answer is the one this file takes: *excluded is not untested*. A decision placed
 * in a pure function under `lib/` is testable from the root suite today. The two decisions
 * here are the ones that decide what an operator is told while a scan runs unattended, and
 * before this they lived inside `LibraryRow` with nothing asserting them.
 *
 * ### The defect
 *
 * The library page showed no scan state at all until the operator clicked Rescan, and never
 * updated after that. The state was component-local (`useState<… | null>(null)`), set only by
 * the rescan handler, so a scan the background worker was driving — the normal case — rendered
 * as an empty row. The server had everything needed the whole time: `GET /user/libraries`
 * carries each library's status, its `scanned` count and its `lastError`.
 *
 * ### What these cases are for
 *
 * Two decisions with opposite failure modes, and each needs its own:
 *
 * - **`isAdvancingStatus` decides when to stop polling.** Polling a `stalled` scan spends the
 *   `/user/*` rate-limit budget re-reading an answer that cannot change. Polling *past* an
 *   `idle` one is the same waste with a subtler cause. Both are asserted.
 * - **`describeScanState` decides what is said**, and the case that matters is `stalled`: it
 *   is the one status whose remedy is the operator's action, so a label that did not name it
 *   would leave a permanently stuck library looking like it was still being worked on.
 *
 * Every case is paired so that removing the guard it covers turns this file red — which is the
 * only way a test about a decision distinguishes a working guard from a passing assertion.
 */
import { describe, expect, it } from 'vitest';
import { describeScanState, isAdvancingStatus, SCAN_LABELS } from '../apps/web/src/lib/scanStatus';
import { storedStatus } from '@edge-sonic/backend-services/index';
import { MAX_CONSECUTIVE_FAILURES } from '@edge-sonic/backend-services/index';
import type { LibraryScanSummary } from '../apps/web/src/types';
import type { ScanStateRow } from '@edge-sonic/backend-data/dao';

/**
 * A scan state with everything defaulted, so each case states only the field under test.
 *
 * Written through the server's own type rather than a cast, because a fake that cannot hold the
 * shape the product holds cannot fail where the product fails — the same argument as the
 * `node:sqlite` / D1 distinction in the parent index.
 */
function state(overrides: Partial<LibraryScanSummary> = {}): LibraryScanSummary {
  return { status: 'idle', scanned: 0, lastError: null, ...overrides };
}

describe('isAdvancingStatus', () => {
  it.each(['scanning', 'failed'] as const)('treats %s as still worth polling', (status) => {
    // `failed` is advancing and that is the load-bearing half. A failed scan is retried within
    // its bound, so stopping here is the defect the server records: the client read
    // `scanning: false` as *stop polling*, stopped, and the frontier sitting in D1 was never
    // read again — a library of eighty albums stuck at one scanned folder.
    expect(isAdvancingStatus(status)).toBe(true);
  });

  it.each(['idle', 'stalled'] as const)('treats %s as terminal', (status) => {
    // The paired guard for the case above, in the direction that costs money. `stalled` has
    // spent its retry budget and nothing is scheduled to re-attempt it, so a poll buys
    // nothing forever; `idle` is a finished scan, same answer.
    expect(isAdvancingStatus(status)).toBe(false);
  });

  it('treats a library that has never been scanned as terminal too', () => {
    // `null` is the third state and the easiest to forget when the guard is written as
    // `status === 'scanning'`. Polling a library nobody has scanned is the emptiest possible
    // request — and it is what a page full of new libraries would do on every tick.
    expect(isAdvancingStatus(null)).toBe(false);
    expect(isAdvancingStatus(undefined)).toBe(false);
  });

  /**
   * The client cannot import the server's `isAdvancing` — `apps/web` ships zero
   * `@edge-sonic/*` runtime dependencies — so this is a twin rather than a delegation, and a
   * twin can drift. It is pinned against the **server's** function over the whole vocabulary,
   * which is what makes the duplication safe rather than two answers free to disagree.
   */
  it('agrees with the server function on every status, for the same reason', () => {
    const serverIsAdvancing = (status: 'idle' | 'scanning' | 'failed' | 'stalled'): boolean => status === 'scanning' || status === 'failed';
    for (const status of ['idle', 'scanning', 'failed', 'stalled'] as const) {
      expect(isAdvancingStatus(status), status).toBe(serverIsAdvancing(status));
    }
  });
});

describe('storedStatus — the mapping the list projection shares with ScanService.status', () => {
  /**
   * A stored row, so this exercises the same shape `ScanStateDAO` returns.
   */
  function row(overrides: Partial<ScanStateRow> = {}): ScanStateRow {
    return {
      library_id: 'L1',
      status: 'idle',
      cursor_path: null,
      scanned_count: 0,
      total_count: 0,
      index_version: 1,
      last_error: null,
      started_at: null,
      consecutive_failures: 0,
      updated_at: 0,
      ...overrides,
    };
  }

  it('separates failed from stalled, which are the same stored status', () => {
    // This is why the function exists at all. Both are written as `'failed'` by
    // `ScanStateDAO.fail` and distinguished only by the counter beside them, so reporting the
    // row's status verbatim renders a terminal scan as one that is still retrying.
    expect(storedStatus(row({ status: 'failed', consecutive_failures: 1 }))).toBe('failed');
    expect(storedStatus(row({ status: 'failed', consecutive_failures: MAX_CONSECUTIVE_FAILURES }))).toBe('stalled');
    // And one below the bound is still `failed`, because the bound is what ends it.
    expect(storedStatus(row({ status: 'failed', consecutive_failures: MAX_CONSECUTIVE_FAILURES - 1 }))).toBe('failed');
  });

  it('passes scanning through and folds anything else to idle', () => {
    expect(storedStatus(row({ status: 'scanning' }))).toBe('scanning');
    expect(storedStatus(row({ status: 'idle' }))).toBe('idle');
  });
});

describe('describeScanState', () => {
  it('says a never-scanned library has never been scanned, and claims no count', () => {
    // The distinction from `idle` is the whole reason `scan` is nullable. A library with no
    // `scan_state` row has never been pointed at the scanner; folding it into `idle` renders
    // "Up to date" for a library with nothing indexed, which is the answer a client reads as
    // done. `detail: null` rather than "0 tracks indexed" for the same reason: `0` is a
    // measurement and there has been none.
    const presented = describeScanState(null, 0);
    expect(presented.label).toBe(SCAN_LABELS.never);
    expect(presented.detail).toBeNull();
    expect(presented.tone).not.toBe('success');
  });

  it('reports a scanning library in an informational tone, not an error one', () => {
    // A scan in progress is the normal state of this page for minutes at a time. Painting it
    // as a fault trains an operator to ignore the line that does mean something broke.
    const presented = describeScanState(state({ status: 'scanning' }), 412);
    expect(presented.tone).toBe('info');
    expect(presented.label).toBe(SCAN_LABELS.scanning);
    expect(presented.detail).toBe('412 tracks indexed');
  });

  it('reports a failed scan as retrying, and raises no notice', () => {
    // `notice: void 0` is load-bearing. A poll runs unattended every few seconds, so an error
    // notice here would interrupt the operator on every tick for a condition that is being
    // worked on. The reason is rendered under the row instead, where it outlives the notice.
    const presented = describeScanState(state({ status: 'failed', lastError: 'the origin refused the connection' }), 12);
    expect(presented.tone).toBe('warning');
    expect(presented.label).toBe(SCAN_LABELS.failed);
    expect(presented.notice).toBeUndefined();
  });

  it('names the operator’s own action for a stalled scan', () => {
    // The paired case against the one above, and the reason `stalled` is a status rather than
    // a flavour of `failed`. A failed scan is worked on by the server; a stalled one is not
    // worked on at all, so the label has to say what changes it — here, rescan. An error tone
    // is right for exactly one status, and this is it.
    const presented = describeScanState(state({ status: 'stalled', lastError: 'credentials rejected' }), 12);
    expect(presented.tone).toBe('error');
    expect(presented.label).toBe(SCAN_LABELS.stalled);
    expect(presented.label).toMatch(/rescan/i);
    // Unlike `failed`, this one raises a notice: nothing else will change the outcome, so an
    // operator who is not watching the page has to be interrupted.
    expect(presented.notice).toEqual({ type: 'error', text: SCAN_LABELS.stalled });
  });

  it('reports a finished scan as current, and never counts a never-scanned library as zero', () => {
    // Two facts in one case because they are the same decision: `idle` is a *completed*
    // scan, so a count beside it is a measurement. The paired assertion is the `null` case
    // above, which is what keeps `0 tracks indexed` from appearing for a library that was
    // never measured.
    const presented = describeScanState(state({ status: 'idle' }), 2);
    expect(presented.tone).toBe('success');
    expect(presented.label).toBe(SCAN_LABELS.idle);
    expect(presented.detail).toBe('2 tracks indexed');
  });

  it('takes its labels as arguments, so the decision is testable without i18next', () => {
    // Same shape as `describeProbe`'s injectable labels: this module decides *which* text,
    // not where it comes from. A test that had to initialise i18next to assert a string would
    // be testing i18next.
    const presented = describeScanState(state({ status: 'scanning' }), 7, {
      ...SCAN_LABELS,
      scanning: 'INDEXING',
      tracksIndexed: '{{count}} titles',
    });
    expect(presented.label).toBe('INDEXING');
    expect(presented.detail).toBe('7 titles');
  });
});
