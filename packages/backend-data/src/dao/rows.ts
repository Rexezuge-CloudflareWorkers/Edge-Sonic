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
