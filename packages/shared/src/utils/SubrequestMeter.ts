/**
 * What one Worker invocation may spend, counted.
 *
 * ### Why this exists at all
 *
 * Cloudflare counts a **subrequest** per invocation and kills the invocation when the count
 * is exceeded — it does not throw something a `catch` can see, so the whole invocation dies
 * with `Too many subrequests by single Worker invocation` and everything after the ceiling
 * is lost. The only defence is to never issue the request that crosses it.
 *
 * A subrequest is not only `fetch`. The platform's own D1 limits page states:
 *
 * > Queries per Worker invocation (read subrequest limits) — 1000 (Workers Paid) / **50 (Free)**
 *
 * So a D1 query is a subrequest, and on the Free plan a `KV` read, a Durable Object RPC and
 * a Secrets Store read are subrequests too. This repository spent a long time budgeting
 * **only** `fetch` — `ScanBudget` metered `WebDavClient.request()` and nothing else, on the
 * strength of a reading that "internal service subrequests (D1, KV) are 1,000 on Free".
 * That reading is wrong, and it shipped: a scan chunk cost ~40 counted requests and ~200
 * uncounted ones, every chunk died at the ceiling, and the scan only ever finished because
 * each dead invocation left a little progress behind. See
 * `docs/issues/free-plan-subrequest-ceiling.md`.
 *
 * ### Why the count is pessimistic
 *
 * The platform does not say whether a D1 `batch()` of N statements costs 1 or N. The D1 page
 * counts *queries*, which reads as N; the Workers page counts subrequests, which reads as 1.
 * So the meter charges **one per statement**, which is the reading that cannot kill an
 * invocation. If the friendlier reading turns out to be right, the meter over-counts and a
 * chunk does slightly less work per poll — a cost in throughput, never a correctness or
 * availability problem. That asymmetry is the whole reason to choose it: an over-count is a
 * slow scan, an under-count is a dead one.
 *
 * ### The opening paragraph is true of one ceiling and false of the other
 *
 * "It does not throw something a `catch` can see" describes the **external** ceiling, which
 * kills the invocation outright. Measured on a Free account on 2026-10-05, there are two
 * budgets: external `fetch` is 50, and **D1 statements are 1,000**, in a separate pool — 1,000
 * D1 statements and 50 outbound requests in one invocation survive together.
 *
 * A **D1** overrun *throws* `Too many API requests by single Worker invocation` and an ordinary
 * `catch` sees it. So this counter's single ceiling covers two resources that fail differently,
 * and this file's own header asserted the stricter one's behaviour as if it were both.
 *
 * That is not a licence to catch and continue — a swallowed limit is still a limit, and handling
 * it turns a loud failure into a quiet one. It is a reason to keep charging D1 against the
 * external 50: bounding both by the resource that cannot be handled when it runs out is the
 * choice that cannot take the product down. Full account, and what was not measured:
 * `docs/issues/subrequest-budgets-are-two-not-one.md`.
 *
 * ### Why it is an interface and not a class everywhere
 *
 * `backend-data` may only import layer 0, and `webdav` may import nothing at all — so the
 * DAOs and the KV cache accept this shape as a constructor dependency and the composition
 * root hands them the one counter for the invocation. Nothing below layer 3 constructs one.
 */

/**
 * What spent the subrequests, for the operator-facing breakdown.
 *
 * `d1` is separated from `kv` and `fetch` because the three have different remedies: a chunk
 * that ran out on `fetch` needs a bigger `SCAN_CHUNK_MAX_REQUESTS` on a Paid plan, and one
 * that ran out on `d1` needs a smaller page size. Collapsing them into a single number is how
 * the ceiling became invisible in the first place.
 */
type SubrequestKind = 'd1' | 'kv' | 'fetch' | 'rpc' | 'secret';

const SUBREQUEST_KINDS: readonly SubrequestKind[] = ['d1', 'kv', 'fetch', 'rpc', 'secret'];

/**
 * The counter every charge point writes to.
 *
 * A method rather than a mutable field so a charge point can be handed the *interface* and
 * the test that owns the ceiling keeps the only real instance. `charge` is the whole write
 * surface; `spent` and `byKind` are the only read surface a charge point needs.
 */
interface SubrequestMeter {
  /**
   * Record `count` subrequests issued.
   *
   * Never throws and never refuses. A meter that could reject would turn "the budget ran
   * out" into an error at a charge point deep inside a DAO, which is the one place that
   * cannot afford to decide anything — the decision belongs *before* the work, in
   * `canAfford`.
   */
  charge(count?: number, kind?: SubrequestKind): void;
  /**
  Subrequests issued so far in this invocation.
  */
  readonly spent: number;
  /**
  The ceiling this counter enforces, or `Infinity` when it enforces none.
  */
  readonly ceiling: number;
  /**
  How many more fit, floored at zero.
  */
  readonly remaining: number;
  /**
  Whether the ceiling has been reached.
  */
  readonly exhausted: boolean;
  /**
  Whether `count` more would still fit.
  */
  canAfford(count?: number): boolean;
  /**
  Lower this meter's effective ceiling for the current unit of work.

  ### Why the ceiling is mutable at all

  Because a chunk's budget is **tighter** than the platform's and is spent by code that
  cannot see `ScanBudget`. `ScanBudget` lives in layer 3; every charge point that matters
  — `BaseDAO.runWriteBatch`, `BaseDAO.withRetry`, `KvCache`, `WebDavClient` — lives below
  it and holds only this meter, so the meter is the one place the two can meet and the
  ceiling is how a tighter bound reaches them.

  It was not done this way, and the write batch is where it showed: `fitCount` read
  `meter.remaining`, so a chunk could issue statements up to the *platform's* 50 while its
  own budget said 42. That is not a chunk overspending its own budget by two — it is a
  chunk spending the invocation's 8-statement reserve, after which the post-walk
  `saveProgress` crosses 50 and the runtime terminates the invocation with an error no
  `catch` in this repository can see. Measured against a 60-entry root: 52 subrequests on a
  ceiling of 50, `is_scanned: true` never written, the frontier never draining.

  Never raises it. `ScanBudget` may only *narrow* the platform's ceiling, so a caller
  asking for more than the platform allows is clamped rather than trusted — the same
  asymmetry as everywhere else in this file: an over-count costs throughput, an under-count
  costs an invocation.
  */
  setCeiling(limit: number): void;
}

/**
 * One counter per Worker invocation.
 *
 * `reset()` rather than a fresh instance per chunk because the counter is owned by the
 * **request scope**, which is created once per invocation: a scan chunk does not own the
 * budget, it borrows the invocation's. Constructing a new counter per chunk would be a second
 * place that decides what the ceiling is, and the DAOs — which are constructed once per scope
 * — would be holding a reference to the wrong one.
 */
class SubrequestCounter implements SubrequestMeter {
  private counts: number = 0;

  /**
   * Spend per kind, so `ChunkResult` can report *what* ran out rather than only that
   * something did. A single total is what made this ceiling un-diagnosable: the operator saw
   * "paused" and the three possible causes have three different fixes.
   */
  private readonly byKindSpent: Record<SubrequestKind, number> = { d1: 0, kv: 0, fetch: 0, rpc: 0, secret: 0 };
  /**
   * The platform's ceiling, or a narrower one `setCeiling` imposed for the current unit of
   * work. Restored to `limit` by `reset()`, so a narrowed ceiling cannot leak past the chunk
   * that asked for it — two chunks in one invocation would otherwise leave the second one
   * bounded by the first one's budget.
   */
  private effective: number;

  constructor(private readonly limit: number = Infinity) {
    this.effective = limit;
  }

  public charge(count = 1, kind: SubrequestKind = 'd1'): void {
    if (count <= 0) return;
    this.counts += count;
    this.byKindSpent[kind] += count;
  }

  public get spent(): number {
    return this.counts;
  }

  /**
   * The **effective** ceiling: the platform's, or a narrower one a caller imposed.
   */
  public get ceiling(): number {
    return this.effective;
  }

  public get remaining(): number {
    if (this.effective === Infinity) return Infinity;
    return Math.max(0, this.effective - this.counts);
  }

  public get exhausted(): boolean {
    return this.counts >= this.effective;
  }

  public canAfford(count = 1): boolean {
    return this.counts + count <= this.effective;
  }

  public setCeiling(limit: number): void {
    // An unmetered counter stays unmetered: a ceiling of `Infinity` cannot be lowered to a
    // finite one, because the callers that would impose one are the *production* ones and a
    // test double asking for a bound must not start refusing statements.
    if (!Number.isFinite(this.effective) || !Number.isFinite(limit)) return;
    this.effective = Math.max(0, Math.min(this.effective, Math.floor(limit)));
  }

  /**
   * Zero the count and restore the platform's ceiling.
   *
   * One method rather than a public `counts` field so "start measuring again" is a named
   * operation, and so the per-kind breakdown cannot drift out of step with the total — which
   * is exactly the kind of second-answer defect this file exists to prevent.
   *
   * The ceiling is **restored**, not kept, and that is the whole of why it is here rather than
   * on a separate method: a narrowed ceiling belongs to the unit of work that asked for it, and
   * `POST /user/libraries/:id/scan/step` runs two of those in one invocation.
   */
  public reset(): void {
    this.counts = 0;
    this.effective = this.limit;
    for (const kind of SUBREQUEST_KINDS) this.byKindSpent[kind] = 0;
  }

  /**
   * Spend per kind, as a plain object.
   *
   * A copy, so a caller cannot reach in and change the totals the operator is shown.
   */
  public breakdown(): Record<SubrequestKind, number> {
    return { ...this.byKindSpent };
  }
}

/**
 * A meter that enforces nothing, for a caller that has not been given one.
 *
 * `Infinity` rather than a small number, because the alternative is a default ceiling that a
 * test would satisfy by accident — the failure this file is about is a path that spends
 * nothing because nothing was watching it, and a limit of 50 would hide that behind a
 * passing assertion. Production wiring is asserted to pass a real counter
 * (`test/subrequest-budget.test.ts`), so the default is only reachable from a double.
 */
const UNMETERED_SUBREQUESTS: SubrequestMeter = new SubrequestCounter(Infinity);

/**
 * What an invocation spent, broken down.
 *
 * A total alone is what made this ceiling undiagnosable. An operator whose scan keeps pausing
 * was told "paused" and nothing else, while the causes have different fixes: a chunk that ran
 * out on `fetch` wants a bigger budget, one that ran out on `d1` wants a smaller page or a
 * bigger plan, and one that ran out on `kv` wants the cache entry to exist.
 */
interface SubrequestSpend extends Record<SubrequestKind, number> {
  /**
  Every subrequest spent, whatever its kind. The number the ceiling is enforced against.
  */
  readonly total: number;
}

/**
 * Flatten a meter's breakdown into a report, total included.
 *
 * A function rather than a method on the counter so the *shape* the rest of the system passes
 * around — including the zeroes for kinds that spent nothing — is built in one place. A caller
 * that assembled it by hand would omit an absent kind, and the operator surface would render
 * a missing field as a missing measurement rather than as `0`.
 */
function subrequestSpend(byKind: Record<SubrequestKind, number>, total: number): SubrequestSpend {
  return { total, d1: byKind.d1, kv: byKind.kv, fetch: byKind.fetch, rpc: byKind.rpc, secret: byKind.secret };
}

/**
 * Nothing spent, for a code path that did no work — so a zero report is a *measurement* rather
 * than an absent field.
 */
const NO_SUBREQUESTS_SPENT: SubrequestSpend = subrequestSpend({ d1: 0, kv: 0, fetch: 0, rpc: 0, secret: 0 }, 0);

export { SubrequestCounter, UNMETERED_SUBREQUESTS, SUBREQUEST_KINDS, subrequestSpend, NO_SUBREQUESTS_SPENT };
export type { SubrequestMeter, SubrequestKind, SubrequestSpend };
