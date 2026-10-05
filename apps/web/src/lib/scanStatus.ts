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
 * ### Why polling stops at `stalled` and at `paused`
 *
 * Both are states where more polling buys nothing, and for the same reason: the answer cannot
 * change. `stalled`'s retry budget is spent and nothing is scheduled to retry; a `paused` scan
 * waits for a wall-clock moment and no amount of asking moves it. A page that keeps polling either
 * spends the operator's `/user/*` rate-limit budget to re-read an answer that will be identical,
 * which is the one thing the 60-requests-per-minute bucket cannot afford.
 *
 * `failed` is the opposite case and **is** still advancing — it is retried within its bound —
 * which is the distinction `isAdvancing` records on the server. `paused` is `true` there and
 * `false` here, and that is not an inconsistency: the server's `isAdvancing` answers *the alarm's*
 * question ("will this resume by itself?"), which is `yes` for a pause, and this one answers
 * *the page's* ("will looking again change what I read?"), which is `no`. Both answers are needed
 * and neither is the other's, so `test/scan-progress.test.ts` pins this one to the server's and
 * `test/d1-daily-limit.test.ts` pins the server's to both halves.
 */
import type { LibraryScanSummary, Notice, ScanStatus } from '../types';

/**
 * Whether more work will happen if someone looks again.
 *
 * Mirrors `isAdvancing` in `backend-services`; see the header for why it is not that
 * function imported. `paused` is in neither, and for the same reason in both: the server's
 * `isAdvancing` answers the **alarm's** question ("will this resume by itself?" — yes, at a
 * known moment) and this one answers the **page's** ("will looking again change what I read?" —
 * no). Two questions, two functions, and `test/scan-progress.test.ts` pins both halves so neither
 * is written against the other's answer.
 */
function isAdvancingStatus(status: ScanStatus | null | undefined): boolean {
  return status === 'scanning' || status === 'failed';
}

type ScanTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

/**
 * The six sentences an operator can be shown about a library's index.
 *
 * `never` is not a tone but a state: a library that has never been scanned is the one case
 * where the operator has an action to take, and it is a different answer from every status —
 * not a variant of `idle`, which means the scan finished and found nothing to do.
 *
 * `empty` is the same kind of correction, and it exists because `never` alone was not
 * enough. A library *has* a scan state, the scan *finished*, and it indexed zero tracks —
 * and `idle` rendered that as a success-toned "Up to date." beside "0 tracks indexed". Both
 * halves were on screen and they contradicted each other, and the badge won.
 *
 * That is not cosmetic. It shipped: 80 album folders on the origin, zero of them indexed,
 * `scan_state` `idle`, and the page said the library was up to date. The zero is a
 * measurement, so it is only ever rendered beside a claim the scan can back up.
 */
interface ScanLabels {
  readonly never: string;
  readonly idle: string;
  readonly empty: string;
  readonly scanning: string;
  readonly failed: string;
  readonly stalled: string;
  /**
   * A pause the scan will lift itself. `{{time}}` is substituted by this module, not by the
   * caller, for the same reason `tracksIndexed` is: a component that formats the value is a
   * decision with no test.
   */
  readonly paused: string;
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
  empty: 'Scan finished with nothing indexed. Check the library root path, then rescan.',
  scanning: 'Scanning.',
  failed: 'Retrying after an error.',
  stalled: 'Stopped retrying. Fix the cause, then rescan.',
  paused: "D1's daily write allowance is spent. Paused until {{time}} UTC; the scan resumes itself.",
  tracksIndexed: '{{count}} tracks indexed',
};

/**
 * A wall-clock moment as an operator reads it, in UTC and to the minute.
 *
 * UTC because that is the clock D1's reset is defined in, and a local-time rendering would be
 * wrong twice a day — once by the offset, and once because the two midnights disagree. `HH:MM`
 * rather than a date because a pause is at most a few hours long: the date is noise, and rendering
 * a second format an operator then has to interpret is a second thing to get wrong.
 *
 * `null` for an unusable timestamp, so a client that receives one falls back to the label without
 * a substitution rather than rendering `Invalid Date`.
 */
function formatResumeAt(resumeAt: number | null | undefined): string | null {
  if (typeof resumeAt !== 'number' || !Number.isFinite(resumeAt)) return null;
  const at = new Date(resumeAt);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
}

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
  if (scan.status === 'paused') {
    // Warning, not error, and `notice: void 0` rather than a notice. A pause is a limit that will
    // lift itself at a stated time, so it is not a fault an operator has to act on and raising a
    // notice on every poll would interrupt them repeatedly for something already handled. The
    // reason and the time are on the row, where they outlive any notice — the same treatment a
    // failed scan gets, for the same reason.
    const at = formatResumeAt(scan.resumeAt);
    return {
      tone: 'warning',
      label: at === null ? labels.paused.replaceAll('{{time}}', '00:00') : labels.paused.split('{{time}}').join(at),
      detail,
      notice: void 0,
    };
  }
  if (scan.status === 'stalled') {
    // Terminal: the retry budget is spent and nothing will re-attempt it. An error tone is
    // right here, and the label names the remedy, because this is the one status where the
    // operator's action is the only thing that changes the outcome.
    return { tone: 'error', label: labels.stalled, detail, notice: { type: 'error', text: labels.stalled } };
  }

  // A finished scan that indexed nothing. Checked **after** `scanning` and `failed`, because
  // zero tracks is the expected state of both for the whole length of a first scan — only a
  // *completed* scan claiming nothing is a contradiction, since completion is a claim about
  // having read the library.
  //
  // `detail: null` rather than "0 tracks indexed", the same reasoning as the never-scanned
  // case above: rendering the count under this label gives the number the badge is denying.
  // And it is a notice, because nothing else will change it — the same argument as
  // `stalled`, and the reason this is not merely a warning badge.
  if (songCount === 0) {
    return { tone: 'error', label: labels.empty, detail: null, notice: { type: 'error', text: labels.empty } };
  }

  return { tone: 'success', label: labels.idle, detail, notice: void 0 };
}

export { describeScanState, isAdvancingStatus, formatResumeAt, SCAN_LABELS };
export type { ScanLabels, ScanPresentation, ScanTone };
