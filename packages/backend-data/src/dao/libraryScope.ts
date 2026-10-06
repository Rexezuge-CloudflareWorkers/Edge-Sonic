/**
 * Which libraries a read is scoped to.
 *
 * ### Why this is a type rather than an argument
 *
 * A user may be granted several libraries, and the aggregates a client browses — albums,
 * artists, genres, search — answer for **all** of them rather than the first. So a read that
 * takes `libraryId: string` cannot express the union, and the two ways of fixing that are both
 * bad: a parallel `listAlbumsAcrossLibraries` beside `listAlbums` is two implementations of one
 * query, free to disagree about the `WHERE` that decides what a row is; and threading
 * `readonly string[]` through every signature breaks every call site that legitimately has one
 * library, including most of the suite.
 *
 * A union widens the **type** without widening the call: `listAlbums(libraryId, …)` still
 * compiles and still means *that one library*, and `listAlbums([a, b], …)` means their union.
 * One implementation, two spellings — the same shape `SongIdLookupDAO` already has in
 * `listIdsIn` / `listIdsAcrossLibraries`, and for the same reason: the per-user records there
 * are not scoped to one library, and narrowing them was a silent data loss.
 *
 * ### `IN (?)` rather than `= ?`, deliberately
 *
 * One element renders as `library_id IN (?)`, which is `=` to the planner and still uses an
 * index whose leading column is `library_id` — asserted by `EXPLAIN QUERY PLAN` in
 * `test/schema.int.test.ts`, because a predicate that is right and one that is merely
 * equivalent return identical rows and the plan is the only instrument that tells them apart.
 *
 * ### And the bind budget moves with it
 *
 * `library_id IN (?, ?, …)` binds **one variable per library**, so every batch size derived from
 * `bindChunkSize` has to reserve `scope.length` rather than a single one. That is the quiet
 * version of the D1 bind ceiling defect this package has shipped twice: the arithmetic fits
 * and the statement is still one variable over, and the database refuses it rather than the
 * arithmetic noticing. So {@link libraryScope} is the only thing that computes the reservation,
 * and no caller writes the count itself.
 */

/**
 * One library, or the union of several. A bare string is the single-library case.
 */
type LibraryScope = string | readonly string[];

/**
 * The ids in a scope, always as a list — so a caller has one shape to iterate.
 */
function libraryIds(scope: LibraryScope): readonly string[] {
  return typeof scope === 'string' ? [scope] : scope;
}

/**
 * The reserved bind variables a statement scoped to `scope` spends on its library list.
 *
 * `LIMIT` and `OFFSET` are reserved here too, because every paged aggregate binds both, and
 * forgetting them is exactly the failure the reserve exists to prevent. A statement that binds
 * neither over-reserves, which costs one row of batch — the safe direction, and the reason this
 * is a single default rather than a parameter each call site could get wrong.
 */
function libraryReserve(scope: LibraryScope, paging = false): number {
  return libraryIds(scope).length + (paging ? 2 : 0);
}

/**
 * The `WHERE` fragment and its bound values for a scope.
 *
 * **A singleton renders as `=`**, not `IN (?)`. It is the same plan, but it keeps the common
 * query text identical to what it was, so an `EXPLAIN QUERY PLAN` assertion written against the
 * single-library form keeps meaning what it said.
 */
function libraryScope(scope: LibraryScope, column = 'library_id'): { sql: string; values: readonly string[] } {
  const ids = libraryIds(scope);
  if (ids.length === 1) return { sql: `${column} = ?`, values: ids };
  // An empty scope selects nothing, and says so as a predicate rather than as SQL that would
  // be true of every row: `IN ()` is a syntax error, and dropping the clause would turn "this
  // user can see no library" into "every library".
  if (ids.length === 0) return { sql: '0 = 1', values: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, values: ids };
}

export { libraryScope, libraryIds, libraryReserve };
export type { LibraryScope };
