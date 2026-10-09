/**
 * Warnings about a configured bound the platform will not honour.
 *
 * Split out of [`validate.ts`](./validate.ts) because these are all one rule applied four times,
 * and while they were inline that one rule was four copies of a `requested > ceiling → warn`
 * that could each drift in wording. The scan's advice in particular has to say *why* raising it
 * does not help, and that sentence is the first thing lost when a check is copy-pasted.
 */
import {
  SCAN_CHUNK_FOLDER_LIMIT,
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SCAN_ENRICH_MAX_PER_FOLDER,
  SUBSREQUESTS_PER_ENRICHED_TRACK,
  SUBSREQUESTS_PER_FOLDER_BASE,
  WORKER_SUBSREQUEST_CEILING,
} from './subrequests';
import { MAX_PAGE_SIZE_CEILING } from './ConfigurationDefaults';
import type { RequestLimits, ScanLimits } from './sections/LibraryLimits';

/**
 * One "configured above what the platform allows, and therefore clamped" check.
 *
 * Four of these, all the same shape, so they are one type and one function. Written as four
 * separate `if` blocks they were four copies of a `requested > ceiling → warn` that could each
 * drift in wording, and the three scan ones already had to explain why their advice differs —
 * which is the part most likely to be lost when it is copy-pasted rather than stated once.
 */
interface ClampCheck {
  /**
  The variable as the operator wrote it, for the message.
  */
  key: string;
  /**
  The value they asked for.
  */
  requested: number;
  /**
  What the platform allows.
  */
  ceiling: number;
  /**
  Why this one is clamped, and what raising it would actually do.
  */
  because: string;
}

/**
 * A configured bound the platform will not honour.
 *
 * Reported rather than applied quietly, and that distinction is the whole point: a page size
 * above what one invocation can answer is a **failed** request rather than a slow one, so
 * silently clamping it would leave an operator believing a limit is in force when the request
 * was already unservable. The scan's case is sharper still, because the operator surface tells
 * people to raise `SCAN_CHUNK_MAX_REQUESTS` — advice that is actively harmful on Free, where
 * the ceiling is 50 and cannot be raised from here.
 */
function clampWarnings(checks: readonly ClampCheck[]): string[] {
  return checks
    .filter((check) => check.requested > check.ceiling)
    .map((check) => `Configuration: ${check.key}=${check.requested} exceeds the ${check.ceiling} ${check.because}; it is clamped.`);
}

/**
 * Every clamp warning for this configuration, in the order the variables are documented.
 *
 * Reported rather than applied quietly, and that distinction is the whole point: a page size
 * above what one invocation can answer is a **failed** request rather than a slow one, so
 * silently clamping it would leave an operator believing a limit is in force when the request
 * was already unservable.
 */
function clampWarningsFor(scan: ScanLimits, requests: RequestLimits): string[] {
  return clampWarnings([
    {
      key: 'MAX_PAGE_SIZE',
      requested: requests.getRequestedMaxPageSize(),
      ceiling: MAX_PAGE_SIZE_CEILING,
      because:
        `this server can answer in one request. A page is a promise to answer, not a budget to spend — raise it only with ` +
        `limits.subrequests in the wrangler config`,
    },
    {
      key: 'SCAN_CHUNK_MAX_REQUESTS',
      requested: scan.getRequestedScanChunkMaxRequests(),
      ceiling: SCAN_CHUNK_SUBSREQUEST_BUDGET,
      because:
        `a chunk may spend under the platform's ${WORKER_SUBSREQUEST_CEILING}-subrequest ceiling. The operator surface tells people to raise ` +
        `this one, and on Workers Free that advice is actively harmful — the platform's ceiling cannot be raised from here, so a chunk that ` +
        `spends more is terminated rather than slowed`,
    },
    {
      key: 'SCAN_CHUNK_FOLDERS',
      requested: scan.getRequestedScanChunkFolders(),
      ceiling: SCAN_CHUNK_FOLDER_LIMIT,
      because: `a chunk can afford at ${SUBSREQUESTS_PER_FOLDER_BASE} subrequests a folder. Raising it cannot make a chunk finish`,
    },
    {
      key: 'SCAN_ENRICH_MAX_PER_FOLDER',
      requested: scan.getRequestedScanEnrichMaxPerFolder(),
      ceiling: SCAN_ENRICH_MAX_PER_FOLDER,
      because: `a chunk can afford at ${SUBSREQUESTS_PER_ENRICHED_TRACK} subrequests a track`,
    },
  ]);
}

export { clampWarnings, clampWarningsFor };
