/**
 * The `songs` write contracts: the upsert statement, and the shape of the
 * derived-metadata patch.
 *
 * Their own module because they have to be read together with the column list they
 * target: the `INSERT` list is what a **new** row gets, the `ON CONFLICT` clause is what
 * an existing one keeps, and the patch is what a later read writes back. Getting them out
 * of step is how a file ends up with a path-derived title on a rescan and no duration, or
 * with an `enriched_at` that survives a file whose bytes changed.
 */
import { DERIVED_VERSION } from './pathConvention';
import { GROUPING_SOURCE_DERIVED } from './groupingSource';

/**
 * Derived metadata and enrichment results, for one row.
 *
 * Every field is optional and absent means "leave this column alone", so a caller that
 * read one value does not blank out the rest — a format with no comment block must not
 * erase the path-convention fallback the indexer derived, because that fallback is what
 * keeps the track in `getArtists` and `getAlbumList2` until a real tag replaces it.
 */
interface SongMetadataInput {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  track?: number | null;
  disc?: number | null;
  year?: number | null;
  genre?: string | null;
  duration?: number | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  /**
   * Which version of the tag reader produced this write. Written with the values rather
   * than beside them, because a row whose `enriched_at` moved without its
   * `reader_version` is a row no future reader can tell apart from a current one — and
   * the reader is what decides whether a re-read is needed at all.
   */
  readerVersion?: number | null;
}

/**
 * Insert or refresh a song's file facts, and fill the *gaps* in its grouping columns.
 *
 * ### Why the derived columns are here at all
 *
 * `listAlbums` filters `album_ci IS NOT NULL AND album_ci <> ''`, `listArtists` filters
 * `artist_ci IS NOT NULL`, `listGenres` filters `genre_ci IS NOT NULL`. A row with
 * those NULL is not shown with a blank name — it is **absent from every aggregate**,
 * and `search3` cannot match it.
 *
 * Those columns are otherwise written only by a tag read: one ranged WebDAV request
 * per track, bounded twice over (a chunk spends most of its subrequest ceiling on
 * `PROPFIND`s, and a track past `SCAN_ENRICH_MAX_PER_FOLDER` keeps `enriched_at = NULL`
 * until a client opens it by hand). So for a library of any size most rows are
 * unenriched for a long time and the whole tag-organized half of the protocol answers
 * `[]`. It shipped — a client authenticated against 80 albums and saw empty artists,
 * albums, genres and search, while `getRandomSongs`, which does not group, returned
 * rows happily.
 *
 * The path already carries the answer, so it is written here, where the indexer
 * already knows `dir_path`. See `pathConvention.ts`.
 *
 * ### Why `COALESCE`, and why it is the whole safety argument
 *
 * `COALESCE(songs.album, excluded.album)` — the **existing** value wins, always. A
 * derived name can only fill a NULL, so an enrichment pass that has written the real
 * tag is never overwritten, and a rescan cannot roll a tag back to a guess. That is
 * what makes it safe to derive on *every* index rather than only on first sight, and
 * it is why this is a `COALESCE` and not a plain assignment in the `SET` list.
 *
 * ### What is deliberately not derived
 *
 * `genre`, `track`, `year`. There is no path convention for them that is not a guess,
 * and a guessed genre is worse than an absent one: it is offered to the user as though
 * it were real, and `getGenres` would publish it with a song count.
 *
 * ### `derived_version` is stamped here, and it is load-bearing
 *
 * The backfill (`songDerivation.ts`) selects `WHERE derived_version < ?` — the same
 * `reader_version` rule one layer down, because "the column is NULL" cannot express a
 * *corrected* convention. It did not stamp this one, so it took the migration's `DEFAULT 0`
 * and **every row this statement wrote was immediately owed to the backfill**: the page it
 * owed was `DERIVE_MAX_ROWS_PER_CHUNK` (200) single-row `UPDATE`s with `requireComplete`,
 * against a chunk budget of 42, so the write was refused on every poll, before
 * `listFrontier`, and the walk never ran. It shipped alongside the subrequest metering that
 * made the refusal reachable — the double in `test/scan-incremental.test.ts` stamped
 * `DERIVED_VERSION` and its comment asserted that this statement did, which is the
 * "a double may disagree with production about the very column under repair" defect on a
 * second column. `test/schema.int.test.ts` now runs this statement over real SQLite.
 *
 * Stamped **unconditionally**, like `APPLY_DERIVATION`, which stamps in all three of its
 * `CASE` branches including the one where the values did not change. The `COALESCE`s below
 * leave a real enrichment tag alone, and a row holding a real tag is equally not owed a
 * derivation — so the two statements cannot disagree about which rows the backfill owns.
 *
 * The value is interpolated from `DERIVED_VERSION` rather than typed, because a number typed
 * beside a query is wrong by the time somebody bumps the version.
 *
 * ### `grouping_source` is stamped on the `INSERT` and **not** in the `SET` list
 *
 * On insert it is `'derived'` unconditionally, including when the path said nothing useful.
 * That is deliberate: a row this statement created cannot hold a value any tag supplied, so
 * "no tag has written this row's grouping" holds, and stamping it unconditionally is what
 * keeps the row from being *permanently owed* the backfill — the way an unstamped
 * `derived_version` once made every row this statement wrote.
 *
 * On conflict it is **preserved** — absent from `SET` entirely — because this statement can
 * only ever *add* a derived value to a gap, and a row already carrying a tag's value must
 * not become flagged because a later gap was filled. Writing it out as
 * `grouping_source = songs.grouping_source` would say the same thing while reading, three
 * lines below, as though the omission were an oversight; this comment is the assertion.
 */
const UPSERT_FILE_FACTS = `INSERT INTO songs
  (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix, duration, bitrate,
   artist, artist_ci, album, album_ci, album_artist, album_artist_ci, created_at, updated_at, derived_version, grouping_source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ${DERIVED_VERSION}, '${GROUPING_SOURCE_DERIVED}')
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
  -- The text TAGS are left alone, and only the derived path names are filled. 'album'
  -- and 'artist' below take the path-derived value *only when the row has none*, so a
  -- real tag written by an enrichment pass is never rolled back to a guess — see the
  -- header. A mtime change therefore does not drop the track out of any group: it keeps
  -- the grouping it had, and 'enriched_at = NULL' guarantees the real value replaces it
  -- on the next read.
  duration = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.duration ELSE 0 END,
  bitrate = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.bitrate ELSE 0 END,
  sample_rate = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.sample_rate ELSE NULL END,
  channels = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.channels ELSE NULL END,
  enriched_at = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.enriched_at ELSE NULL END,
  -- Cleared with 'enriched_at', in the same statement and for the same reason. These two
  -- are one fact: this row's enrichment was produced from these bytes by some reader,
  -- and clearing one without the other leaves a row that claims to be enriched by a
  -- reader nobody is running any more.
  reader_version = CASE WHEN songs.mtime_ms = excluded.mtime_ms THEN songs.reader_version ELSE 0 END,
  id = excluded.id,
  name = excluded.name,
  name_ci = excluded.name_ci,
  size = excluded.size,
  mtime_ms = excluded.mtime_ms,
  content_type = excluded.content_type,
  suffix = excluded.suffix,
  -- The path-derived grouping, filling a gap and only a gap. Every '_ci' twin moves
  -- with its counterpart in the same statement, because a '_ci' column that drifts
  -- from its source is an unsearchable row and the drift is invisible until somebody
  -- searches.
  --
  -- 'album_artist' takes the derived artist as well: 'getArtist' groups on it, and an
  -- album whose album-artist column is NULL does not appear under the artist a client
  -- navigated to.
  artist = COALESCE(songs.artist, excluded.artist),
  artist_ci = COALESCE(songs.artist_ci, excluded.artist_ci),
  album = COALESCE(songs.album, excluded.album),
  album_ci = COALESCE(songs.album_ci, excluded.album_ci),
  album_artist = COALESCE(songs.album_artist, excluded.album_artist),
  album_artist_ci = COALESCE(songs.album_artist_ci, excluded.album_artist_ci),
  -- The convention that produced the grouping above is the current one, so this row owes
  -- the backfill nothing. On conflict this is the row's *second* pass through the same
  -- derivation, which is exactly what makes stamping it here rather than leaving it to the
  -- backfill the difference between a bounded pass and a permanent debt.
  derived_version = excluded.derived_version,
  updated_at = excluded.updated_at`;

export { UPSERT_FILE_FACTS };
export type { SongMetadataInput };
