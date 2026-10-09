import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Input, Label } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { EmptyState, LoadingSpinner } from '../components/layout/PageState';
import { PhaseRow } from '../components/import/RunReport';
import {
  IMPORT_PHASES,
  IMPORT_PHASE_LABELS,
  createImportSource,
  deleteImportSource,
  listImports,
  listImportSources,
  readImport,
  startImport,
} from '../services/importService';
import { listUsers } from '../services/userService';
import type { ShowNotice } from '../hooks/useNotice';
import type { ImportPhase, ImportRunSummary, ImportSourceSummary, PhaseReport, UserSummary } from '../types';

/**
How often a running import re-reads its report.
*/
const POLL_INTERVAL_MS = 4000;

/**
 * One load's worth of everything, so a caller can decide what to do with it.
 *
 * Module-level rather than declared inside the component, for the reason `apps/web/AGENTS.md`
 * gives for `lib/` over components: a decision inside a component is a decision with no test.
 * `load` answering `null` on failure and this carrying success is a distinction the poll *acts*
 * on, so it is stated in a type rather than implied by a shape.
 */
interface Loaded {
  readonly sources: ImportSourceSummary[];
  readonly runs: ImportRunSummary[];
  readonly users: UserSummary[];
}

/**
 * Importing player data from another Subsonic server.
 *
 * ### Why the phase list is checkboxes and not a single "Import" button
 *
 * Because the categories cost wildly different amounts and recover differently. Playlists are
 * most of a Free account's daily row-write allowance; the play queue is one call; play counts
 * are an unbounded walk that runs for days. An operator who cannot see that cannot choose, and
 * the choice they make is the one this page exists to collect.
 *
 * ### Why the play queue is **off** by default
 *
 * A saved queue is transient state. The person who has just moved servers does not want
 * yesterday's half-finished queue restored, and a default-on would import it without anybody
 * deciding to. It is one checkbox to opt into and it says what it does.
 *
 * ### A failed poll keeps the list, and marks it stale
 *
 * Same rule as the libraries page, and for the same reason inverted: an unreachable API renders
 * as an **empty list plus a notice** — the one sentence on this page meaning something is
 * genuinely absent — so a failed poll holds what it had and says the figures may be old. The
 * poll is unattended, and "no imports yet" every four seconds is worse than a stale list.
 */
function ImportView({ showNotice }: { showNotice: ShowNotice }) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<ImportSourceSummary[] | null>(null);
  const [runs, setRuns] = useState<ImportRunSummary[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [selected, setSelected] = useState<ImportRunSummary | null>(null);
  const [detail, setDetail] = useState<readonly PhaseReport[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', baseUrl: '', username: '', password: '' });
  const [target, setTarget] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [phases, setPhases] = useState<readonly ImportPhase[]>(IMPORT_PHASES.filter((name) => name !== 'playQueue'));

  /**
   * The one fetch, and it returns its result rather than setting state.
   *
   * A `load` that both fetched and called `setState` had to close over the state it sets in order
   * to build its own stale fallback — which made every poll re-create the effect that depends on
   * it, so a timer's lifetime was decided by the data it fetched. Returning the value and letting
   * the caller apply it is what keeps `load` a **pure read**, and it is the shape
   * `LibrariesView.load` already has.
   *
   * `null` on failure rather than a partial value, because the caller must be able to tell
   * "nothing to show" from "could not ask" — the distinction the `stale` line exists to carry.
   */
  const load = useCallback(async (): Promise<Loaded | null> => {
    try {
      const [sourceList, runList, userList] = await Promise.all([listImportSources(), listImports(), listUsers()]);
      return { sources: sourceList.sources, runs: runList.runs, users: userList.users };
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [showNotice]);

  /**
   * Apply a load, or mark the page stale.
   *
   * **Stale, not emptied** — the one rule this page's poll turns on. An unreachable API renders
   * as an *empty list plus a notice*, which is the right answer for a **load** and wrong for an
   * unattended poll: folding the failure in would blank the page every few seconds and turn "No
   * imports yet" into a sentence meaning something is genuinely absent.
   */
  const apply = useCallback((loaded: Loaded | null): void => {
    if (loaded === null) {
      setStale(true);
      return;
    }
    setStale(false);
    setSources(loaded.sources);
    setRuns(loaded.runs);
    setUsers(loaded.users);
    // Preselect the first source and first user, because a form with two empty required fields
    // and one button reads as broken rather than as a form.
    setSourceId((current) => current || loaded.sources[0]?.id || '');
    setTarget((current) => current || loaded.users[0]?.id || '');
  }, []);

  const reload = useCallback(async () => {
    apply(await load());
  }, [apply, load]);

  useEffect(() => {
    // `cancelled` is what the effect needs and `load` could not provide: a component unmounted
    // mid-fetch must not set state, and React 18 turns that into a silent leak rather than a
    // warning. It also stops a slow first response from overwriting a faster refresh the user
    // triggered in the meantime. Copied from `LibrariesView` rather than invented.
    let cancelled = false;
    void load().then((loaded) => {
      if (!cancelled) apply(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [load, apply]);

  // The poll only runs while something is going, and only for the row that is open — a page
  // refreshing every four seconds forever would spend an operator's D1 reads on nothing.
  useEffect(() => {
    const running = runs.some((run) => run.status === 'running' || run.status === 'paused');
    if (!running && detail === null) return;
    const timer = setInterval(() => {
      // Through `apply`, so the poll and the initial load make the **same** decision about a
      // failure. A poll that handled it itself is a second answer — and this page's one rule is
      // that a failed poll keeps the list and marks it stale.
      void load().then((loaded) => {
        apply(loaded);
        if (selected !== null) void readImport(selected.id).then((run) => setDetail(run.report?.phases ?? []));
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [runs, selected, detail, load, apply]);

  const submitSource = async () => {
    setBusy('source');
    try {
      await createImportSource(draft);
      showNotice('success', t('import.sourceAdded', 'Import source added.'));
      setAdding(false);
      setDraft({ name: '', baseUrl: '', username: '', password: '' });
      await reload();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const submitImport = async () => {
    if (sourceId === '' || target === '') return;
    setBusy('import');
    try {
      await startImport({ sourceId, targetUserId: target, phases });
      showNotice('success', t('import.started', 'Import started.'));
      await reload();
    } catch (error) {
      // The server's refusal is the useful part here: "the scan is running" and "that user has
      // no library" both arrive as a message written for this page, so it is shown rather than
      // collapsed into "failed".
      showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const openRun = async (run: ImportRunSummary) => {
    setSelected(run);
    try {
      const full = await readImport(run.id);
      setDetail(full.report?.phases ?? []);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
    }
  };

  // A **conditional render**, not an early `return`, and that is the shape `LibrariesView` uses.
  //
  // Beyond matching the neighbouring view: a bare `return` halfway down a component makes every
  // declaration after it read as "before an early exit", and the next author moves one up
  // without noticing they have crossed the boundary that makes it unreachable. One expression,
  // no branch, nothing to cross.
  return sources === null ? (
    <LoadingSpinner />
  ) : (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('import.title', 'Import from another server')}</CardTitle>
          <Button variant="secondary" onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('common.refresh', 'Refresh')}
          </Button>
        </CardHeader>
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('import.intro', 'Bring playlists, favourites, ratings, bookmarks and play counts across from another Subsonic server.')}
          </p>
          <p className="text-sm text-[var(--color-text-muted)]">
            {t(
              'import.pauseNotice',
              'An import pauses the library scan while it runs, so the two do not compete for the daily write allowance.',
            )}
          </p>
          <p className="text-sm text-[var(--color-text-muted)]">
            {t(
              'import.matchNotice',
              'Songs are matched by their path first, then by album and title. Anything that cannot be matched is listed below rather than dropped.',
            )}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('import.sources', 'Where from')}</CardTitle>
          <Button onClick={() => setAdding((value) => !value)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('import.addSource', 'Add a server')}
          </Button>
        </CardHeader>
        {adding && (
          <div className="mb-4 space-y-3 rounded-md border border-[var(--color-border)] p-4">
            <div>
              <Label htmlFor="import-source-name">{t('import.sourceName', 'Name')}</Label>
              <Input
                id="import-source-name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="My old server"
              />
            </div>
            <div>
              <Label htmlFor="import-source-url">{t('import.sourceUrl', 'Server URL')}</Label>
              <Input
                id="import-source-url"
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                placeholder="https://music.example.com/sonic"
              />
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {t('import.sourceUrlHint', 'Include the path if the server is behind a reverse proxy, e.g. /sonic.')}
              </p>
            </div>
            <div>
              <Label htmlFor="import-source-user">{t('import.sourceUsername', 'Username on that server')}</Label>
              <Input
                id="import-source-user"
                value={draft.username}
                onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="import-source-pass">{t('import.sourcePassword', 'Password')}</Label>
              <Input
                id="import-source-pass"
                type="password"
                value={draft.password}
                onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                autoComplete="off"
              />
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                {t('import.sourcePasswordHint', 'Stored encrypted and never shown again.')}
              </p>
            </div>
            <Button onClick={() => void submitSource()} disabled={busy === 'source'}>
              {t('common.save', 'Save')}
            </Button>
          </div>
        )}
        {sources.length === 0 ? (
          <EmptyState
            title={t('import.noSources', 'No import sources yet')}
            description={t('import.noSourcesDescription', 'Add the server you are moving from to begin.')}
          />
        ) : (
          <ul className="space-y-2">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] py-2 last:border-b-0"
              >
                <div>
                  <span className="text-sm text-[var(--color-text-primary)]">{source.name}</span>
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                    {source.baseUrl} · {source.username}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" onClick={() => setSourceId(source.id)}>
                    {t('import.use', 'Use')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setBusy(`delete:${source.id}`);
                      void deleteImportSource(source.id)
                        .then(() => reload())
                        .catch((error: unknown) => showNotice('error', error instanceof Error ? error.message : String(error)))
                        .finally(() => setBusy(null));
                    }}
                    disabled={busy === `delete:${source.id}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    {t('common.delete', 'Delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('import.start', 'Start an import')}</CardTitle>
        </CardHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="import-target">{t('import.targetUser', 'Import into which account')}</Label>
            <select
              id="import-target"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">{t('import.chooseUser', 'Choose an account')}</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.username}
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-[var(--color-text-primary)]">{t('import.phases', 'What to bring across')}</legend>
            <div className="mt-2 space-y-1">
              {IMPORT_PHASES.map((name) => (
                <label key={name} className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={phases.includes(name)}
                    onChange={(event) =>
                      setPhases((current) => (event.target.checked ? [...current, name] : current.filter((entry) => entry !== name)))
                    }
                  />
                  {IMPORT_PHASE_LABELS[name]}
                  {name === 'playQueue' && (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {t('import.playQueueHint', '— off by default; it restores a half-finished queue.')}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </fieldset>
          <Button
            onClick={() => void submitImport()}
            disabled={busy === 'import' || sourceId === '' || target === '' || phases.length === 0}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            {t('import.startButton', 'Start import')}
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('import.runs', 'Recent imports')}</CardTitle>
        </CardHeader>
        {stale && (
          <p className="mb-2 text-xs text-[var(--color-text-warning)]">
            {t('import.stale', 'Could not reach the server — these figures may be out of date.')}
          </p>
        )}
        {runs.length === 0 ? (
          <EmptyState
            title={t('import.noRuns', 'No imports yet')}
            description={t('import.noRunsDescription', 'Imports you run will be listed here with anything they could not match.')}
          />
        ) : (
          <ul className="space-y-1">
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] py-2 text-left last:border-b-0"
                  onClick={() => void openRun(run)}
                >
                  <span className="text-sm text-[var(--color-text-primary)]">
                    {run.sourceName ?? t('import.unknownSource', 'Unknown source')}
                    {run.targetUsername === null ? '' : ` → ${run.targetUsername}`}
                  </span>
                  <Badge variant={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : 'warning'}>
                    {run.status}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected !== null && detail !== null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('import.detail', 'What happened')}</CardTitle>
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setDetail(null);
              }}
            >
              {t('common.close', 'Close')}
            </Button>
          </CardHeader>
          {detail.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">{t('import.noDetail', 'Nothing has been recorded yet.')}</p>
          ) : (
            detail.map((report) => <PhaseRow key={report.phase} report={report} />)
          )}
        </Card>
      )}
    </div>
  );
}

export default ImportView;
// Re-exported so a test can reach the reason mapping without rendering the view. `apps/web` has
// no component tests in the root suite, and this is the decision in this feature.

export { UnresolvedRow, reasonText, PhaseRow } from '../components/import/RunReport';
