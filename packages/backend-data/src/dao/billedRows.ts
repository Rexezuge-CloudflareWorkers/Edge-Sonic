/**
 * How many rows D1 *bills* for a write, as opposed to how many rows it changes.
 *
 * ### The two are different numbers, and the allowance is denominated in the first
 *
 * Cloudflare's D1 pricing page, definition 6 (page last updated 2026-04-21):
 *
 * > Indexes will add an additional written row when writes include the indexed column, as
 * > there are two rows written: one to the table itself, and one to the index.
 *
 * So the unit the **daily row-write allowance** is denominated in is a *billed row*: the
 * table row plus every index entry the statement had to rewrite. SQLite's `changes()` —
 * which is what a `D1Result.meta.changes` reports, and what this repository was counting —
 * is neither of those. It is the number of table rows the statement touched, and it is a
 * **lower bound** on the billed figure by a factor of `1 + (indexes on the table)`.
 *
 * For `songs` that factor is **10**: eight declared indexes plus the implicit unique index
 * SQLite creates for `id TEXT PRIMARY KEY`. A single `upsertFileFacts` insert is therefore
 * nine rows of work for one row of data, and `nodes` is four for one.
 *
 * ### Why this is a derivation and not a typed constant
 *
 * Because the count is a property of the schema, and a schema changes. A multiplier typed
 * beside a query is right until the first `CREATE INDEX`, after which it silently
 * under-counts — which is the same defect as `listIdsIn`'s batch size of 200 under a
 * comment asserting SQLite's limit was 999, and as `SCAN_CHUNK_FOLDERS = 40` documented as
 * a bound on D1 work when it was derived from the subrequest ceiling instead. A number
 * that is wrong is at least *visible*; a number that is wrong in the safe direction is
 * invisible for ever.
 *
 * So the table below is **asserted against the real migrated schema** in
 * `test/schema.int.test.ts`, which reads `sqlite_schema` and compares. Adding an index
 * turns that suite red until the count here is updated. This is the mechanism
 * `migrations.lock.json` already provides for applied migrations, applied to a different
 * fact: a file on disk that nothing checks is a file that drifts.
 *
 * ### Why `1 + indexes` and not the exact number of entries touched
 *
 * Because the exact number depends on *which columns a statement changes*, and that is a
 * property of each statement rather than of each table. An `INSERT` touches every index,
 * so `1 + indexes` is exact there. An `UPDATE` touches only the indexes covering the
 * columns it set, so `1 + indexes` over-charges — `applyMetadata` is charged ten and bills
 * about seven, because `idx_nodes_frontier`-style indexes on unchanged columns are not
 * rewritten.
 *
 * Over-charging is the direction this file is written in, for the reason
 * `SubrequestMeter` already argues at length: an over-count costs throughput, an
 * under-count costs the outage this whole allowance mechanism exists to prevent. Charging
 * the table's worst case is a bound, and a bound is what a budget needs.
 *
 * ### Why the count is *not* taken from D1
 *
 * `D1Meta.rows_written` is declared, real, and never read by this repository — and it
 * cannot be trusted as the source, because Cloudflare documents it only as "a total count
 * of the rows written by that query" and never says whether that count includes the index
 * entries definition 6 describes. Using it as the meter would make the daily budget
 * depend on an undocumented platform detail, and a budget that is correct only while an
 * assumption holds is the same class of defect as a constant that is correct only until
 * the next migration.
 *
 * So it stays unread, deliberately. The way to retire this model is to measure D1's own
 * figure against it on a real account — which is a one-off investigation, not code, and
 * not something to put a `console.warn` behind: a warning nobody can act on is a log line
 * that trains people to ignore the log.
 */

/**
 * Indexes per table, as the schema declares them.
 *
 * **Includes the implicit unique indexes SQLite creates for `PRIMARY KEY`**, which appear
 * in `sqlite_schema` as `sqlite_autoindex_*` with no SQL of their own and are easy to miss
 * when counting `CREATE INDEX` statements by eye. Every table here has one: no table in
 * this schema uses `INTEGER PRIMARY KEY`, which is the one form that gets the rowid
 * alias and creates no index at all. So `songs` is 9 and not 8, and `scan_state` is 1 and
 * not 0 — which matters, because the scan writes one `scan_state` row per chunk and the
 * budget for it is exactly the thing being corrected.
 */
const TABLE_INDEX_COUNTS: Readonly<Record<string, number>> = {
  users: 2,
  libraries: 2,
  user_libraries: 2,
  nodes: 3,
  songs: 9,
  scan_state: 1,
  playlists: 3,
  playlist_entries: 2,
  stars: 2,
  ratings: 1,
  bookmarks: 1,
  play_queue: 1,
  play_queue_entries: 1,
  play_counts: 1,
  now_playing: 1,
  auth_failures: 1,
  settings: 1,
  import_sources: 2,
  import_runs: 3,
  import_play_count_progress: 1,
};

/**
 * The most expensive table in the schema, and what an unrecognised statement is charged.
 *
 * A statement whose table cannot be read is charged **this**, not 1. A default of 1 is
 * precisely the bug this module exists to remove — silently under-counting the allowance
 * by an order of magnitude on a path that takes the whole product down at midnight UTC —
 * so the fallback has to be the pessimistic direction. It is also the direction that
 * costs nothing in correctness: a scan charged ten rows for a row that billed two is slow,
 * and a scan charged one is an outage.
 */
const MAX_BILLED_ROWS_PER_ROW = 1 + Math.max(...Object.values(TABLE_INDEX_COUNTS));

/**
 * The leading write verb of a statement, with any leading whitespace and `--` comments
 * skipped.
 *
 * Anchored at the **start** rather than searched for, because a bare
 * `/\bINSERT\s+INTO\s+(\w+)/i` would find a verb quoted inside a string literal or a
 * comment — `name = 'UPDATE users'` is a legal value for a column this schema carries.
 * The statements this repository writes are all a single leading verb, and anchoring is
 * what makes the failure mode "no match, charge the worst case" instead of "matched the
 * wrong word inside a string".
 */
const LEADING_WRITE_VERB = /^(?:INSERT|REPLACE|UPDATE|DELETE)\b\s*/i;

/**
 * The table named after that verb, skipping `OR <conflict-clause>`, `INTO` and `FROM`.
 *
 * `(?:OR\s+\w+\s+)?` rather than an enumeration of SQLite's five conflict clauses, because the
 * shape is uniform and listing five is five ways to be wrong the next time SQLite adds one. The
 * words it skips are structural, not data.
 *
 * Split from the verb match rather than combined, because combining them is what pushed the
 * single pattern past `sonarjs`'s complexity ceiling — and the complexity is not incidental: a
 * nested alternation over `OR IGNORE|REPLACE|ABORT|FAIL|ROLLBACK` is four extra branches that
 * have to be right for every statement. Two small patterns, each readable on its own.
 */
const TABLE_AFTER_VERB = /^(?:OR\s+\w+\s+)?(?:INTO\s+|FROM\s+)?["`[]?([A-Z_]\w*)/i;

/**
 * Leading whitespace and `--` comments, removed.
 *
 * A **loop, not one nested-quantifier pattern.** A pattern of the form "any number of
 * `spaces + comment + newline`, then whitespace" is the shape this repository has a standing rule
 * against — an unbounded quantifier wrapping another, over input nothing here controls — and
 * `eslint-plugin-regexp`'s `no-super-linear-backtracking` is silent on it by the same measurement
 * that left the slash-trailing pattern in `toLibraryPath` unguarded. A `while` over the comments is
 * visibly linear instead, and each pass strictly shortens the string.
 *
 * Line comments only, because that is every comment this repository writes inside a SQL string.
 * A C-style block comment would need a real lexer; none is written, so a statement carrying one
 * matches no verb and is charged the worst case — which errs safe.
 */
function stripLeadingNoise(sql: string): string {
  let rest = sql.replace(/^\s+/, '');
  while (rest.startsWith('--')) {
    const newline = rest.indexOf('\n');
    // A comment with no newline after it is a comment over the whole remainder, so there is no
    // verb left to find. Returning the empty string says exactly that, and `null` follows.
    if (newline === -1) return '';
    rest = rest.slice(newline + 1).replace(/^\s+/, '');
  }
  return rest;
}

/**
 * The table a statement writes, or `null` when it cannot be told.
 *
 * `null` rather than a default table, because the caller's next question is "how much does
 * this cost" and a fabricated answer to that is worse than admitting ignorance. Every
 * caller turns `null` into the pessimistic charge.
 */
function statementTable(sql: string): string | null {
  const stripped = stripLeadingNoise(sql);
  const verb = LEADING_WRITE_VERB.exec(stripped);
  if (verb === null) return null;
  const table = TABLE_AFTER_VERB.exec(stripped.slice(verb[0].length));
  return table === null ? null : table[1].toLowerCase();
}

/**
 * Billed rows for `logicalRows` writes to one table.
 *
 * Separate from {@link billedRowsFor} so a caller holding a table *name* — the schema
 * assertion in `test/schema.int.test.ts`, which has no statement — reaches the same
 * arithmetic rather than a second copy of it.
 */
function billedRowsForTable(table: string, logicalRows: number): number {
  if (logicalRows <= 0) return 0;
  // A table absent from the map is a **schema change nobody updated this for** — a new table, or
  // one that grew an index and had its entry forgotten. `test/schema.int.test.ts` asserts the
  // map equals the real schema, so in that suite it cannot happen; this branch is what a
  // deployment running a *newer* migration than the code sees, which is exactly when being
  // pessimistic is the only safe answer.
  const indexes = TABLE_INDEX_COUNTS[table] ?? (MAX_BILLED_ROWS_PER_ROW - 1);
  return logicalRows * (1 + indexes);
}

/**
 * Billed rows for a statement that changed `logicalRows` table rows.
 *
 * `statement` is a `D1PreparedStatement`, narrowed to the one field this reads: the SQL is
 * the only place the table is written down, and every statement this repository issues
 * names its own target. Taking the whole statement rather than a table name keeps the
 * caller from having to *know* the table — a caller-supplied table is a claim about a
 * statement, and a claim about a statement is wrong exactly when the statement is.
 */
function billedRowsFor(statement: { readonly sql: string }, logicalRows: number): number {
  const table = statementTable(statement.sql);
  return table === null ? logicalRows * MAX_BILLED_ROWS_PER_ROW : billedRowsForTable(table, logicalRows);
}

export { TABLE_INDEX_COUNTS, MAX_BILLED_ROWS_PER_ROW, statementTable, billedRowsForTable, billedRowsFor };