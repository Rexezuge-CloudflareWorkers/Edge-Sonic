# Edge-Sonic — Backend Data (D1 / DAO layer)

Scope: `packages/backend-data/**`. Parent index: `../../AGENTS.md`.

All D1 access goes through a DAO over `D1Queryable`. `BaseDAO` owns exactly one thing:
`withRetry`, the transient-fault retry. Per-table SQL belongs in the concrete DAO, and
`D1ErrorClassifier.isD1ErrorRetryable` is the only thing that decides what is transient.

## The files

| File             | Holds                                                                        |
| ---------------- | ---------------------------------------------------------------------------- |
| `dao/BaseDAO.ts` | `withRetry`, and nothing else                                                 |
| `dao/rows.ts`    | every row type and the aggregate row shapes                                   |
| `dao/SongDAO.ts` | one song row: its facts, its derived metadata, its lifecycle, its single-row reads |
| `dao/songIndex.ts`| the aggregate reads: a page of albums, a page of artists, the genres         |
| `dao/albumKeySql.ts`| the album key as SQL: the `GROUP BY` per grouping, and the batch size |
| `dao/NodeDAO.ts` | the folder tree, the scan frontier, the subtree prune                         |
| `dao/playlists.ts` | a named, ordered list of songs owned by one user                            |
| `dao/UserStateDAO.ts` | per-user state: playlists, stars, ratings, bookmarks, play queue, now playing, throttle |
| `dao/identity.ts` | `UserDAO` and `LibraryDAO` — the two rows with a credential                   |
| `dao/songSql.ts` | the `songs` upsert statement                                                  |
| `dao/chunking.ts`| `chunkArray`, for `IN (...)` binding                                          |
| `dao/songIdLookup.ts` | `IN (...)` id lookups, scoped to one library and across all of them    |
| `dao/sqlLimits.ts`| D1's measured bind-parameter ceiling, and the batch size derived from it    |
| `utils/`         | `D1Types`, `D1Utils`, `D1ErrorClassifier`                                     |

`SongDAO` and `SongIndexDAO` are separate because they answer different-shaped questions.
`SongDAO` owns one row; `SongIndexDAO` pages over a **group**, which means it runs two
statements — see the aggregation rule below. Keeping them apart is what makes the
page-then-fetch pattern readable in one place instead of duplicated five times.

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
  it was not one client or one page size. `songsForAlbumKeys` binds **two** variables per
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
    count: one variable per group under `folder` and `album`, two under `album_artist`. 49, not 50.
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
  `listArtists` on `artist_ci IS NOT NULL`, `listGenres` on `genre_ci IS NOT NULL` — so a
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
    `DERIVED_MARKER` — replace a value that is itself a guess, fill a NULL, leave a real
    tag — because a plain `COALESCE` there would re-select the row and then decline to
    change it, which is a version column that buys nothing. That is also why the marker is
    on the **album** as well as the artist: with the artist marked and the album bare, a
    version bump could correct a wrong artist and never a wrong album.
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
  `migrations/applied.lock.json` records the sha256 of everything applied so
  `test/schema.int.test.ts` fails on an edit. The suite was blind because it applied one
  hardcoded file, which cannot distinguish a new migration from an edit to an old one; it
  now reads the directory sorted, which is also how it found `0001_router_init.sql`'s
  foreign key to `users(email)` — unresolvable against a nullable, non-unique column, so
  `PRAGMA foreign_key_check` failed on the real schema. Dropped in `0003`.
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
  missed: using `ensure` turns every `GET` into a write against the 5,000-rows/day allowance on
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
- **No blanket `.catch(() => null)` on a D1 read.** Only `isMissingSchemaError` may
  degrade; everything else becomes a `DatabaseError`, or an outage reads as "not found".

## Schema

One migration, `migrations/0001_edge_sonic_init.sql`, with 17 tables. `libraries` and
`users` carry a `key_version` for credential rotation; `users` carries `token_epoch`,
bumped on a password change, because a Subsonic token is valid forever and that is the
only lever for revoking one. The header of the file records the free-tier arithmetic that
sets the scan's chunk size.

## Layer 2 (layer 0 only)

Import only `@edge-sonic/shared` and `@edge-sonic/backend-errors`. Never
`backend-runtime`, `backend-services`, or `apps/*` — enforced by `no-restricted-imports`.
