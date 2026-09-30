/**
 * How many values one D1 statement may bind.
 *
 * ### The number is measured, and the measurement is the whole point
 *
 * D1 caps bound parameters per query at **100**. That is not SQLite's default: SQLite has
 * used `SQLITE_MAX_VARIABLE_NUMBER = 32766` since 3.32.0, and the `999` that predates it
 * is still what most of the literature quotes. So a query written against "SQLite's
 * limit" is written against a limit this database does not have, and it fails at a
 * tenth of the size its author expected.
 *
 * Measured against a live D1 on 2026-09-29, through `getAlbumList2`, which binds two
 * variables per album group:
 *
 * | album groups | bound variables | result                                    |
 * | ------------ | --------------- | ----------------------------------------- |
 * | 49           | 99              | `ok`                                      |
 * | 50           | 101             | `D1_ERROR: too many SQL variables`        |
 *
 * 99 succeeds and 101 fails, which brackets the ceiling at 100.
 *
 * ### What it cost
 *
 * It shipped as a masked `code=0` on the endpoint a player calls to draw its album list,
 * and it was not specific to one client or one page size: **any** request for 50 or more
 * albums failed, and `MAX_PAGE_SIZE` is 500, so the server was required to accept requests
 * it could not answer. `songsForAlbumKeys` bound two variables per group, `listArtists`
 * one per artist, and `listIdsIn` chunked at 200 with a comment asserting 999 — a guard
 * that was real and whose stated budget was fiction, at twice the ceiling.
 *
 * ### Why `999` is the number to watch for
 *
 * Every one of those sites had a *reason* for not chunking, and each reason was a
 * misapplied fact: "the page size is bounded by the request's own `size` parameter", which
 * bounds it at 500. The instinct was right — an unbounded `IN` list must be chunked — and
 * the budget was wrong. So the rule here is narrower than "chunk your queries": **derive
 * the batch size from this constant, never choose it.** `bindChunkSize` exists so the
 * arithmetic is written once and asserted once, and so a page size raised tomorrow cannot
 * silently re-break a query written correctly today.
 */

/**
 * The ceiling, measured above. Do not raise this without measuring it again.
 */
const D1_MAX_BIND_PARAMETERS = 100;

/**
 * How many rows of `varsPerRow` variables fit in one statement.
 *
 * `reserved` is the number of variables the statement binds *besides* the list — a
 * `library_id`, a `LIMIT`, an `OFFSET`. Forgetting it is the quiet version of this bug: the
 * batch fits in the arithmetic and is one variable over in the database.
 *
 * Floors rather than rounds, and clamps at 1 so a caller asking for more variables per row
 * than the ceiling allows gets a one-row batch that still runs, instead of an empty array
 * that silently returns nothing. A wrong page of zero rows is a much worse failure than a
 * slow one.
 */
function bindChunkSize(varsPerRow: number, reserved = 1): number {
  if (varsPerRow < 1) throw new RangeError(`varsPerRow must be at least 1, got ${varsPerRow}`);
  return Math.max(1, Math.floor((D1_MAX_BIND_PARAMETERS - reserved) / varsPerRow));
}

export { D1_MAX_BIND_PARAMETERS, bindChunkSize };
