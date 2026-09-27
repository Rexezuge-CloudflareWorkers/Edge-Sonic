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
| `dao/NodeDAO.ts` | the folder tree, the scan frontier, the subtree prune                         |
| `dao/playlists.ts` | a named, ordered list of songs owned by one user                            |
| `dao/UserStateDAO.ts` | per-user state: playlists, stars, ratings, bookmarks, play queue, now playing, throttle |
| `dao/identity.ts` | `UserDAO` and `LibraryDAO` — the two rows with a credential                   |
| `dao/songSql.ts` | the `songs` upsert statement                                                  |
| `dao/chunking.ts`| `chunkArray`, for `IN (...)` binding                                          |
| `utils/`         | `D1Types`, `D1Utils`, `D1ErrorClassifier`, `UpdateClause`                     |

`SongDAO` and `SongIndexDAO` are separate because they answer different-shaped questions.
`SongDAO` owns one row; `SongIndexDAO` pages over a **group**, which means it runs two
statements — see the aggregation rule below. Keeping them apart is what makes the
page-then-fetch pattern readable in one place instead of duplicated five times.

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
- **Aggregate queries page over groups, then fetch every row of the groups on the page.**
  A SQL `GROUP BY` returns one *representative row* per group, so counting from it
  reports 1 for a real discography. This shipped: every album in the product reported
  `songCount: 1` and its first track's duration. The second query deliberately does **not**
  re-apply the year or genre filter — those choose which albums appear, and a partial
  track count for a selected album is the same bug in a narrower window.
- **A changed file invalidates its own enrichment, in the same statement.** The upsert
  compares `mtime_ms` and clears `duration`/`bitrate`/`sample_rate`/`channels`/
  `enriched_at` together. Doing it in two statements leaves a window where a row claims a
  new mtime with the old duration, and `EnrichmentService` — which short-circuits on
  `enriched_at` — will never re-read it. The text tags are deliberately *kept*: they are
  the path-convention fallback `getArtists` groups by, and clearing them would drop the
  track out of every group.
- **An ordered id list stays ordered.** `id IN (...)` returns rows in index-scan order, so
  `listIdsIn` re-orders to the caller's list. Ids that do not resolve are omitted, not
  substituted.
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
