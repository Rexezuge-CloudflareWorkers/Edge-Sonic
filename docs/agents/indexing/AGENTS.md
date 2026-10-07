# Edge-Sonic — The Index

Scope: D1, the DAOs in `packages/backend-data`, and the migrations that create the
schema. Reads for: anyone writing or changing SQL, or adding a migration.

Two platform numbers govern everything here and neither is a choice: D1 binds **100
parameters** per statement (Node's SQLite allows 32,766, which is why the test double has
to enforce it), and a write is billed as the row **plus every index entry it rewrote**.
The first is why a page of 500 albums is several statements; the second is why the daily
row-write allowance runs out in a couple of hours of scanning.

## The schema

Three migrations, in Wrangler's order: `migrations/0008_squash.sql` (the baseline — 17
tables), `migrations/0009_subsonic_import.sql` (3 more), and
`migrations/0010_drop_token_epoch.sql` (drops one column from `users`, and changes nothing
else). **20 tables, 40 index entries** — 20 declared and 20 implicit `sqlite_autoindex_*`,
because a `TEXT PRIMARY KEY` is one. `PRAGMA foreign_key_check` is clean.

| Table | Index entries | Billed rows per written row |
| --- | ---: | ---: |
| `songs` | 9 | **10** |
| `nodes`, `playlists`, `import_runs` | 3 | 4 |
| `users`, `libraries`, `user_libraries`, `playlist_entries`, `stars`, `import_sources` | 2 | 3 |
| the other nine | 1 | 2 |

Those counts live in `dao/billedRows.ts` and are asserted **both ways** against the real
`sqlite_schema` in `test/schema.int.test.ts`, so a migration that adds an index turns the
suite red rather than quietly halving the budget.

Batch sizes are **derived**, never typed: `bindChunkSize(varsPerRow)` at
`dao/sqlLimits.ts` is the single place the 100-parameter ceiling is turned into a number.

## Normalisation, and the fourteen columns that do not obey it

The schema is in **3NF** apart from fourteen deliberate exceptions. No table here is split,
joined or restructured to reach 3NF, and the reason that is a sentence rather than a project is
the last paragraph of this section. The exceptions are columns, in two kinds, and they are not
the same kind of problem:

| Deviation | Columns | Why it exists |
| --- | ---: | --- |
| `_ci` twins | 10 | an indexable lowercased twin, because `lower(col)` cannot use one |
| stored aggregates | 4 | a number the writer already holds and the reader would re-derive |

**The 10 `_ci` columns** are transitive dependencies on their twin — `name → name_ci` — and are
the textbook violation. Enumerated from `PRAGMA table_info` over both applied migrations, not
from grep, so the count is the schema's:

`users.username_ci` · `libraries.slug_ci` · `import_sources.username_ci` · `nodes.name_ci` ·
`songs.{name,title,artist,album,album_artist,genre}_ci`

They back **nine declared indexes**, which is the whole reason they are stored rather than
computed — `idx_songs_album` alone needs two of them, and it is the index that keeps
`getArtists`/`getAlbumList2` from sorting on every request:

| Table | Index | `_ci` columns |
| --- | --- | ---: |
| `songs` | `idx_songs_album` | **2** |
| `songs` | `idx_songs_artist` | 1 |
| `songs` | `idx_songs_genre` · `idx_songs_title_ci` · `idx_songs_album_title_ci` | 1 each |
| `nodes` | `idx_nodes_parent_ci` | 1 |
| `users` | `idx_users_username_ci` | 1 |
| `libraries` | `idx_libraries_slug_ci` | 1 |
| `import_sources` | `idx_import_sources_username_ci` | 1 |

**The 4 aggregates** are `playlists.song_count`, `playlists.duration`,
`scan_state.scanned_count` and `scan_state.total_count` — each derivable from
`playlist_entries`/`nodes`, and each recomputed by a writer that already holds the number:
`refreshTotals` folds both playlist totals into the same statement as the entry write, and
`listVisible` returns them for free from `SELECT *`. Recomputing them on read costs a
correlated subquery per playlist against the 50-subrequest Free ceiling, on the one query that
renders a playlist list.

### The obvious refactor is a behaviour regression, and this is the measurement for it

Both standard replacements work, and both are wrong here. `COLLATE NOCASE` with a `UNIQUE`
constraint rejects `Alice`/`alice` and uses a covering index; `GENERATED ALWAYS AS
(lower(col)) STORED` indexes cleanly. Neither is equivalent to what is stored, because the
twins hold **JavaScript's** `toLowerCase()` and SQLite's `lower()` and `NOCASE` are ASCII-only:

| Input | JS `toLowerCase()` | SQLite `lower()` | `NOCASE` equal? |
| --- | --- | --- | ---: |
| `MiXeD` | `mixed` | `mixed` | 1 |
| `ÉCLAIR` | `éclair` | `Éclair` | **0** |
| `İSTANBUL` | `i̇stanbul` | `İstanbul` | **0** |
| `ΣΊΣΥΦΟΣ` | `σίσυφος` | `ΣΊΣΥΦΟΣ` | **0** |

Measured on **3.53.4** — the engine `test/helpers/sqlite.ts` runs the suite against, and the
version the `ADD COLUMN IF NOT EXISTS` finding below was measured on. D1's *build* has not been
measured for this, and the difference between the two has cost this repository a defect before;
treat a claim about D1 from this table as unproven.

So a mechanical normalisation does not make the schema tidier, it makes `Éclair` and
`éclair` two different users, and drops the nine indexes on the way past.

### Three more deviations that are structural rather than columnar

These are the ones a "just normalise it" request usually means, and each has a stated reason:

- **`nodes.parent_path` rather than a `parent_id` self-reference.** A `parent_id` costs a join
  on every `getIndexes`, which is the tree walk the browser drives; `idx_nodes_parent_ci` reads
  as `(library_id, parent_path, name_ci)` and answers it from one index.
- **`songs.{name,name_ci,dir_path}` duplicate `nodes.{name,name_ci,parent_path}`.** A genuine
  cross-table redundancy — same key, same values. `dir_path` is the one that has to be on
  `songs`, because it is how an album resolves to its tracks and therefore how an `alk:` id is
  derived; the other two are duplication kept to avoid the join on every song read.
- **`stars`/`ratings` keep `item_id` + `item_type` instead of one table per type.** The ids are
  derived, never minted, so a polymorphic column is what lets a deleted-and-rescanned library
  re-attach every star. Three typed tables would orphan all of them — the same conclusion
  `indexDrop` already rests on.

`import_runs.{phases_json,report_json}` is a **1NF** question rather than a 3NF one, and is
answered on write volume: a report nobody queries by item is thousands of writes against a
5,000-rows/day allowance to store as rows what one column holds.

### Why none of this is a table rebuild

A migration here may not `ALTER`, both applied files are sha256-locked, and D1 runs each
migration in an implicit transaction — so `DROP TABLE` on a parent becomes a `DELETE FROM parent`
that fires every cascade beneath it (`users` has nine children, `libraries` four). Reaching 3NF
is therefore a new `0010_*.sql` rebuilding `users`, `libraries`, `nodes`, `songs` and
`import_sources`: the exact shape of the `songs.reader_version` change this repository shipped
once, where the column never reached the live database and every enrichment write failed.

## Invariants

Violating any of these reintroduces a fixed defect. The suite asserts each one.

- **D1 predicates: lowercase the _parameter_, never the column.** `lower(col)` cannot
  use an index, so the authenticated hot path becomes a full table scan. Every writer
  stores a lowercased twin, so this changes no matching semantics. Paths are the
  exception and are exact: a WebDAV origin on Linux is case-sensitive, and lowercasing a
  path merges two real folders. The twins are a 3NF deviation with a measured
  justification and a Unicode table — see
  [Normalisation](#normalisation-and-the-fourteen-columns-that-do-not-obey-it).
- **The album/artist/genre queries page over groups, then fetch every row of the groups
  on the page.** A SQL `GROUP BY` returns one *representative row* per group, so the
  counts computed from it are 1 for a real discography. This shipped once: every album in
  the product reported `songCount: 1` and its first track's duration.
- **An ordered id list stays ordered.** `id IN (...)` returns rows in index-scan order, so
  `listIdsIn` re-orders to the caller's list. A play queue that reshuffles between polls
  is worse than no queue.
- **A chunked fetch cannot inherit an `ORDER BY`, so the order is rebuilt from the key
  list.** This is `listIdsIn`'s trick and `songsForAlbumKeys`' now, and the failure it
  replaced is the same one the comparator caused: re-sorting by a tuple that leads with a
  *different* column substitutes *alphabetical by artist* for whatever was asked. Assert
  the **concatenation** of consecutive pages, not any one page's order — a re-sort leaves
  every individual page looking plausible.
- **Never rebuild a parent table.** D1 runs each migration in an implicit transaction,
  so `PRAGMA foreign_keys = OFF` is unavailable and a `DROP TABLE <parent>` becomes a
  `DELETE FROM parent` that fires every cascade beneath it. Only a child may be rebuilt.
- **An applied migration is immutable, and nothing in a `.sql` file says so.** D1 records
  applied migrations by *filename* in `d1_migrations`, so a migration that has run is
  skipped by every later `wrangler d1 migrations apply` — silently, with no warning. An
  applied migration is therefore immutable in fact while being an ordinary text file in
  appearance. `songs.reader_version` was added by editing `0001`; the column never reached
  the live database, so `applyMetadata` and `upsertFileFacts` both failed naming it, every
  enrichment wrote nothing, `getArtists`/`getAlbumList2`/`getGenres`/`search3` answered
  `[]` for a library of 80 albums, `getSong` answered a masked 500, and the scan wedged —
  through 489 passing tests. Two rules, and the second exists because the first did not
  stop it:
  - **A migration change is a new numbered file, and only the baseline may not `ALTER`.** These
  are two rules, and the second exists because the first did not stop it:
  - **A schema change is a new numbered file.** Never an edit to one that has shipped.
  - **The baseline may contain nothing but no-ops against a full schema**, because it is the
    file that actually executes against production: `d1_migrations` records the absorbed
    filenames, so they are skipped and `0008` is what runs. Hence `CREATE TABLE IF NOT EXISTS`
    throughout, hence no `ALTER TABLE` in it — `ADD COLUMN` has no `IF NOT EXISTS` form and
    fails with "duplicate column name" on exactly the databases that need it, which is why
    those columns are folded into their `CREATE TABLE`s.
  - **An incremental file may `ALTER`,** because D1 records it by its own filename and skips
    it once applied, so it is never run twice. `0010_drop_token_epoch.sql` relies on this: its
    `ALTER TABLE users DROP COLUMN` has no `IF EXISTS` form, and a second run fails with
    `no such column` — correct for a file that runs once, and a defect only under a rule that
    never applied to it. This is why the re-run assertions in `test/schema.int.test.ts` read
    the baseline alone rather than `migrationSql()`.
    Measured on **workerd's build**, not only `node:sqlite`, because the engine-versus-build
    gap has cost this repository a defect before: `wrangler d1 migrations apply --local`
    applied it, `pragma_table_info('users')` reads back 0 `token_epoch` columns with
    `pragma_foreign_key_check` clean and both `users` indexes intact, and a second apply
    answers *"No migrations to apply!"*. An `ALTER` in the **baseline** is still caught —
    that assertion reads the baseline alone, and was verified by injecting one.
  - **What did *not* relax: no migration may `DROP TABLE`, on any file.** D1's implicit
    transaction turns a parent drop into a `DELETE FROM parent` firing every cascade beneath
    it — `users` parents ten tables — so a drop that looks like a schema change is in fact an
    unrecoverable mass `DELETE`. That assertion still reads the whole set, deliberately.
  - **`migrations/migrations.lock.json` records the sha256 of everything applied**, and
    `test/schema.int.test.ts` asserts both directions — every file on disk is listed, and
    every listed hash matches. Adding a migration means adding a lock entry in the same
    commit; editing an applied one fails the suite instead of the deployment.
    `pnpm run migrations:lock` records a newly-added file and **refuses to touch an
    existing entry**, so it cannot quietly bless an edit the operator just made. There is
    deliberately no `--force`: a write that could adopt a new digest for a file already
    applied *is* the bug, offered as a flag.
- **Eight migrations were squashed into one baseline, and the cost is stated rather than
  absorbed.** `migrations/0008_squash.sql` holds the combined schema of every file before
  it and those files are deleted. A lock can stop an *edit*; nothing stopped the file count
  growing. Three things the squash had to get right, each of which the next one collapses:
  - **It is not a concatenation.** `d1_migrations` records the absorbed filenames, so they
    are skipped and the squash is unapplied — it runs against production databases that
    already have every table, column and index. The four `ALTER TABLE … ADD COLUMN` the
    absorbed migrations used have **no** `IF NOT EXISTS` form, so a concatenated squash
    fails with "duplicate column name" on exactly the databases it exists to serve. The
    columns are folded into their `CREATE TABLE`s, in the order the ALTERs appended them,
    so the resulting `sqlite_schema` is identical.
  - **It resolves what a squash is for.** `namespaces` and `router_backends` are never
    created, which retires the inherited `owner_email → users(email)` foreign key that did
    not resolve at all (`PRAGMA foreign_key_check` failed; D1 enforces foreign keys), and
    it removes the **duplicate `0001_` prefix** — two files from two different projects,
    ordered by a lexicographic tiebreak nobody intended, on a database that could run only
    one. `lock-check.ts` fails on a duplicate prefix, which is what forced this.
  - **It omits 0006's data migration, and that omission is checked rather than assumed.**
    On a fresh database `songs` is empty; on an existing one 0006 already stamped every row
    it matched. Asserted by seeding the old marker rows *between* 0005 and 0006 — seeding
    them afterwards tests nothing, because 0006 has already run.

  The cost: D1's `d1_migrations` on an existing database still lists the eight absorbed
  filenames, and this repository no longer describes what they contained. D1 keeps that
  history, which is what makes adopting a baseline safe — and it is why the baseline is a
  deliberate act recorded in the lock, not a formatting change.
  The suite was blind to all of it because it `exec`'d one hardcoded migration file, which
  cannot tell *a new migration* from *an edit to an old one* — both produce identical
  bytes on the database it is building. `test/helpers/migrations.ts` reads the **directory
  sorted**, which is what Wrangler does, and reading it immediately exposed a second
  problem: `0001_router_init.sql` is inherited dead code that declares `users` with an
  incompatible shape and left `router_backends` with a **foreign key that does not
  resolve** (`users(email)` against a nullable, non-unique column), so
  `PRAGMA foreign_key_check` failed outright on the real schema. Dropped in `0003`.
- **Provenance is a column, because the marker became configuration and a `LIKE` is not a
  string.** The guard above used to be `col LIKE '%' || DERIVED_MARKER` — reading the
  suffix back out of the stored value — and `DERIVED_MARKER` is now an env var, because an
  operator asked for one. Empty is its **default**, and that is the point rather than an
  absence: an empty marker is what makes a derived `X` and a tagged `X` **one** album
  instead of two spellings of one release, which is also the only reason a search for the
  album's real name could find a track the scan has not tag-read. Two failures follow from
  the string guard, both measured over real SQLite against the real statement before the
  column was added:
  | `DERIVED_MARKER` | `Bonobo (derived)` | `Bonobo` | `Black Sands (Remastered)` |
  | --- | --- | --- | --- |
  | `' (derived)'`   | replaced | kept | **kept** |
  | `''`             | replaced | replaced | **→ replaced** |
  | `'_ (guess)'`    | **kept** | kept | kept |
  - **An empty marker is a match-all**, so the shipped default would have replaced every
    real `ALBUMARTIST` in the library — silently, on every poll, and past the first page.
  - **Any other marker is a `LIKE` pattern, not a literal.** `'_ (guess)'` is `'%_ (guess)'`,
    where `_` matches one character, so the guard stopped recognising its **own** guesses: a
    version bump re-selected those rows and declined to change them. The `reader_version`
    defect verbatim, one layer down, with no error anywhere. `%` as a marker is the empty
    case again.
  - So `songs.grouping_source` holds `'derived'`, meaning **all three** of
    `artist`/`album`/`album_artist` came from `dir_path`. "All three" is the conservative
    direction: the permissive one lets a convention correction overwrite a real tag, and the
    price is only that a partially-tagged row's derived `album_artist` is never corrected
    again — which no change of separator rule would affect. `applyMetadata` **clears** it
    whenever it writes any of the three, and that is the writer whose absence is a data-loss
    defect rather than a stale one. Three assertions, one per input, in
    `test/schema.int.test.ts`; all three go red against the `LIKE` guard, and the `%`/`_` case
    carries a *stale* marked value rather than a NULL for the reason above — seeded as a NULL
    it is filled by `col IS NULL` whatever the pattern is, so it passes against the defect it
    exists to catch.
  - **Changing the marker is a migration, and it costs stars.** It re-derives every wholly
    derived row, so `_ci` moves, the album grouping key moves, and `alk:` album ids move with
    it. Accepted rather than papered over with a fallback lookup, and stated in
    `migrations/0008_squash.sql` beside the `' (derived)'` literal that is now
    the only place it is written down (it was introduced in `0006`, which that file absorbs).
- **A limit the platform imposes is not a number the code may choose.** `MAX_PAGE_SIZE` is
  500 and D1 binds 100 parameters, so a 500-album page was a request this server was
  *obliged* to accept and could not answer. Same shape as `SCAN_CHUNK_MAX_REQUESTS` being
  1,000 against a 50-subrequest ceiling: a configured maximum read as a permission rather
  than as an obligation on everything below it. A chunk bound is a claim about the code
  beneath it, and it is only true if something measures it.
  The variable form of it was still live: `MAX_PAGE_SIZE` is env-raisable, and past a
  certain size a page is not *slow*, it is unservable — one grouped query plus
  `ceil(N / groupsPerStatement)` more, and D1 queries are subrequests. So it is clamped to
  `MAX_PAGE_SIZE_CEILING`, whose own docstring derives the number from the two platform
  limits rather than picking a comfortable one, and `validate()` **reports the clamp**
  rather than applying it quietly. Raising a number in `ConfigurationDefaults` is an
  encouraged operation, so an un-clamped maximum is a defect waiting for an operator.
- **A column that is real to the code and absent from the database is invisible to every DAO
  test.** `import_runs.report_json` was in `ImportRunRow`, written by `writeReport` and read by
  `parseReport`, and **absent from `CREATE TABLE`** — every DAO test passed, because the phase
  tests drive a port, the route tests use a run with no report, and the migration lock records
  **bytes, not columns**. The write failed with "no such column" and the retry layer turned that
  into a `DatabaseError`. This is the second and third time in this repository
  (`songs.reader_version`, `scan_state.consecutive_failures`), and both times the instrument that
  found it was `test/schema.int.test.ts` reading `PRAGMA table_info`. So the import's tables now
  have an assertion naming **every** column a DAO writes — written out rather than derived from
  the DAOs, because a list derived from the code cannot detect a disagreement the code is part of.
- **A member that is real to the code and absent from the platform is the same defect, one
  level out.** The rule above is about a **column**; this is about a property of a platform
  object, and it shipped through the same door for the same reason. `billedRowsFor` took a
  `D1PreparedStatement` and read `statement.sql` off it to work out which table a write bills
  against. **workerd's statement has no `sql`** — `types/defines/d1.d.ts` declares `bind`,
  `first`, `run`, `all`, `raw`, and Cloudflare's `prepare()` reference calls the return value
  *"an object which only contains methods"* — so `sql` was `undefined` on every real write and
  `stripLeadingNoise` threw `TypeError: Cannot read properties of undefined (reading 'replace')`.
  Every write that measured its cost died: the frontier seed, the index write, enrichment, the
  derived-grouping backfill, playlist totals, play counts, the play queue. The scan could not
  seed or advance a chunk, and `scan_state` kept reporting `scanning` throughout — because
  `markScanning` goes through `withRetry`, which does not bill, so the status write the operator
  reads was the one write that still worked. **Reads were entirely unaffected**, which is why
  the library browsed fine and nothing had ever been indexed. Three things, and each is how the
  other two would have collapsed:
  - **A structural type that claims the platform satisfies it is a claim about the platform, and
    nothing was checking.** `D1PreparedStatement` declared `sql: string` as **required**, under
    a comment asserting *"Real D1Database satisfies these structurally"* — which was false.
    `requestScope.ts`'s `env.DB as D1Queryable` is what let it compile: the local type is a
    **superset** of the platform's, so a cast is legal in that direction and the disagreement
    is never reported. `wrangler types` is the instrument, and it says so in
    `worker-configuration.d.ts` in this very repository.
  - **The one double in the suite modelled the type this repository wrote, not the one it runs
    against.** `test/helpers/sqlite.ts` returned a statement *with* a `sql`, which is why 1,270
    tests were green while the entire write half of the product was down. The double now carries
    exactly the platform's four members, and `test/schema.int.test.ts` asserts that list **both
    ways** against a written-out copy of workerd's declaration — derived from the double, it
    would compare the double with itself. See the testing guide for the second half of this:
    the double's `bind()` returned `this` while Cloudflare's returns a new statement, so *any*
    fix that hung the SQL off the statement object (a `WeakMap`, a `defineProperty`) would have
    passed the suite and failed in production.
  - **The SQL travels beside the statement, from the one place that has it.** `BaseDAO.prepare`
    mints a `TrackedStatement` — `{ sql, statement }` — and `runWriteStatement`/`runWriteBatch`
    take it. That is what makes "the SQL and the statement cannot be different facts"
    structural rather than a convention, and it is why the write helpers are handed a pair
    rather than an extra argument: a helper taking two arguments is two literals for one
    statement, which is the shape this repository has now paid for three times. Reads keep
    calling `this.database.prepare` directly, because nothing reads a read's SQL.

  The missing case is then handled in the direction this file is written in throughout:
  `statementTable` answers `null` for a non-string, which charges the schema's **worst** case.
  Over-charging costs throughput; the `TypeError` cost every write in the product. Asserted —
  and the assertion is on `nodes`, not `songs`, for a reason worth stating: `songs` bills ten
  and `MAX_BILLED_ROWS_PER_ROW` **is** ten, so on the dominant write path a lost SQL and a
  correct one are the same number and every `songs` assertion stays green against it.

## See also

- [`packages/backend-data/AGENTS.md`](../../../packages/backend-data/AGENTS.md) — the DAOs
  themselves, and the per-file inventory
- [`packages/backend-runtime/README.md`](../../../packages/backend-runtime/README.md) —
  where every bound is derived
- [`Scanning`](../scanning/AGENTS.md) — what spends this budget
