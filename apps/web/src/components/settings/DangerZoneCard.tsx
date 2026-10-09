import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { TypeToConfirmModal } from '../modals/TypeToConfirmModal';
import {
  confirmPhraseForAll,
  confirmPhraseForLibrary,
  describeAllDrop,
  describeDropCost,
  describeDropOutageRisk,
  describeLibraryDrop,
} from '../../lib/indexDrop';
import type { LibraryIndexStats } from '../../types';

/**
 * The Danger Zone: drop a scanned index, keeping the library registered.
 *
 * ### Why this is its own page and not a row on the libraries page
 *
 * Because the action is **global in consequence and per-library in scope**. A row-level
 * "Drop index" button would sit beside `Delete` on every library, and the two differ in the
 * one way an operator most needs to know: `Delete` takes the registration **and** the encrypted
 * WebDAV password with it, while a drop leaves both. Two destructive buttons of different
 * severity, identical colour, identical single click, side by side, is how the wrong one gets
 * pressed.
 *
 * Separating them onto a page reached deliberately — `/settings`, not the default route — is
 * what makes the first click mean anything. The libraries page is where an operator goes to
 * look at their music; this is where they go to destroy it.
 *
 * ### Why there is no per-library picker and two actions instead
 *
 * Both were considered and the two-action shape won for a specific reason: a picker puts the
 * destructive choice inside a control that also serves a non-destructive reading, and a
 * forgotten dropdown is a drop of whichever library happened to be selected. Two explicitly
 * separate buttons, each with its own phrase, cannot be confused for each other.
 *
 * ### What the confirmation actually guarantees
 *
 * Two gates, and the second one is the load-bearing half:
 *
 * 1. The `Button variant="danger"` arms the dialog.
 * 2. `TypeToConfirmModal` keeps its confirm button **disabled** until the operator has typed
 *    the library's slug — or, for the global drop, the literal `drop-all-index`.
 *
 * The cost figures are rendered *inside* the dialog and above the input, because the number is
 * the reason to read it. A large drop can spend most of a day's row-write allowance, and past
 * that D1 refuses every query until midnight UTC — so this is not only an irreversible action
 * but one with a blast radius wider than the index. The dialog says so rather than leaving an
 * operator to find out from a 503 an hour later.
 *
 * ### Why the annotations are not offered
 *
 * Not a gap. They have **no foreign key** to `songs` and hold song ids as derived strings, so
 * a rescan re-attaches every star, play count and playlist entry to the row it belonged to.
 * Dropping them too would spend more billed rows to destroy listening history a rescan restores
 * for free — and the dialog says they are kept, because a dialog that understates its scope is
 * the failure that trains operators to confirm without reading.
 */
function DangerZoneCard({
  libraries,
  stats,
  dropping,
  onDropLibrary,
  onDropAll,
}: {
  /**
  The registered libraries, for naming which one a row is about.
  */
  readonly libraries: ReadonlyArray<{ readonly id: string; readonly slug: string; readonly displayName: string | null }>;
  /**
  Per-library and total costs, from `GET /user/index/stats`. `null` while it is in flight.
  */
  readonly stats: ReadonlyArray<LibraryIndexStats> | null;
  /**
  The library id whose drop is in flight, or `'all'`, or `null`.
  */
  readonly dropping: string | null;
  readonly onDropLibrary: (libraryId: string) => Promise<void>;
  readonly onDropAll: () => Promise<void>;
}) {
  const { t } = useTranslation();
  /**
   * Which dialog is open: a library id, or the literal `'all'`.
   *
   * One key rather than a boolean per row, so opening a second dialog **replaces** the first
   * rather than stacking two portals on top of each other, and so the armed state is a single
   * value that cannot be half set. `'all'` cannot collide with a library id because those are
   * UUIDs.
   */
  const [armed, setArmed] = useState<string | null>(null);

  const statsFor = (libraryId: string): LibraryIndexStats | null => stats?.find((entry) => entry.libraryId === libraryId) ?? null;

  const armedAll = armed === 'all';
  /**
   * The armed library, or `null`.
   *
   * Looked up rather than stored, so a library removed between arming and rendering yields
   * `null` and renders no dialog — the alternative is a modal confirming the destruction of a
   * library the page no longer lists, whose phrase names a slug nothing on screen mentions.
   */
  const armedLibrary = armed === null || armedAll ? null : (libraries.find((candidate) => candidate.id === armed) ?? null);

  const totalSongs = stats?.reduce((sum, entry) => sum + entry.songs, 0) ?? 0;
  const totalNodes = stats?.reduce((sum, entry) => sum + entry.nodes, 0) ?? 0;
  const total = stats === null || stats.length === 0 ? null : stats.reduce((sum, entry) => sum + entry.billedRows, 0);

  /**
   * Run a drop, then close the dialog on the way out — including on failure.
   *
   * The close is in a `finally` rather than after the `await` because a failed drop leaves the
   * operator staring at a dialog whose confirm button re-enables behind an error notice, with
   * the input still holding what they typed. Re-opening it would re-read the stats, which is
   * the useful next action either way, and a `catch` that re-throws for the notice is the
   * `run` pattern `LibrariesView` already uses.
   */
  const run = async (action: () => Promise<void>) => {
    setArmed(null);
    await action();
  };

  return (
    <Card className="border-[var(--color-error-text)]/40">
      <CardHeader>
        <CardTitle>{t('danger.title', 'Danger zone')}</CardTitle>
      </CardHeader>

      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          {t(
            'danger.intro',
            'Dropping an index empties it without unregistering the library, so a rescan can rebuild it from scratch. Registrations, WebDAV passwords, stars, play counts and playlists are all kept.',
          )}
        </p>

        {libraries.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">{t('danger.noLibraries', 'No libraries registered yet.')}</p>
        ) : (
          libraries.map((library) => {
            const entry = statsFor(library.id);
            const name = library.displayName ?? library.slug;
            return (
              <div key={library.id} className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">{name}</p>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    {t('danger.dropOneLibrary', 'Delete this library’s scanned index')}
                  </p>
                  {/*
                    The count, rendered under the row rather than only in the dialog.

                    A number an operator has to open a modal to see is a number they consent to
                    without. `songCount` is what a drop removes, and a library showing 0 indexed
                    has nothing to drop — so the button stays enabled and the dialog says 0,
                    because the alternative is a disabled control whose reason is not on screen.
                  */}
                  <p className="text-xs text-[var(--color-text-muted)] mt-1">
                    {entry === null
                      ? t('danger.readingCost', 'Reading what this would cost…')
                      : t('danger.currentSize', '{{songs}} tracks indexed.', { songs: entry.songs })}
                  </p>
                </div>
                <Button variant="danger" size="sm" loading={dropping === library.id} onClick={() => setArmed(library.id)}>
                  {t('danger.dropIndex', 'Drop index')}
                </Button>
              </div>
            );
          })
        )}

        {/*
          The global action, below a rule and separated from the per-library rows.

          The separation is the whole argument for having two actions rather than one with a
          picker: a button that clears every library's index should not be visually adjacent to
          one that clears a single one, and the `border-t` is what makes the scope change
          visible without reading either label.
        */}
        {libraries.length > 0 && (
          <div className="flex items-center justify-between gap-3 flex-wrap border-t border-[var(--color-border)] pt-4">
            <div>
              <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('danger.dropEverything', 'Drop every index')}</p>
              <p className="text-sm text-[var(--color-text-secondary)]">
                {t('danger.dropEverythingDescription', 'Empties every registered library at once. Registrations are kept.')}
              </p>
              {total !== null && (
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  {/* Pluralised through its own key rather than a ternary here: "1 libraries" is
                      the sentence a `count`-only template produces, and this row is the one place
                      an operator reads a library count before consenting to empty all of them. */}
                  {libraries.length === 1
                    ? t('danger.everythingSizeOne', '{{songs}} tracks.', { songs: totalSongs })
                    : t('danger.everythingSizeMany', '{{songs}} tracks across {{count}} libraries.', {
                        songs: totalSongs,
                        count: libraries.length,
                      })}
                </p>
              )}
            </div>
            <Button variant="danger" size="sm" loading={dropping === 'all'} onClick={() => setArmed('all')}>
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              {t('danger.dropEverythingAction', 'Drop every index')}
            </Button>
          </div>
        )}
      </div>

      {/*
        One dialog, rendered for whichever action armed it.

        Both are unmounted when `armed` is `null`, so a typed phrase cannot survive into the
        next confirmation — a phrase left in a field is a phrase one click from re-submitting.
        `armedAll` is split out rather than branching inline because a ternary holding a JSX
        tree this size is the shape where the `null` arm for a library that disappeared
        between arming and rendering goes unread.
      */}
      {armedAll && (
        <TypeToConfirmModal
          title={t('danger.confirmAllTitle', 'Drop every index')}
          description={describeAllDrop(t, libraries.length)}
          expectedName={confirmPhraseForAll()}
          confirmLabel={t('danger.confirmAllAction', 'Drop every index')}
          loading={dropping === 'all'}
          cost={<DropCost songs={totalSongs} nodes={totalNodes} total={total ?? 0} />}
          onConfirm={() => void run(onDropAll)}
          onCancel={() => setArmed(null)}
        />
      )}
      {armedLibrary !== null && (
        <TypeToConfirmModal
          title={t('danger.confirmOneTitle', 'Drop index')}
          description={describeLibraryDrop(t, armedLibrary.slug)}
          expectedName={confirmPhraseForLibrary(armedLibrary.slug)}
          confirmLabel={t('danger.dropIndex', 'Drop index')}
          loading={dropping === armedLibrary.id}
          cost={
            <DropCost
              songs={statsFor(armedLibrary.id)?.songs ?? 0}
              nodes={statsFor(armedLibrary.id)?.nodes ?? 0}
              total={statsFor(armedLibrary.id)?.billedRows ?? 0}
            />
          }
          onConfirm={() => void run(() => onDropLibrary(armedLibrary.id))}
          onCancel={() => setArmed(null)}
        />
      )}
    </Card>
  );
}

/**
 * What the confirmation says the action costs.
 *
 * Its own component so both dialogs render the same block from the same two functions — the
 * global figure and the per-library figure are the same sentence with different numbers, and a
 * dialog that described them differently would be two claims about one cost.
 *
 * The outage sentence is **not** gated on the size. It reads as alarmist on a library of nine
 * tracks and it is still true: the allowance is per account, other libraries share it, and
 * whether today's scan has already spent half of it is not knowable from here.
 */
function DropCost({ songs, nodes, total }: { songs: number; nodes: number; total: number }) {
  const { t } = useTranslation();
  return (
    <div className="mb-4 rounded-lg border border-[var(--color-error-text)]/30 bg-[var(--color-error-bg)]/40 p-3">
      <p className="text-xs text-[var(--color-text-primary)]">{describeDropCost(t, { songs, nodes, billedRows: total })}</p>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{describeDropOutageRisk(t)}</p>
    </div>
  );
}

export { DangerZoneCard };
