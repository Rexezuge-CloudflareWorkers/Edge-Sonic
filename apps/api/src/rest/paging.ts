/**
 * How far into a result set a request may page.
 *
 * ### Why an offset needs a ceiling at all
 *
 * The protocol pages with `offset`, and `SubsonicParams.int` defaults its maximum to
 * `MAX_SAFE_INTEGER` — which is a *parse* bound, not a *page* bound. Two endpoints then added the
 * offset to their limit and asked the database for that many rows:
 *
 * ```
 * getSongsByGenre   SELECT … LIMIT (count + offset) OFFSET 0
 * runSearch         SELECT … LIMIT (limit + offset) OFFSET 0
 * ```
 *
 * So `?genre=Rock&offset=9007199254740991` asked D1 for the entire matching set, and the caller
 * then threw almost all of it away with `slice(offset, offset + count)`. That is a
 * rows-read-amplification vector built out of one query parameter, on the two endpoints a client
 * polls most, against a plan that bills reads and a runtime with a fixed memory ceiling.
 *
 * ### Derived from the page ceiling, never typed
 *
 * The bound is `OFFSET_PAGES × maxPage`, and `maxPage` is the deployment's clamped
 * `MAX_PAGE_SIZE`. So the answer moves when the limit moves, and it cannot drift from it: a
 * constant beside the query is a constant that is wrong by the time somebody raises the page size.
 *
 * The multiple is small and stated. A client paging through a UI reaches a few dozen pages; beyond
 * that the honest answer is an empty page, which is what a client renders as "no more results" —
 * so the ceiling does not truncate anything a real client asks for, and it turns a query that read
 * the whole table into one that reads a bounded page.
 */
const OFFSET_PAGES = 20;

/**
 * The largest `offset` this request may carry, given the page size it will also carry.
 *
 * Derived rather than clamped-after-the-fact so the number the statement binds and the number the
 * parser accepted are the same one.
 */
function maxOffsetFor(maxPage: number): number {
  return Math.max(1, Math.trunc(maxPage)) * OFFSET_PAGES;
}

export { OFFSET_PAGES, maxOffsetFor };
