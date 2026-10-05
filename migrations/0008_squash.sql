-- Migration 0008: squash. The baseline, holding the combined schema of every
-- migration before it.
--
-- Absorbs, in full:
--
--   0001_edge_sonic_init.sql     the schema as it shipped
--   0001_router_init.sql         dead code from the project this repository was
--                                scaffolded from; see "What is NOT here"
--   0002_songs_reader_version.sql
--   0004_scan_retry_budget.sql
--   0005_songs_derived_version.sql
--   0006_songs_grouping_source.sql
--   0007_scan_state_changed.sql
--   0003_drop_router_tables.sql  the drops themselves; see "What is NOT here"
--
-- WHY SQUASH
--
-- A migration that has been applied must never change. D1 records applied
-- migrations by FILENAME in `d1_migrations`, so an edit to a shipped file is
-- skipped on every later `wrangler d1 migrations apply` — silently, with no
-- warning. The code starts naming a column the database does not have and every
-- statement that names it fails at runtime. `migrations/migrations.lock.json`
-- exists to make that a CI failure, and a lock cannot stop the *number* of
-- migrations growing.
--
-- So the first eight files are collapsed into one baseline, which is the form a
-- fresh database and every future development branch actually build from. The
-- lock records `0008_squash.sql` as its `baseline`; from here a schema change is
-- one new numbered file, and the immutable set is one entry.
--
-- WHAT THIS COSTS, STATED PLAINLY
--
-- D1's `d1_migrations` on an existing database still lists the eight absorbed
-- filenames, and this repository no longer describes what they contained. That
-- history is not reproducible from here. D1 itself keeps it, which is why the
-- baseline is safe to adopt, and why adopting one is a deliberate act rather
-- than a formatting change.
--
-- WHY EVERY STATEMENT IS IDEMPOTENT — read this before editing
--
-- This file does NOT run only on a fresh database. `d1_migrations` records the
-- absorbed filenames, so those files are skipped here and THIS one is
-- unapplied: it executes against production databases that already have every
-- table, every column and every index below.
--
-- Hence `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
-- throughout, and hence one rule that governs the whole file:
--
--   **This file must contain only statements that are no-ops against a database
--   that already has the full schema.**
--
-- Concretely, the four `ALTER TABLE ... ADD COLUMN` statements that the
-- absorbed migrations used are NOT reproduced. SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so re-running one fails with "duplicate column
-- name" — on every existing database, which is the only place this file runs
-- after its first application. Those columns are folded into their table's
-- `CREATE TABLE` instead, in the order the ALTERs appended them, so the
-- resulting `sqlite_schema` is identical to what the absorbed sequence
-- produced.
--
-- `test/schema.int.test.ts` asserts both properties against real SQLite: that
-- this file alone yields the same schema as the sequence it replaces, and that
-- applying it AFTER that sequence leaves the schema unchanged.
--
-- WHAT IS NOT HERE, AND WHY
--
-- `namespaces` and `router_backends` are not created, so nothing needs dropping.
-- They came from `0001_router_init.sql`, inherited from Durable-DAV-Router:
-- nothing in this codebase reads either table, and `0003` dropped both. Its
-- `users` declaration was always a no-op — both files say
-- `CREATE TABLE IF NOT EXISTS` and `0001_edge_sonic_init.sql` sorts first, so
-- Edge-Sonic's own `users` won.
--
-- That file also carried a **broken foreign key**:
--
--     owner_email TEXT, FOREIGN KEY (owner_email) REFERENCES users(email)
--
-- while `users` is keyed on `id` and its `email` is nullable and non-unique.
-- SQLite resolves a foreign key to a *unique* index on the parent column, so
-- the reference did not resolve at all: `PRAGMA foreign_key_check` failed with
-- `foreign key mismatch`. D1 enforces foreign keys, so that was a landmine whose
-- error named a table no operator knew existed. Deleting the file removes the
-- landmine permanently rather than leaving a `DROP` to keep carrying.
--
-- Two `0001_` files sharing a prefix was itself the defect that forced this
-- squash: D1 orders migrations by the REST of the filename, so which of the two
-- landed on a given database depended on a lexicographic tiebreak nobody
-- intended, and a database that had run one could never run the other.
-- `scripts/migrations/lock-check.ts` fails on exactly that.
--
-- OMITTED DATA MIGRATION
--
-- `0006` carried an `UPDATE songs SET grouping_source = 'derived' WHERE artist
-- LIKE '% (derived)' OR album LIKE '% (derived)' OR album_artist LIKE '%
-- (derived)'`. It is absent here, and that omission is checked rather than
-- assumed:
--
--   - On a fresh database `songs` is empty, so it would match nothing.
--   - On an existing database `0006` has already run and stamped every row it
--     matched, and every row written since carries `grouping_source = 'derived'`
--     directly, so it would again match nothing.
--
-- `test/schema.int.test.ts` seeds rows bearing the old marker and asserts that
-- running the absorbed sequence leaves no row carrying it.
--
-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- Subsonic clients authenticate with `u` + `t=md5(password+salt)`. That token is
-- NOT derivable from a password hash, so the worker must be able to recover the
-- plaintext on every request; see the `password_ciphertext` note below.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  -- As sent in `?u=`. Preserved verbatim so the admin UI can show what the user
  -- actually types; `username_ci` is the lookup key.
  username TEXT NOT NULL,
  -- Subsonic usernames are matched case-insensitively by every client, so the
  -- lookup is on the lowercased form. See the predicate rule in AGENTS.md:
  -- lowercases the PARAMETER, never the column.
  username_ci TEXT NOT NULL,
  -- AES-256-GCM under SUBSONIC_USER_ENCRYPTION_KEY_SECRET. Reversible *by
  -- necessity*, not by choice: navidrome#202 documents that token auth cannot
  -- work otherwise. This is obfuscation against a D1 dump, not protection
  -- against a full worker compromise — which is precisely why the daily backup
  -- refuses to leave D1 unencrypted.
  password_ciphertext TEXT NOT NULL,
  password_iv TEXT NOT NULL,
  -- Ships at 1 and is read by nothing. It exists so rotating a leaked key is a
  -- re-encrypt migration rather than a schema break or a forced reset for every
  -- user.
  key_version INTEGER NOT NULL DEFAULT 1,
  -- Bumped on password change. A Subsonic token is valid forever, so without
  -- this there is no way to invalidate one after a password change.
  token_epoch INTEGER NOT NULL DEFAULT 1,
  email TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  scrobbling_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(username_ci);

-- ---------------------------------------------------------------------------
-- Libraries (WebDAV origins)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  slug_ci TEXT NOT NULL,
  -- Bare origin, e.g. https://dav.example.com. Never a path, never a query.
  base_url TEXT NOT NULL,
  -- Path prefix within the origin, e.g. /remote.php/dav/files/alice/Music.
  root_path TEXT NOT NULL,
  -- WebDAV Basic username. Not secret on its own, but see the SSRF note.
  dav_username TEXT NOT NULL,
  -- AES-256-GCM under WEBDAV_ENCRYPTION_KEY_SECRET. A separate key from the
  -- user key on purpose: this one is read on every scan and every stream, so it
  -- has a far larger exposure surface, and it must not be able to mint a
  -- Subsonic session.
  password_ciphertext TEXT NOT NULL,
  password_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  display_name TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_slug_ci ON libraries(slug_ci);

-- Which Subsonic users may see which libraries. Many-to-many: a family can
-- share one WebDAV bucket behind separate Subsonic accounts, and `getMusicFolders`
-- is filtered through this.
CREATE TABLE IF NOT EXISTS user_libraries (
  user_id TEXT NOT NULL,
  library_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, library_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_libraries_library ON user_libraries(library_id);

-- ---------------------------------------------------------------------------
-- The index: the folder tree
-- ---------------------------------------------------------------------------
--
-- One row per folder, materialized by the scan and by read-through
-- materialization of an uncached `getMusicDirectory` folder.
--
-- `path` is the library-relative, percent-DECODED path. Decoded on the way in
-- and used decoded everywhere, because a value stored encoded and compared
-- against a decoded one is how a traversal check ends up validating a different
-- string than the one that gets fetched.
--
-- `path` is compared EXACTLY and is case-sensitive. A WebDAV origin on Linux is
-- case-sensitive, so lowercasing would merge `Album/` with `album/` and index a
-- file that does not exist. Case-insensitive matching lives in the separate
-- `_ci` columns, which is also what keeps the predicate rule intact: lowercases
-- the parameter, never the column.
CREATE TABLE IF NOT EXISTS nodes (
  library_id TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ci TEXT NOT NULL,
  -- `getlastmodified` as epoch milliseconds. THE change-detection primitive: the
  -- scan compares this against a fresh PROPFIND and only descends into folders
  -- that moved, so an unchanged rescan writes zero rows.
  mtime_ms INTEGER,
  etag TEXT,
  depth INTEGER NOT NULL,
  is_scanned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (library_id, path),
  FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
);

-- `getIndexes` lists a folder's children, ordered by name.
CREATE INDEX IF NOT EXISTS idx_nodes_parent_ci ON nodes(library_id, parent_path, name_ci);
-- The scan walks the frontier in a stable order so a resumed scan is deterministic.
CREATE INDEX IF NOT EXISTS idx_nodes_frontier ON nodes(library_id, is_scanned, depth);

-- ---------------------------------------------------------------------------
-- The index: songs
-- ---------------------------------------------------------------------------
--
-- One row per playable file. The Subsonic `id` is the primary key, and it is
-- REVERSIBLE (`s:base64url(libraryId + "\n" + path)`), so resolving an id to a
-- path is a base64 decode rather than a query. This table is what makes search,
-- album lists and genre queries answerable.
--
-- The four columns after `updated_at` were each `ALTER TABLE ... ADD COLUMN` in
-- an absorbed migration. They are folded in here, in the order the ALTERs
-- appended them, so the schema is identical to the sequence this file replaces.
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL,
  -- Library-relative path, exact and case-sensitive, matching `nodes.path`.
  path TEXT NOT NULL,
  -- The containing folder. THIS is how an album is resolved to its songs, and
  -- it is why an album's Subsonic id must be derived from a directory path
  -- rather than an album name: rename the folder and a name-derived id silently
  -- orphans every star.
  dir_path TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Lowercased twin of `name`, for the ORDER BY clauses that must present a
  -- stable, case-insensitive ordering. Every writer sets it in the same
  -- statement as `name`; a `_ci` column that drifts from its counterpart is an
  -- unsearchable row, and the drift is invisible until someone searches.
  name_ci TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  suffix TEXT NOT NULL DEFAULT '',
  -- ---- derived metadata ----
  title TEXT,
  title_ci TEXT,
  artist TEXT,
  artist_ci TEXT,
  album TEXT,
  album_ci TEXT,
  album_artist TEXT,
  album_artist_ci TEXT,
  track INTEGER,
  disc INTEGER,
  year INTEGER,
  genre TEXT,
  genre_ci TEXT,
  -- 0 until the lazy tag read fills them. A client that gets 0 shows a scrubber
  -- it cannot use; a client that gets a WRONG value seeks to the wrong place.
  duration INTEGER NOT NULL DEFAULT 0,
  bitrate INTEGER NOT NULL DEFAULT 0,
  sample_rate INTEGER,
  channels INTEGER,
  -- When duration/bitrate were last read from the file, for staleness reporting.
  enriched_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Which version of the *tag reader* produced `enriched_at`. Staleness is a
  -- function of two things and only one used to be recorded: the file's bytes
  -- (via `mtime_ms`) and the reader that extracted from them. A corrected reader
  -- otherwise leaves every row it already wrote looking current, because the
  -- file genuinely has not moved. It shipped — a fixed Ogg reader left a live
  -- library reporting a 240.61s track as 3s at 15329 kbps with no tags, and no
  -- rescan re-read it.
  reader_version INTEGER NOT NULL DEFAULT 0,
  -- Which convention version last *examined* this row's path-derived grouping.
  -- A version, not "is the column NULL": once a derivation has written a value
  -- the columns are no longer NULL, so a later and better `pathConvention` could
  -- never reach the rows an earlier one wrote.
  derived_version INTEGER NOT NULL DEFAULT 0,
  -- `'derived'` means all three of artist/album/album_artist came from
  -- `dir_path`; anything else is NULL. A column rather than a marker suffix in
  -- the value, because the marker was configuration and a `LIKE` is not a
  -- string — see `migrations/0006` history, absorbed here. Deliberately
  -- unindexed: it is read only inside a `WHERE id = ?` and is never a selection
  -- predicate.
  grouping_source TEXT,
  FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
);

-- The PROPFIND reconciliation lookup, and the identity that prevents two rows
-- describing one file.
CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_library_path ON songs(library_id, path);
-- `getArtists` and `getAlbumList2` group by this; covered so the aggregation does
-- not sort on every request.
CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(library_id, album_artist_ci, album_ci);
CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(library_id, artist_ci);
-- `getSongsByGenre`.
CREATE INDEX IF NOT EXISTS idx_songs_genre ON songs(library_id, genre_ci);
-- `getMusicDirectory` on a scanned folder.
CREATE INDEX IF NOT EXISTS idx_songs_dir ON songs(library_id, dir_path, track);
-- Prefix search (`search3` with a term the user has not finished typing) resolves
-- to a range scan on this index.
--
-- INFIX search cannot use any index: a leading `%` makes the pattern's start
-- unknown, so SQLite falls back to a scan of the library's rows. That is
-- deliberate for v1 — a personal library is thousands of rows, and FTS5 would
-- add a virtual table whose rows must be kept in step with `songs` on every
-- scan. The day a query plan says otherwise, this is the note to revisit.
CREATE INDEX IF NOT EXISTS idx_songs_title_ci ON songs(library_id, title_ci);
CREATE INDEX IF NOT EXISTS idx_songs_album_title_ci ON songs(library_id, album_ci);
-- Serves the derived-grouping backfill's own selection, `derived_version < ?`,
-- scoped to one library. The existing `(library_id, album_ci)` index cannot: a
-- drained library has every row at the current version, so the predicate is a
-- range scan on a column nothing else filters by. This makes it a seek that
-- returns nothing immediately once the library is caught up, which is what keeps
-- a poll on a fully-derived library costing one indexed read and zero rows.
CREATE INDEX IF NOT EXISTS idx_songs_derived ON songs(library_id, derived_version);

-- ---------------------------------------------------------------------------
-- Scan state
-- ---------------------------------------------------------------------------
--
-- `index_version` is the cache-invalidation primitive. It increments when a scan
-- completes, and every KV key embeds it, so entries written under a superseded
-- version become STRUCTURALLY unreachable and age out by TTL. Invalidation
-- therefore costs zero KV deletes — the alternative (`del` on every cache entry
-- for a library) is the quota trap this design exists to avoid.
CREATE TABLE IF NOT EXISTS scan_state (
  library_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle',
  -- Resumable frontier. A chunked scan that overshoots the daily D1 write
  -- allowance degrades to "takes a couple of days", never to "fails".
  cursor_path TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  -- Increments on completion; embedded in every cache key for this library.
  index_version INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  -- Bounded retry budget, and it lives in D1 because it has to survive the
  -- isolate: a module-level counter resets whenever a different isolate serves
  -- the next poll. Bounded rather than unlimited because retrying a *permanent*
  -- fault is a loop that spends the operator's subrequest budget to reach the
  -- same conclusion — `markScanning` resets it and is the escape hatch.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Did THIS scan change the index. `rows_written > 0` is the wrong signal: most
  -- rows a rescan writes are frontier bookkeeping, and invalidating a cache for
  -- them is a false answer. Set from what a cached aggregate depends on, never
  -- from the folder's own frontier row.
  changed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- User state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  comment TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  -- Denormalized so `getPlaylists` does not need a correlated count per row.
  song_count INTEGER NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_playlists_public ON playlists(is_public);

CREATE TABLE IF NOT EXISTS playlist_entries (
  playlist_id TEXT NOT NULL,
  -- Gapless, zero-based, and part of the primary key so position is unique. The
  -- Subsonic protocol addresses entries by index (`songIndexToRemove`), so two
  -- rows sharing a position would make removal ambiguous.
  position INTEGER NOT NULL,
  song_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_entries_song ON playlist_entries(song_id);

-- Stars and ratings are per-user and cover three item types.
CREATE TABLE IF NOT EXISTS stars (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  starred_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id, item_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stars_user_type ON stars(user_id, item_type, starred_at);

CREATE TABLE IF NOT EXISTS ratings (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  -- The protocol allows 1..5.
  rating INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id, item_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  position_ms INTEGER NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, song_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS play_queue (
  user_id TEXT PRIMARY KEY,
  current_song_id TEXT,
  position_ms INTEGER NOT NULL DEFAULT 0,
  changed TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS play_queue_entries (
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  song_id TEXT NOT NULL,
  PRIMARY KEY (user_id, position),
  -- Must reference `users(id)`, not `users(user_id)`: the child declares a
  -- foreign key to a *parent key*, and `user_id` is not unique on `users` — it
  -- is the natural key for the `user_libraries` join. Pointing at it produces a
  -- "foreign key mismatch" that only surfaces at runtime on the first write.
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS play_counts (
  user_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER,
  PRIMARY KEY (user_id, song_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- `getNowPlaying`. A single row per user, upserted on `scrobble`. This is a
-- write on a hot path, but scrobbles are rare (one per track, not per request).
CREATE TABLE IF NOT EXISTS now_playing (
  user_id TEXT PRIMARY KEY,
  song_id TEXT,
  player_name TEXT,
  player_id TEXT,
  username TEXT,
  minutes_ago INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Failed-authentication counters.
--
-- A dedicated table rather than rows in `settings`, for two reasons: the prune is
-- an exact primary-key delete instead of a `LIKE` over unrelated configuration,
-- and a table that only ever holds counters cannot grow without anyone noticing.
--
-- `bucket` is the floor of `now / windowSeconds`, so a counter expires by falling
-- out of the key space rather than by a delete that has to be scheduled.
CREATE TABLE IF NOT EXISTS auth_failures (
  identity TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 1,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (identity, bucket)
);

-- Server-wide settings that are not build constants. `serverType` and
-- `serverVersion` are reported from code, not from here.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Default settings, written by the migration so a fresh database is usable
-- without a seeding step. `OR IGNORE` rather than `INSERT`, so this is a no-op
-- against a database that already seeded it.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('schema_initialized', '1', 0);