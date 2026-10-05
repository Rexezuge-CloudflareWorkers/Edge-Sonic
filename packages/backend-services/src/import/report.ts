/**
 * What an import actually did, and what it could not do.
 *
 * ### Why the report is a first-class value
 *
 * An import resolves hundreds of foreign ids against a library that may not hold them, and
 * **every one it cannot resolve is named**. Not counted — *named*.
 *
 * That is the whole reason this type exists. A playlist that silently lost three tracks is a
 * **wrong answer** rather than an unfinished one, and it is indistinguishable from a playlist
 * the user deliberately shortened. An operator who can see which three tracks were dropped
 * can act on it; an operator who sees "imported 97 of 100" cannot, because the three might be
 * files they have not indexed yet, files they deleted years ago, or a matching failure.
 *
 * ### A phase either reports or it does not run
 *
 * Each phase's outcome is merged into one report that is **replaced** wholesale, never
 * appended to. A step that runs twice after a retry must not list the same unresolved item
 * twice: a duplicate reads as a second, different problem, and an operator triaging a list of
 * 400 entries cannot tell which are real.
 *
 * ### The row accounting is separate from the outcome
 *
 * `rowsWritten` is what the **D1 daily allowance** is spent from, and it is counted from the
 * DAOs' own `WriteBatchResult` rather than estimated from the counts above. An estimate is a
 * claim and the allowance is enforced: since 2026-09-01 an account over its 5,000 rows/day has
 * *every* query fail until midnight UTC, so a phase that under-reports its own spend is a
 * phase that spends the next writer's budget.
 */

/**
One item that did not resolve, named so an operator can act on it.
*/
interface UnresolvedItem {
  /**
  Which category it came from: a playlist, a star, a bookmark.
  */
  readonly category: string;
  /**
  The context a human would recognise — a playlist name, or `starred`.
  */
  readonly context: string;
  /**
  The remote's own id, verbatim. Useless to a client, exact for a support ticket.
  */
  readonly remoteId: string;
  /**
  What the remote called it. This is the part a person reads.
  */
  readonly label: string;
  /**
  Why it did not resolve, where the matcher knows.
  */
  readonly reason: 'not-found' | 'ambiguous' | 'no-metadata';
}

/**
How many unresolved items one phase may carry before the list is summarised.
*/
const MAX_REPORTED_UNRESOLVED = 200;

/**
 * The outcome of one phase.
 *
 * `skipped` is distinct from `failed` and from zero counts. A phase the operator did not ask
 * for is **skipped**; a phase that asked and could not run is **failed**. Collapsing either
 * into "0 imported" makes an operator's deliberate choice indistinguishable from a defect.
 */
interface PhaseReport {
  readonly phase: string;
  readonly status: 'imported' | 'skipped' | 'failed' | 'partial';
  readonly imported: number;
  readonly rowsWritten: number;
  /**
  How many did not resolve. Compare against `unresolved.length` to see if the list was summarised.
  */
  readonly unresolvedCount: number;
  /**
  The named items, capped at {@link MAX_REPORTED_UNRESOLVED}.
  */
  readonly unresolved: UnresolvedItem[];
  readonly lastError: string | null;
}

interface ImportReport {
  readonly runId: string;
  readonly sourceName: string;
  readonly targetUsername: string;
  readonly phases: readonly PhaseReport[];
  /**
  Epoch seconds, or `null` while running.
  */
  readonly finishedAt: number | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Add items to a phase, capping the named list.
 *
 * The cap exists so a wholly-mismatched library cannot produce a multi-megabyte report: the
 * **count** is always exact and only the names are truncated, so the operator learns the scale
 * of the problem even when the list is summarised.
 */
function collectUnresolved(existing: UnresolvedItem[], added: readonly UnresolvedItem[]): UnresolvedItem[] {
  if (existing.length >= MAX_REPORTED_UNRESOLVED) return existing;
  return [...existing, ...added].slice(0, MAX_REPORTED_UNRESOLVED);
}

function phase(partial: Partial<PhaseReport> & { readonly phase: string }): PhaseReport {
  return {
    phase: partial.phase,
    status: partial.status ?? 'skipped',
    imported: partial.imported ?? 0,
    rowsWritten: partial.rowsWritten ?? 0,
    unresolvedCount: partial.unresolvedCount ?? partial.unresolved?.length ?? 0,
    unresolved: partial.unresolved ?? [],
    lastError: partial.lastError ?? null,
  };
}

/**
 * Assemble the final report from a run's phases.
 *
 * `finishedAt` is `null` while running, so an operator polling mid-import can tell progress
 * from a run that stopped — which is the same question `getScanStatus`'s `scanning` answers,
 * and it is why a status of `0 imported` is not read as "finished with nothing found".
 */
function buildReport(input: {
  runId: string;
  sourceName: string;
  targetUsername: string;
  phases: readonly PhaseReport[];
  finished: boolean;
}): ImportReport {
  return {
    runId: input.runId,
    sourceName: input.sourceName,
    targetUsername: input.targetUsername,
    phases: input.phases,
    finishedAt: input.finished ? nowSeconds() : null,
  };
}

/**
 * Serialise for `import_runs.report_json`.
 *
 * Bounded: a run's phases are a closed set, and the unresolved list is capped above, so the
 * largest possible report is a fixed size rather than a function of the library. That matters
 * because a D1 column that grows with the library is a column whose size nothing has checked.
 */
function serializeReport(report: ImportReport): string {
  return JSON.stringify(report);
}

/**
 * Read a stored report back.
 *
 * A malformed body yields `null` rather than throwing. The report is written by this module,
 * so an unparseable one is corruption — and a status read that throws takes down the operator's
 * whole page over a field that is decoration next to `import_runs.status`, which is the same
 * reasoning `subsonic.ts` uses for a body it cannot read.
 */
function parseReport(raw: string | null): ImportReport | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ImportReport>;
    if (!parsed || !Array.isArray(parsed.phases)) return null;
    return {
      runId: (parsed.runId ?? ''),
      sourceName: (parsed.sourceName ?? ''),
      targetUsername: (parsed.targetUsername ?? ''),
      phases: parsed.phases as readonly PhaseReport[],
      finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : null,
    };
  } catch {
    return null;
  }
}

export {
  buildReport,
  collectUnresolved,
  parseReport,
  phase,
  serializeReport,
  MAX_REPORTED_UNRESOLVED,
};
export type { ImportReport, PhaseReport, UnresolvedItem };