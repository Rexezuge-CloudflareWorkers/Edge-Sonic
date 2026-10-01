/**
 * Domain model → protocol element.
 *
 * The one place where a Subsonic field name is spelled. `getAlbum` and
 * `getSong` cannot drift apart on field presence because neither of them names
 * a field: they hand a `Song`/`Album` here.
 *
 * Three rules worth stating:
 *
 * - `undefined` is dropped and `0` is kept. A `duration` of `0` means "the tag
 *   has not been read yet", which clients tolerate; a *missing* `duration` is
 *   read by several clients as a malformed record and hides the track.
 * - `path` is deliberately not emitted. The protocol allows it, but it publishes
 *   the storage layout of someone's WebDAV bucket to every authenticated
 *   client, and nothing in the protocol needs it back — IDs already carry the
 *   path for the server to use.
 * - **An album is two elements, not one.** `albumElement` is an album as a *list
 *   child* (`getAlbumList2`, `getArtist`, `search2`/`search3`); `albumWithSongs`
 *   is `getAlbum`'s payload, which carries a repeated `song` child and therefore
 *   has to declare it. They share `albumAttrs` so the two cannot disagree about
 *   which fields an album has — see the two functions for why the list lives in
 *   one and not the other.
 * - **Only the fields the element's own schema declares.** `AlbumID3` carries
 *   `name` and no `title`, and no `isDir`; a track's `type` is the generic
 *   container (`music`) while `mediaType` is the shape (`song`). Each of those
 *   three was written here by hand and none of them failed anything, which is the
 *   point: an attribute the schema does not declare is dropped by a lenient
 *   client and ignored by a strict one, so nothing in this repository could see it.
 *   `title` merely duplicated `name`, `isDir: true` asserted a field `AlbumID3`
 *   does not have, and `type="song"` wrote a `mediaType` value into the
 *   enumeration a player filters on — so a client asking `type == "music"` saw an
 *   empty library. The way this class of defect is caught is by reading the same
 *   endpoint off a *reference* server and comparing attribute key sets; see
 *   `scripts/compare-navidrome.mjs`.
 */
import { el, elList } from './nodes';
import { songExtensionAttrs, songExtensionChildren } from './extensions';
import type { ElementNode } from './nodes';
import type { Album, Artist, Child, Directory, MusicFolder, Playlist, ScanStatus, Song, SubsonicUserView } from './types';

type Attrs = Record<string, string | number | boolean | undefined>;

/**
Shared field set for anything the protocol allows as a `child`.
*/
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

/**
 * A track, as `getSong`, `getRandomSongs`, `getAlbum`'s songs and every other song list
 * publish it.
 *
 * `type` and `mediaType` are two different fields, and this used to write `mediaType`'s value
 * into `type`. The protocol types `type` as the generic container — [music/podcast/audiobook/
 * video] — and `mediaType` as the shape — [song/album/artist]. So every track published
 * `type="song"`, a value outside `type`'s enumeration and absent from the XSD, and published
 * no `mediaType` at all, so a client branching on it read nothing. It was wrong in the one
 * field every client uses to decide what a row *is*: a player filtering `type == "music"` sees
 * an empty library.
 *
 * The OpenSubsonic additions come from `./extensions.ts` and are spread last, so the literal
 * below stays the answer to "what does the Subsonic protocol declare for a track?" and the
 * extensions stay the answer to a different question.
 */
function songElement(song: Song): ElementNode {
  return el(
    'song',
    {
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
      type: 'music',
      mediaType: song.mediaType,
      bookmarkPosition: song.bookmarkPosition,
      ...songExtensionAttrs(song),
    },
    songExtensionChildren(song),
  );
}

/**
 * The attribute set every album element carries.
 *
 * Separate from the element because `getAlbum`'s payload is an album **and its songs**,
 * which is a different node shape from the album-as-a-list-child the other endpoints
 * build — see `albumWithSongs`. One function behind both is what keeps them from
 * drifting: they were two literals, and `getAlbum` had already dropped `created` from
 * its copy.
 */
function albumAttrs(album: Album): Attrs {
  return {
    id: album.id,
    name: album.name,
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
  };
}

function albumElement(album: Album): ElementNode {
  return el('album', albumAttrs(album));
}

/**
 * An album as `getAlbumList` publishes it — a `Child`, not an `AlbumID3`.
 *
 * ### Why this is a second builder rather than a flag on the first
 *
 * `getAlbumList` and `getAlbumList2` ask the same question and the protocol answers
 * them with different element types: `albumList` is `Array of Child`, `albumList2` is
 * `Array of AlbumID3`. `Child` carries `title`, `isDir` and `parent`; `AlbumID3`
 * carries `name` and none of the three.
 *
 * `albumAttrs` published `title` and `isDir` for both, so every album in
 * `getAlbumList2` carried two attributes its schema does not declare. It cost nothing
 * in a lenient client and nothing in a strict one, and `name` was published alongside,
 * so nothing here could tell an invented field from a deliberate one. The `title` half
 * is load-bearing in the *other* direction: `test/endpoints.test.ts` asserted that
 * `getAlbumList` and `getAlbumList2` agree on which album they report, and did it by
 * reading `title` off one and `name` off the other — a test that passes for two
 * endpoints disagreeing, because the disagreement was the field it was reading.
 *
 * So the split is made here, where each element's schema is known, and the parity
 * assertion compares something both endpoints actually publish.
 *
 * Takes an `Album`, not a separate type: every field a `Child`-shaped album needs is
 * already on the model, and a second model would be a second thing to keep in step
 * with `albumModel`.
 *
 * @param parent The containing artist's id. `Child` declares `parent` and an album is
 *   a directory inside one, so this is what lets a client walk album → artist without
 *   a second request.
 */
function albumChildElement(album: Album, parent?: string): ElementNode {
  return el('album', {
    id: album.id,
    parent,
    isDir: true,
    // A `Child` names its media `title`; an `AlbumID3` names it `name`. Both are
    // published, both mean the album name, and each endpoint carries the one its own
    // schema declares — plus `name`, which a strict client reads off `Child` too.
    title: album.name,
    name: album.name,
    album: album.name,
    artist: album.artist,
    artistId: album.artistId,
    songCount: album.songCount,
    duration: album.duration,
    year: album.year,
    genre: album.genre,
    coverArt: album.coverArt,
    created: album.created,
    playCount: album.playCount,
    userRating: album.userRating,
    starred: album.starred,
    // `mediaType` is the shape — [song/album/artist] — so this is what tells a client
    // the row is an album rather than a track. `type`, the generic container, stays
    // absent: `Child` types it as optional and an album is not a distinct container.
    mediaType: 'album',
  });
}

/**
 * `getAlbum`'s payload: an album **with its songs**.
 *
 * ### Why this is not `albumElement` with children bolted on
 *
 * The songs are a *repeated child of a record element*, and a repeated child has to
 * declare itself as one. `childrenToJsonObject` collapses a single occurrence to a bare
 * object, so an undeclared list renders as `{"song": {...}}` for a one-track album and
 * `{"song": [{...}, {...}]}` for a multi-track one — the shape changing with the data.
 *
 * It shipped. A client whose `Album` model is `@SerialName("song") val songs: List<Song>`
 * decodes that field with plain kotlinx.serialization, which rejects an object, so every
 * single-track album failed to open with `Expected JsonArray, but had JsonObject ... at
 * path: $.song`. Nothing in the product could tell a wrong shape from a wrong record.
 * The test suite never saw it because the fixture album holds two tracks — a collapse is
 * invisible at n≥2 — and both `getAlbum` tests asserted album *attributes*, never
 * `album.song`.
 *
 * `elList` states it, for the same reason it is a parameter rather than inferred: an
 * element carrying attributes is a record to every serializer, and the serializer cannot
 * tell a record's scalar child from a record's list child, so the builder that knows
 * says so. `listKey` also seeds `song: []`, which is unreachable here (`getAlbum` throws
 * `code=70` for an album with no songs) and is why the declaration must **not** move up
 * into `albumAttrs`/`albumElement`: seeding happens unconditionally, so every album in
 * `getAlbumList2`, `getArtist` and `search2`/`search3` would carry an empty `song` key.
 */
function albumWithSongs(album: Album, songs: readonly Song[]): ElementNode {
  return elList('album', 'song', albumAttrs(album), songs.map((song) => songElement(song)));
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
  return elList(
    'directory',
    'child',
    { id: directory.id, parent: directory.parent, name: directory.name, starred: directory.starred, playable: directory.playable },
    directory.children.map((child) => el('child', childAttrs(child))),
  );
}

/**
A `musicFolder` record: an `id` **and** a `name`, so it is an object in JSON.

The counterpart to `userFolderElements`, which is *not* a record. That contrast is
the protocol's, not a stylistic one — see there.
*/
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

/**
 * The `folder` children of a `user` element: one **position** per library the user may
 * see, so `musicFolderId=0` names the first entry and `getMusicFolders` publishes the
 * same list in the same order. It is separate from the role booleans above because a
 * client that predates those still needs it to resolve a folder id, and one that has
 * them still uses `folder` to render the library switcher.
 *
 * ### A position, not a record
 *
 * The schema types this element as `Array of int` — "Folder ID(s)" — so each entry is the
 * bare number, and `musicFolder` from `getMusicFolders` is the one place a folder id
 * arrives with a `name` beside it. Building this as `el('folder', { id })`, which is
 * what it was, renders `[{"id": 0}]` in JSON: an element carrying an attribute is a
 * record to every serializer, and this is the single element in the schema that is a
 * scalar wearing a container's name.
 *
 * It shipped. A client whose `User` model is `folder: List<Int>` — which is what the
 * schema says, and what the docs example shows — throws decoding the object, and the
 * throw lands in its *login* path, so the symptom is "failed to connect, check your
 * credentials" on a server that answered `ping` and authenticated correctly. A wrong
 * shape in a scalar field is indistinguishable from bad credentials.
 *
 * So the value is a scalar **child** and the serializer's existing collapse carries it:
 * `<folder>0</folder>` in XML, `0` in JSON, from one node. Stated here rather than
 * inferred, for the same reason `elList` takes a `listKey` — the serializer cannot tell
 * a scalar-valued element from a record, so the one that knows says so.
 *
 * Stable, which is the whole contract: reordering this list would silently repoint
 * every `musicFolderId` a client is holding.
 *
 * @param libraryCount How many libraries the user may see. Only the count is read,
 *   which is the point: the id is the position, never a library identifier.
 */
function userFolderElements(libraryCount: number): ElementNode[] {
  return Array.from({ length: libraryCount }, (_, index) => ({ ...el('folder', {}, [index]), array: true as const }));
}

function childElement(child: Child): ElementNode {
  return el('child', childAttrs(child));
}

function scanStatusElement(status: ScanStatus): ElementNode {
  return el('scanStatus', { scanning: status.scanning, count: status.count });
}

/**
`{ error }` is handled by the envelope, not here.
*/
export {
  songElement,
  albumElement,
  albumChildElement,
  albumWithSongs,
  artistElement,
  directoryElement,
  musicFolderElement,
  playlistElement,
  userElement,
  userFolderElements,
  scanStatusElement,
  childElement,
};
export type { Attrs };
