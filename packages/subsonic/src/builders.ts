/**
 * Domain model → protocol element.
 *
 * The one place where a Subsonic field name is spelled. `getAlbum` and
 * `getSong` cannot drift apart on field presence because neither of them names
 * a field: they hand a `Song`/`Album` here.
 *
 * Two rules worth stating:
 *
 * - `undefined` is dropped and `0` is kept. A `duration` of `0` means "the tag
 *   has not been read yet", which clients tolerate; a *missing* `duration` is
 *   read by several clients as a malformed record and hides the track.
 * - `path` is deliberately not emitted. The protocol allows it, but it publishes
 *   the storage layout of someone's WebDAV bucket to every authenticated
 *   client, and nothing in the protocol needs it back — IDs already carry the
 *   path for the server to use.
 */
import { el, elList } from './nodes';
import type { ElementNode } from './nodes';
import type { Album, Artist, Child, Directory, MusicFolder, Playlist, ScanStatus, Song, SubsonicUserView } from './types';

type Attrs = Record<string, string | number | boolean | undefined>;

/** Shared field set for anything the protocol allows as a `child`. */
function childAttrs(child: Child): Attrs {
  return {
    id: child.id,
    parent: child.parent,
    isDir: child.isDir,
    title: child.title,
    album: child.album,
    artist: child.artist,
    track: child.track,
    discNumber: child.discNumber,
    year: child.year,
    genre: child.genre,
    coverArt: child.coverArt,
    size: child.size,
    contentType: child.contentType,
    suffix: child.suffix,
    duration: child.duration,
    bitRate: child.bitRate,
    created: child.created,
    starred: child.starred,
    albumId: child.albumId,
    artistId: child.artistId,
    userRating: child.userRating,
    playCount: child.playCount,
    type: child.isDir ? undefined : (child.mediaType ?? 'music'),
  };
}

function songElement(song: Song): ElementNode {
  return el('song', {
    id: song.id,
    parent: song.albumId,
    title: song.title,
    isDir: false,
    album: song.album,
    artist: song.artist,
    track: song.track,
    discNumber: song.discNumber,
    year: song.year,
    genre: song.genre,
    coverArt: song.coverArt,
    size: song.size,
    contentType: song.contentType,
    suffix: song.suffix,
    duration: song.duration,
    bitRate: song.bitRate,
    created: song.created,
    starred: song.starred,
    albumId: song.albumId,
    artistId: song.artistId,
    playCount: song.playCount,
    userRating: song.userRating,
    type: song.mediaType,
    bookmarkPosition: song.bookmarkPosition,
  });
}

function albumElement(album: Album): ElementNode {
  return el('album', {
    id: album.id,
    name: album.name,
    title: album.name,
    artist: album.artist,
    artistId: album.artistId,
    songCount: album.songCount,
    duration: album.duration,
    year: album.year,
    genre: album.genre,
    coverArt: album.coverArt,
    created: album.created,
    starred: album.starred,
    playCount: album.playCount,
    userRating: album.userRating,
    isDir: true,
  });
}

function artistElement(artist: Artist): ElementNode {
  return el('artist', {
    id: artist.id,
    name: artist.name,
    albumCount: artist.albumCount,
    coverArt: artist.coverArt,
    starred: artist.starred,
  });
}

function directoryElement(directory: Directory): ElementNode {
  return elList('directory', { id: directory.id, parent: directory.parent, name: directory.name, starred: directory.starred, playable: directory.playable }, [
    ...directory.children.map((child) => el('child', childAttrs(child))),
  ]);
}

function musicFolderElement(folder: MusicFolder): ElementNode {
  return el('musicFolder', { id: folder.id, name: folder.name });
}

function playlistElement(playlist: Playlist): ElementNode {
  return el('playlist', {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment,
    owner: playlist.owner,
    public: playlist.isPublic,
    songCount: playlist.songCount,
    duration: playlist.duration,
    created: playlist.created,
    changed: playlist.changed,
    coverArt: playlist.coverArt,
  });
}

function userElement(user: SubsonicUserView): ElementNode {
  return el('user', {
    username: user.username,
    email: user.email,
    // Every capability role is reported as present. There is one role, `admin`,
    // and it gates the admin API only — `/rest` itself is authorized per
    // library, not per capability — so advertising the rest as false would
    // make clients hide features that work.
    scrobblingEnabled: user.scrobblingEnabled,
    adminRole: user.isAdmin,
    settingsRole: user.isAdmin,
    downloadRole: true,
    uploadRole: user.isAdmin,
    playlistRole: true,
    coverArtRole: true,
    commentRole: true,
    podcastRole: false,
    streamRole: true,
    jukeboxRole: false,
    shareRole: false,
    videoConversionRole: false,
  });
}

function childElement(child: Child): ElementNode {
  return el('child', childAttrs(child));
}

function scanStatusElement(status: ScanStatus): ElementNode {
  return el('scanStatus', { scanning: status.scanning, count: status.count });
}

/** `{ error }` is handled by the envelope, not here. */
export {
  songElement,
  albumElement,
  artistElement,
  directoryElement,
  musicFolderElement,
  playlistElement,
  userElement,
  scanStatusElement,
  childElement,
};
export type { Attrs };
