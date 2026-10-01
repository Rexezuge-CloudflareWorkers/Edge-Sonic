import { useCallback, useEffect, useState } from 'react';
import { t } from 'i18next';
import { HardDrive, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { EmptyState, LoadingSpinner } from '../components/layout/PageState';
import { LibraryForm } from '../components/library/LibraryForm';
import { LibraryRow } from '../components/library/LibraryRow';
import type { RunAction } from '../components/library/LibraryRow';
import { createLibrary, deleteLibrary, listLibraries, updateLibrary } from '../services/libraryService';
import type { ShowNotice } from '../hooks/useNotice';
import { toPatch } from '../lib/libraryDraft';
import type { LibraryDraft } from '../lib/libraryDraft';
import type { LibrarySummary } from '../types';

/**
 * A row action in flight: `'create'`, or a library id.
 *
 * One key rather than a boolean, so two actions cannot both claim the busy state
 * and so a row can test `busy === library.id` directly instead of being handed a
 * pre-computed flag it cannot check.
 */
type BusyKey = string | null;

/**
 * The library registry.
 *
 * Registration is where an operator points Edge-Sonic at a WebDAV bucket, and the
 * two fields that most often go wrong are the URL shape and the root path — so both
 * are labelled with the shape they must take rather than just their names. The
 * server validates both again; this only saves a round trip.
 */
function LibrariesView({ showNotice }: { showNotice: ShowNotice }) {
  const [libraries, setLibraries] = useState<LibrarySummary[] | null>(null);
  const [busy, setBusy] = useState<BusyKey>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // The fetch, separate from the effect that runs it, so the same code serves the
  // initial load and every refresh button without the effect having to reach into
  // component state.
  const load = useCallback(async (): Promise<LibrarySummary[]> => {
    try {
      const { libraries: loaded } = await listLibraries();
      return loaded;
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
      // An unreachable user API is shown as an empty list plus the notice, rather than
      // an error screen: the operator can still read what is cached in the page and the
      // notice says what went wrong.
      return [];
    }
  }, [showNotice]);

  const reload = useCallback(async () => {
    setLibraries(await load());
  }, [load]);

  useEffect(() => {
    // `cancelled` is what the effect actually needs and `reload` could not provide: a
    // component unmounted mid-fetch must not set state, and React 18 turns that into a
    // silent leak rather than a warning. It also stops a slow first response from
    // overwriting a faster refresh the user triggered in the meantime.
    let cancelled = false;
    void load().then((loaded) => {
      if (!cancelled) setLibraries(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * Run an action, report its outcome, then refresh.
   *
   * The action returns `void` to take the default success message, or a `Notice` to
   * override it. The override is not a convenience: a failed probe is an HTTP `200`,
   * so without it the one diagnostic in the product reported success for the
   * failure it existed to explain.
   */
  const run: RunAction = async (id, action, success) => {
    setBusy(id);
    try {
      const override = await action();
      if (override) showNotice(override.type, override.text);
      else showNotice('success', success);
      await reload();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const submitCreate = (draft: LibraryDraft) => {
    void run(
      'create',
      async () => {
        await createLibrary({
          slug: draft.slug,
          baseUrl: draft.baseUrl,
          rootPath: draft.rootPath,
          davUsername: draft.davUsername,
          davPassword: draft.davPassword,
          ...(draft.displayName.length > 0 && { displayName: draft.displayName }),
        });
        setCreating(false);
        return undefined;
      },
      t('libraries.created', 'Library registered.'),
    );
  };

  const submitEdit = (id: string, draft: LibraryDraft) => {
    void run(
      id,
      async () => {
        // `toPatch` omits an untouched password, so correcting a display name or a
        // root path cannot destroy the stored credential on the way past.
        await updateLibrary(id, toPatch(draft));
        setEditingId(null);
        return undefined;
      },
      t('libraries.updated', 'Library updated.'),
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('libraries.title', 'Music libraries')}</CardTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void reload()} aria-label={t('libraries.refresh', 'Refresh')}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button size="sm" variant="primary" onClick={() => setCreating((open) => !open)}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('libraries.add', 'Add library')}
            </Button>
          </div>
        </CardHeader>

        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          {t(
            'libraries.hint',
            'A library is a WebDAV origin plus a folder inside it. Subsonic clients see each library as a music folder.',
          )}
        </p>

        {creating && <LibraryForm busy={busy === 'create'} onSubmit={submitCreate} onCancel={() => setCreating(false)} />}

        {libraries === null ? (
          <LoadingSpinner label={t('libraries.loading', 'Loading libraries')} />
        ) : libraries.length === 0 ? (
          <EmptyState
            icon={<HardDrive className="h-6 w-6 text-[var(--color-text-muted)]" aria-hidden="true" />}
            title={t('libraries.empty', 'No libraries yet')}
            description={t('libraries.emptyHint', 'Register a WebDAV origin to give Subsonic clients something to browse.')}
          />
        ) : (
          <ul className="space-y-2">
            {libraries.map((library) => (
              <LibraryRow
                key={library.id}
                library={library}
                busy={busy === library.id}
                editing={editingId === library.id}
                onEdit={() => setEditingId(library.id)}
                onEditDone={() => setEditingId(null)}
                onEditSubmit={submitEdit}
                onRun={run}
                onDelete={() =>
                  void run(
                    library.id,
                    async () => {
                      await deleteLibrary(library.id);
                      return undefined;
                    },
                    t('libraries.deleted', 'Library deleted.'),
                  )
                }
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export { LibrariesView };
export default LibrariesView;
