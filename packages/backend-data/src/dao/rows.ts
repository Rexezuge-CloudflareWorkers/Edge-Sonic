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

interface UserRow {
  id: string;
  username: string;
  username_ci: string;
  password_ciphertext: string;
  password_iv: string;
  key_version: number;
  token_epoch: number;
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
  created_at: number;
  updated_at: number;
}

interface ScanStateRow {
  library_id: string;
  status: string;
  cursor_path: string | null;
  scanned_count: number;
  total_count: number;
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

export type {
  UserRow,
  LibraryRow,
  NodeRow,
  SongRow,
  ScanStateRow,
  PlaylistRow,
  PlaylistEntryRow,
  CountRow,
  IndexVersionRow,
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
