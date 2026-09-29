import { useState } from 'react';
import { t } from 'i18next';
import { Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button } from './ui/controls';
import { LibraryForm } from './LibraryForm';
import { Badge } from './ui/panels';
import { libraryScanStatus, probeLibrary, startLibraryScan } from '../lib/api';
import type { LibraryDraft } from '../lib/libraryDraft';
import { describeProbe, describeScan } from '../lib/probe';
import type { LibrarySummary, Notice, ProbeResult } from '../types';

/**
 * Run a row action, then let the view refresh.
 *
 * The action may return a `Notice` to **replace** the success message. That is what
 * makes a diagnostic honest: `probeLibrary` resolves with `200 {ok: false}` rather
 * than throwing, so a runner that always reported success answered a failed probe
 * with a green "Probe finished." toast — the request had succeeded, and the
 * operator was told so, while the thing they asked about had not.
 */
type RunAction = (id: string, action: () => Promise<Notice | void>, success: string) => Promise<void>;

interface LibraryRowProps {
  readonly library: LibrarySummary;
  readonly busy: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onEditDone: () => void;
  readonly onEditSubmit: (id: string, draft: LibraryDraft) => void;
  readonly onRun: RunAction;
  readonly onDelete: () => void;
}

/**
 * One library, with the actions an operator actually needs.
 *
 * `Test` and `Rescan` are separate because they answer different questions — "is
 * this reachable with these credentials" and "has the index caught up" — and
 * conflating them makes a failing probe look like a stale index.
 *
 * ### The probe result is held whole, not as a boolean
 *
 * The server's classification is the only thing that separates a rejected
 * password from a blocked origin from a missing encryption key, and each has a
 * different fix. It used to be collapsed to `'ok' | 'failed'` and rendered as the
 * single word "unreachable", so a fault in this deployment and a typo in the
 * operator's password looked identical. `describeProbe` derives the badge and the
 * notice from the one result, so they cannot disagree.
 */
function LibraryRow({ library, busy, editing, onEdit, onEditDone, onEditSubmit, onRun, onDelete }: LibraryRowProps) {
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [scan, setScan] = useState<{ status: string; lastError: string | null } | null>(null);

  const test = async () => {
    setProbing(true);
    // Cleared first so a stale verdict from a previous click cannot sit next to a
    // new one while this is in flight.
    setProbe(null);
    await onRun(
      library.id,
      async () => {
        const result = await probeLibrary(library.id);
        setProbe(result);
        return describeProbe(result, {
          reachable: t('libraries.reachable', 'Reachable.'),
          probed: t('libraries.probedOk', 'The origin answered.'),
          failed: t('libraries.probeUnknownFailure', 'The probe failed.'),
        }).notice;
      },
      t('libraries.probed', 'Probe finished.'),
    );
    setProbing(false);
  };

  const rescan = async () => {
    await onRun(
      library.id,
      async () => {
        const started = await startLibraryScan(library.id);
        setScan({ status: started.status, lastError: started.lastError });
        const current = await libraryScanStatus(library.id);
        setScan({ status: current.status, lastError: current.lastError });
        return undefined;
      },
      t('libraries.scanStarted', 'Scan started.'),
    );
  };

  const presented = probe === null ? null : describeProbe(probe);
  const scanFailure = describeScan(scan?.lastError);

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">{library.displayName ?? library.slug}</span>
        <code className="rounded bg-[var(--color-surface-base)] px-1.5 py-0.5 text-xs text-[var(--color-text-muted)]">{library.slug}</code>
        {presented !== null && <Badge variant={presented.tone}>{presented.label}</Badge>}
        {library.isEnabled ? null : <Badge variant="warning">{t('libraries.disabled', 'disabled')}</Badge>}
      </div>
      {/*
        `break-all` rather than `truncate`: the origin and the root path are the two
        fields whose shape decides whether a probe can work at all, and truncating
        them hides a pasted path with a stray query string — which the server
        rejects outright.
      */}
      <p className="mt-1 break-all text-xs text-[var(--color-text-muted)]">
        {library.baseUrl}
        {library.rootPath}
      </p>
      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
        {t('libraries.davUser', 'WebDAV user')}: <code className="break-all">{library.davUsername}</code>
      </p>
      {/*
        The reason is rendered under the row as well as in the badge, because the
        notice is transient and a 401 read six seconds after the click is no help to
        whoever opens the page next. `break-words` because the server's answer is
        prose, not a status code.
      */}
      {presented !== null && presented.tone === 'error' && (
        <p className="mt-2 break-words text-xs text-[var(--color-error-text)]">{presented.label}</p>
      )}
      {scan !== null && (
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {t('libraries.scan', 'Scan')}: {scan.status}
          {scanFailure !== null && <span className="ml-2 break-words text-[var(--color-error-text)]">{scanFailure}</span>}
        </p>
      )}
      {editing && <LibraryForm library={library} busy={busy} onSubmit={(draft) => onEditSubmit(library.id, draft)} onCancel={onEditDone} />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" loading={busy || probing} onClick={() => void test()}>
          <Search className="h-3.5 w-3.5" aria-hidden="true" />
          {t('libraries.test', 'Test')}
        </Button>
        <Button size="sm" loading={busy} onClick={() => void rescan()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t('libraries.rescan', 'Rescan')}
        </Button>
        {/*
          The edit action is what makes a rejected credential fixable. It did not
          exist: `PATCH /user/libraries/:id` and `updateLibrary` have both been there
          since the surface was written and nothing called them, so the only remedy
          for a 401 was deleting the library — which cascades the whole index away.
        */}
        <Button size="sm" onClick={onEdit} disabled={editing}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          {t('libraries.edit', 'Edit')}
        </Button>
        <Button size="sm" variant="danger" className="ml-auto" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('libraries.delete', 'Delete')}
        </Button>
      </div>
    </li>
  );
}

export { LibraryRow };
export type { LibraryRowProps, RunAction };
