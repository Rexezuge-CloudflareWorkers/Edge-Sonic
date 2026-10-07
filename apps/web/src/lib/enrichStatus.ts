/**
 * How a library's enrichment state is presented to an operator.
 *
 * The scan's `scanStatus.ts` for the enrichment run, and a twin rather than a reuse for
 * the reason the server keeps them apart: the two loops advance on different alarms, and
 * one presentation deciding for both would poll one while rendering the other. `apps/web`
 * ships zero `@edge-sonic/*` runtime dependencies, so the server's `isEnrichAdvancing`
 * is not reachable here — the two are pinned against the same vocabulary in
 * `test/scan-progress.test.ts`, which is what makes the duplication safe.
 *
 * Polling stops at `stalled` and at `paused`, for the scan's reason: more polling buys
 * nothing in either — one waits for the operator, the other for a wall clock — and the
 * page shares its 60-requests-per-minute bucket with every action on it. `failed` keeps
 * polling: it is retried within its bound.
 */
import type { EnrichStatus, LibraryEnrichSummary, Notice } from '../types';

/**
 * Whether more enrichment work will happen if someone looks again.
 *
 * Mirrors `isEnrichAdvancing` in `backend-services`; see the header for why it is not
 * that function imported.
 */
function isEnrichAdvancingStatus(status: EnrichStatus | null | undefined): boolean {
  return status === 'enriching' || status === 'failed';
}

type EnrichTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

/**
 * The sentences an operator can be shown about a library's enrichment.
 *
 * `never` is not a tone but a state: tracks remain and no run was ever started, which is
 * the one case where the operator has an action to take. `partial` is the same kind of
 * correction the scan's `empty` case is — an `idle` run with tracks still owing is not a
 * failure (lazy `getSong` covers tracks as clients open them), but rendering it as
 * "Enriched." would claim work nobody did.
 */
interface EnrichLabels {
  readonly never: string;
  readonly idle: string;
  readonly partial: string;
  readonly enriching: string;
  readonly failed: string;
  readonly stalled: string;
  /**
   * A pause the run will lift itself. `{{time}}` is substituted by this module, not by the
   * caller, for the scan's reason: a component that formats the value is a decision with
   * no test.
   */
  readonly paused: string;
  readonly tracksRemaining: string;
}

interface EnrichPresentation {
  readonly tone: EnrichTone;
  readonly label: string;
  /**
   * The remaining line, or `null` when there is nothing to count. `null` rather than "0
   * tracks" for a library that was never enriched and for one that finished: "0" beside
   * either badge hands the number to a claim it contradicts.
   */
  readonly detail: string | null;
  readonly notice: Notice | void;
}

const ENRICH_LABELS: EnrichLabels = {
  never: 'Not enriched yet.',
  idle: 'Enriched.',
  partial: 'Partially enriched. New tracks enrich on first play, or run the enrichment again.',
  enriching: 'Enriching.',
  failed: 'Retrying after an error.',
  stalled: 'Stopped retrying. Fix the cause, then enrich again.',
  paused: "D1's daily write allowance is spent. Paused until {{time}} UTC; the enrichment resumes itself.",
  tracksRemaining: '{{count}} tracks remaining',
};

/**
 * A wall-clock moment as an operator reads it, in UTC and to the minute.
 *
 * UTC because that is the clock D1's reset is defined in. `null` for an unusable
 * timestamp, so the label falls back rather than rendering `Invalid Date`.
 */
function formatEnrichResumeAt(resumeAt: number | null | undefined): string | null {
  if (typeof resumeAt !== 'number' || !Number.isFinite(resumeAt)) return null;
  const at = new Date(resumeAt);
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Derive the badge, the remaining line and the notice from one enrichment state.
 *
 * All three come from the single `enrich` value so they cannot disagree — the defect
 * `describeProbe` records, where the badge and the notice were computed separately.
 */
function describeEnrichState(
  enrich: LibraryEnrichSummary | null,
  labels: EnrichLabels = ENRICH_LABELS,
): EnrichPresentation {
  // No run was ever started and tracks remain. There is no count to report and an action
  // to suggest — which is why this is not folded into `idle`.
  if (enrich === null) {
    return { tone: 'neutral', label: labels.never, detail: null, notice: { type: 'success', text: labels.never } };
  }

  const detail = labels.tracksRemaining.split('{{count}}').join(String(enrich.remaining));

  if (enrich.status === 'enriching') {
    return { tone: 'info', label: labels.enriching, detail, notice: void 0 };
  }
  if (enrich.status === 'failed') {
    // `notice: void 0` because a failed run is **retrying**. Raising an error notice on a
    // poll would interrupt the operator every tick for a condition that is being worked on.
    return { tone: 'warning', label: labels.failed, detail, notice: void 0 };
  }
  if (enrich.status === 'paused') {
    const at = formatEnrichResumeAt(enrich.resumeAt);
    return {
      tone: 'warning',
      label: at === null ? labels.paused.replaceAll('{{time}}', '00:00') : labels.paused.split('{{time}}').join(at),
      detail,
      notice: void 0,
    };
  }
  if (enrich.status === 'stalled') {
    // Terminal: the retry budget is spent and nothing will re-attempt it. An error tone is
    // right here, and the label names the remedy, because this is the one status where the
    // operator's action is the only thing that changes the outcome.
    return { tone: 'error', label: labels.stalled, detail, notice: { type: 'error', text: labels.stalled } };
  }

  // A run that finished with tracks still owing. Checked **after** the advancing states,
  // because a remaining count is the expected state of both for the whole length of a run
  // — only a *completed* run claiming tracks is a contradiction worth naming, and even
  // then it is informational: tracks enrich lazily on first play regardless.
  if (enrich.remaining > 0) {
    return { tone: 'info', label: labels.partial, detail, notice: void 0 };
  }

  return { tone: 'success', label: labels.idle, detail: null, notice: void 0 };
}

export { describeEnrichState, isEnrichAdvancingStatus, formatEnrichResumeAt, ENRICH_LABELS };
export type { EnrichLabels, EnrichPresentation, EnrichTone };
