/**
 * The `songs` upsert statement.
 *
 * Its own file because the statement is long and its two halves have to be read together:
 * the column list is what a **new** row gets, and the `ON CONFLICT` clause is what an
 * existing one keeps. Getting them out of step is how a file ends up with a path-derived
 * title on a rescan and no duration, or with an `enriched_at` that survives a file whose
 * bytes changed.
 */
const UPSERT_FILE_FACTS = `INSERT INTO songs
  (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix, duration, bitrate, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
ON CONFLICT (library_id, path) DO UPDATE SET
  -- The bytes changed, so everything read *out of* those bytes is stale. Leaving
  -- 'duration' alone here is the silent bug this guards: a client shows a scrubber for a
  -- track whose length is now wrong, no error is ever raised, and EnrichmentService
  -- short-circuits on 'enriched_at' so nothing ever re-reads it.
  --
  -- 'mtime_ms' is compared in the same statement, so one scan pass both notices the change
  -- and invalidates the result - there is no window where a row claims a new mtime with
  -- the old duration. Every right-hand side is evaluated against the pre-update row, so
  -- the later 'mtime_ms = excluded.mtime_ms' cannot affect it.
  --
  -- The text tags are deliberately left alone. They survive as the path-convention
  -- fallback for getArtists/getAlbumList2, which group by them; clearing them would drop
  -- the track out of every group until a client opened it. They are overwritten the
  -- moment 'enrich' re-reads the file, which 'enriched_at = NULL' now guarantees.
  duration = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.duration ELSE 0 END,
  bitrate = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.bitrate ELSE 0 END,
  sample_rate = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.sample_rate ELSE NULL END,
  channels = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.channels ELSE NULL END,
  enriched_at = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.enriched_at ELSE NULL END,
  id = excluded.id,
  name = excluded.name,
  name_ci = excluded.name_ci,
  size = excluded.size,
  mtime_ms = excluded.mtime_ms,
  content_type = excluded.content_type,
  suffix = excluded.suffix,
  updated_at = excluded.updated_at`;

export { UPSERT_FILE_FACTS };
