import { useEffect, useRef, useState } from 'react';
import { t } from 'i18next';
import { Pencil, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { LibraryForm } from './LibraryForm';
import { probeLibrary, startLibraryEnrich, startLibraryScan, stepLibraryEnrich, stepLibraryScan } from '../../services/libraryService';
import type { LibraryDraft } from '../../lib/libraryDraft';
import { describeProbe, describeScan, describeStopReason } from '../../lib/probe';
import { describeScanState } from '../../lib/scanStatus';
import { describeEnrichState } from '../../lib/enrichStatus';
import type { ChunkStopReason, LibrarySummary, Notice, ProbeResult } from '../../types';

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
  /**
   * Which bound ended the last chunk **this row ran**, or `null`.
   *
   * Why local and not from `library.scan`: `stoppedBy` is a property of a chunk, and the
   * server does not persist it — `GET /user/libraries` reads `scan_state`, which has no such
   * column, so the only place it exists is the response to `POST …/scan/step`. Holding it here
   * is what lets the diagnosis outlive the 6-second notice the chunk also raises.
   *
   * The cost is that it does not survive a reload, which was the deliberate trade: persisting
   * it means a new column, a migration, a lock entry and a write on every chunk, for a
   * sentence an operator reads once while the page is open.
   */
  const [stoppedBy, setStoppedBy] = useState<ChunkStopReason>(null);
  // Guards the two async handlers below, which are **event handlers, not effects**.
  //
  // An effect owns its own cleanup because the effect knows when the component goes away;
  // an event handler has to be told. `rescan` makes two sequential round trips against a
  // deliberately slow origin — a chunk is bounded by `SCAN_CHUNK_DEADLINE_MS` — so
  // navigating to `/users` mid-chunk calls `setState` on a row that is gone. The view-level
  // effects already do this; these two had no guard, and `apps/web/AGENTS.md` claimed a lint
  // rule covers the gap. `react-hooks/recommended-latest` is `exhaustive-deps`,
  // `rules-of-hooks` and `set-state-in-effect` — **none of which detects a missing
  // cancellation guard**, so the claim was not backed by the configuration it named.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const test = async () => {
    setProbing(true);
    // Cleared first so a stale verdict from a previous click cannot sit next to a
    // new one while this is in flight.
    setProbe(null);
    await onRun(
      library.id,
      async () => {
        const result = await probeLibrary(library.id);
        if (!alive.current) return undefined;
        setProbe(result);
        return describeProbe(result, {
          reachable: t('libraries.reachable', 'Reachable.'),
          probed: t('libraries.probedOk', 'The origin answered.'),
          failed: t('libraries.probeUnknownFailure', 'The probe failed.'),
        }).notice;
      },
      t('libraries.probed', 'Probe finished.'),
    );
    // Also after the await, and also guarded: `onRun` swallows its own errors, so this is
    // the only thing that re-enables the button.
    if (alive.current) setProbing(false);
  };

  /**
   * Rescan: seed the frontier, then advance one chunk.
   *
   * Both halves are needed and neither is enough alone. `start` probes the root and
   * decides whether there is work; `step` is the only thing that does any, because the
   * scan is client-driven and `/rest/getScanStatus` is the surface that normally drives
   * it. So an operator with no Subsonic client polling used to click this and watch a
   * scan that never moved.
   *
   * Nothing is read back afterwards. `onRun` reloads the library list when the action
   * returns, and that list now carries the scan state — so the third round trip re-read a
   * field the refresh was about to re-read anyway, and the only thing it contributed was
   * overwriting `stoppedBy` with `null` and discarding the diagnosis with it.
   */
  const rescan = async () => {
    await onRun(
      library.id,
      async () => {
        const started = await startLibraryScan(library.id);
        if (!alive.current) return undefined;
        // Kept from `start` as well as from the chunk, and not overwritten by a later
        // `null`: a library whose *root probe* fails is decided by `start` and never
        // reaches `step`, so this is where its diagnosis lives.
        setStoppedBy((previous) => started.stoppedBy ?? previous);
        const chunk = await stepLibraryScan(library.id);
        if (!alive.current) return undefined;
        setStoppedBy((previous) => chunk.stoppedBy ?? previous);
        return undefined;
      },
      t('libraries.scanStarted', 'Scan started.'),
    );
  };

  /**
   * Enrich: tag-read every track still owing one, a bounded chunk at a time.
   *
   * Both halves are needed for the scan's reason. `start` begins the run and advances
   * one chunk on the object's alarm; `step` is the operator's manual single-chunk
   * trigger — and without the `ENRICH` binding it is the only thing that moves the run
   * at all. Nothing is read back afterwards: `onRun` reloads the list, which carries
   * the enrichment state, so a third round trip would only discard the chunk's
   * diagnosis.
   *
   * While the scan is advancing the server refuses with `409`, and that refusal arrives
   * as the error notice — the operator asked, so the operator is told to wait.
   */
  const enrich = async () => {
    await onRun(
      library.id,
      async () => {
        await startLibraryEnrich(library.id);
        if (!alive.current) return undefined;
        await stepLibraryEnrich(library.id);
        if (!alive.current) return undefined;
        return undefined;
      },
      t('libraries.enrichStarted', 'Enrichment started.'),
    );
  };

  const presented = probe === null ? null : describeProbe(probe);
  // From the list, not from this row's own state: the poll is what keeps it current, and a
  // status held only here would be right until the operator happened to click something.
  const scanState = library.scan;
  const scanPresented = describeScanState(scanState, library.songCount, {
    never: t('libraries.scanNever', 'Not scanned yet.'),
    idle: t('libraries.scanIdle', 'Up to date.'),
    empty: t('libraries.scanEmpty', 'Scan finished with nothing indexed. Check the library root path, then rescan.'),
    scanning: t('libraries.scanScanning', 'Scanning.'),
    failed: t('libraries.scanFailed', 'Retrying after an error.'),
    stalled: t('libraries.scanStalled', 'Stopped retrying. Fix the cause, then rescan.'),
    paused: t('libraries.scanPaused', "D1's daily write allowance is spent. Paused until {{time}} UTC; the scan resumes itself."),
    tracksIndexed: t('libraries.scanTracks', '{{count}} tracks indexed'),
  });
  const scanFailure = describeScan(scanState?.lastError);
  // Which bound cut the last chunk short, when one did. Rendered under the row for the
  // same reason as `lastError`: `useNotice` clears after 6 s, and a scan that pauses
  // every poll is not something an operator reads once and remembers.
  const scanPaused = describeStopReason(stoppedBy, {
    // The inline default and the bundle are validated against each other by
    // `scripts/i18n/validate_locales.ts`, so both say the same thing: on Workers Free the ceiling
    // is the platform's and cannot be raised from here, the server clamps the value, and a chunk
    // that spends more is terminated rather than slowed. "Raise this knob" was advice that made
    // the scan die.
    requests: t(
      'libraries.scanPausedRequests',
      'Paused at the per-chunk request limit. This is the plan limit, not a fault — the scan continues on the next tick.',
    ),
    deadline: t('libraries.scanPausedDeadline', 'Paused at the per-chunk time limit. Raise SCAN_CHUNK_DEADLINE_MS, or expect more polls.'),
  });
  // From the list, like the scan state: the poll is what keeps it current.
  const enrichState = library.enrich;
  const enrichPresented = describeEnrichState(enrichState, {
    never: t('libraries.enrichNever', 'Not enriched yet.'),
    idle: t('libraries.enrichIdle', 'Enriched.'),
    partial: t('libraries.enrichPartial', 'Partially enriched. New tracks enrich on first play, or run the enrichment again.'),
    enriching: t('libraries.enrichEnriching', 'Enriching.'),
    failed: t('libraries.enrichFailed', 'Retrying after an error.'),
    stalled: t('libraries.enrichStalled', 'Stopped retrying. Fix the cause, then enrich again.'),
    paused: t('libraries.enrichPaused', "D1's daily write allowance is spent. Paused until {{time}} UTC; the enrichment resumes itself."),
    tracksRemaining: t('libraries.enrichTracks', '{{count}} tracks remaining'),
  });
  const enrichFailure = describeScan(enrichState?.lastError);

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">{library.displayName ?? library.slug}</span>
        <code className="rounded bg-[var(--color-surface-base)] px-1.5 py-0.5 text-xs text-[var(--color-text-muted)]">{library.slug}</code>
        {presented !== null && <Badge variant={presented.tone}>{presented.label}</Badge>}
        {/*
          The scan badge is unconditional, where the probe badge is not — and the asymmetry
          is the point. A probe is an event with no state until one is run, so nothing to show
          is honest. A scan is a *state* that exists whether or not anyone is looking: a
          library nobody has scanned says so here, which is the one row on this page the
          operator has to act on. It rendered nothing at all before, because the state lived in
          this component and was only ever set by the Rescan button.
        */}
        <Badge variant={scanPresented.tone}>{scanPresented.label}</Badge>
        {/*
          The enrichment badge is unconditional for the scan badge's reason: enrichment is
          a *state* that exists whether or not anyone is looking. A library whose tracks
          still owe a tag read says so here, which is the row's second call to action
          beside the scan's.
        */}
        <Badge variant={enrichPresented.tone}>{enrichPresented.label}</Badge>
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
      {/*
        The count, and the two diagnoses. Rendered from the list's scan state so the poll is
        what updates them, which is the whole reason this line exists on a page load.

        `songCount` is tracks, not folders: it is the figure `getScanStatus` publishes as
        `count`, and it is the only progress number that means the same thing to this surface
        and to a Subsonic client watching the same library. `scanned` (folders visited) is
        deliberately not shown as a fraction — there is no denominator to show it against.
        The server wrote `total_count` as `0` and never updated it, so the `ChunkResult`
        field built from it was `0` on every path but one, and the one exception carried
        `scanned_count` instead; both are gone rather than documented.
      */}
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        {scanPresented.detail}
        {scanFailure !== null && <span className="ml-2 break-words text-[var(--color-error-text)]">{scanFailure}</span>}
        {/*
          Muted rather than an error tone: a chunk that hit a bound did its job and
          left the rest of the frontier for the next poll. It is information about
          throughput, not a fault, and colouring it as one would train an operator to
          ignore the line that does mean something went wrong.
        */}
        {scanPaused !== null && <span className="ml-2 break-words">{scanPaused}</span>}
      </p>
      {/*
        The enrichment count and its diagnosis, from the list's enrichment state so the
        poll updates them. Rendered on its own line because it answers a different
        question from the scan's — "are the tags read" rather than "is the index caught
        up" — and one line carrying both would read as one claim.
      */}
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        {enrichPresented.detail}
        {enrichFailure !== null && <span className="ml-2 break-words text-[var(--color-error-text)]">{enrichFailure}</span>}
      </p>
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
          Tag-read every track still owing one. Separate from Rescan because the two do
          different work — "has the index caught up" and "are the tags read" — and the
          enrichment runs only while the scan is idle, so one button cannot do both.
        */}
        <Button size="sm" loading={busy} onClick={() => void enrich()}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {t('libraries.enrich', 'Enrich')}
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
