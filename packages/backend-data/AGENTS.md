# Edge-Sonic — Backend Data (D1 / DAO layer)

Scope: `packages/backend-data/**`. Parent index: `../../AGENTS.md`.

All D1 access goes through a DAO over `D1Queryable`. `BaseDAO` owns the write path and the
meter: `withRetry` (the transient-fault retry, decided by
`D1ErrorClassifier.isD1ErrorRetryable`), `runWriteBatch`, `runWriteStatement`,
`requireSubrequests`, `fitCount`/`canFitAll`, `clampToSubrequestBudget`, and the charge each
statement makes against the invocation's subrequest ceiling — which is why it, and not each
DAO, is the one place a forgotten charge would have no symptom. Per-table SQL belongs in the
concrete DAO.

## The files

| File             | Holds                                                                        |
| ---------------- | ---------------------------------------------------------------------------- |
| `dao/BaseDAO.ts` | `withRetry`, `runWriteBatch`, and the ceiling both enforce                     |
| `dao/rows.ts`    | every row type, plus the `CountRow` / `IndexVersionRow` shapes (a few aggregate
  shapes live beside the query that produces them, in `songIndex.ts`)                 |
| `dao/SongDAO.ts` | one song row: its facts, its derived metadata, its lifecycle, its single-row reads |
| `dao/songIndex.ts`| the aggregate reads: a page of albums, a page of artists, the genres         |
| `dao/albumKeySql.ts`| the album key as SQL: the `GROUP BY` per grouping, and the batch size |
| `dao/NodeDAO.ts` | the folder tree, the scan frontier, the subtree prune                         |
| `dao/playlists.ts` | a named, ordered list of songs owned by one user                            |
| `dao/UserStateDAO.ts` | per-user state: stars, ratings, bookmarks, play queue, now playing, throttle (`AnnotationDAO` + `AuthThrottleDAO`; **playlists are `dao/playlists.ts`**) |
| `dao/ScanStateDAO.ts` | scan status per library: the frontier's home, the retry counter, the index version |
| `dao/songDerivation.ts` | `SongDerivationDAO` — re-running the path convention over rows the walk will never revisit |
| `dao/songMetadata.ts` | the `applyMetadata` patch builder, and `GROUPING_FIELDS` |
| `dao/songMatch.ts` | the import's lookups: by path, by album title, and which album keys are present |
| `dao/playCounts.ts` | `PlayCountDAO` |
| `dao/imports.ts` | `ImportSourceDAO`, `ImportRunDAO`, and `IMPORT_PHASES` |
| `dao/importProgress.ts` | `ImportPlayCountProgressDAO` — the walk's own resume point |
| `dao/index.ts` | the barrel every other layer imports rather than a deep path |
| `crypto/` | `encryptData`, `decryptData`, `isUsableKey` — every stored credential |
| `utils/` | `D1Types`, `D1Utils`, `D1ErrorClassifier` |
| `dao/identity.ts` | `UserDAO` and `LibraryDAO` — the two rows with a credential                   |
| `dao/songSql.ts` | the `songs` upsert statement                                                  |
| `dao/pathConvention.ts` | the `Artist/Album` and `Artist - Album` naming rules, and `DERIVED_VERSION` |
| `dao/groupingSource.ts` | whether a row's grouping came from the path or from a tag, and the marker measurements |
| `dao/songCounts.ts` | how many tracks a library holds — a count is not a row                       |
| `dao/chunking.ts`| `chunkArray`, for `IN (...)` binding                                          |
| `dao/songIdLookup.ts` | `IN (...)` id lookups, scoped to one library and across all of them    |
| `dao/sqlLimits.ts`| D1's measured bind-parameter ceiling, and the batch size derived from it    |
| `dao/indexStats.ts`| `IndexStatsDAO` — what dropping an index would cost, before it is run |
| `dao/indexDrop.ts` | `IndexDropDAO` — the Danger Zone's `DELETE`s, and what they billed   |
| `dao/billedRows.ts`| What D1 bills a write as: the row **plus every index entry it rewrote**  |
| `utils/`         | `D1Types`, `D1Utils`, `D1ErrorClassifier`                                     |

`SongDAO` and `SongIndexDAO` are separate because they answer different-shaped questions.
`SongDAO` owns one row; `SongIndexDAO` pages over a **group**, which means it runs two
statements — see the aggregation rule below. Keeping them apart is what makes the
page-then-fetch pattern readable in one place instead of duplicated five times.

**Layer 0, so the marker is a parameter and not an import.** `backend-data` depends only on
`shared`, `backend-errors` and `subsonic`, and the configuration layer sits *above* it. So
`deriveFromPath(dirPath, marker)` takes the marker, `SongDAO` and `SongDerivationDAO` take it
by constructor, and `requestScope.ts` reads `config.getDerivedMarker()` once and passes it to
both — the same reason `ALBUM_GROUP_BY` is carried per request. `SongDerivationDAO.deriveFor`
is an **instance** method for the same reason it cannot be `static`: a static one could only
have read a module constant, which is precisely the value the operator is no longer forced to
take.

### Two readings of "the songs with these ids"

`SongIdLookupDAO` has a library-scoped `listIdsIn` and a cross-library
`listIdsAcrossLibraries`, deliberately as **two methods** rather than one with a nullable
`libraryId`. The scoped one is right for almost every caller: an id from a library the
caller cannot see must not resolve, and that is an authorization guarantee the shared method
cannot make.

The cross-library one is for the two **per-user** records — the play queue and a playlist's
entries — whose ids come from whatever libraries that user was granted. Both resolved
`libraries[0]` and filtered, so with two grants every entry from the second silently
vanished: a playlist that lost songs, a queue that shortened itself, a `createPlaylist` that
stored fewer tracks than it was given, and no error on any path. `getBookmarks`, which
iterates all libraries, disagreed with both.

So the invariant is: **a per-user record is not scoped to one library**, and narrowing it is
a silent data loss rather than a filter.

## The rules that keep getting broken

- **D1 predicates: lowercase the _parameter_, never the column.** `lower(col)` cannot use
  an index, so the authenticated hot path becomes a full table scan. Every writer stores a
  lowercased twin (`username_ci`, `slug_ci`, `title_ci`, …), so this changes no matching
  semantics. `test/schema.int.test.ts` asserts `EXPLAIN QUERY PLAN` directly, because a
  wrong predicate and a right one return identical rows and the plan is the only
  observable difference.
- **Paths compare exactly, never lowercased.** A WebDAV origin on Linux is
  case-sensitive, so `Album` and `album` are two folders and lowercasing the column merges
  them into one row pointing at a file that may not exist.
- **D1 binds at most 100 parameters per statement, and every `IN (...)` size is derived from
  that number.** It is not SQLite's default: SQLite has used 32,766 since 3.32.0, and the
  `999` that predates it is still what most of the literature quotes — so a query written
  against "SQLite's limit" is written against a limit this database does not have. Measured
  on a live D1 on 2026-09-29: 99 bound variables answer, 101 raise `too many SQL variables`.
  It shipped as a masked `code=0` on the endpoint a player draws its album list from, and
  it was not one client or one page size. `songsForAlbumKeys` bound **two** variables per
  album group, so **any** request for 50 or more albums failed — while `MAX_PAGE_SIZE` is
  500, so the server was *required* to accept requests it could not answer. `listArtists`
  binds one per artist and its three callers ask for 500, 5,000 and 500, so `getArtists`,
  `getArtist` and `getCoverArt` were each a guaranteed failure on a library with 100+
  artists. `listIdsIn` was the sharpest of the three: it *did* batch, at 200, under a
  comment asserting "SQLite's limit (999 by default)" — a guard that was real and whose
  stated budget was fiction, at twice the ceiling. Three rules:
  - **The batch size is derived, never chosen.** `bindChunkSize(varsPerRow, reserved)` in
    `dao/sqlLimits.ts` is the only place that arithmetic is written, and
    `test/schema.int.test.ts` asserts *both sides* of the measured edge. A number typed
    beside a query is a number that is wrong by the time somebody raises a page size.
  - **Batch on key boundaries, never row boundaries.** A row-level split returns an album's
    first tracks from one statement and the rest from another, which `groupAlbums` then
    merges — so the counts stay right and nothing reports why.
  - **A chunked fetch cannot inherit the `ORDER BY` it used to inherit from one statement.**
    Chunks concatenate in the *key page's* order, which is `RANDOM()` for `type=random` and
    `mtime_ms DESC` for `type=newest` — neither of which is the sort tuple. So
    `songsForAlbumKeys` re-sorts, making its result a function of `keys` alone. Without
    that, a 40-album library answers sorted and a 400-album one does not, and the same
    endpoint behaves differently depending on how much music the user happens to own.
- **`node:sqlite` is D1's engine but not D1's *build*, and the suite was blind because of
  it.** The DAOs run against real SQLite precisely so a wrong predicate and a right one can
  be told apart by the query plan — but its `SQLITE_MAX_VARIABLE_NUMBER` is 32,766 against
  D1's 100, so it is *structurally incapable* of failing the way D1 fails. 500+ tests were
  green throughout a guaranteed 500. `helpers/sqlite.ts` now enforces the ceiling on every
  statement. This is the `fakeDav` receiver mistake one layer down: a double is evidence
  only to the extent it models the platform's constraints, and modelling *an* SQLite was
  not the same as modelling *D1's* SQLite.
- **A write costs a *billed* row, not a row, and `meta.changes` is not that number.** D1's
  pricing page, definition 6: *"Indexes will add an additional written row when writes include
  the indexed column, as there are two rows written: one to the table itself, and one to the
  index."* So the daily allowance is denominated in the row **plus every index entry it
  rewrote**, and the multiplier is a property of the *table*: `songs` is ten (nine indexes),
  `nodes` is four, `scan_state` is two (it declares none at all — only the implicit
  `sqlite_autoindex` for `library_id TEXT PRIMARY KEY`).
  `dao/billedRows.ts` owns that, and four rules keep it true:
  - **`meta.changes` is SQLite's count of *table rows* touched.** `runWriteBatch` summed it, and
    `EnrichmentService` declared a literal `1` because `applyMetadata` returned `void` — so the
    scan's daily budget believed it had ~10x its real headroom on the dominant write path, and
    the platform's refusal arrived first. `WriteBatchResult` therefore carries `billedRows`
    beside `changes`, not in place of it: `changes` is progress and is what
    `test/scan-convergence.test.ts` measures, `billedRows` is cost.
  - **The counts are asserted against `sqlite_schema`, both directions.** A per-table index
    count typed beside a query is right until the first `CREATE INDEX`, after which it
    under-counts silently and in the direction that looks safe. This is the
    `migrations.lock.json` mechanism applied to a different fact, in the same file.
  - **Counting indexes by eye undercounts every table here by one.** SQLite creates an implicit
    unique index for every `PRIMARY KEY` that is not an `INTEGER PRIMARY KEY` rowid alias, and
    no table in this schema uses that one form. So `sqlite_schema` must be queried **without**
    the `LIKE 'sqlite_%'` filter the structure comparison uses, or `songs` reads as eight.
  - **One implementation, two call sites.** `runWriteStatement` (single) and `runWriteBatch`
    (batched) both go through `billedRowsFor`, so the two cannot disagree — and each is
    asserted over real SQLite, because the scan suites meter *doubles* that report their own
    `billedRows` and never execute the DAO, so reverting the arithmetic turns nothing red there.
- **What a group *is* is `ALBUM_GROUP_BY`, and the two halves of it are one function.**
  `albumKeySql.ts` writes the `GROUP BY` and `subsonic/albumKey.ts` derives the key in TypeScript;
  `projection.keyOf` rebuilds the key string from the grouped row so the page's membership and the
  caller's membership cannot disagree. Three things here are invisible in a result and are asserted
  some other way:
  - **`GROUP BY album_artist_ci`, not `COALESCE(album_artist_ci, '')`.** A missing album artist is
    a *value*, so NULL is its own group. The coercion returns the same rows — `'' IS ''` — and
    silently drops `idx_songs_album`, which is a page of albums becoming a scan of the library's
    rows. `EXPLAIN QUERY PLAN` is the only instrument that tells the two apart.
  - **The batch size is derived from the grouping**, because the halves are not the author's to
    count: one variable per group under `folder` and `album` (`bindChunkSize(1)` = **99**), two
    under `album_artist` (`bindChunkSize(2)` = **49**). So a 500-album page is 6 statements
    under the default grouping and 11 under `album_artist`, and neither is a number to type
    beside the query.
  - **The page's tiebreak is the key columns, not `dir_path`.** A directory can hold two album keys
    under a tag grouping, so `dir_path` was never a *total* order, and a page boundary between two
    albums that tie on every term could return one twice or skip it.
- **Every caller that starts from a set of keys goes through `listForAlbumKeys`, not a local
  grouping.** `getAlbum`, the starred paths, `getArtist` and `search3` each begin with a subset of
  an album's rows, and grouping that subset publishes an album holding one track of a compilation —
  a `songCount`, a `duration` and an `artist` that disagree with every other surface.
- **Aggregate queries page over groups, then fetch every row of the groups on the page.**
  A SQL `GROUP BY` returns one *representative row* per group, so counting from it
  reports 1 for a real discography. This shipped: every album in the product reported
  `songCount: 1` and its first track's duration. The second query deliberately does **not**
  re-apply the year or genre filter — those choose which albums appear, and a partial
  track count for a selected album is the same bug in a narrower window.
- **A changed file invalidates its own enrichment, in the same statement.** The upsert
  compares `mtime_ms` and clears `duration`/`bitrate`/`sample_rate`/`channels`/
  `enriched_at`/`reader_version` together. Doing it in two statements leaves a window
  where a row claims a new mtime with the old duration, and `EnrichmentService` — which
  short-circuits on `enriched_at` — will never re-read it. The text tags are deliberately
  *kept*: they are the path-convention fallback `getArtists` groups by, and clearing them
  would drop the track out of every group.
- **A path-derived grouping fills a gap, and never overwrites a tag.** The aggregates
  filter in SQL — `listAlbums` on `album_ci IS NOT NULL AND album_ci <> ''`,
  `listArtists` on `artist_ci IS NOT NULL AND artist_ci <> ''`, `listGenres` on
  `genre_ci IS NOT NULL AND genre_ci <> ''` — so a
  row the scan has not range-read is **absent** from every one of them rather than shown
  with a blank name, and `search3` cannot match it. Those columns are written only by a
  tag read, one ranged request per track, bounded twice over, so most rows of any real
  library are unenriched for a long time. It shipped: 80 albums, and
  `getArtists`/`getAlbumList2`/`getGenres`/`search3` all answered `[]` while
  `getRandomSongs` — which does not group — returned rows. So `upsertFileFacts` derives
  `album`/`artist` from `dir_path` (`pathConvention.ts`: `Artist/Album`, and the flat
  `Artist - Album` layout, split on the *first* separator only). Three rules:
  - **`COALESCE(songs.x, excluded.x)`, always.** The existing value wins, so a derived
    name fills a NULL and only a NULL. That is the whole safety argument: a real tag is
    never rolled back to a guess, and a rescan writes nothing — which is what makes it
    safe to derive on *every* index rather than only on first sight.
  - **Every `_ci` twin moves in the same statement**, asserted *separately* from the
    display values. A guard on `artist` proves nothing about `artist_ci`; dropping
    `COALESCE` from only the twins passes every other assertion, and the result is a row
    that displays correctly and is in no album list.
  - **`genre`, `track` and `year` are never derived.** No path convention for them is
    anything but a guess, and `getGenres` would publish a guessed genre with a song count
    beside it. An uninformative path yields NULL, never `''` — `''` groups under a blank
    name, the defect `NodeDAO.listRoots` had with the library root.
  - **The `Artist - Album` split is a scan, and the scan is only equivalent because the
    caller trims.** `findAlbumSeparator` used to be `/\s+[-–—]\s+/.exec(dirName)`, which is
    quadratic on a folder name that reached this module from an untrusted `DAV:href` — 16 KB
    costs ~280 ms against a 10 ms CPU limit on Workers Free, and `dir_path` is re-read on
    every upsert *and* on every `songDerivation` poll, so one hostile `PROPFIND` is an
    invocation the runtime kills. The replacement returns the **dash's** index rather than the
    regex's match index, and that is sound for one specific reason: **both sides of the split
    are `.trim()`ed by `fromFlatAlbumFolder`**, so the *extent* of the whitespace runs cannot
    change the answer and never has to be measured. That argument dies with the trim — the
    separator rule is a property of the convention *and* of the caller's cleanup together, not
    of the convention alone. The adversarial input must be a run of spaces followed by a
    **non-dash**: a run ending in a dash matches on the first attempt and costs nothing.
    `test/redos-linear-parsing.test.ts` holds the oracle, the seeded fuzz and the wall-clock
    bound, and it is the **only** guard — `eslint-plugin-regexp`'s
    `no-super-linear-backtracking` is silent on this shape, so a green lint says nothing here.
- **Deriving at index time was not enough, and the reason is that indexing only happens
  on change.** Every writer of the grouping columns is gated on the file having *moved*:
  the `Depth: 0` root probe, `isScanned: !changed`, `if (changed)` in `reconcileFolder`,
  and the read-through `getMusicDirectory` path. That gating is **correct** — it is what
  makes a rescan of an unchanged library cost one subrequest — and the consequence is that
  the derivation is unreachable for an already-indexed library, so its aggregates never
  recover without a file changing. It shipped twice: the first attempt added the
  derivation to the upsert and deploying it changed **nothing** on a live library where
  nothing had changed, with 113 rows all carrying NULL grouping.
  - It was invisible per-track because `rest/mappers.ts` falls back to the folder name
    when `album` is NULL. The one endpoint that does not group in SQL was the one that
    looked healthy.
  - So `songDerivation.ts` runs the same `deriveFromPath` over rows selected by
    **`derived_version`**, not by `NULL`, and `ScanService.step` runs it *ahead of* the
    status check — a fully-scanned library is `idle` and returns without touching the
    walk, so a backfill placed after the check never runs for the libraries that need it.
  - **The selection is on a version because `NULL` cannot express a corrected
    convention.** With the stamp, bumping `DERIVED_VERSION` re-derives everything, which
    is the `reader_version` invariant one layer down. The write is a `CASE` keyed on
    **`songs.grouping_source`** — replace a value a derivation is recorded as owning,
    fill a NULL, leave a real tag — because a plain `COALESCE` there would re-select the
    row and then decline to change it, which is a version column that buys nothing.
  - **The guard is a column, not the marker on the value, and that is load-bearing.**
    The guard used to be `col LIKE '%' || DERIVED_MARKER`, reading the suffix back out of
    the stored string. The marker is now `DERIVED_MARKER` configuration — and empty is its
    default, because an empty marker is what makes a derived `X` and a tagged `X` one
    album rather than two. Two failures follow from the old guard, both measured over real
    SQLite against the real statement: `'%' || ''` is `'%'`, which matches **every**
    non-NULL value, so the default overwrote every real `ALBUMARTIST` in the library
    silently on every poll; and any other marker is a `LIKE` **pattern**, so `_ (guess)`
    matches nothing and the backfill stopped recognising its own guesses — a version bump
    re-selecting rows and declining to change them, with no error anywhere. So
    `songs.grouping_source` holds `'derived'` and provenance moved off the string, which
    also makes an operator-chosen `%` or `_` an ordinary character.
    `'derived'` means **all three** of `artist`/`album`/`album_artist` came from the path;
    anything else means a tag supplied at least one. "All three" is the conservative
    direction — the permissive one lets a convention correction overwrite a real tag, and
    the cost is only that a partially-tagged row's derived `album_artist` is never
    corrected, which no change of separator rule would affect anyway. Asserted in both
    directions in `test/schema.int.test.ts`.
  - **Three writers maintain that column and all three are required.** `UPSERT_FILE_FACTS`
    stamps `'derived'` on the `INSERT` and **preserves** it on conflict (absent from the
    `SET` list); `APPLY_DERIVATION` restates it in the same statement as the values;
    `applyMetadata` **clears** it whenever it writes any of the three. The last is the one
    that is easy to miss and the one whose absence is a data-loss defect: a tag write that
    left the flag standing would leave the row looking like a guess, and the next bump
    would replace a real `ALBUMARTIST` with a folder name.
  - **It never stamps `enriched_at`.** `EnrichmentService` short-circuits on it, so
    claiming a row was read would mean a track with `duration: 0` is never range-read on
    first play — a backfill that repairs the grouping by breaking enrichment.
  - **The index write stamps `derived_version` too, and that is load-bearing.** It stamped
    no version, so every row `upsertFileFacts` produced took the migration's `DEFAULT 0`
    and was *immediately owed* to the backfill — permanently, since the selection is
    `derived_version < 1`. The backfill's page is one `UPDATE` per row with
    `requireComplete`, so on any library past ~48 owing rows it **refused**, and the refusal
    is thrown from `derivePending`, which runs before `listFrontier`: the walk never ran,
    `step`'s catch recorded a scan failure, and `getScanStatus` answered `scanning: true` for
    ever. Stamped unconditionally on both the `INSERT` and the `ON CONFLICT` clause, like
    `APPLY_DERIVATION` stamps in all three of its `CASE` branches — a row holding a real
    enrichment tag is equally not owed a derivation, so the two statements cannot disagree
    about which rows the backfill owns. The value is interpolated from `DERIVED_VERSION`,
    because a number typed beside a query is wrong by the time somebody bumps the version.
    Asserted over real SQLite in `test/schema.int.test.ts` against `upsertFileFacts` itself:
    two doubles in `test/scan-incremental.test.ts` and `test/scan-budget.test.ts` had been
    made to stamp it under comments asserting this statement did, so the suite agreed with
    itself and with neither production — which is this file's own recorded rule about
    doubles, arriving on the same column for the second time.
  - `idx_songs_derived (library_id, derived_version)` is load-bearing: the query runs on
    **every** poll, and a table scan there would cost a full `songs` pass on a fully
    repaired library. Asserted with `EXPLAIN QUERY PLAN`.
- **An applied migration is immutable, and nothing in a `.sql` file says so.** D1 records
  applied migrations by *filename* in `d1_migrations`, so one that has run is skipped by
  every later `wrangler d1 migrations apply` — silently. `songs.reader_version` was added
  by editing `0001_edge_sonic_init.sql` after `0001` had been applied, so the column never
  existed in the live database: `applyMetadata` and `UPSERT_FILE_FACTS` both named it,
  both failed, and a library of 80 albums served empty aggregates with `getSong` answering
  a masked 500 — through 489 green tests. A schema change is a **new numbered file**, and
  `migrations/migrations.lock.json` records the sha256 of everything applied so
  `test/schema.int.test.ts` fails on an edit. The suite was blind because it applied one
  hardcoded file, which cannot distinguish a new migration from an edit to an old one; it
  now reads the directory sorted, which is also how it found `0001_router_init.sql`'s
  foreign key to `users(email)` — unresolvable against a nullable, non-unique column, so
  `PRAGMA foreign_key_check` failed on the real schema. That file is now **absorbed**:
  `migrations/0008_squash.sql` is the baseline, and it never creates `namespaces` or
  `router_backends`, so the broken key is retired rather than carried by a `DROP`. The
  squash is the schema below — 17 tables, plus every column the earlier `ALTER`s added.
- **A row's enrichment is a function of the bytes *and* the reader, and both go in the
  key.** `mtime_ms` alone is correct for the bytes and blind to the reader, so a corrected
  reader reaches no row an earlier one wrote: the file genuinely has not moved, so the
  short-circuit is right and the wrong value is served for ever. It shipped — a deploy
  carrying a fixed Ogg reader left a live library reporting a 240.61 s track as 3 s at
  15329 kbps with no artist, album, genre, track or year, and a full rescan changed
  nothing. `songs.reader_version` carries the other input, stamped by `applyMetadata` in
  the **same statement** as the values, because a row whose `enriched_at` moved without it
  is one nothing can re-read. The `songMeta` KV entry carries it for the same reason and
  because `enrich` consults the cache *before* the row. `SongMetadataInput` lives in
  `dao/songSql.ts` with the statement it targets, so the columns a patch may write and the
  statement that writes them are read together.
- **An ordered id list stays ordered.** `id IN (...)` returns rows in index-scan order, so
  `listIdsIn` re-orders to the caller's list. Ids that do not resolve are omitted, not
  substituted. The re-order happens once over the *merged* result rather than per chunk, so
  batching is invisible to the caller for the same reason it is in `songsForAlbumKeys`.
- **A read that reports on a row must not create it.** `ScanStateDAO.ensure` writes an `idle` row
  on first sight, so `GET /user/libraries` uses `listByLibraries` — a plain read — and reports
  `null` for a library with no row. Two reasons, and the second is the one that would have been
  missed: using `ensure` turns every `GET` into a write against the day's row-write allowance on
  a page the operator **polls**; and it destroys the distinction the client depends on, because
  the row it wrote is exactly the row whose absence means *never scanned*. The same rule as
  `songs.countByLibraries`, which omits a library with no tracks rather than defaulting it to
  `0` — a defaulted zero erases the difference between "nothing indexed" and "never looked at".
- **A D1 statement is a subrequest, so `withRetry` charges one.** Workers Free allows **50
  subrequests per invocation** and D1 counts its own queries against the same 50 — *Queries
  per Worker invocation — 1000 (Workers Paid) / 50 (Free)*. Every DAO holds the request
  scope's `SubrequestMeter`, and `withRetry` charges it, because that is the one path every
  statement takes: a charge per call site is a hundred chances to forget one, and a forgotten
  charge has **no symptom at all** until the platform terminates the invocation — the
  statement works, the rows are right, the suite is green. `runWriteBatch` charges
  **per statement**, not per `batch()` call, because the platform does not say which reading
  is right and an over-count costs throughput while an under-count costs availability.
- **A write batch splits to fit, and reports that it did.** `runWriteBatch` returns
  `WriteBatchResult`, not a count, because a 500-track album is ~1,000 statements against a
  ceiling of 50 — truncation is the *expected* case on Free, not an edge case. The caller
  acts on it: the scan writes a folder's children first and its own `is_scanned` row last,
  **only if nothing was truncated**, so a half-written folder stays on the frontier. Writes
  with no partial form — a play queue, a playlist's `song_count`, the derivation backfill —
  pass `requireComplete` and refuse with a `413` instead, because half a queue is a *shorter
  queue*, which is a wrong answer rather than an unfinished one.
- **A DAO that constructs another DAO must pass the meter down.** `SongDAO` built its
  `SongIdLookupDAO` with `new SongIdLookupDAO(this.database)`, dropping it — the whole defect
  above, present in the code written to fix it. `BaseDAO` exposes the meter to subclasses so
  the only way to build a DAO from a DAO is from one that already has one.
- **A read whose size the caller chose is clamped; one it did not is refused.**
  `listArtists`' callers ask for 500, 5,000 and 500, so the limit is clamped to what the
  remaining budget can fetch rows for. `songsForAlbumDirs` and `listIdsIn` refuse with a
  `413`, because the key list *is* the answer and resolving a subset of it is a page that
  silently omits albums or a queue that silently shortened.
- **A configured limit is not a bound the queries can honour.** `MAX_PAGE_SIZE` is 500, and
  until the batching above existed a 500-album page was a request the server was obliged to
  accept and could not answer. Same class as `SCAN_CHUNK_MAX_REQUESTS` being 1,000 on an
  account whose ceiling was 50: both numbers are read as permissions rather than as
  obligations on the code below them. The ceiling is now **derived** from the statement
  budget in `subrequests.ts` rather than typed here — the old `2200` bounded the page's
  *group* count while the statement count is driven by its *track* count, so 2,200 albums
  cost ~100 statements.
- **A prune takes the whole subtree, with a trailing `/`.** A folder that disappears takes
  its `dir_path`s deeper than itself with it, so a one-level delete leaves songs indexed
  that keep appearing in every album list. The `LIKE` is escaped so a folder named `100%`
  does not match everything, and the trailing slash is what stops `Blur` from taking out
  `Blurberry`. The library root's own row is never deleted: `path === parentPath === ''`.
- **Never rebuild a parent table.** D1 runs each migration in an implicit transaction, so
  `PRAGMA foreign_keys = OFF` is unavailable and `DROP TABLE <parent>` becomes
  `DELETE FROM parent`, firing every `ON DELETE CASCADE` beneath it. Only a **child** table
  may be rebuilt. The schema is correct on the first migration precisely so this never has
  to be tested.
- **Deleting an index keeps `libraries`, and that is the whole point of it.** `dao/indexDrop.ts`
  empties `songs`, `nodes` and `scan_state` and nothing else. Three things follow from what it
  does *not* touch, and each is a decision rather than an omission:
  - **The registration and its encrypted WebDAV credential survive.** This is the difference from
    `LibraryDAO.delete`, which cascades `libraries` and with it the only copy of the password —
    so before this, a rejected credential had no remedy but re-registering the origin.
  - **The per-user annotations survive**, because they have **no foreign key** to `songs` and
    hold derived id strings, so a rescan re-attaches every star, play count and playlist entry.
    Asserted in `test/index-drop.test.ts` by re-deriving a song id from `(libraryId, path)` with
    a helper that does **not** call the production encoder — a test using the same helper would
    pass even if that helper became a UUID, which is the property the whole decision rests on.
  - **`scan_state` is deleted rather than reset to `idle`.** Absence *is* a state the operator
    surface reads: `librarySummary` publishes `scan: null` for a library with no row and the SPA
    renders that as "never scanned", which is what an operator wants after an empty index. A row
    reset to `idle` beside `songCount: 0` renders the success-toned "Up to date." next to "0
    tracks indexed" — the contradictory pair `describeScanState`'s `empty` case exists to catch.
  - **`scan_state` is deleted *first*.** It is the smallest statement and the one whose absence
    makes the library read as unscanned, so a reader arriving between the three sees an honestly
    "never scanned" library rather than one reporting progress towards rows being removed.
- **The projection and the charge are one arithmetic, and the projection has to live here.**
  `IndexStatsDAO` projects a bill with `billedRowsForTable`; `IndexDropDAO` measures the same
  figure through `runWriteStatement`, which calls the same function. `apps/api` may not import
  this package's **values**, so a route quoting `songs * 10` would be a second copy of a
  per-table table in the one layer that cannot see it — and the figure is the one an operator
  consents to. `test/index-drop.test.ts` asserts the projection equals the measured total, over
  real SQLite, because a double reporting expected numbers would agree with itself.
  **A `DELETE`'s `meta.changes` *is* the rows deleted**, which is what makes the measurement
  above exact rather than an estimate.
- **No blanket `.catch(() => null)` on a D1 read.** Only `isMissingSchemaError` may
  degrade; everything else becomes a `DatabaseError`, or an outage reads as "not found".

## Schema

**Two** migrations, applied in Wrangler's order: `migrations/0008_squash.sql` is the
squashed baseline every database is built from and every future migration stacks on (17
tables), and `migrations/0009_subsonic_import.sql` adds the import's three (20 in all, with
40 index entries counting the implicit `sqlite_autoindex_*` a `TEXT PRIMARY KEY` creates).
`libraries` and `users` carry a `key_version` for credential rotation. `users` also carries
`token_epoch`, bumped on a password change and **read by nothing** — a Subsonic token is
`md5(password + salt)`, so the password change is what actually revokes issued tokens, and
the credential carries no epoch to compare. The header of the file records what it absorbs and why it is idempotent —
which is the property to read before editing it, because it also runs against databases
that already have the full schema.

## Layer 2 (layer 0 only)

Import only `@edge-sonic/shared`, `@edge-sonic/backend-errors` and
`@edge-sonic/subsonic`. Never `backend-runtime`, `backend-services`, `webdav` or `apps/*` —
enforced by `no-restricted-imports`. `subsonic` is layer 0 and carries the album key, so it
has no block of its own; it is declared in this package's manifest, which is where a
dependency that resolves only by hoisting should be noticed.
