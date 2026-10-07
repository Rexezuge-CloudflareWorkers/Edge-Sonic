/**
 * Tag-organized browsing: `getArtists`, `getArtist`, `getAlbum`, `getSong`.
 *
 * This is the view modern clients actually use (Symfonium, DSub, play:sub), and it
 * is the one that needs the materialized `songs` index — a recursive `PROPFIND` per
 * request cannot answer "every album by this artist, newest first".
 *
 * ### The grouping, and where it can be wrong
 *
 * Artists and albums are derived from the path convention *and* from tags, and neither is
 * authoritative — which is why the grouping is a setting (`ALBUM_GROUP_BY`) rather than an
 * assumption, and why the album record and its id live in `./albumRecord` instead of here: they are
 * the two ends of one decision, and both are read by four callers each.
 */
import { albumElement, albumWithSongs, decodeId, elList, ErrorCode, IdKind, songElement, SubsonicError } from '@edge-sonic/subsonic';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { artistIndexGroups, artistNameOf, groupArtistRows, IGNORED_ARTICLES, songToModel } from '../mappers';
import type { AnnotationLookup } from '../mappers';
import { compareAlbumTracks } from '../albumIdentity';
import { albumModel, groupAlbumsOf, libraryForAlbumId, resolveAlbumKey } from './albumRecord';
import { librariesForId, resolveLibraries } from './libraries';

/**
 * This user's annotations, for the ids about to be rendered.
 *
 * `ids` is a **short-circuit, not a filter.** Every branch below is a per-user query, not
 * a per-id one, so there is nothing to narrow — and pretending otherwise is how a caller
 * ends up passing something that looks like an id and is not. `getArtists` was passing
 * lowercased artist *names* here, which the lookup could never contain; the argument was
 * pure noise, and the cost of it was seven D1 reads on a page of artists. The parameter
 * survives only as the empty-page check it actually is, which is stated in its name.
 */
async function annotationsFor(context: RestContext, renderingAnything: boolean): Promise<AnnotationLookup> {
  if (!renderingAnything) return { stars: new Map(), ratings: new Map(), playCounts: new Map() };
  const [songStars, albumStars, artistStars, songRatings, albumRatings, artistRatings, playCounts] = await Promise.all([
    context.annotations.listStarredWithTime(context.user.id, 'song'),
    context.annotations.listStarredWithTime(context.user.id, 'album'),
    context.annotations.listStarredWithTime(context.user.id, 'artist'),
    context.annotations.listRatings(context.user.id, 'song'),
    context.annotations.listRatings(context.user.id, 'album'),
    context.annotations.listRatings(context.user.id, 'artist'),
    // `PlayCountDAO`, not `annotations`: play counts are a per-user table with **two** semantics
    // (a scrobble increments, an import overwrites), so they have their own DAO whose docstrings
    // name each other. Reading them off `annotations` would be reaching past the boundary that
    // keeps the two writers near each other.
    context.playCounts.listPlayCounts(context.user.id),
  ]);
  return {
    stars: new Map([...songStars, ...albumStars, ...artistStars]),
    ratings: new Map([...songRatings, ...albumRatings, ...artistRatings]),
    playCounts,
  };
}

/**
 * `getArtists` — every artist, grouped by index letter.
 *
 * Aggregated from `songs` in one indexed pass rather than by walking folders,
 * because the tag view's whole point is that it is not the folder view. The
 * grouping itself is `groupArtistRows` in `../mappers`, shared with the artist
 * half of `getIndexes` — one grouping, or the two browses disagree about who is
 * whom.
 */
async function getArtists(context: RestContext): Promise<EnvelopeResponse> {
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const identity = context.albumsFor(library);
  const limit = context.pageSize(context.params.optionalInt('size'), 500);
  const offset = context.params.int('offset', 0, { min: 0 });

  const rows = await context.songIndex.listArtists(scope, limit + offset, 0);

  const groups = groupArtistRows(rows, identity).slice(offset, offset + limit);
  const annotations = await annotationsFor(context, groups.length > 0);
  const indexes = artistIndexGroups(library, groups, annotations.stars);

  return respond(context, elList('artists', 'index', { ignoredArticles: IGNORED_ARTICLES }, indexes));
}

/**
 * The `id` of a single media item, or the same "not found" a wrong id produces.
 *
 * ### Why this is not `params.require('id')`
 *
 * `require` raises `code=10` ("required parameter is missing"), and for most endpoints that
 * is exactly right — Navidrome does the same for `getPlaylist`, `stream`, `download`,
 * `scrobble` and the bookmark pair, and a client that forgot a parameter wants to be told
 * so.
 *
 * The four endpoints that fetch **one item identified by its id** are the exception, and
 * they are an exception for a reason rather than by accident: the id is the *selector*, and
 * there is no other way to say "I want none". `getSong` with no id and `getSong` with a
 * deleted id are the same request — resolve this identifier to a track — so they answer
 * `code=70` for the same reason. Splitting them across two codes would make a client's
 * error handling depend on which mistake it happened to make.
 *
 * Navidrome draws the line in the same place, measured endpoint by endpoint: `code=70` for
 * these four, `code=10` for everything else that takes an id.
 *
 * @param what Named in the message so the client learns *which* item was not found, which
 *   is the one piece of information it can act on.
 */
function requireMediaId(context: RestContext, what: string): string {
  const id = context.params.get('id');
  if (id === undefined || id.length === 0) throw new SubsonicError(ErrorCode.NotFound, `${what} not found.`);
  return id;
}

/**
`getArtist` — an artist's albums.
*/
async function getArtist(context: RestContext): Promise<EnvelopeResponse> {
  const id = requireMediaId(context, 'Artist');
  const decoded = decodeId(id, IdKind.Artist);
  // An artist id names a group, so it carries the sentinel and resolves across every library the
  // caller was granted — an artist with an album in two of them is one artist, and an id scoped
  // to one would publish the discography in halves. `getSong` below keeps the single-library
  // form, because a path only means something inside one.
  const libraries = await librariesForId(context, decoded.libraryId);
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const artistName = decoded.path;
  const identity = context.albumsFor(library);

  const all = await context.songIndex.listArtists(scope, 5000, 0);
  const mine = all.filter((row) => (row.artist ?? artistNameOf(row)).toLowerCase() === artistName.toLowerCase());
  if (mine.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');

  // **The album is completed, not just grouped.**
  //
  // `mine` is every track by this artist, so grouping it alone publishes an album holding only
  // that artist's share of a release — and the same album id then reports a different
  // `songCount` here than in `getAlbumList2`, `search3` and `getAlbum`. Two numbers for one
  // album is the shape of defect this file already records for `getAlbum`'s omitted `created`:
  // every response is internally valid and no client can reconcile them.
  //
  // So the keys are collected and the whole groups fetched. One extra statement per 49 keys,
  // against an endpoint that already spends 51 statements reading artists.
  const keys = [...new Set(mine.map((row) => identity.keyOf(row)))];
  const complete = await context.songIndex.listForAlbumKeys(library.id, keys, identity.grouping);
  const annotations = await annotationsFor(context, true);
  const albums = groupAlbumsOf(complete, library, identity, annotations);
  return respond(context, elList('artist', 'album', { id, name: artistName, albumCount: albums.length, coverArt: id }, albums.map((album) => albumElement(album))));
}



/**
`getAlbum` — an album's songs.
*/
async function getAlbum(context: RestContext): Promise<EnvelopeResponse> {
  const id = requireMediaId(context, 'Album');
  const { library, scope } = await libraryForAlbumId(context, id);
  const identity = context.albumsFor(library);

  // Both id kinds, because both are in the wild. `alk:` is what this server mints; `al:` is
  // what it minted before an album's identity became configurable, and it is still sitting in
  // every starred album and every rating on every deployment. Resolving it through the
  // directory and then the *group* is what keeps such a star pointing at the merged album
  // rather than at the half of it that happened to be its directory — which would be two
  // answers to "what album is this id" for one id, one of them reachable only from a list.
  const key = await resolveAlbumKey(context, id, library);
  if (key === null) throw new SubsonicError(ErrorCode.NotFound, 'Album not found.');

  const songs = await context.songIndex.listForAlbumKeys(scope, [key], identity.grouping);
  if (songs.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Album not found.');

  const annotations = await annotationsFor(context, songs.length > 0);
  const ordered = [...songs].sort(compareAlbumTracks);

  // `albumWithSongs`, not `albumElement` with children attached: the songs are a repeated
  // child of a record element, and an undeclared one collapses to a bare object for a
  // single-track album. See the builder for the failure that shipped.
  return respond(
    context,
    albumWithSongs(
      albumModel(ordered, library, identity, annotations),
      ordered.map((song) => songToModel(song, library, identity, annotations)),
    ),
  );
}


/**
 * `getSong` — one track, enriched on demand.
 *
 * This is where `duration` and `bitRate` get filled in. The enrichment is a single
 * ranged read of the file's first bytes, cached in D1 and KV, and it is bounded by
 * "one per song the client actually opens" rather than "one per indexed track" —
 * which is the only way it fits under the subrequest limit.
 *
 * With the `MEDIA_DO` binding the parse runs in the library's own media object
 * (`MediaWorker.enrichSong`); without it the direct service runs in-fetch, which
 * is the path the suite exercises. It is deliberately **not** the scan's object:
 * one event at a time per object, and a chunk walking the origin would sit on
 * this request's critical path.
 */
async function getSong(context: RestContext): Promise<EnvelopeResponse> {
  const id = requireMediaId(context, 'Song');
  const song = await context.songs.findBySongId(id);
  if (!song) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');
  const library = await context.libraries.requireForUser(context.user.id, song.library_id);
  TreeService.assertPath(song.path);

  let resolved = song;

  // Through the **media** object, not the scan's. A Durable Object handles one event at a
  // time, so resolving the scan stub here would put this request behind whatever chunk that
  // library's scan happened to be running — up to `SCAN_CHUNK_DEADLINE_MS` of a client's wait.
  const stub = context.mediaStubFor(library.id);
  if (stub) {
    const updated = await stub.enrichSong(library.id, resolved.id);
    if (updated) resolved = updated;
  } else {
    await context.enrichment.enrich(library, resolved);
    // Re-read: the enrichment wrote duration, bitrate, and tags to D1, and the
    // in-memory row still has the pre-enrichment zeros.
    resolved = (await context.songs.findById(resolved.id)) ?? resolved;
  }

  const annotations = await annotationsFor(context, true);
  return respond(context, songElement(songToModel(resolved, library, context.albumsFor(library), annotations)));
}

/**
Handlers only — the registry rejects a signature that is not `(context) => ...`.
*/
const structuredEndpoints = { getArtists, getArtist, getAlbum, getSong };

export {
  structuredEndpoints,
  getArtists,
  getArtist,
  getAlbum,
  getSong,
  annotationsFor,
};

// `groupAlbumsOf` and `albumModel` live in `./albumRecord` and are re-exported under the names
// `lists.ts` and `search.ts` already import, because reaching into a second module for one call
// would make the grouping look like it belongs to whichever endpoint imported it first — which is
// how two of them came to disagree about it.
