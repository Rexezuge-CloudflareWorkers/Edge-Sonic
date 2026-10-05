/**
 * The platform's subrequest ceiling, and every number in this codebase derived from it.
 *
 * ### The limit itself
 *
 * Workers Free allows **50 subrequests per invocation**. Workers Paid allows 10,000, raiseable
 * to 10M with `limits.subrequests`. A subrequest is any request a Worker makes with the Fetch
 * API **or to a Cloudflare service — R2, KV and D1 included**. D1 says so on its own limits
 * page:
 *
 * > Queries per Worker invocation (read subrequest limits) — 1000 (Workers Paid) / **50 (Free)**
 *
 * Exceeding it does not slow a request down and does not raise a catchable error: the runtime
 * terminates the invocation with `Too many subrequests by single Worker invocation`. Everything
 * after the ceiling is lost, and the caller sees a platform error rather than the product's
 * masked envelope.
 *
 * ### The two doc pages that disagree, and what this file does about it
 *
 * Cloudflare's Workers limits page carries a second row, *Subrequests to internal services:
 * 1,000 on Free*, which reads as "D1 and KV have their own budget". This repository spent a
 * long time believing that — `scanBudget.ts` and `docs/agents/runtime/AGENTS.md` both stated it,
 * and `ScanBudget` therefore metered `fetch` alone. D1's page, updated more recently on the
 * subrequests point, contradicts it.
 *
 * **This file takes the pessimistic reading and charges D1 and KV against the 50.** Two
 * reasons, and the second is the one that decides it:
 *
 * 1. The D1 page is the specific authority for D1, and it names the subrequest limit.
 * 2. The cost of being wrong is not symmetric. A ceiling sized for 1,000 that is really 50
 *    kills invocations; a ceiling sized for 50 that is really 1,000 only makes the scan
 *    slower. "Free must work, even if slow" resolves the ambiguity in the direction that
 *    cannot take the product down.
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
 * The platform number, not a choice. `50`.
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
  PAGE_ALBUM_KEYS_PER_STATEMENT,
  PAGE_ALBUMS_PER_STATEMENT,
  PAGE_IDS_PER_STATEMENT,
  PAGE_ANNOTATION_READS,
  PAGE_FIXED_STATEMENTS,
  PAGE_STATEMENTS_PER_GROUP,
  MAX_PAGE_SIZE_CEILING,
  pageStatementCount,
};