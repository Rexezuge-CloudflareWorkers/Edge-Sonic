/**
 * Library and scan calls against `/user/libraries/*`.
 *
 * The only module besides `userService` that knows a request shape. Views and
 * rows call these; `lib/api.ts` owns the transport.
 */
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import type { LibraryPatch } from '../lib/libraryDraft';
import type { EnrichStateSummary, IndexDropResult, IndexStats, LibrarySummary, ProbeResult, ScanStateSummary } from '../types';

export const listLibraries = (): Promise<{ libraries: LibrarySummary[] }> => apiGet('/libraries');

export const createLibrary = (body: {
  slug: string;
  baseUrl: string;
  rootPath: string;
  davUsername: string;
  davPassword: string;
  displayName?: string;
}): Promise<{ id: string; slug: string }> => apiPost('/libraries', body);

/**
 * The body is `LibraryPatch`, not an inline shape, so the rule that an untouched
 * password must be **absent** rather than empty is expressed once in the type that
 * produces it. An inline copy here could drift to `davPassword: string` and quietly
 * re-encrypt an empty password over a working credential.
 */
export const updateLibrary = (id: string, body: LibraryPatch): Promise<{ ok: true }> =>
  apiPatch(`/libraries/${encodeURIComponent(id)}`, body);

export const deleteLibrary = (id: string): Promise<{ ok: true }> => apiDelete(`/libraries/${encodeURIComponent(id)}`);

/**
 * Probe and rescan are POSTs, not query flags on GET.
 *
 * Both perform a live outbound request with the *stored* credential, and a `GET`
 * that can be triggered by a link is a `GET` that can be triggered by a prefetcher.
 */
export const probeLibrary = (id: string): Promise<ProbeResult> => apiPost(`/libraries/${encodeURIComponent(id)}/probe`);

export const startLibraryScan = (id: string): Promise<ScanStateSummary> => apiPost(`/libraries/${encodeURIComponent(id)}/scan`);

/**
 * Advance one scan chunk.
 *
 * A `POST` for the same reason `probeLibrary` is: it performs live outbound requests
 * with the stored credential, and a `GET` a link — or a prefetcher — can trigger is a
 * `GET` neither should.
 *
 * This is what makes "Rescan" do something without a Subsonic client polling. The scan
 * is client-driven, so before this route an operator started a scan that only advanced
 * while some other surface happened to poll it.
 */
export const stepLibraryScan = (id: string): Promise<ScanStateSummary> => apiPost(`/libraries/${encodeURIComponent(id)}/scan/step`);

/**
 * Start a library-wide tag enrichment.
 *
 * A `POST` for the probe's reason: it performs live outbound requests with the stored
 * credential, and a `GET` a link — or a prefetcher — can trigger is a `GET` neither
 * should. Runs only while the scan is idle; while the scan is advancing the server
 * refuses with `409`, so the operator learns to wait rather than watching a run that
 * cannot move.
 */
export const startLibraryEnrich = (id: string): Promise<EnrichStateSummary> => apiPost(`/libraries/${encodeURIComponent(id)}/enrich`);

// Two wrappers that are deliberately absent: `libraryScanStatus` and `libraryEnrichStatus`. Both
// read one library's state where `GET /user/libraries` already carries every library's state, and
// the library page polls that one list — so a per-library read is a second round trip for a fact
// the page already holds. The **routes** stay, because they are part of the operator API and are
// asserted in `test/user-api.test.ts`; it is only the browser-side wrappers that nothing calls,
// and an export with no caller is a second vocabulary to keep in sync.

/**
 * Advance one enrichment chunk.
 *
 * Without the `ENRICH` binding this is the only thing that moves a run at all — the
 * client-driven path, one bounded chunk per call, like the scan's step before it.
 */
export const stepLibraryEnrich = (id: string): Promise<EnrichStateSummary> => apiPost(`/libraries/${encodeURIComponent(id)}/enrich/step`);

/**
 * What dropping every library's index would cost.
 *
 * The one `GET` among the Danger Zone's calls, and it is a `GET` only because it cannot
 * write: `IndexStatsDAO` has no write method, so there is no version of this that spends
 * anything. A prefetcher firing it costs three batched counts and nothing else.
 *
 * It returns **both** the per-library rows and the total, so the Danger Zone can render a
 * row per library and a global action from one reading — two calls would be two answers to
 * "what does this cost", and the figure the operator consents to would depend on which one
 * they happened to read.
 */
export const indexStats = (): Promise<IndexStats> => apiGet('/index/stats');

/**
 * Drop one library's index.
 *
 * A `POST`, and deliberately **not** a `DELETE` on `/libraries/:id` — that route exists and
 * means "forget this origin and its credential", cascading the registration away. Two
 * destructive routes under one id that differ in whether the operator has to re-enter a
 * WebDAV password is a distinction worth carrying in the verb.
 *
 * The library registration and its encrypted credential **survive**, and so do every
 * per-user annotation: song ids are derived from `(libraryId, path)`, so a rescan recreates
 * them byte-identically and every star and play count re-attaches to the row it belonged to.
 */
export const dropLibraryIndex = (id: string): Promise<IndexDropResult & { readonly ok: true }> =>
  apiPost(`/libraries/${encodeURIComponent(id)}/index/drop`);

/**
 * Drop **every** library's index, leaving every registration in place.
 *
 * The unscoped sibling of `dropLibraryIndex`, and the reason its confirmation is a literal
 * phrase rather than a library name: nothing in the request names what is being destroyed,
 * so the operator types the fact that *everything* is.
 */
export const dropAllIndexes = (): Promise<IndexDropResult & { readonly ok: true }> => apiPost('/index/drop');
