/**
 * The Subsonic domain model, and its single translation to protocol nodes.
 *
 * Every endpoint returns one of these types and never hand-builds an element, so
 * the same field cannot be present for `getAlbum` and missing for `getSong` —
 * the class of bug that only surfaces in the client screen that reads the field
 * nobody else does.
 *
 * Conventions carried over from the reference repository and kept deliberately:
 *
 * - **Nullable, not optional, for "the server may legitimately not know this"**
 *   (`duration: number | null`). Optional is reserved for "this endpoint does not
 *   carry the field at all". Conflating the two is how a `0` duration starts
 *   meaning "unknown" and a real zero-length track becomes unplayable.
 * - Epoch values stay numbers, not ISO strings, where the protocol says so.
 */

interface Song {
  readonly id: string;
  /** Album ID, when the library index can resolve one. */
  readonly albumId?: string;
  /** Artist ID, when the library index can resolve one. */
  readonly artistId?: string;
  readonly title: string;
  readonly album?: string;
  readonly artist?: string;
  readonly track?: number;
  readonly discNumber?: number;
  readonly year?: number;
  readonly genre?: string;
  /** 0 when the tag has not been read yet. See `media-tags`. */
  readonly duration: number;
  /** kbps. 0 when unknown. */
  readonly bitRate: number;
  readonly size: number;
  readonly contentType: string;
  readonly suffix: string;
  /** Library-relative path. Not emitted: it leaks the storage layout. */
  readonly created?: string;
  readonly starred?: string;
  readonly playCount?: number;
  readonly userRating?: number;
  readonly coverArt?: string;
  readonly bookmarkPosition?: number;
  readonly mediaType: 'song';
}

interface Album {
  readonly id: string;
  readonly name: string;
  readonly artist?: string;
  readonly artistId?: string;
  readonly songCount: number;
  /** Total seconds. */
  readonly duration: number;
  readonly year?: number;
  readonly genre?: string;
  readonly coverArt?: string;
  readonly created?: string;
  readonly starred?: string;
  readonly playCount?: number;
  readonly userRating?: number;
}

interface Artist {
  readonly id: string;
  readonly name: string;
  readonly albumCount: number;
  readonly coverArt?: string;
  readonly starred?: string;
}

/** A child of a music directory. Either a subfolder or a playable file. */
interface Child {
  readonly id: string;
  readonly parent?: string;
  readonly isDir: boolean;
  readonly title: string;
  readonly album?: string;
  readonly artist?: string;
  readonly track?: number;
  readonly discNumber?: number;
  readonly year?: number;
  readonly genre?: string;
  readonly coverArt?: string;
  readonly size?: number;
  readonly contentType?: string;
  readonly suffix?: string;
  readonly duration: number;
  readonly bitRate: number;
  readonly starred?: string;
  readonly albumId?: string;
  readonly artistId?: string;
  readonly created?: string;
  readonly userRating?: number;
  readonly playCount?: number;
  readonly mediaType?: 'song';
}

interface Directory {
  readonly id: string;
  readonly parent?: string;
  readonly name: string;
  readonly children: readonly Child[];
  readonly starred?: string;
  readonly playable?: boolean;
}

interface MusicFolder {
  readonly id: string;
  readonly name: string;
}

interface Playlist {
  readonly id: string;
  readonly name: string;
  readonly comment?: string;
  readonly owner: string;
  readonly isPublic: boolean;
  readonly songCount: number;
  readonly duration: number;
  readonly created?: string;
  readonly changed?: string;
  readonly coverArt?: string;
}

/** The `user` element returned by `getUser`/`getUsers`. */
interface SubsonicUserView {
  readonly username: string;
  readonly email?: string;
  readonly isAdmin: boolean;
  readonly scrobblingEnabled: boolean;
}

interface ScanStatus {
  readonly scanning: boolean;
  readonly count: number;
}

export type { Song, Album, Artist, Child, Directory, MusicFolder, Playlist, SubsonicUserView, ScanStatus };
