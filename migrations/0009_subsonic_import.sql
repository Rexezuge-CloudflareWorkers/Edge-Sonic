-- ---------------------------------------------------------------------------
-- Importing player data from another Subsonic server
-- ---------------------------------------------------------------------------
--
-- WebDAV stays the only origin for *music*. Everything here is state that exists
-- nowhere but in a database — playlists, stars, ratings, bookmarks, a play queue
-- and play counts — which is why it has to travel over the protocol rather than
-- being copied off the filesystem. There is no file representation of a favourite.
--
-- `import_sources` is a *remote instance the operator registered*, which is a
-- different thing from `libraries` (a WebDAV bucket this server indexes). They are
-- kept apart deliberately:
--
-- - `libraries.password_ciphertext` is guarded by `WEBDAV_ENCRYPTION_KEY_SECRET`,
--   the key read on every scan and every stream. It has the largest exposure
--   surface in the product.
-- - `import_sources.password_ciphertext` is guarded by
--   `SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET`, a third key that exists so rotating a
--   remote instance's credential never requires re-entering a single user's Subsonic
--   password. Merging it into the user key would make the most frequently used
--   credential in the product also the one guarding every library and every remote.
--
-- Three keys, one per feature, never merged — the rule `docs/agents/runtime`
-- states for the two that already existed.

CREATE TABLE IF NOT EXISTS import_sources (
  id TEXT PRIMARY KEY,
  -- Operator-chosen label. Display only; nothing addresses a source by slug.
  name TEXT NOT NULL,
  -- Bare origin plus an optional mount path, e.g. `https://music.example.com/sonic`.
  --
  -- A *path* is permitted here and is refused by `normalizeBaseUrl` for a WebDAV
  -- library, because a WebDAV root path is a column of its own while a Subsonic
  -- server mounted under a reverse proxy has nowhere else to put it. The SSRF gate is
  -- the same one, and re-applied on read: see `remoteSubsonic.ts`.
  base_url TEXT NOT NULL,
  -- The remote Subsonic account, as `?u=`. Case-insensitively matched by clients, so
  -- a `_ci` twin like every other name this product looks up.
  username TEXT NOT NULL,
  username_ci TEXT NOT NULL,
  -- AES-256-GCM under SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET. See the note above on
  -- why this is not the user key.
  password_ciphertext TEXT NOT NULL,
  password_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  -- Which music folder on the remote to read, when it has more than one. `null` is
  -- "the first", which is what every third-party server answers when asked for its
  -- folders and what a single-folder server has anyway.
  music_folder_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexed on the **`username_ci` twin**, not on `name`. Two sources may share a name — a staging
-- server called "music" beside a production one called "music" is the ordinary case — so the
-- uniqueness that matters is per-credential. This index is what makes `findByName`'s lookup a
-- seek: it is the predicate rule this whole schema follows, and a `lower(name)` here would be a
-- scan of every source on a table that will hold a handful.
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_sources_username_ci ON import_sources(username_ci);

-- One import run.
--
-- `status` is the same vocabulary `scan_state` uses, deliberately: an operator
-- reading a scan and an operator reading an import are asking the same question —
-- "will more work happen if I poll again?" — and one set of words is cheaper to
-- reason about than two that mean the same thing.
--
-- `report_json` holds the per-phase, per-category outcome including **every item that
-- did not resolve to a local song**. An import that silently dropped three tracks
-- from a playlist is a wrong answer rather than an unfinished one, and nothing else
-- in this schema could tell the operator which three.
CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  -- The Subsonic account the imported data belongs to. `ON DELETE CASCADE`: the
  -- annotations a run wrote cascade with the user anyway, so a run outliving them
  -- would be a report about rows that no longer exist.
  target_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  -- The Cloudflare Workflow instance and the Durable Object walking the play counts,
  -- so the operator surface can report progress from either without re-deriving an id.
  workflow_id TEXT,
  play_count_worker TEXT,
  -- Which phases were asked for, and which the operator deliberately left out. The
  -- play queue is opt-in because a saved queue is transient state most people moving
  -- between servers do not want restored, and a default-on would import it silently.
  phases_json TEXT NOT NULL,
  -- The per-phase, per-category outcome, **including every item that did not resolve** to a
  -- local song.
  --
  -- An import that silently dropped three tracks from a playlist is a **wrong answer** rather
  -- than an unfinished one, and it is indistinguishable from a playlist the user deliberately
  -- shortened. So the report names each one, and this column is the only place it could.
  --
  -- `TEXT` holding JSON rather than a normalised table, for two reasons that are the same
  -- reason: the set is **closed** (the phases above) and the item list is **unbounded and
  -- read-only** once written. A row per unresolved item would be thousands of writes against
  -- a 5,000-rows/day allowance to store a report nobody will query by item — the operator reads
  -- the whole thing. The bound is `MAX_REPORTED_UNRESOLVED` in `import/report.ts`, so this is
  -- a fixed size rather than a function of the library.
  report_json TEXT,
  -- Why the run stopped, or `null`. Mirrors `scan_state.last_error`: a diagnosis
  -- nothing can retrieve is the same defect as never computing one.
  last_error TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (source_id) REFERENCES import_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_import_runs_user ON import_runs(target_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_runs_source ON import_runs(source_id);

-- Where an alarm-chained play-count walk has got to.
--
-- **Durable Object storage, not here.** The walk is bounded by the platform's
-- subrequest ceiling per alarm invocation and resumes from this cursor, so it must
-- survive an eviction — and it must be writable when D1 is refusing writes, which is
-- exactly when a run is most likely to need to record why it stopped. It is the same
-- reason `ScanPauseStore` holds the scan's pause in DO storage.
--
-- Kept here as a row anyway, for the same reason it is there at all: the operator's
-- page reads D1, and a run whose progress only existed in an object storage the page
-- cannot reach would render as "no progress" rather than as "paused".
--
-- `remote_album_id` is the cursor and `last_played_at` the tiebreak, so a resumed
-- walk continues rather than restarting. A walk that restarted would re-import every
-- album it had already done — which for a play-count import means *adding* to counts
-- that were already set, since play counts are additive by nature.
CREATE TABLE IF NOT EXISTS import_play_count_progress (
  run_id TEXT PRIMARY KEY,
  last_remote_album_id TEXT,
  albums_done INTEGER NOT NULL DEFAULT 0,
  songs_imported INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES import_runs(id) ON DELETE CASCADE
);