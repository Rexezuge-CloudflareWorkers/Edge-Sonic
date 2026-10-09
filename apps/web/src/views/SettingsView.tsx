import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { LoadingSpinner } from '../components/layout/PageState';
import { DangerZoneCard } from '../components/settings/DangerZoneCard';
import { dropAllIndexes, dropLibraryIndex, indexStats, listLibraries } from '../services/libraryService';
import { describeDropped } from '../lib/indexDrop';
import type { ShowNotice } from '../hooks/useNotice';
import type { IndexStats, LibrarySummary } from '../types';

/**
 * `/settings` — the Danger Zone, and nothing else yet.
 *
 * ### Why this is its own route rather than a section on the libraries page
 *
 * Because the action is **global in consequence** — a large drop can spend the deployment's
 * whole daily row-write allowance, and past that D1 refuses every query until midnight UTC,
 * reads included — while the libraries page is the page an operator opens to look at their
 * music. Putting a control with that blast radius on the page people browse would make the
 * browsing dangerous.
 *
 * It is a separate `SPA_ROUTES` entry in `EdgeSonicWorker` as well as a `<Route>` here, because
 * a browser navigating to a client-side route sends no API call for the worker to
 * authenticate: a route missing from that list answers 404 to anyone who bookmarked or shared
 * it while working perfectly for whoever typed it into a loaded tab. The two lists are one
 * decision written twice and `test/worker.int.test.ts` compares them as source text.
 *
 * ### Why the page loads the library list *and* the stats
 *
 * Two calls where one would do, and the split is deliberate. `GET /user/libraries` carries each
 * library's name, slug and `songCount`, which is what the rows render and what tells an
 * operator whether there is anything to drop at all. `GET /user/index/stats` carries the
 * **billed-row projection**, which is the figure the confirmation quotes — and it has to be the
 * server's figure, computed with the same `billedRowsForTable` that will charge the delete.
 *
 * Reading the projection off `songCount` would mean multiplying by ten in the browser, and that
 * multiplication is a copy of a per-table table this layer cannot see, in the one place nothing
 * would catch it being wrong.
 *
 * ### The two-call shape is also what makes a failed stats read survivable
 *
 * A failed **load** renders the documented "empty list plus a notice" — the operator can still
 * read what is registered. A failed **stats** read leaves the rows and their track counts in
 * place with the cost reading blank, because the destructive controls are still correct: the
 * dialog would quote `0` for an unreadable projection, which is wrong in the safe direction and
 * is corrected by the server refusing a projection it cannot produce.
 *
 * So the cost line renders "reading…" rather than a zero. A zero there would read as "this
 * costs nothing", and an operator would confirm a 50,000-row drop having been told it was free.
 */
function SettingsView({ showNotice }: { showNotice: ShowNotice }) {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<LibrarySummary[] | null>(null);
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);

  /**
   * Guards the two `await`ing handlers below.
   *
   * A drop is three round trips — stats read, `DELETE`, notice — against a database that may be
   * mid-refusal, so a drop can outlive the navigation that started it. `LibrariesView`'s
   * `LibraryRow` records this in a comment worth repeating: `react-hooks/recommended-latest`
   * is `exhaustive-deps`, `rules-of-hooks` and `set-state-in-effect`, and **none** of them
   * detects a `setState` after an `await` in an event handler. There is no lint rule here.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Read the registered libraries, then the cost projection.
   *
   * Sequential rather than `Promise.all` because the second call's answer is scoped to the
   * first's ids, and issuing them together would spend a statement on ids the projection then
   * has to filter. On a deployment where the first read fails the second is not issued at all,
   * which is the difference between one failed request and two against a spent allowance.
   *
   * It **returns** what it read rather than setting state, and the effect below adopts it. That
   * is not a style choice: a `load` that also called `setState` would have to close over the
   * state it sets in order to build its own stale fallback, which makes every poll re-create
   * the effect that depends on it — so a timer's lifetime ends up decided by the data it
   * fetched. `LibrariesView`'s `poll` records the same lesson in a comment after it shipped.
   */
  const load = useCallback(async (): Promise<{ libraries: LibrarySummary[]; stats: IndexStats | null }> => {
    let loaded: LibrarySummary[];
    try {
      ({ libraries: loaded } = await listLibraries());
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error));
      // The documented "empty list plus a notice", rather than an error screen: the operator can
      // still read what is registered, and the notice says what went wrong.
      return { libraries: [], stats: null };
    }
    try {
      return { libraries: loaded, stats: await indexStats() };
    } catch {
      // A failed projection leaves `stats` **null**, and null renders as "reading what this
      // would cost…" rather than as a zero. That is the load-bearing part: a zero there would
      // read as "this costs nothing", and an operator would confirm a 50,000-row drop having
      // been told it was free. The rows and the controls stay correct either way, so the page
      // does not blank — and this is the one deliberate silent `catch` on this surface, for
      // the same reason `lib/probe.ts` swallows an unreadable answer.
      return { libraries: loaded, stats: null };
    }
  }, [showNotice]);

  useEffect(() => {
    /**
     * `cancelled` rather than `alive`, and **both** flags exist on purpose.
     *
     * `cancelled` is the effect form: only the effect knows when the component goes away, so it
     * owns the guard and returns it from its cleanup. `alive` is for the two event handlers
     * below, which have no cleanup to return — `set-state-in-effect` does not catch an
     * un-guarded `setState` after an `await` in a handler, so they need the ref.
     *
     * The effect also does not call `setState` synchronously: `load` **returns** what it read and
     * the effect adopts it, which is `LibrariesView`'s shape and the reason `load` there is a
     * separate `useCallback` from the effect that runs it. Calling a state-setting function
     * straight from an effect body cascades a render, which is what
     * `react-hooks/set-state-in-effect` reports.
     */
    let cancelled = false;
    void load().then((next) => {
      if (cancelled) return;
      setLibraries(next.libraries);
      setStats(next.stats);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  /**
   * Read the projection again after a drop.
   *
   * Not `load()` in full: the library list is unchanged by a drop — that is the point of it —
   * and re-reading it would spend a request out of the same 60-per-minute bucket every other
   * operator action on this surface shares. Only the numbers moved.
   */
  const refreshStats = useCallback(async () => {
    try {
      const projection = await indexStats();
      if (alive.current) setStats(projection);
    } catch {
      // A failed re-read leaves the previous figures on screen, which are now wrong. The
      // notice the drop raised says what was measured, so the stale figure is not the only
      // number the operator has; and the next navigation re-reads it.
    }
  }, []);

  const dropLibrary = useCallback(
    async (libraryId: string) => {
      setDropping(libraryId);
      try {
        const result = await dropLibraryIndex(libraryId);
        if (!alive.current) return;
        showNotice('success', describeDropped(t, result.songs, result.libraries, result.billedRows));
        await refreshStats();
      } catch (error) {
        if (alive.current) showNotice('error', error instanceof Error ? error.message : String(error));
      } finally {
        if (alive.current) setDropping(null);
      }
    },
    [refreshStats, showNotice, t],
  );

  const dropEverything = useCallback(async () => {
    setDropping('all');
    try {
      const result = await dropAllIndexes();
      if (!alive.current) return;
      showNotice('success', describeDropped(t, result.songs, result.libraries, result.billedRows));
      await refreshStats();
    } catch (error) {
      if (alive.current) showNotice('error', error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) setDropping(null);
    }
  }, [refreshStats, showNotice, t]);

  if (libraries === null) {
    return <LoadingSpinner label={t('danger.loading', 'Loading settings')} />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.title', 'Settings')}</CardTitle>
        </CardHeader>
        <p className="text-sm text-[var(--color-text-secondary)]">{t('settings.intro', 'Operational controls for this deployment.')}</p>
      </Card>

      <DangerZoneCard
        libraries={libraries.map((library) => ({ id: library.id, slug: library.slug, displayName: library.displayName }))}
        stats={stats?.libraries ?? null}
        dropping={dropping}
        onDropLibrary={(libraryId) => dropLibrary(libraryId)}
        onDropAll={() => dropEverything()}
      />
    </div>
  );
}

export { SettingsView };
export default SettingsView;
