import { useCallback, useEffect, useState } from 'react';
import { t } from 'i18next';
import { Plus, RefreshCw, UserPlus } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Input, Label } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { EmptyState, LoadingSpinner } from '../components/layout/PageState';
import { listLibraries } from '../services/libraryService';
import { createUser, deleteUser, listUsers, setUserEnabled, setUserLibraries } from '../services/userService';
import type { ShowNotice } from '../hooks/useNotice';
import type { LibrarySummary, UserSummary } from '../types';

/**
 * Subsonic accounts.
 *
 * The password is write-only: it is sent once and the API never returns it, so
 * there is no field here to display and no reason to store one. The copy says so
 * explicitly, because "the field is blank" otherwise reads as a bug.
 */
function UsersView({ showNotice }: { showNotice: ShowNotice }) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ username: '', password: '', email: '' });

  // Both lists are fetched together because neither is meaningful without the other: a
  // user row shows the libraries it is granted, and a grant picker needs the libraries.
  const load = useCallback(async (): Promise<{ users: UserSummary[]; libraries: LibrarySummary[] }> => {
    try {
      const [userList, libraryList] = await Promise.all([listUsers(), listLibraries()]);
      return { users: userList.users, libraries: libraryList.libraries };
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
      return { users: [], libraries: [] };
    }
  }, [showNotice]);

  const reload = useCallback(async () => {
    const { users: loadedUsers, libraries: loadedLibraries } = await load();
    setUsers(loadedUsers);
    setLibraries(loadedLibraries);
  }, [load]);

  useEffect(() => {
    // See the note in `LibrariesView`: the effect owns the "am I still mounted" check,
    // because only the effect knows when the component goes away.
    let cancelled = false;
    void load().then((loaded) => {
      if (cancelled) return;
      setUsers(loaded.users);
      setLibraries(loaded.libraries);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const submit = async () => {
    setBusy('create');
    try {
      await createUser({
        username: draft.username,
        password: draft.password,
        ...(draft.email.length > 0 && { email: draft.email }),
      });
      setDraft({ username: '', password: '', email: '' });
      setCreating(false);
      showNotice('success', t('users.created', 'User created.'));
      await reload();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  /**
   * One path for every mutation, and the reason it exists is below.
   *
   * `toggleLibrary`, `setUserEnabled` and `deleteUser` each `await`ed their call with **no
   * `catch`**, and the click handlers `void`ed them. `readJson` throws a `BackendError` for
   * any non-2xx, so a 404 on a stale library id, a 409 from the grant ceiling, or a 500
   * produced an unhandled rejection and **no operator feedback at all** — the button looked
   * like it had done nothing, and nothing said why.
   *
   * `LibrariesView` funnels all four of its mutations through one `run` with
   * `try/catch/finally`; this view had the opposite shape for the same class of failure.
   * `void` is how a handler says "I have handled this rejection" — so on a path with no
   * catch it is a claim the code does not support.
   */
  const mutate = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    try {
      await action();
      await reload();
      showNotice('success', success);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    }
  };

  const toggleLibrary = (user: UserSummary, libraryId: string): Promise<void> => {
    const next = user.libraryIds.includes(libraryId) ? user.libraryIds.filter((id) => id !== libraryId) : [...user.libraryIds, libraryId];
    return mutate(async () => await setUserLibraries(user.id, next), t('users.updated', 'Updated.'));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('users.title', 'Subsonic users')}</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void reload()} aria-label={t('users.refresh', 'Refresh')}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <Button size="sm" variant="primary" onClick={() => setCreating((open) => !open)}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('users.add', 'Add user')}
          </Button>
        </div>
      </CardHeader>

      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        {t(
          'users.hint',
          'Point a Subsonic client at this server and sign in with one of these usernames. Passwords are stored encrypted and are never shown again.',
        )}
      </p>

      {creating && (
        <form
          className="mb-4 grid gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <Label htmlFor="username">{t('users.field.username', 'Username')}</Label>
            <Input
              id="username"
              required
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="email">{t('users.field.email', 'Email (optional)')}</Label>
            <Input
              id="email"
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="password">{t('users.field.password', 'Password')}</Label>
            <Input
              id="password"
              required
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              autoComplete="new-password"
            />
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" variant="primary" loading={busy === 'create'}>
              {t('users.save', 'Save')}
            </Button>
            <Button onClick={() => setCreating(false)}>{t('users.cancel', 'Cancel')}</Button>
          </div>
        </form>
      )}

      {users === null ? (
        <LoadingSpinner label={t('users.loading', 'Loading users')} />
      ) : users.length === 0 ? (
        <EmptyState
          icon={<UserPlus className="h-6 w-6 text-[var(--color-text-muted)]" aria-hidden="true" />}
          title={t('users.empty', 'No users yet')}
          description={t('users.emptyHint', 'Create an account, then sign in to this server from any Subsonic client.')}
        />
      ) : (
        <ul className="space-y-2">
          {users.map((user) => (
            <li key={user.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-[var(--color-text-primary)]">{user.username}</span>
                {user.isAdmin ? <Badge variant="info">{t('users.admin', 'admin')}</Badge> : null}
                {user.isEnabled ? null : <Badge variant="warning">{t('users.disabled', 'disabled')}</Badge>}
              </div>
              {user.email !== null && <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{user.email}</p>}

              <fieldset className="mt-3">
                <legend className="mb-1 text-xs font-medium text-[var(--color-text-muted)]">{t('users.libraries', 'Libraries')}</legend>
                <div className="flex flex-wrap gap-2">
                  {libraries.length === 0 ? (
                    <span className="text-xs text-[var(--color-text-muted)]">{t('users.noLibraries', 'No libraries registered yet.')}</span>
                  ) : (
                    libraries.map((library) => {
                      const granted = user.libraryIds.includes(library.id);
                      return (
                        <Button
                          key={library.id}
                          size="sm"
                          variant={granted ? 'primary' : 'secondary'}
                          onClick={() => void toggleLibrary(user, library.id)}
                          aria-pressed={granted}
                        >
                          {library.displayName ?? library.slug}
                        </Button>
                      );
                    })
                  )}
                </div>
              </fieldset>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void mutate(async () => await setUserEnabled(user.id, !user.isEnabled), t('users.updated', 'Updated.'))}>
                  {user.isEnabled ? t('users.disable', 'Disable') : t('users.enable', 'Enable')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => void mutate(async () => await deleteUser(user.id), t('users.deleted', 'User deleted.'))}>
                  {t('users.delete', 'Delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export { UsersView };
export default UsersView;
