/**
 * The operator's index drop: what it would cost, and performing it.
 *
 * ### Why this is a service and not route code
 *
 * Three reasons, and only the first is "layering".
 *
 * 1. `apps/api` may not import `@edge-sonic/backend-data`'s **values**, and the billed-row
 *    arithmetic lives there. A route that quoted `songs * 10` would be a second copy of that
 *    arithmetic in a layer that cannot see the table it is quoting.
 * 2. The **ordering** between D1 and the Durable Object is a decision, not an accident of the
 *    order two calls happen to be written in. See `stopScan` below.
 * 3. An operator dropping a 5,000-track library spends roughly 55,000 rows of a 100,000-row
 *    daily allowance in one request, and past that D1 refuses *every* query until midnight
 *    UTC. The figure the operator consents to and the figure that gets charged must come from
 *    one implementation, or the number in the confirmation dialog is a guess.
 *
 * ### What is destroyed, and what survives
 *
 * `songs`, `nodes` and `scan_state`. **Not** `libraries`, and **not** the per-user
 * annotations — stars, ratings, bookmarks, play queue, play counts, playlist entries.
 *
 * The annotations survive because a song id is *derived* (`s:` + base64url of the library id
 * and the path), so a rescan recreates byte-identical ids and every annotation re-attaches to
 * the row it belonged to. Deleting them too would spend more billed rows to destroy listening
 * history a rescan restores for free.
 *
 * `libraries` surviving is the difference from `LibraryDAO.delete`, which cascades and takes
 * the encrypted WebDAV credential with it. A wrong password currently has no remedy but
 * re-registering the origin; this is the remedy.
 */
import type { IndexDropResult, IndexStats, LibraryIndexStats } from '@edge-sonic/backend-data/dao';

/**
 * The stores this service needs, as ports.
 *
 * Ports rather than DAO imports because `backend-services` is Layer 3 and holds no D1 binding
 * of its own — the composition root supplies them, which is what lets `test/` drive this
 * against doubles without a database. The projection and the drop are separate members
 * because they are separate operations on the same tables, and a caller that can ask the
 * price should not thereby gain the ability to charge it.
 */
interface IndexDropStore {
  /**
  What dropping these libraries' index would cost. Never writes.
  */
  statsForLibrary(libraryId: string): Promise<LibraryIndexStats>;
  /**
  What dropping these libraries' index would cost, per library and in total. Never writes.
  */
  statsAcrossLibraries(libraryIds: readonly string[]): Promise<IndexStats>;
  /**
  Destroy one library's index. Returns what it removed and what it billed.
  */
  dropLibrary(libraryId: string): Promise<IndexDropResult>;
  /**
  Destroy every library's index, leaving the registrations.
  */
  dropAll(): Promise<IndexDropResult>;
}

/**
 * The scan Durable Object, as far as a drop needs it.
 *
 * Two methods and no more, because a drop needs exactly two things from an object that owns a
 * scan loop: **stop it**, and **tell it what the drop spent**.
 *
 * Optional because the `SCAN` binding is not always configured — tests and local dev without
 * workerd take the direct-service path, which is the fallback every other scan route uses.
 */
interface ScanControl {
  /**
   * Delete the alarm and clear any held pause, without advancing the walk.
   *
   * Called **before** the D1 deletes, and that order is the point rather than a detail — see
   * `stopScan`.
   */
  reset(libraryId: string): Promise<void>;
  /**
   * Add rows to the object's count of today's billed D1 writes.
   *
   * The drop spends real allowance, and this counter is what paces the next scan. Not charging
   * it would let a rescan start believing it has headroom the platform has already refused,
   * which is how an account-wide outage is reached rather than survived.
   */
  charge(libraryId: string, billedRows: number): Promise<void>;
}

/**
 * What a drop did, as the operator surface reports it.
 *
 * `billedRows` is the **measured** figure from the `DELETE`s themselves, not the projection
 * the operator confirmed against. They agree unless the index moved while the dialog was open,
 * and when they disagree the measured one is what was actually spent — so it is the one
 * reported.
 */
interface IndexDropOutcome extends IndexDropResult {
  /**
  Libraries whose index was destroyed: 1 for a per-library drop.
  */
  readonly libraries: number;
}

class IndexDropService {
  constructor(
    private readonly store: IndexDropStore,
    /**
     * Resolves the scan object for one library, or `null` when the `SCAN` binding is absent.
     *
     * A resolver rather than the object because there is one object **per library** and this
     * service has no way to reach them; and a function rather than a nullable field because
     * "no binding configured" is the ordinary state in tests, where every call would otherwise
     * re-test it.
     *
     * **Optional**, and defaulted here rather than at the two call sites, because both of them
     * legitimately have none: `ScanWorkerFactory` is a Durable Object that cannot RPC itself,
     * and `apps/api` is the only place a namespace stub exists. A drop with no resolver still
     * works — the D1 deletes are the whole point of the operation — and there is simply no
     * alarm to stop and no day-counter to charge.
     */
    private readonly scanFor: (libraryId: string) => ScanControl | null = () => null,
  ) {}

  /**
  What dropping one library's index would cost. A read, and the only read below a drop.
  */
  public async statsForLibrary(libraryId: string): Promise<LibraryIndexStats> {
    return await this.store.statsForLibrary(libraryId);
  }

  /**
  What dropping these libraries' index would cost. A read.
  */
  public async statsAcrossLibraries(libraryIds: readonly string[]): Promise<IndexStats> {
    return await this.store.statsAcrossLibraries(libraryIds);
  }

  /**
   * Drop one library's index.
   *
   * Order: stop the scan, delete, charge. The reverse is a race, not a stylistic choice.
   *
   * A live `ScanWorker` alarm fires every second. If it fires between the `songs` delete and
   * the `nodes` delete, `step` finds a frontier describing rows that no longer exist, walks
   * the origin and writes fresh song rows — landing *after* the delete meant to have removed
   * them. The operator is told their index is empty and it is not.
   *
   * So the alarm is deleted first, from the same object that would otherwise fire it. That is
   * the only ordering that makes the result a function of this request rather than of when the
   * alarm happened to fire.
   *
   * A held **pause** is cleared at the operator's next read for the same request's sake:
   * `getStatus` overlays a held pause over the stored status, because D1 cannot know about a
   * pause entered *because* it was refusing writes. A pause surviving a drop would render
   * "paused until 00:00 UTC" over an empty library.
   *
   * The charge comes last, because it needs the figure the deletes actually billed.
   */
  public async dropLibrary(libraryId: string): Promise<IndexDropOutcome> {
    await this.stopScan(libraryId);
    const result = await this.store.dropLibrary(libraryId);
    await this.charge(libraryId, result.billedRows);
    return { ...result, libraries: 1 };
  }

  /**
   * Drop every library's index, leaving the registrations.
   *
   * `libraryIds` is passed rather than read here because only the caller knows what is
   * registered, and a service that guessed would have to read `libraries` — which after the
   * deletes is still correct, but before them is a statement this method would issue for no
   * reason when the caller has the list in hand from the request that rendered the page.
   *
   * Every object is stopped before the first delete, for `dropLibrary`'s reason times every
   * library: a library whose object is still armed when its songs are deleted re-indexes
   * itself, and an operator who asked for a clean database across four libraries would get
   * one of them quietly refilling.
   */
  public async dropAll(libraryIds: readonly string[]): Promise<IndexDropOutcome> {
    for (const libraryId of libraryIds) await this.stopScan(libraryId);
    const result = await this.store.dropAll();
    await this.chargeAcross(libraryIds, result.billedRows);
    return { ...result, libraries: libraryIds.length };
  }

  /**
   * Charge each object its **share** of the drop, not the whole of it.
   *
   * Two facts make the whole total wrong here. Each object's counter is its own day's spend,
   * and `dailyRowWriteShare` divides the allowance by the number of libraries — so an object
   * told "55,000 rows" would pause itself at 100% of a share sized for a quarter of that, and
   * a four-library deployment would have three of its four scans refuse immediately after
   * dropping an index.
   *
   * The share is proportional to what each library held, taken from the projection rather than
   * from the measured total: the `DELETE`s are unscoped, so `meta.changes` is one number for
   * all of them and cannot be attributed per library. The parts are then corrected to **sum to
   * the measured total** — each is floored, and the shortfall is given to the library with the
   * largest projection, which is where rounding loses the most.
   *
   * The correction is not cosmetic. Without it the counters would under-report the day's real
   * spend by up to `libraryIds.length - 1` rows, and the drift compounds across every drop
   * and every scan in the day — which is the under-count that `scanPause.ts` was rebuilt to
   * eliminate.
   *
   * A zero projection total means nothing was indexed and nothing was billed, so every share
   * is legitimately zero. That is the only way the ratio below is undefined, and it is
   * handled rather than divided through.
   */
  private async chargeAcross(libraryIds: readonly string[], measuredBilledRows: number): Promise<void> {
    if (libraryIds.length === 0 || measuredBilledRows <= 0) return;

    const projection = await this.store.statsAcrossLibraries(libraryIds);
    const weights = projection.libraries.map((entry) => Math.max(0, entry.stats.billedRows));
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);

    if (weightTotal <= 0) {
      // The projection said nothing was indexed, which the measurement contradicts — the index
      // grew while the dialog was open. Charging the whole thing to one object is the least
      // wrong answer available and it is the pessimistic one: an over-count costs throughput.
      const [heaviest] = libraryIds;
      if (heaviest !== undefined) await this.charge(heaviest, measuredBilledRows);
      return;
    }

    let assigned = 0;
    let heaviestIndex = 0;
    for (const [index, weight] of weights.entries()) {
      if (weight > weights[heaviestIndex]) heaviestIndex = index;
      const share = Math.floor((weight / weightTotal) * measuredBilledRows);
      assigned += share;
      const libraryId = libraryIds[index];
      if (libraryId !== undefined) await this.charge(libraryId, share);
    }

    const shortfall = measuredBilledRows - assigned;
    if (shortfall <= 0) return;
    const heaviest = libraryIds[heaviestIndex];
    if (heaviest !== undefined) await this.charge(heaviest, shortfall);
  }

  private async stopScan(libraryId: string): Promise<void> {
    await this.scanFor(libraryId)?.reset(libraryId);
  }

  private async charge(libraryId: string, billedRows: number): Promise<void> {
    if (billedRows <= 0) return;
    await this.scanFor(libraryId)?.charge(libraryId, billedRows);
  }
}

export { IndexDropService };
export type { IndexDropStore, ScanControl, IndexDropOutcome };
