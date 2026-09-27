import { useCallback, useEffect, useState } from 'react';
import { t } from 'i18next';
import { HardDrive, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button, Input, Label } from '../components/ui/controls';
import { Badge, Card, CardHeader, CardTitle, LoadingSpinner, PageState } from '../components/ui/panels';
import { createLibrary, deleteLibrary, libraryScanStatus, listLibraries, probeLibrary, startLibraryScan } from '../lib/api';
import type { LibrarySummary, Notice } from '../types';

/**
 * The library registry.
 *
 * Registration is where an operator points Edge-Sonic at a WebDAV bucket, and the
 * two fields that most often go wrong are the URL shape and the root path — so both
 * are labelled with the shape they must take rather than just their names. The
 * server validates both again; this only saves a round trip.
 */
function LibrariesView({ showNotice }: { showNotice: (notice: Notice) => void }) {
  const [libraries, setLibraries] = useState<LibrarySummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ slug: '', baseUrl: '', rootPath: '/', davUsername: '', davPassword: '', displayName: '' });

  const reload = useCallback(async () => {
    try {
      const { libraries: loaded } = await listLibraries();
      setLibraries(loaded);
    } catch (error) {
      setLibraries([]);
      showNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }, [showNotice]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (id: string, action: () => Promise<unknown>, success: string) => {
    setBusy(id);
    try {
      await action();
      showNotice({ type: 'success', text: success });
      await reload();
    } catch (error) {
      showNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    setBusy('create');
    try {
      await createLibrary({
        slug: draft.slug,
        baseUrl: draft.baseUrl,
        rootPath: draft.rootPath,
        davUsername: draft.davUsername,
        davPassword: draft.davPassword,
        ...(draft.displayName.length > 0 ? { displayName: draft.displayName } : {}),
      });
      // The password is dropped from component state as soon as it is accepted, so
      // it does not linger in a React tree or in a devtools inspector.
      setDraft({ slug: '', baseUrl: '', rootPath: '/', davUsername: '', davPassword: '', displayName: '' });
      setCreating(false);
      showNotice({ type: 'success', text: t('libraries.created', 'Library registered.') });
      await reload();
    } catch (error) {
      showNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
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

        {creating && (
          <form
            className="mb-4 grid gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div>
              <Label htmlFor="slug">{t('libraries.field.slug', 'Slug')}</Label>
              <Input id="slug" required value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder="home" />
            </div>
            <div>
              <Label htmlFor="displayName">{t('libraries.field.displayName', 'Display name')}</Label>
              <Input id="displayName" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} placeholder="Home" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="baseUrl">{t('libraries.field.baseUrl', 'WebDAV origin')}</Label>
              <Input
                id="baseUrl"
                required
                type="url"
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="https://dav.example.com"
              />
            </div>
            <div>
              <Label htmlFor="rootPath">{t('libraries.field.rootPath', 'Root path inside the origin')}</Label>
              <Input id="rootPath" value={draft.rootPath} onChange={(e) => setDraft({ ...draft, rootPath: e.target.value })} placeholder="/remote.php/dav/files/alice/Music" />
            </div>
            <div>
              <Label htmlFor="davUsername">{t('libraries.field.davUsername', 'WebDAV username')}</Label>
              <Input id="davUsername" required value={draft.davUsername} onChange={(e) => setDraft({ ...draft, davUsername: e.target.value })} autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="davPassword">{t('libraries.field.davPassword', 'WebDAV password')}</Label>
              <Input id="davPassword" required type="password" value={draft.davPassword} onChange={(e) => setDraft({ ...draft, davPassword: e.target.value })} autoComplete="new-password" />
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit" variant="primary" loading={busy === 'create'}>
                {t('libraries.save', 'Save')}
              </Button>
              <Button onClick={() => setCreating(false)}>{t('libraries.cancel', 'Cancel')}</Button>
            </div>
          </form>
        )}

        {libraries === null ? (
          <LoadingSpinner label={t('libraries.loading', 'Loading libraries')} />
        ) : libraries.length === 0 ? (
          <PageState
            icon={<HardDrive className="h-6 w-6 text-[var(--color-text-muted)]" aria-hidden="true" />}
            title={t('libraries.empty', 'No libraries yet')}
            description={t('libraries.emptyHint', 'Register a WebDAV origin to give Subsonic clients something to browse.')}
          />
        ) : (
          <ul className="space-y-2">
            {libraries.map((library) => (
              <LibraryRow key={library.id} library={library} busy={busy === library.id} onRun={run} onDelete={() => void run(library.id, () => deleteLibrary(library.id), t('libraries.deleted', 'Library deleted.'))} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * One library, with the three actions an operator actually needs.
 *
 * `Test` and `Rescan` are separate because they answer different questions — "is
 * this reachable with these credentials" and "has the index caught up" — and
 * conflating them makes a failing probe look like a stale index.
 */
function LibraryRow({
  library,
  busy,
  onRun,
  onDelete,
}: {
  library: LibrarySummary;
  busy: boolean;
  onRun: (id: string, action: () => Promise<unknown>, success: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [probe, setProbe] = useState<string | null>(null);
  const [scan, setScan] = useState<string | null>(null);

  const test = async () => {
    setProbe('running');
    await onRun(library.id, async () => {
      const result = await probeLibrary(library.id);
      setProbe(result.ok ? 'ok' : 'failed');
    }, t('libraries.probed', 'Probe finished.'));
  };

  const rescan = async () => {
    setScan('running');
    await onRun(library.id, async () => {
      const started = await startLibraryScan(library.id);
      setScan(started.status);
      const current = await libraryScanStatus(library.id);
      setScan(current.status);
    }, t('libraries.scanStarted', 'Scan started.'));
  };

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">{library.displayName ?? library.slug}</span>
        <code className="rounded bg-[var(--color-surface-base)] px-1.5 py-0.5 text-xs text-[var(--color-text-muted)]">{library.slug}</code>
        {probe === 'ok' && <Badge variant="success">{t('libraries.reachable', 'reachable')}</Badge>}
        {probe === 'failed' && <Badge variant="error">{t('libraries.unreachable', 'unreachable')}</Badge>}
        {library.isEnabled ? null : <Badge variant="warning">{t('libraries.disabled', 'disabled')}</Badge>}
      </div>
      <p className="mt-1 truncate text-xs text-[var(--color-text-muted)]">
        {library.baseUrl}
        {library.rootPath}
      </p>
      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
        {t('libraries.davUser', 'WebDAV user')}: <code>{library.davUsername}</code>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" loading={busy} onClick={() => void test()}>
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          {t('libraries.test', 'Test')}
        </Button>
        <Button size="sm" loading={busy} onClick={() => void rescan()}>
          {t('libraries.rescan', 'Rescan')}
        </Button>
        {scan !== null && <span className="text-xs text-[var(--color-text-muted)]">scan: {scan}</span>}
        <Button size="sm" variant="danger" className="ml-auto" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('libraries.delete', 'Delete')}
        </Button>
      </div>
    </li>
  );
}

export { LibrariesView };
export default LibrariesView;
