/**
 * Library and scan calls against `/user/libraries/*`.
 *
 * The only module besides `userService` that knows a request shape. Views and
 * rows call these; `lib/api.ts` owns the transport.
 */
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import type { LibraryPatch } from '../lib/libraryDraft';
import type { LibrarySummary, ProbeResult, ScanStateSummary } from '../types';

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

export const libraryScanStatus = (id: string): Promise<ScanStateSummary> => apiGet(`/libraries/${encodeURIComponent(id)}/scan`);

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
