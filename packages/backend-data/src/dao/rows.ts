/**
 * D1 row shapes.
 *
 * One file so a column rename is a single edit, and so a DAO and the mapper that
 * consumes it cannot disagree about a field's name.
 *
 * These are the *storage* types, not the Subsonic types. Keeping them separate is
 * what stops a D1 column from becoming part of the protocol surface: `song` has
 * no `path` field in Subsonic and none is emitted, even though `SongRow` has one.
 */
import type { GroupingSource } from './groupingSource';

interface UserRow {
  id: string;
  username: string;
  username_ci: string;
  password_ciphertext: string;
  password_iv: string;
  key_version: number;
  email: string | null;
  is_admin: number;
  is_enabled: number;
  scrobbling_enabled: number;
  created_at: number;
  updated_at: number;
}

interface LibraryRow {
  id: string;
  slug: string;
  slug_ci: string;
  base_url: string;
  root_path: string;
  dav_username: string;
  password_ciphertext: string;
  password_iv: string;
  key_version: number;
  display_name: string | null;
  is_enabled: number;
  created_at: number;
  updated_at: number;
}

interface NodeRow {
  library_id: string;
  path: string;
  parent_path: string;
  name: string;
  name_ci: string;
  mtime_ms: number | null;
  etag: string | null;
  depth: number;
  is_scanned: number;
  created_at: number;
  updated_at: number;
}

/**
 * A child of a folder, plus whether a `songs` row exists for it.
 *
 * The join is the point. A reconcile pass has to answer "does this child need writing" once for
 * the **node** row and once for the **song** row, and answering the second from `nodes` — which is
 * what `changed` did — is a proxy that the two tables are free to disagree about. They do
 * disagree whenever a write batch truncates between the two writers, and the disagreement is
 * permanent: the folder closes with the node row present and the song row never written, so no
 * later pass re-offers it. Measured on a live library: 117 `nodes` rows, 116 `songs` rows, one
 * track absent from every album list with no error anywhere.
 *
 * So the caller reads both planes in the statement it already issues, rather than spending a
 * second subrequest to ask.
 */
type ChildNodeRow = NodeRow & {
  /**
   * `1` when a `songs` row exists for this path, `0` when it does not.
   *
   * `0` is also the answer for every non-audio file and every subfolder, because only audio
   * children become songs — so this is meaningful **only after** the caller has decided the
   * child is audio. Read in the other order it is a guarantee that a `cover.jpg` will be
   * upserted as a song for ever.
   */
  has_song: 0 | 1;
  /**
   * The `songs.id` for this path, or `null` when there is no song row.
   *
   * Read from the same `LEFT JOIN` as `has_song`, so reusing an existing id costs
   * no extra statement. Song ids are derived from `(library_id, path)` (see
   * `subsonic/songId.ts`) — a writer that derived unconditionally would rename a
   * legacy row out from under the id backfill's selection, so the existing id is
   * reused and only a missing row derives.
   */
  song_id: string | null;
};

interface SongRow {
  id: string;
  library_id: string;
  path: string;
  dir_path: string;
  name: string;
  name_ci: string;
  size: number;
  mtime_ms: number;
  content_type: string | null;
  suffix: string;
  title: string | null;
  title_ci: string | null;
  artist: string | null;
  artist_ci: string | null;
  album: string | null;
  album_ci: string | null;
  album_artist: string | null;
  album_artist_ci: string | null;
  track: number | null;
  disc: number | null;
  year: number | null;
  genre: string | null;
  genre_ci: string | null;
  duration: number;
  bitrate: number;
  sample_rate: number | null;
  channels: number | null;
  enriched_at: number | null;
  /**
   * Which version of the tag reader produced `enriched_at`.
   *
   * Staleness is a function of the file's bytes *and* of the reader that extracted from
   * them, and only the first was recorded — so a reader that learns to read something
   * it previously could not leaves every row it already wrote looking current. See
   * `READER_VERSION` in `media-tags` and the migration's comment.
   */
  reader_version: number;
  /**
   * Which version of `pathConvention` wrote this row's `album`/`artist`.
   *
   * The derivation's half of the same invariant as `reader_version`. Every writer of the
   * grouping columns is gated on the file having *changed*, so a version bump is the only
   * thing that can reach rows an earlier convention wrote — without it, a corrected
   * derivation would leave a wrong guess in place for ever, exactly as a corrected reader
   * once did. See `pathConvention.ts`.
   */
  derived_version: number;
  /**
   * Who wrote `artist` / `album` / `album_artist`: the path convention, or a file's tags.
   *
   * `'derived'` means **all three** came from `dir_path`; anything else means a tag
   * supplied at least one, and a derivation may no longer replace the row's grouping. It
   * was a suffix on the value itself, which cannot be configured: an empty marker is a
   * match-all and any other marker is a `LIKE` pattern, so the guard either stopped
   * recognising its own guesses or stopped recognising anything. See `groupingSource.ts`.
   */
  grouping_source: GroupingSource;
  created_at: number;
  updated_at: number;
}

interface ScanStateRow {
  library_id: string;
  status: string;
  cursor_path: string | null;
  scanned_count: number;
  total_count: number;
  /**
   * Whether this scan wrote anything, accumulated by `saveProgress` and consumed by
   * `complete`.
   *
   * Read-only, and never set by a caller: it is the answer to "did the last scan change
   * the index", which only the statements that did the writing can give.
   */
  readonly changed?: number;
  index_version: number;
  last_error: string | null;
  started_at: number | null;
  /**
   * Consecutive chunks that ended in a failure.
   *
   * Bounded retries, not a boolean. A scan that failed once is retried by the next
   * poll — the frontier is in D1 and the fault may have been transient — so a `failed`
   * status cannot itself be terminal. Without a count, a permanently broken library
   * is re-attempted on every poll for ever.
   *
   * In D1 rather than in a module-level variable because it must survive the isolate:
   * a counter that resets when a different isolate serves the next poll is not a bound.
   */
  consecutive_failures: number;
  updated_at: number;
}

interface PlaylistRow {
  id: string;
  owner_user_id: string;
  name: string;
  comment: string | null;
  is_public: number;
  song_count: number;
  duration: number;
  created_at: number;
  updated_at: number;
}

interface PlaylistEntryRow {
  playlist_id: string;
  position: number;
  song_id: string;
  created_at: number;
}

interface CountRow {
  cnt: number;
}

interface IndexVersionRow {
  index_version: number;
}

/**
 * A registered remote Subsonic instance.
 *
 * `username_ci` exists because the remote's own login is case-insensitive on every
 * server worth importing from, and the `_ci` twin is what keeps the predicate on an index —
 * the rule this whole layer states and `test/schema.int.test.ts` asserts.
 */
interface ImportSourceRow {
  id: string;
  name: string;
  base_url: string;
  username: string;
  username_ci: string;
  /**
   * AES-256-GCM under `SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET` — a **third** key, not the
   * user key and not the WebDAV key.
   *
   * Worth stating in the row type because it is the reason this table is not `libraries`
   * with a different column: a remote credential is operator-supplied and re-entered per
   * source, so a rotation of this key must not require re-entering any Subsonic user's
   * password, and a compromise of the frequently-read WebDAV key must not yield it.
   */
  password_ciphertext: string;
  password_iv: string;
  key_version: number;
  music_folder_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * One import run.
 *
 * `report_json` holds the per-phase outcome **including every item that did not
 * resolve**. An import that silently dropped three tracks from a playlist is a wrong
 * answer rather than an unfinished one, and this column is the only place that could say
 * which three — so it is written by every phase and read by the operator surface.
 */
interface ImportRunRow {
  id: string;
  source_id: string;
  target_user_id: string;
  /**
   * `running` | `completed` | `failed` | `paused`.
   *
   * The same four names `scan_state` uses, deliberately: an operator reading a scan and an
   * operator reading an import are asking the same question — "will more work happen if I
   * poll again?" — and one vocabulary is cheaper to reason about than two that mean the
   * same thing.
   */
  status: string;
  workflow_id: string | null;
  play_count_worker: string | null;
  phases_json: string;
  report_json: string | null;
  last_error: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

export type {
  UserRow,
  LibraryRow,
  NodeRow,
  ChildNodeRow,
  SongRow,
  ScanStateRow,
  PlaylistRow,
  PlaylistEntryRow,
  CountRow,
  IndexVersionRow,
  ImportSourceRow,
  ImportRunRow,
};

/**
 * What a star or a rating can point at.
 *
 * The ids are the same reversible ids every other response uses, so a star on an album is
 * stored against the album's own id and resolves back through the same `groupAlbums` path
 * a listing would take. The type lives with the row shapes because that is what it
 * describes.
 */
export type StarItemType = 'song' | 'album' | 'artist';
