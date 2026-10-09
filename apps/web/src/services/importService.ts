/**
 * Import calls against `/user/import/*`.
 *
 * A third module beside `libraryService` and `userService`, because an import is a **third
 * thing** an operator does: it neither configures where music comes from nor manages accounts,
 * and folding it into either would put a remote credential's form next to a library's.
 */
import { apiDelete, apiGet, apiPost } from '../lib/api';
import type { ImportPhase, ImportReport, ImportRunSummary, ImportSourceSummary } from '../types';

/**
The phase list, in the order the server runs them. Mirrors `IMPORT_PHASES` on the server.
*/
export const IMPORT_PHASES: readonly ImportPhase[] = ['playlists', 'stars', 'bookmarks', 'playQueue', 'playCounts'];

/**
 * A label for each phase, and the ones a person needs explaining.
 *
 * `playQueue` carries its explanation because it is the one phase that is **off by default** and
 * the one whose effect is least expected: a checkbox that silently imports yesterday's queue
 * reads as a feature, and a user who did not mean to is left with a queue they did not build.
 */
export const IMPORT_PHASE_LABELS: Readonly<Record<ImportPhase, string>> = {
  playlists: 'Playlists',
  stars: 'Favourites and ratings',
  bookmarks: 'Bookmarks',
  playQueue: 'Play queue',
  playCounts: 'Play counts',
};

export const listImportSources = (): Promise<{ sources: ImportSourceSummary[] }> => apiGet('/import/sources');

export const createImportSource = (body: {
  name: string;
  baseUrl: string;
  username: string;
  password: string;
  musicFolderId?: string;
}): Promise<{ id: string; name: string; baseUrl: string }> => apiPost('/import/sources', body);

export const deleteImportSource = (id: string): Promise<{ ok: true }> => apiDelete(`/import/sources/${encodeURIComponent(id)}`);

export const listImports = (): Promise<{ runs: ImportRunSummary[] }> => apiGet('/import');

export const startImport = (body: {
  sourceId: string;
  targetUserId: string;
  libraryId?: string;
  phases: readonly ImportPhase[];
}): Promise<{ id: string; workflowId: string }> => apiPost('/import', body);

export const readImport = (id: string): Promise<ImportRunDetail> => apiGet(`/import/${encodeURIComponent(id)}`);

interface ImportRunDetail {
  readonly id: string;
  readonly status: string;
  readonly lastError: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly playCounts: { readonly albumsDone: number; readonly songsImported: number } | null;
  readonly report: ImportReport | null;
}

export type { ImportRunDetail };
export { type ImportPhase, type ImportReport, type ImportRunSummary, type ImportSourceSummary } from '../types';
