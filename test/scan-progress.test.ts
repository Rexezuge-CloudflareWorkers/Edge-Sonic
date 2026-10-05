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
import { describeScanState, formatResumeAt, isAdvancingStatus, SCAN_LABELS } from '../apps/web/src/lib/scanStatus';
import { isAdvancing, storedStatus, willResumeWithoutAPoll } from '@edge-sonic/backend-services/index';
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
  // `resumeAt: null` explicitly rather than left to a default. The field is nullable and always
  // sent, so a fake that omitted it would model a server that does not send it — which is the
  // defect `stalled` records, and the one `paused` arrived through.
  return { status: 'idle', scanned: 0, lastError: null, resumeAt: null, ...overrides };
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

  it('treats a paused scan as terminal, because polling cannot move a wall clock', () => {
    // A paused scan is *not* terminal — it resolves by itself at midnight UTC — and it is not
    // advancing either. A page that polled it would re-read an identical answer every few seconds
    // until the reset, against a 60-request-per-minute bucket this surface shares with probe and
    // rescan. This is the client's half of the split; the server's half is asserted below, because
    // the two answers differ and writing this guard against the other one is the defect.
    expect(isAdvancingStatus('paused')).toBe(false);
  });

  /**
   * The client cannot import the server's `isAdvancing` — `apps/web` ships zero
   * `@edge-sonic/*` runtime dependencies — so this is a twin rather than a delegation, and a
   * twin can drift. It is pinned against the **server's** function over the whole vocabulary,
   * which is what makes the duplication safe rather than two answers free to disagree.
   */
  it('agrees with the server function on every status, for the same reason', () => {
    // Pinned against the **server's** function rather than a restatement of it, so the twin cannot
    // drift: a fourth status appearing on the server and not here would fail this case.
    for (const status of ['idle', 'scanning', 'failed', 'stalled', 'paused'] as const) {
      expect(isAdvancingStatus(status), status).toBe(isAdvancing(status));
    }
  });
});

describe('the server answers two questions, and this client mirrors only one of them', () => {
  it('keeps the alarm\'s answer out of the polling guard', () => {
    // `paused` is the one status where the two differ, and both answers are needed: the Durable
    // Object's alarm must stay armed (nothing else advances a scan in production) while the page
    // must stop polling (nothing a client does changes the answer). Asserted from the client side
    // against the server's two functions, because a guard written against the wrong one is the
    // defect — and `ScanWorker` is the only caller that wants the other half.
    expect(willResumeWithoutAPoll('paused')).toBe(true);
    expect(isAdvancing('paused')).toBe(false);
    expect(isAdvancingStatus('paused')).toBe(false);
  });

  it('agrees with the server on every other status, for both functions', () => {
    // Without this, `willResumeWithoutAPoll` could be "every status but stalled" and every case
    // above would still pass — the split would be untested in the direction that matters.
    for (const status of ['idle', 'scanning', 'failed', 'stalled'] as const) {
      expect(willResumeWithoutAPoll(status), status).toBe(isAdvancing(status));
    }
  });
});

describe('formatResumeAt', () => {
  it('renders the moment in UTC to the minute, because D1 resets at UTC midnight', () => {
    // UTC and not local: a local rendering is wrong twice a day — once by the offset, and once
    // because the two midnights disagree — and an operator reading the wrong hour waits for the
    // wrong morning.
    expect(formatResumeAt(Date.UTC(2026, 9, 6, 0, 0, 0))).toBe('00:00');
    expect(formatResumeAt(Date.UTC(2026, 9, 6, 14, 5, 0))).toBe('14:05');
  });

  it('pads the hour, so a 9am reset does not read as 9am-in-the-past beside 14:05', () => {
    expect(formatResumeAt(Date.UTC(2026, 9, 6, 9, 5, 0))).toBe('09:05');
  });

  it('answers null for an unusable timestamp, so the label falls back rather than rendering NaN', () => {
    // A client has to be able to render a status it does not fully understand, and "Invalid Date"
    // on an operator's screen is worse than a label without a time.
    expect(formatResumeAt(null)).toBeNull();
    expect(formatResumeAt(undefined)).toBeNull();
    expect(formatResumeAt(NaN)).toBeNull();
    expect(formatResumeAt(Infinity)).toBeNull();
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

describe('a paused scan, which is a status the vocabulary did not have', () => {
  const MIDNIGHT = Date.UTC(2026, 9, 6, 0, 0, 0);

  it('names the hour it resumes and says the scan will resume itself', () => {
    // The content of the status. "Paused" alone tells an operator nothing about whether to wait or
    // to act, and this one needs neither: the work resumes at a stated moment. That is the
    // difference from `stalled`, whose label names the operator's action precisely *because* there
    // is no scheduled recovery.
    const shown = describeScanState(state({ status: 'paused', resumeAt: MIDNIGHT }), 42);

    expect(shown.tone).toBe('warning');
    // The hour is formatted in UTC by `formatResumeAt`, so this is the reset itself rather
    // than whatever the machine's timezone would render.
    expect(shown.label).toContain('00:00');
    expect(shown.label).toContain('resumes itself');
    expect(shown.detail).toBe('42 tracks indexed');
  });

  it('does not raise a notice on every poll', () => {
    // A pause is a limit already being handled, so a notice would interrupt the operator every few
    // seconds for something nobody has to do — the same reasoning as `failed`, and the reason the
    // reason and the time are rendered under the row instead, where they outlive the notice.
    expect(describeScanState(state({ status: 'paused', resumeAt: MIDNIGHT }), 42).notice).toBeUndefined();
  });

  it('falls back to a whole-hour label when the server sent no usable time', () => {
    // A client has to render a status it cannot fully understand. Rendering the literal `null` or
    // `Invalid Date` on an operator's screen is worse than a label without a specific hour, and
    // the fallback is deliberately 00:00 — the real reset — rather than a plausible-looking guess.
    for (const resumeAt of [null, undefined, NaN]) {
      const shown = describeScanState(state({ status: 'paused', resumeAt }), 0);
      expect(shown.label, String(resumeAt)).toContain('00:00');
      expect(shown.label, String(resumeAt)).not.toContain('null');
      expect(shown.label, String(resumeAt)).not.toContain('NaN');
    }
  });

  it('still renders the track count, because the count is a measurement', () => {
    // `detail: null` is right for a never-scanned library and for one that finished with nothing,
    // where `0` would contradict the badge. It is wrong here: a paused scan with tracks indexed is
    // exactly the state where the count is the thing worth watching while the scan waits.
    expect(describeScanState(state({ status: 'paused', resumeAt: MIDNIGHT }), 7).detail).toBe('7 tracks indexed');
  });

  it('is not the terminal error tone, because nothing is broken', () => {
    // The distinction from `stalled` and from the `empty` case, both of which are `error`. An
    // operator who has learned to ignore a red badge has to be able to trust it, and colouring a
    // self-clearing limit as a fault spends that trust.
    expect(describeScanState(state({ status: 'paused', resumeAt: MIDNIGHT }), 7).tone).not.toBe('error');
    expect(describeScanState(state({ status: 'stalled' }), 0).tone).toBe('error');
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

  it('refuses to call a finished scan that indexed nothing "up to date"', () => {
    // The gap this file existed to close had a second half. `never` covered a library with
    // no `scan_state` row; nothing covered a library whose scan *finished* and indexed
    // nothing, which fell through to `idle` — a success-toned "Up to date." beside "0
    // tracks indexed". Both halves on screen, contradicting, and the badge won.
    //
    // It shipped: 80 album folders on the origin, every one left unopened by a scan that
    // could not tell a browse-written row from its own, `songs` empty, `scan_state`
    // `idle`. So this is not a cosmetic tone — it is the only thing on the page that was
    // untrue.
    const presented = describeScanState(state({ status: 'idle' }), 0);
    expect(presented.label).toBe(SCAN_LABELS.empty);
    expect(presented.tone).not.toBe('success');
    expect(presented.tone).toBe('error');
    // `detail: null`, not "0 tracks indexed": rendering the count under a label denying
    // there is any gives the number the badge is contradicting. Same reasoning as `never`.
    expect(presented.detail).toBeNull();
    // And it is a notice, because nothing else changes it — the same argument as `stalled`.
    expect(presented.notice).toEqual({ type: 'error', text: SCAN_LABELS.empty });
  });

  it.each(['scanning', 'failed', 'stalled'] as const)('still shows zero tracks honestly while a scan is %s', (status) => {
    // The paired direction, and it matters: zero tracks is the *expected* state of a
    // library for the whole length of a first scan. A guard written as `songCount === 0`
    // rather than as `idle && songCount === 0` would paint every first scan as a failure
    // and train an operator to ignore the line that does mean something is wrong.
    const presented = describeScanState(state({ status }), 0);
    expect(presented.label).not.toBe(SCAN_LABELS.empty);
    expect(presented.detail).toBe('0 tracks indexed');
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
