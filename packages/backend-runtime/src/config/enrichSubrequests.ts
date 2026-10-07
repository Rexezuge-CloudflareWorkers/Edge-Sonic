/**
 * What one library-wide enrich chunk may spend, derived from the platform ceiling.
 *
 * Own module rather than constants in `subrequests.ts` because that file is over the
 * god-file limit and this is the block that does not belong elsewhere: the scan's own
 * bounds stay beside the ceiling they derive from, and the enrichment page — which sizes
 * the selection so a chunk that spends its whole page still fits the ceiling — lives here.
 * `config/index.ts` re-exports both, so `@edge-sonic/backend-runtime/config` is still the
 * one import path.
 */
import { SCAN_CHUNK_SUBSREQUEST_BUDGET, SUBSREQUESTS_PER_ENRICHED_TRACK } from './subrequests';

/**
 * Statements a library-wide enrich chunk spends that belong to no track.
 *
 * Three: the scan-state read the idle-only guard needs, the page of tracks still owing a
 * tag read, and the remaining count the progress display is built from.
 */
const SUBSREQUESTS_PER_ENRICH_CHUNK_OVERHEAD = 3;

/**
 * Tracks one library-wide enrich chunk may attempt.
 *
 * The overhead above plus five subrequests per track — the whole cost of one enrichment,
 * not its range reads alone. `ScanBudget.canAfford` still decides per track at runtime;
 * this only sizes the page the chunk selects.
 */
const ENRICH_TRACKS_PER_CHUNK = Math.max(
  1,
  Math.floor((SCAN_CHUNK_SUBSREQUEST_BUDGET - SUBSREQUESTS_PER_ENRICH_CHUNK_OVERHEAD) / SUBSREQUESTS_PER_ENRICHED_TRACK),
);

export { SUBSREQUESTS_PER_ENRICH_CHUNK_OVERHEAD, ENRICH_TRACKS_PER_CHUNK };
