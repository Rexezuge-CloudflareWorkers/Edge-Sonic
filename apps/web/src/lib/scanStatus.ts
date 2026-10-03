/**
 * How a library's scan state is presented to an operator.
 *
 * ### Why this is a pure module and not JSX in the row
 *
 * Two reasons, both of which have bitten this surface before. `apps/web` is outside the
 * coverage gate, so a decision that lives in a component is a decision with no evidence —
 * `test/probe-notice.test.ts` and `test/spa-decisions.test.ts` exist because the decisions
 * that were wrong lived inside components. And `t()` is not called here: a test that had to
 * initialise i18next to assert a string would be testing i18next, so the labels are
 * parameters and this module decides *which* text, not *where* it comes from.
 *
 * ### `isAdvancingStatus` is a twin of the server's `isAdvancing`, not a copy of it
 *
 * `backend-services` exports `isAdvancing` for exactly this question, and this is **not** it
 * imported: `apps/web` ships zero `@edge-sonic/*` runtime dependencies, so the package is not
 * reachable from a browser bundle at all. That is a platform constraint, not a preference, and
 * it is why the duplication is tolerable rather than a second answer free to disagree — the
 * two are asserted against the same status vocabulary in `test/scan-progress.test.ts`. Import
 * it when the SPA gains runtime dependencies; do not add them for this.
 *
 * ### Why polling stops at `stalled`
 *
 * `stalled` is the only status where more polling buys nothing: the retry budget is spent and
 * nothing is scheduled to retry. A page that keeps polling it is spending the operator's
 * `/user/*` rate-limit budget to re-read an answer that cannot change. `failed` is the
 * opposite case and **is** still advancing — it is retried within its bound — which is the
 * distinction `isAdvancing` records on the server.
 */
import type { LibraryScanSummary, Notice, ScanStatus } from '../types';

/**
 * Whether more work will happen if someone looks again.
 *
 * Mirrors `isAdvancing` in `backend-services`; see the header for why it is not that
 * function imported.
 */
function isAdvancingStatus(status: ScanStatus | null | undefined): boolean {
  return status === 'scanning' || status === 'failed';
}

type ScanTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

/**
 * The five sentences an operator can be shown about a library's index.
 *
 * `never` is not a tone but a state: a library that has never been scanned is the one case
 * where the operator has an action to take, and it is a different answer from every status —
 * not a variant of `idle`, which means the scan finished and found nothing to do.
 */
interface ScanLabels {
  readonly never: string;
  readonly idle: string;
  readonly scanning: string;
  readonly failed: string;
  readonly stalled: string;
  readonly tracksIndexed: string;
}

interface ScanPresentation {
  readonly tone: ScanTone;
  readonly label: string;
  /**
   * The count line, or `null` when there is nothing to count. `null` rather than `0 tracks`
   * for a library that has never been scanned: "0" is a measurement and there has been none.
   */
  readonly detail: string | null;
  /**
   * A notice for an action the operator just took, or `void` for a passive poll.
   *
   * The distinction is the same one `describeProbe` draws. A failed probe is an HTTP `200`
   * and reporting success for it told the operator "Probe finished." beside a red badge; a
   * poll that discovers a failed scan has not itself failed, so it must not raise a notice on
   * every tick.
   */
  readonly notice: Notice | void;
}

const SCAN_LABELS: ScanLabels = {
  never: 'Not scanned yet.',
  idle: 'Up to date.',
  scanning: 'Scanning.',
  failed: 'Retrying after an error.',
  stalled: 'Stopped retrying. Fix the cause, then rescan.',
  tracksIndexed: '{{count}} tracks indexed',
};

/**
 * Derive the badge, the count line and the notice from one scan state.
 *
 * All three come from the single `scan` value so they cannot disagree — the defect
 * `describeProbe` records, where the badge and the notice were computed separately and the
 * notice was the wrong one.
 */
function describeScanState(scan: LibraryScanSummary | null, songCount: number, labels: ScanLabels = SCAN_LABELS): ScanPresentation {
  // No scan row at all. The library has never been pointed at the scanner, so there is no
  // count to report and an action to suggest — which is why this is not folded into `idle`.
  if (scan === null) {
    return { tone: 'neutral', label: labels.never, detail: null, notice: { type: 'success', text: labels.never } };
  }

  // `split`/`join` rather than `replace`: the substituted value is a number and
  // `String#replace` gives a `$&`-bearing pattern a meaning it cannot mean here. i18next
  // itself substitutes the same way, so the bundle and this agree on `{{count}}` being a
  // plain token.
  const detail = labels.tracksIndexed.split('{{count}}').join(String(songCount));

  if (scan.status === 'scanning') {
    return { tone: 'info', label: labels.scanning, detail, notice: void 0 };
  }
  if (scan.status === 'failed') {
    // `notice: void 0` because a failed scan is **retrying**. Raising an error notice on a
    // poll would interrupt the operator every tick for a condition that is being worked on.
    // The reason is rendered under the row instead, which outlives any notice.
    return { tone: 'warning', label: labels.failed, detail, notice: void 0 };
  }
  if (scan.status === 'stalled') {
    // Terminal: the retry budget is spent and nothing will re-attempt it. An error tone is
    // right here, and the label names the remedy, because this is the one status where the
    // operator's action is the only thing that changes the outcome.
    return { tone: 'error', label: labels.stalled, detail, notice: { type: 'error', text: labels.stalled } };
  }
  return { tone: 'success', label: labels.idle, detail, notice: void 0 };
}

export { describeScanState, isAdvancingStatus, SCAN_LABELS };
export type { ScanLabels, ScanPresentation, ScanTone };
