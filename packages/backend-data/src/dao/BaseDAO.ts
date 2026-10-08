import { SubrequestBudgetExhaustedError } from '@edge-sonic/backend-errors';
import { UNMETERED_SUBREQUESTS } from '@edge-sonic/shared';
import type { SubrequestMeter } from '@edge-sonic/shared';
import type { D1PreparedStatement, D1Queryable, D1Result, TrackedStatement } from '../utils/D1Types';
import { executeD1WithRetry } from '../utils/D1Utils';
import { billedRowsFor } from './billedRows';

/**
 * What a write batch actually managed to write.
 *
 * ### Why a batch can come back short
 *
 * `runWriteBatch` issues statements in groups sized by what is left of the invocation's
 * **subrequest** budget, not by what D1 will accept. A folder of 500 tracks is one
 * `upsertFileFacts` call and ~500 statements, and Workers Free allows **50 subrequests per
 * invocation** — so the batch cannot be issued whole, and issuing it whole does not make it
 * slow, it **terminates the invocation** with `Too many subrequests by single Worker
 * invocation`, an error no `catch` here can see.
 *
 * So it is issued in as many groups as fit and the rest is reported as unwritten. That is only
 * safe because every caller of a truncating batch treats "not written" as "not done":
 *
 * - the scan leaves the folder's `is_scanned` flag alone, so the folder stays on the frontier
 *   and the next chunk re-lists it and writes the rows that are still missing. `upsertFileFacts`
 *   is an idempotent upsert keyed on `path`, and the pre-write comparison skips rows whose
 *   mtime has not moved, so the retry costs one `PROPFIND` and one `listChildren` and no
 *   duplicate writes;
 * - the read-through browse (`TreeService`) does not persist at all when its writes do not
 *   fit, because it already holds the listing in memory and the folder is not marked
 *   materialized.
 *
 * `truncated` is therefore not a diagnostic — it is a promise the caller is relying on, which
 * is why it is on the return value rather than logged.
 *
 * ### Why the result carries two row counts
 *
 * Because D1 bills **two different numbers** and this repository needed the wrong one. The
 * daily row-write allowance is denominated in *billed* rows — the table row plus every index
 * entry the write rewrote — while `meta.changes` is SQLite's count of table rows touched. For
 * `songs` those differ by a factor of ten, so a scan pacing itself against `changes` writes
 * roughly ten times the allowance it believes it is respecting, and on Free that is not a slow
 * scan but an account-wide refusal until midnight UTC.
 *
 * Both are returned because they answer different questions. `changes` is progress — it is
 * what convergence is measured in — and `billedRows` is cost. Collapsing them into one field
 * would force one of the two claims to be a lie.
 */
interface WriteBatchResult {
  /**
  Rows the statements changed, summed over the groups that were issued.
  */
  readonly changes: number;
  /**
  How many statements were issued. Less than were passed in when `truncated`.
  */
  readonly written: number;
  /**
  Whether statements were left unwritten because the budget ran out.
  */
  readonly truncated: boolean;
  /**
  What those changes cost against D1's **daily row-write allowance**, in billed rows.

  Not `changes`, and derived rather than defaulted. D1 bills an index entry as well as
  the table row, so a `songs` insert bills ten rows for one row of data, and the allowance
  is denominated in the billed figure.

  `changes` is kept beside it rather than replaced, because it still answers a different
  and load-bearing question: it is what `test/scan-convergence.test.ts` measures to prove a
  folder converges, and a convergence assertion reading the index multiplier would be
  measuring the schema rather than the scan's progress.
  */
  readonly billedRows: number;
}

/**
 * Base for every D1 DAO.
 *
 * It owns two concerns: retrying transient D1 faults, and **charging the subrequest meter**.
 * Everything else (SQL text, binding order, result shaping) belongs to the concrete DAO, which
 * is the only place that knows its table's shape.
 *
 * ### Why charging lives here
 *
 * Because this is the only place every D1 statement passes through. There are roughly a
 * hundred call sites; a charge at each of them is a hundred chances to forget one, and a
 * forgotten charge is invisible — the statement still works, the query still returns the right
 * rows, and the invocation still dies at the ceiling with nothing in the logs to say why.
 *
 * So `withRetry` charges, because a DAO's every read and every single write goes through it,
 * and `runWriteBatch` charges, because a `batch()` does not.
 *
 * ### Why a DAO without a meter is a defect and not a default
 *
 * The meter defaults to one that enforces nothing, which is right for a test double and wrong
 * for production. Production wiring is asserted — `test/subrequest-budget.test.ts` checks that
 * both composition roots construct their DAOs with a real counter — because an unmetered DAO
 * in production is precisely the failure this class of bug is made of: a path that spends
 * nothing because nothing was watching it.
 */
abstract class BaseDAO {
  constructor(
    protected readonly database: D1Queryable,
    private readonly meter: SubrequestMeter = UNMETERED_SUBREQUESTS,
  ) {}

  /**
   * Run a statement — or a read — with bounded retries on transient faults.
   *
   * `context` names the operation so a failure is attributable in logs; it is the
   * only place D1's own message is allowed to become user-facing (via
   * `DatabaseError`), which is why it must be descriptive. A D1 error carries
   * table and column names, so a context string is the part that reaches an
   * operator.
   *
   * Generic so reads get the same retry as writes; see `executeD1WithRetry`.
   *
   * Charges **one** subrequest, once, for the logical statement. A retry that re-issues the
   * operation is charged again only if the platform counted it, which this cannot know; the
   * pessimistic choice would be to charge per attempt, and that would make a transient blip
   * look like three statements' worth of budget on a ceiling of fifty. One per statement is
   * the reading D1's own limits page states.
   */
  protected withRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    this.meter.charge(1, 'd1');
    return executeD1WithRetry(operation, context);
  }

  /**
   * A statement paired with the SQL it was prepared from.
   *
   * The platform's `D1PreparedStatement` does not expose its SQL — see
   * {@link TrackedStatement} — and something in this layer has to know which table a write
   * bills against, because D1 charges a write as the row *plus every index entry it
   * rewrote*. So the SQL is carried beside the statement instead of being read off it.
   *
   * This is the only place a statement becomes a {@link TrackedStatement}, which is what
   * makes "the SQL and the statement cannot be different facts" structural rather than a
   * convention: the pair is minted once, here, from the one string both come from. A
   * write helper handed two arguments would be two literals for one statement, which is
   * the shape of defect this repository has paid for three times.
   *
   * Reads deliberately keep calling `this.database.prepare` directly. Nothing reads a
   * read's SQL, and routing 100 read sites through a wrapper to carry a field no reader
   * wants is the other kind of wrong.
   */
  protected prepare(query: string): TrackedStatement {
    const track = (statement: D1PreparedStatement): TrackedStatement => ({
      sql: query,
      statement,
      // A **new** pair, mirroring the platform: Cloudflare's `bind()` returns a new
      // statement rather than mutating and returning the same one, so a pair that
      // mutated in place would model a statement the runtime does not have.
      bind: (...values: unknown[]): TrackedStatement => track(statement.bind(...values)),
    });
    return track(this.database.prepare(query));
  }

  /**
   * The invocation's counter, for a DAO that constructs another one.
   *
   * `SongDAO` delegates its id lookups to `SongIdLookupDAO`, and it built one with
   * `new SongIdLookupDAO(this.database)` — dropping the meter. That is the whole defect this
   * layer was changed for, present in the code written to fix it: the delegated DAO worked,
   * returned the right rows, and spent nothing the budget could see, and nothing in the suite
   * failed because a total is the easiest thing in the world to assert.
   *
   * So a composition's meter is reachable from a subclass, and the only way to build a DAO is
   * from a DAO that already has one.
   */
  protected get subrequests(): SubrequestMeter {
    return this.meter;
  }

  /**
   * Assert that `statements` more statements fit, or refuse.
   *
   * For a **read** whose size the caller did not choose. A write can be truncated and resumed;
   * a read cannot — half a page of albums is a wrong page, not an unfinished one — so the only
   * honest options are to clamp the size upstream (which is what the derived
   * `MAX_PAGE_SIZE_CEILING` does) or to refuse here with an error the mapper can turn into a
   * `413`. Being killed by the platform is the third option and it is the worst one: no
   * envelope, no status, and a message about subrequests in a client's error log.
   *
   * `statements` rather than rows, because rows and statements are different numbers and the
   * ceiling is denominated in the second. Callers derive it from `bindChunkSize`, which is
   * where every other batching decision in this layer is made.
   */
  protected requireSubrequests(statements: number, context: string): void {
    if (!Number.isFinite(this.meter.ceiling) || (statements <= this.meter.remaining)) return;
    throw new SubrequestBudgetExhaustedError(
      `Reading ${context} needs about ${statements} queries and ${this.meter.remaining} remain in this invocation.`,
    );
  }

  /**
   * Run **one** write statement and report what it cost against the daily row-write allowance.
   *
   * The single-statement twin of `runWriteBatch`, and it exists because a write that never
   * reaches the batch is a write whose *cost* nothing measures. `applyMetadata` is the case
   * that mattered: it is one `UPDATE songs` per track a client opens, it goes through
   * `withRetry` — which charges a **subrequest**, a different resource — and the scan's
   * day-row budget counted it as a hardcoded `1` at the call site in `EnrichmentService`.
   *
   * That call site cannot know what the statement billed, and `1` is wrong by the table's
   * index count: a `songs` update is ten rows against the allowance, so a library enriched
   * track by track spent about ten times the budget it reported spending.
   *
   * Measured here, at the choke point, for the reason the subrequest meter is also measured
   * there: a caller-incremented counter is a *claim* about work, and only a measurement of it
   * can bound anything.
   */
  protected async runWriteStatement(
    tracked: TrackedStatement,
    context: string,
  ): Promise<{ changes: number; billedRows: number }> {
    const result: D1Result = await this.withRetry(async () => await tracked.statement.run(), context);
    const changes = result?.meta?.changes ?? 0;
    return { changes, billedRows: billedRowsFor(tracked.sql, changes) };
  }

  /**
   * Run a write batch, splitting it to fit the subrequest budget.
   *
   * Falls back to sequential statements when the binding does not support `batch`. The
   * fallback is not hypothetical: the D1 doubles used in the unit suite are plain objects,
   * and a code path that only works against real D1 is a code path with no test coverage at
   * all.
   *
   * ### The group size is the budget, not a constant
   *
   * A statement cannot be half-issued — `batch()` is a transaction — so the question is not
   * "how do I split this" but "how many of these fit in what is left of the ceiling". The
   * loop therefore asks `canAfford` before each group rather than dividing by a number chosen
   * here, which is what makes it correct on an account that raised its ceiling and on one that
   * did not.
   *
   * Zero statements fit once the budget is gone, so a batch with nothing left returns
   * `truncated` without issuing anything rather than crossing the ceiling to make one
   * statement's worth of progress.
   *
   * @param options.requireComplete Refuse rather than truncate. See `SubrequestBudgetExhaustedError`.
   */
  protected async runWriteBatch(
    statements: readonly TrackedStatement[],
    context: string,
    options?: { requireComplete?: boolean },
  ): Promise<WriteBatchResult> {
    if (statements.length === 0) return { changes: 0, written: 0, truncated: false, billedRows: 0 };

    // Checked once, before anything is issued, so the refusal costs no writes. A caller that
    // needs all-or-nothing gets an error instead of a partial write; a caller that can resume
    // gets `truncated` and finishes on the next chunk.
    if (options?.requireComplete === true && !this.canFitAll(statements.length)) {
      throw new SubrequestBudgetExhaustedError(
        `Writing ${statements.length} rows for ${context} needs ${statements.length} subrequests and ${this.meter.remaining} remain in this invocation.`,
      );
    }

    let changes = 0;
    let billedRows = 0;
    let written = 0;

    for (let offset = 0; offset < statements.length; ) {
      const fits = this.fitCount(statements.length - offset);
      if (fits === 0) break;

      const group = statements.slice(offset, offset + fits);
      // Charged before the group is issued, and for its pessimistic cost, so the ceiling is
      // never crossed by the accounting being later than the request.
      this.meter.charge(fits, 'd1');
      written += group.length;

      if (this.database.batch) {
        // The **raw** statements, never the wrappers: `batch()` is the platform's, and it
        // takes `D1PreparedStatement[]`. A wrapper reaching it is the object it does not
        // know how to execute.
        const raw = group.map((entry) => entry.statement);
        const results: D1Result[] = await executeD1WithRetry(async () => await this.database.batch!(raw), context);
        changes += (results ?? []).reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
        // Zipped against `group` rather than summed on its own, because `billedRowsFor`
        // needs the *SQL* to know which table's index entries the change rewrote, and only
        // the pair carries it. `batch()` preserves order, so index `i` of the results is
        // index `i` of the group; a mismatch here would silently attribute a folder's
        // songs to its nodes.
        billedRows += group.reduce((total, entry, at) => total + billedRowsFor(entry.sql, results[at]?.meta?.changes ?? 0), 0);
      } else {
        for (const entry of group) {
          const result: D1Result = await executeD1WithRetry(async () => await entry.statement.run(), context);
          const changed = result.meta?.changes ?? 0;
          changes += changed;
          billedRows += billedRowsFor(entry.sql, changed);
        }
      }
      offset += fits;
    }

    return { changes, written, truncated: written < statements.length, billedRows };
  }

  /**
   * How many of `available` statements still fit in the subrequest budget.
   *
   * `available` rather than a derived batch size, so the caller never has to know the
   * ceiling: this is the one place the relationship between "statements left" and "budget
   * left" is written down.
   */
  private fitCount(available: number): number {
    if (!Number.isFinite(this.meter.ceiling)) return available;
    return Math.max(0, Math.min(available, Math.floor(this.meter.remaining)));
  }

  /**
   * The most items of `perStatement` each that the remaining budget can still fetch.
   *
   * For a read whose size the caller chooses and whose answer is a whole number of items —
   * a page of artists, a page of albums. Clamping is right there and refusing is not: the
   * caller asked for "as many as you can serve", so a smaller page is the answer rather than
   * an error, and it is the same degradation `MAX_PAGE_SIZE_CEILING` performs one layer up.
   *
   * Never returns less than one group: a page of nothing is not an answer, and the caller
   * would render it as an empty library.
   */
  protected clampToSubrequestBudget(requested: number, perStatement: number): number {
    if (!Number.isFinite(this.meter.ceiling)) return requested;
    const affordable = Math.max(1, Math.floor(this.meter.remaining)) * Math.max(1, perStatement);
    return Math.max(1, Math.min(Math.max(0, requested), affordable));
  }

  /**
   * Whether `count` statements fit whole.
   *
   * Separate from `fitCount` because the two answer different questions: "how many may I
   * issue" and "may I issue all of these". An unmetered DAO fits everything, which is what
   * keeps every existing test double working.
   */
  private canFitAll(count: number): boolean {
    return !Number.isFinite(this.meter.ceiling) || count <= this.meter.remaining;
  }
}

export { BaseDAO };
export type { WriteBatchResult };