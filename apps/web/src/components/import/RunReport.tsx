/**
 * What one import actually did, and everything it could not.
 *
 * ### Why this is its own component and not part of the view
 *
 * Because {@link reasonText} is a **decision** — it maps a machine reason onto the words an operator
 * acts on — and `apps/web/AGENTS.md`'s standing rule is that a decision inside a component is a
 * decision with no test. It lives beside the two components that render it rather than in `lib/`,
 * because it is not a free function of arguments: it exists to be rendered, and moving it away
 * from both renderers would put the reason next to neither.
 *
 * ### And the unresolved list is always rendered, never summarised to a count
 *
 * A count tells an operator the size of a problem and nothing about what it is. The list tells them
 * which three tracks, which is the only thing they can act on — and the server's cap
 * (`MAX_REPORTED_UNRESOLVED`) is what bounds it, so this renders the names it was given rather than
 * inventing a threshold of its own that could disagree with the server's.
 */
import { useTranslation } from 'react-i18next';
import { Badge } from '../ui/Badge';
import type { PhaseReport, UnresolvedItem } from '../../types';

/**
 * Why an item did not resolve, in words an operator can act on.
 *
 * `ambiguous` is **not** a variant of `not-found` and must not read like one: it means two local
 * tracks matched, so the remedy is to say which one was meant, whereas a missing track needs a
 * rescan or the tag fixed. Collapsing them into "not found" would send somebody to index a
 * library that already holds the album.
 */
function reasonText(reason: UnresolvedItem['reason']): string {
  if (reason === 'ambiguous') return 'matched more than one local track';
  if (reason === 'no-metadata') return 'the remote published no path, album or title to match on';
  return 'not in this library';
}

/**
One unresolved item, with its reason attached rather than implied by a count.
*/
function UnresolvedRow({ item }: { item: UnresolvedItem }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-col gap-0.5 border-b border-[var(--color-border)] py-2 last:border-b-0">
      <span className="text-sm text-[var(--color-text-primary)]">{item.label}</span>
      <span className="text-xs text-[var(--color-text-muted)]">
        {item.context} · {t('import.reason', 'not matched')}: {reasonText(item.reason)}
      </span>
    </li>
  );
}

/**
 * One phase's outcome.
 *
 * The unresolved list is **always rendered**, never summarised to a count. A count tells an
 * operator the size of a problem and nothing about what it is; the list tells them which three
 * tracks, which is the only thing they can act on.
 */
function PhaseRow({ report }: { report: PhaseReport }) {
  const { t } = useTranslation();
  // `variant`, not `tone`: `Badge` is a cva and its variant names are the tones. `error` rather
  // than `danger` for the same reason — the name is the token.
  const variant =
    report.status === 'failed'
      ? 'error'
      : report.status === 'partial'
        ? 'warning'
        : report.status === 'imported'
          ? 'success'
          : 'neutral';
  return (
    <div className="border-b border-[var(--color-border)] py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">{report.phase}</span>
        <div className="flex items-center gap-2">
          {report.unresolvedCount > 0 && (
            <span className="text-xs text-[var(--color-text-muted)]">
              {t('import.unresolvedCount', '{{count}} not matched', { count: report.unresolvedCount })}
            </span>
          )}
          <Badge variant={variant}>{report.status}</Badge>
        </div>
      </div>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        {t('import.importedCount', '{{count}} imported', { count: report.imported })} ·{' '}
        {t('import.rowsWritten', '{{count}} rows written', { count: report.rowsWritten })}
      </p>
      {report.lastError !== null && <p className="mt-1 text-xs text-[var(--color-text-warning)]">{report.lastError}</p>}
      {report.unresolved.length > 0 && (
        <ul className="mt-2">
          {report.unresolved.map((item: UnresolvedItem) => (
            <UnresolvedRow key={`${report.phase}:${item.remoteId}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

export { PhaseRow, UnresolvedRow, reasonText };
