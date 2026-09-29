/**
 * How a probe outcome is presented to an operator.
 *
 * ### Why this is a pure module and not JSX
 *
 * The badge and the notice used to be computed independently, and they disagreed:
 * a failed probe set `probe: 'failed'`, which rendered the single word
 * "unreachable", while `run()` went on to raise a **success** notice reading
 * "Probe finished." because the request had succeeded — it had returned `200` with
 * `ok: false`. One event, two answers, and the one the operator reads last was the
 * wrong one.
 *
 * Both are now derived here from a single result, so they cannot disagree, and the
 * function is pure so it can be tested without a DOM.
 *
 * ### The server owns the wording
 *
 * `result.error` is passed through verbatim rather than mapped to a local string,
 * for the same reason `extractError` in `lib/api.ts` surfaces an `Exception`
 * message: the server has already classified the failure and knows more than a
 * client-side mapping can. "Unreachable" is now produced by exactly one branch on
 * the server — a transport failure — so the word is worth trusting when it appears.
 *
 * ### Translation is a parameter, not an import
 *
 * `t()` is not called here. A test that had to initialise i18next to assert a
 * string would be testing i18next; taking the two labels as arguments keeps this a
 * decision about *which* text, not about *where* it comes from.
 */
import type { ChunkStopReason, Notice, ProbeResult } from '../types';

/**
 * The two stop-reason sentences, injectable for the same reason `PROBE_LABELS` is:
 * this module decides *which* text, not where it comes from, so a test asserts the
 * decision without initialising i18next.
 */
interface StopReasonLabels {
  readonly requests: string;
  readonly deadline: string;
}

/**
Badge tone. `neutral` covers the in-flight state, which is not a verdict.
*/
type ProbeTone = 'success' | 'error' | 'neutral';

interface ProbePresentation {
  readonly tone: ProbeTone;
  /**
  Badge text. On failure this is the server's own sentence, which is long — the
  badge is not the only place it appears, and the notice carries it too.
  */
  readonly label: string;
  readonly notice: Notice;
}

/**
The two success strings differ on purpose: the badge is a verdict the row keeps
showing, and the notice is a one-shot confirmation. They used to be the same
string, which is how a success notice ended up reading "Probe finished." beside a
failure badge.
*/
interface ProbeLabels {
  readonly reachable: string;
  readonly probed: string;
  readonly failed: string;
}

const PROBE_LABELS: ProbeLabels = {
  reachable: 'Reachable.',
  probed: 'The origin answered.',
  failed: 'The probe failed.',
};

function describeProbe(result: ProbeResult, labels: ProbeLabels = PROBE_LABELS): ProbePresentation {
  if (result.ok) {
    return { tone: 'success', label: labels.reachable, notice: { type: 'success', text: labels.probed } };
  }
  // `error` is `null` only in a shape the server does not produce, so the
  // fallback exists to keep a malformed response from rendering an empty badge.
  const text = result.error ?? labels.failed;
  // `type: 'error'` is the whole point: `NoticeBar` gives it `role="alert"`, so a
  // failed probe interrupts rather than being replaced by the next polite message.
  return { tone: 'error', label: text, notice: { type: 'error', text } };
}

/**
How a scan outcome is presented, for the same reason.

`lastError` was declared optional on the wire type and never sent by the server at
all, so a failed scan rendered the bare word "failed" while the reason sat in
`scan_state` unread. An empty string counts as absent alongside `null` and
`undefined`: a stored-but-blank error is indistinguishable from no error, and an
empty error line reads as a rendering bug rather than a diagnosis.
*/
function describeScan(lastError: string | null | undefined): string | null {
  if (lastError === null || lastError === undefined || lastError.trim().length === 0) return null;
  return lastError;
}

/**
 * Why a chunk stopped early, or `null` for one that did not.
 *
 * A scan chunk is bounded by a subrequest ceiling and a wall-clock deadline, and it
 * returns when it reaches either. Reporting that is the difference between an
 * operator reading "still scanning" and reading "still scanning, because your origin
 * takes two seconds a request and the chunk is capped at twenty" — one is a status,
 * the other is a diagnosis, and the second one is the one that has an action.
 *
 * `frontier` returns `null`: the chunk ran out of folders to visit, which is the
 * ordinary case and not worth a line of text. `null`/`undefined` likewise, for a
 * read-only status that did no work.
 *
 * The two limits are named separately because they have different remedies — a slow
 * origin is fixed with `WEBDAV_TIMEOUT_MS` and a faster server, a small budget with
 * `SCAN_CHUNK_MAX_REQUESTS` — and "it stopped" is not either of them.
 */
function describeStopReason(stoppedBy: ChunkStopReason | undefined, labels?: StopReasonLabels): string | null {
  if (stoppedBy === 'requests') return labels?.requests ?? STOP_REASON_LABELS.requests;
  if (stoppedBy === 'deadline') return labels?.deadline ?? STOP_REASON_LABELS.deadline;
  return null;
}

const STOP_REASON_LABELS: StopReasonLabels = {
  requests: 'Paused at the per-chunk request limit. Raise SCAN_CHUNK_MAX_REQUESTS to index more per poll.',
  deadline: 'Paused at the per-chunk time limit. Raise SCAN_CHUNK_DEADLINE_MS, or expect more polls.',
};

export { describeProbe, describeScan, describeStopReason, PROBE_LABELS, STOP_REASON_LABELS };
export type { ProbePresentation, ProbeTone, StopReasonLabels };
