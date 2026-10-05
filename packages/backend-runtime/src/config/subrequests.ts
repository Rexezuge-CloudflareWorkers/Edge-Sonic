/**
 * The platform's subrequest ceilings, and every number in this codebase derived from them.
 *
 * ### The limit itself
 *
 * Workers Free allows **50 subrequests per invocation**. Workers Paid allows 10,000, raiseable
 * to 10M with `limits.subrequests`. Exceeding it does not slow a request down: the runtime
 * terminates the invocation, everything after the ceiling is lost, and the caller sees a
 * platform error rather than the product's masked envelope.
 *
 * ### There are TWO budgets, and this file spends both from one
 *
 * A subrequest is a request to the internet with `fetch`, **or** a request to a Cloudflare
 * service — R2, KV, D1, DO RPC. Those are counted separately, and the Workers limits page says
 * so:
 *
 * > Workers on the free plan remain limited to **50 external subrequests** and **1,000
 * > subrequests to Cloudflare services** per invocation.
 *
 * **Measured on a Free account on 2026-10-05, and confirmed:** 50 outbound `fetch` requests die
 * at the 51st; 1,000 D1 statements die at the 1,001st; 1,000 D1 statements *plus* 50 outbound
 * requests in one invocation survive together. A Durable Object reached by RPC runs on a fresh
 * budget, and the caller's ceiling is untouched by whatever the callee spent.
 *
 * So `WORKER_SUBSREQUEST_CEILING` below is the **external** ceiling, and this file deliberately
 * charges D1 and KV against it anyway. Full account, including the measurements and the
 * reasoning this replaces: `docs/issues/subrequest-budgets-are-two-not-one.md`.
 *
 * That choice is now **conservatism rather than correction**, and the distinction matters to the
 * next reader. The previous text here claimed the pessimistic reading was forced by the
 * platform; the measurement shows it was not. `SCAN_CHUNK_MAX_REQUESTS` is roughly 21× more
 * conservative than the D1 statements it bounds. Nothing is broken by that — a ceiling that is
 * too small costs throughput, which is the direction that cannot take the product down — but
 * anyone deciding whether to raise it is being told something false, so the reason is stated
 * rather than left to be re-derived.
 *
 * ### The two ceilings also fail differently, and only one is catchable
 *
 * An **external** overrun kills the invocation with no catchable error. A **D1** overrun
 * *throws* — `Too many API requests by single Worker invocation` — and an ordinary `catch` sees
 * it. That asymmetry is not licence to catch and continue: a swallowed limit is still a limit,
 * and handling it has converted a loud failure into a quiet one. It does mean a D1 overrun is
 * diagnosable where an external one is not, which is what `D1ErrorClassifier` exists to exploit.
 *
 * ### Why there is no plan switch
 *
 * There is deliberately no `WORKER_PLAN=free|paid` variable and no `limits.subrequests` in the
 * deployment template. A second knob is a second thing that can be set wrong, and this
 * deployment targets Workers Free: one ceiling, stated once, with every bound below derived
 * from it by arithmetic rather than typed beside the code that has to honour it. That is the
 * same rule `bindChunkSize` follows from D1's 100-parameter ceiling, and it is the whole
 * transferable part of the defect this file exists for.
 */

/**
 * Subrequests one Worker invocation may issue on the Free plan.
 *
 * **The external ceiling**, and the platform number rather than a choice. `50`.
 *
 * D1, KV and DO RPC have 1,000 of their own — measured, and recorded above. They are charged
 * against this one deliberately, so a chunk's budget is bounded by the resource that cannot be
 * handled when it runs out.
 */
const WORKER_SUBSREQUEST_CEILING = 50;

/**
 * What an invocation spends on itself, before any feature work.
 *
 * Authentication, the Subsonic envelope's reads, `scan_state`, the library grant. A chunk that
 * budgets the full 50 discovers this by dying — the ceiling does not arrive with an error the
 * chunk can catch, so the reserve has to be a number that is subtracted rather than a margin
 * that is hoped for.
 *
 * Eight, not two: the authenticated `/rest` path is a user lookup, a throttle read, a library
 * grant read and a `scan_state` read before a single endpoint statement, and `POST
 * /user/libraries/:id/scan/step` pays for the operator's session as well.
 */
const SUBSREQUEST_INVOCATION_RESERVE = 8;

/**
 * What one scan chunk may spend: the ceiling less the invocation's own overhead.
 *
 * **This is the number `SCAN_CHUNK_MAX_REQUESTS` defaults to**, and it is a *total* — D1
 * statements, KV operations and WebDAV requests alike. It used to be a WebDAV-only budget of
 * `40`, which is why a chunk of `40` folders cost the platform about 240 and every chunk on a
 * Free account died at the ceiling.
 */
const SCAN_CHUNK_SUBSREQUEST_BUDGET = WORKER_SUBSREQUEST_CEILING - SUBSREQUEST_INVOCATION_RESERVE;

/**
 * D1 statements one folder costs before any of its children are counted.
 *
 * The fixed part of `reconcileFolder`, and every one of these is a statement:
 * `listChildren` to diff against, `upsertMany` for the folder's own row, `upsertFileFacts` for
 * the folder's songs, `listChildren` again for the prune's `vanished` set, and
 * `deleteInDirectoryNotIn`. Plus the one external `PROPFIND` that produced the listing.
 *
 * Six. It is a *base*, not a total: a folder's children are counted individually by
 * `runWriteBatch`, which is why this constant shapes how many folders a chunk attempts rather
 * than bounding what one costs.
 */
const SUBSREQUESTS_PER_FOLDER_BASE = 6;

/**
 * Subrequests one track's enrichment costs.
 *
 * Five, and this is the number that was wrong by the most. `MAX_REQUESTS_PER_TRACK` was `2`,
 * counting a prefix read and a tail read — the two **external** requests. The same track also
 * costs a `songMeta` KV read, a D1 `applyMetadata`, and a `songMeta` KV write, so it is five.
 * On a cold scan that is the difference between a chunk that finishes and one that is killed
 * partway through its first album.
 */
const SUBSREQUESTS_PER_ENRICHED_TRACK = 5;

/**
 * Statements a chunk spends that belong to no folder.
 *
 * Four, and the count is the whole reason the backfill's page is 32 rather than the 35 a
 * reader is likely to reach for first. One chunk spends:
 *
 * | Statement                                   | Spent by            |
 * | ------------------------------------------- | ------------------- |
 * | `scanState.ensure`                          | `step`, first       |
 * | `listNeedingDerivation`                     | the backfill, first |
 * | `listFrontier`                              | `step`, before the walk |
 * | `saveProgress`                              | `step`, after the walk  |
 *
 * The two bracket the walk, so a page sized without counting them leaves five of a folder's
 * six, the loop's `canAfford(SUBSREQUESTS_PER_FOLDER_BASE)` refuses, and the chunk returns
 * `scanning` having visited **zero** folders — a scan that reports progress and never moves,
 * which is the defect `SCAN_DERIVE_MAX_ROWS_PER_CHUNK` exists to make structurally
 * impossible. A bound that is satisfied on paper and leaves the walk nothing is not a bound.
 */
const SUBSREQUESTS_PER_CHUNK_OVERHEAD = 4;

/**
 * Rows the derivation backfill may stamp in one chunk.
 *
 * One statement per row — `APPLY_DERIVATION` is a per-row `UPDATE`, not a set-based one — plus
 * the read that selected them, and `applyDerivation` passes `requireComplete`, so the page
 * must fit **whole** or the DAO refuses rather than truncating. That refusal is right: the
 * selection is on `derived_version`, so a partial page leaves rows stamped and rows not
 * stamped, and the un-stamped ones are re-selected on every poll for ever.
 *
 * Which makes the page size a *bound the chunk budget imposes*, not a number chosen for how
 * fast a library repairs. It was `200`, against a chunk budget of 42 and a platform ceiling
 * of 50 — so it could never fit, on any chunk, under any configuration. A library with more
 * than ~48 rows owing a derivation therefore threw `SubrequestBudgetExhaustedError` from the
 * backfill on every poll, before `listFrontier`, which meant the walk never ran, which
 * `step`'s catch recorded as a scan failure. See `deriveBackfill.ts`.
 *
 * `SUBSREQUESTS_PER_FOLDER_BASE` is held back so a chunk that spends its whole backfill
 * allowance still visits one folder. The arithmetic is asserted as a relationship rather
 * than as this numeral in `test/subrequest-budget.test.ts`.
 */
const SCAN_DERIVE_MAX_ROWS_PER_CHUNK = Math.max(
  1,
  SCAN_CHUNK_SUBSREQUEST_BUDGET - SUBSREQUESTS_PER_CHUNK_OVERHEAD - SUBSREQUESTS_PER_FOLDER_BASE,
);

/**
 * Folders one chunk attempts before the walk's own bookkeeping is accounted for.
 *
 * Derived, never chosen: `SCAN_CHUNK_FOLDERS` used to be `40`, documented as a bound on D1
 * *row writes* against the 5,000-rows/day allowance, which it still is — but a chunk also
 * spends the subrequest ceiling on those same folders, and 40 of them cannot fit in 42
 * subrequests however few tracks they hold.
 *
 * It remains a bound worth having for its own sake: it stops a chunk that is doing nothing but
 * cheap metadata work from spending the whole poll on one level of the tree.
 */
const SCAN_CHUNK_FOLDER_LIMIT = Math.max(1, Math.floor(SCAN_CHUNK_SUBSREQUEST_BUDGET / SUBSREQUESTS_PER_FOLDER_BASE));

/**
 * Tracks one folder's enrichment may attempt, as a bound on a folder's *shape*.
 *
 * Derived from the chunk budget the same way, and it is deliberately not the binding
 * constraint — `ScanBudget.canAfford` decides what actually gets enriched, per track, and this
 * only stops one album of 500 tracks from taking every poll for itself.
 */
const SCAN_ENRICH_MAX_PER_FOLDER = Math.max(1, Math.floor(SCAN_CHUNK_SUBSREQUEST_BUDGET / SUBSREQUESTS_PER_ENRICHED_TRACK));

/**
 * How many groups a page of results may carry, derived from the statement budget.
 *
 * ### Why this replaces the number it replaces
 *
 * `MAX_PAGE_SIZE_CEILING` was `2200`, derived from the right principle — a page of N album
 * groups costs one grouped query plus `ceil(N / groupsPerStatement)` further statements — but
 * from a quantity that does not bound what the page *spends*. The follow-on statement count is
 * driven by the page's **track** count, not its group count: `songsForAlbumDirs` binds two
 * variables per album directory, so a page of 2,200 albums with twelve tracks each fetches
 * 26,400 rows in `ceil(2200 / 49)` = 45 statements before the annotation reads are counted at
 * all. Deriving a ceiling from the group count alone is the same defect as deriving a chunk
 * size from the folder count alone.
 *
 * So the arithmetic below counts every statement class a page actually issues:
 *
 * | Class                                | Statements                        |
 * | ------------------------------------ | --------------------------------- |
 * | the grouped aggregate query          | 1                                  |
 * | the album keys                       | `ceil(N / albumKeysPerStatement)`  |
 * | the songs of those albums            | `ceil(N / albumsPerStatement)`    |
 * | annotations (stars, ratings, marks)  | `3 × ceil(N / idsPerStatement)`    |
 *
 * with the three denominators derived from D1's 100-parameter ceiling rather than typed, and
 * the numerator set to the chunk budget so a page and a scan chunk are sized against the same
 * number. `2200 × (1/99 + 1/49 + 3/99) ≈ 100` statements — over the ceiling by half, which is
 * how a ceiling derived to be "conservative" ended up unservable.
 */

/**
Album keys per statement: one bound variable each, plus `library_id`.
*/
const PAGE_ALBUM_KEYS_PER_STATEMENT = 99;

/**
Album directories per statement: two bound variables each, plus `library_id`.
*/
const PAGE_ALBUMS_PER_STATEMENT = 49;

/**
Ids per annotation statement: one each, plus `library_id`.
*/
const PAGE_IDS_PER_STATEMENT = 99;

/**
The three annotation reads every list endpoint makes for the page's ids.
*/
const PAGE_ANNOTATION_READS = 3;

/**
The statements a page costs that do not scale with its size.
*/
const PAGE_FIXED_STATEMENTS = 4;

/**
 * Statements per group in a page of results.
 *
 * The marginal rate, not the total: one group's own key read plus its songs plus its three
 * annotation reads.
 */
const PAGE_STATEMENTS_PER_GROUP = 1 / PAGE_ALBUM_KEYS_PER_STATEMENT + 1 / PAGE_ALBUMS_PER_STATEMENT + PAGE_ANNOTATION_READS / PAGE_IDS_PER_STATEMENT;

/**
 * Rows D1 accepts written per day on the Free plan.
 *
 * The platform number, not a choice. `5,000`.
 *
 * And since 2026-09-01 it is **enforced**: Cloudflare fails every query on the database,
 * reads included, until the allowance resets at midnight UTC. So this is not a throughput
 * number that degrades a scan into "takes a couple of days" — it is the boundary between a
 * slow product and an unreachable one, which is why the scan now paces itself against it
 * (`SCAN_DAILY_ROW_WRITE_BUDGET`) rather than discovering it.
 */
const D1_DAILY_ROW_WRITE_LIMIT = 5000;

/**
 * Rows the scan leaves alone for everything that is not a scan.
 *
 * The scan is not the only writer: a client stars a track, rates it, saves a play queue or a
 * playlist, a failed login increments the credential throttle, a completed scan bumps
 * `index_version`. Those are all rows against the same daily allowance, and the scan is by
 * far the largest consumer of it — so the scan's budget is the allowance **less** what
 * everything else might need.
 *
 * A thousand is a reserve, not a derivation: there is no arithmetic that produces it, and
 * pretending otherwise would be the "a number typed beside a query is wrong by the time
 * somebody raises a page size" defect in a new place. What *is* load-bearing is that it is
 * non-zero, and that is asserted as a relationship in `test/subrequest-budget.test.ts` —
 * because a zero reserve makes the two constants below identical, and a scan that may spend
 * the entire allowance leaves nothing for the stars a client presses while it runs.
 */
const D1_DAILY_ROW_WRITE_RESERVE = 1000;

/**
 * Rows one scan may write per UTC day, across every library on the account.
 *
 * D1's allowance is per **account**, not per database, so a per-library budget is unsound the
 * moment a second library exists: two libraries each capped at the whole allowance write
 * twice it. So the scan takes a *share*, derived from the number of libraries actually
 * registered — which `ScanWorker` already reads, because it looks the library up before every
 * chunk, so dividing by it costs nothing.
 *
 * One library (the ordinary deployment) therefore gets the whole budget, and N libraries
 * together cannot exceed it. That is the direction the arithmetic has to err in: a pessimistic
 * share makes a scan take longer, and the cost of that is time, while an optimistic one is an
 * outage until midnight UTC.
 */
const SCAN_DAILY_ROW_WRITE_BUDGET = D1_DAILY_ROW_WRITE_LIMIT - D1_DAILY_ROW_WRITE_RESERVE;

/**
 * One library's share of the day's row-write budget.
 *
 * `max(1, …)` so that a day still gets a budget when the share would round to zero — which is
 * what a hundred libraries on the Free plan would produce. A scan that may write nothing a day
 * never completes, and a scan that cannot complete is the same class of permanent failure this
 * whole mechanism exists to avoid; so at that scale the budget degrades to "slow", deliberately,
 * and the reactive pause in `D1ErrorClassifier` is what stops it going further.
 */
function dailyRowWriteShare(enabledLibraries: number): number {
  return Math.max(1, Math.floor(SCAN_DAILY_ROW_WRITE_BUDGET / Math.max(1, Math.floor(enabledLibraries))));
}

/**
 * The largest page this server will accept, whatever `MAX_PAGE_SIZE` says.
 *
 * Derived from the ceiling and the measured statement denominators, floored so the answer is a
 * whole number of groups and **capped at the protocol's own maximum** — there is no answer
 * above 500 that is better than 500, so a derivation that produced 625 must not widen the
 * surface to reach it.
 */
const MAX_PAGE_SIZE_CEILING = Math.min(500, Math.max(1, Math.floor((SCAN_CHUNK_SUBSREQUEST_BUDGET - PAGE_FIXED_STATEMENTS) / PAGE_STATEMENTS_PER_GROUP)));

/**
 * The statement count `MAX_PAGE_SIZE_CEILING` implies.
 *
 * Exported so a test can assert the relationship rather than the numeral: the derivation is
 * the invariant, and a test that pinned `2200` would have passed while the derivation was
 * wrong.
 */
function pageStatementCount(groups: number): number {
  const n = Math.max(0, Math.floor(groups));
  return (
    PAGE_FIXED_STATEMENTS +
    Math.ceil(n / PAGE_ALBUM_KEYS_PER_STATEMENT) +
    Math.ceil(n / PAGE_ALBUMS_PER_STATEMENT) +
    PAGE_ANNOTATION_READS * Math.ceil(n / PAGE_IDS_PER_STATEMENT)
  );
}

export {
  WORKER_SUBSREQUEST_CEILING,
  SUBSREQUEST_INVOCATION_RESERVE,
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SUBSREQUESTS_PER_FOLDER_BASE,
  SUBSREQUESTS_PER_ENRICHED_TRACK,
  SUBSREQUESTS_PER_CHUNK_OVERHEAD,
  SCAN_DERIVE_MAX_ROWS_PER_CHUNK,
  SCAN_CHUNK_FOLDER_LIMIT,
  SCAN_ENRICH_MAX_PER_FOLDER,
  D1_DAILY_ROW_WRITE_LIMIT,
  D1_DAILY_ROW_WRITE_RESERVE,
  SCAN_DAILY_ROW_WRITE_BUDGET,
  dailyRowWriteShare,
  PAGE_ALBUM_KEYS_PER_STATEMENT,
  PAGE_ALBUMS_PER_STATEMENT,
  PAGE_IDS_PER_STATEMENT,
  PAGE_ANNOTATION_READS,
  PAGE_FIXED_STATEMENTS,
  PAGE_STATEMENTS_PER_GROUP,
  MAX_PAGE_SIZE_CEILING,
  pageStatementCount,
};