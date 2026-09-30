/**
 * User and session calls against `/user/*`.
 *
 * The only module besides `libraryService` that knows a request shape. Views call
 * these; `lib/api.ts` owns the transport.
 */
import { apiDelete, apiGet, apiPatch, apiPost, buildQuery } from '../lib/api';
import type { CurrentUser, UserSummary } from '../types';

// Deduplicates concurrent mounts (e.g. StrictMode double-effects) so the shell
// issues a single `GET /user/me`. Cleared on settle so a later explicit reload
// refetches. A holder object (not a reassigned binding) keeps the shared
// inflight request.
const currentUserRequest: { inflight: Promise<CurrentUser> | null } = { inflight: null };

export async function loadCurrentUser(): Promise<CurrentUser> {
  currentUserRequest.inflight ??= apiGet<CurrentUser>('/me').finally(() => {
    currentUserRequest.inflight = null;
  });
  return currentUserRequest.inflight;
}

export const listUsers = (): Promise<{ users: UserSummary[] }> => apiGet('/users');

export const createUser = (body: {
  username: string;
  password: string;
  email?: string;
  isAdmin?: boolean;
}): Promise<{ id: string; username: string }> => apiPost('/users', body);

export const setUserEnabled = (id: string, enabled: boolean): Promise<{ ok: true }> =>
  apiPatch(`/users/${encodeURIComponent(id)}/enabled${buildQuery({ enabled })}`);

export const setUserLibraries = (id: string, libraryIds: string[]): Promise<{ ok: true }> =>
  apiPatch(`/users/${encodeURIComponent(id)}/libraries`, { libraryIds });

export const deleteUser = (id: string): Promise<{ ok: true }> => apiDelete(`/users/${encodeURIComponent(id)}`);
