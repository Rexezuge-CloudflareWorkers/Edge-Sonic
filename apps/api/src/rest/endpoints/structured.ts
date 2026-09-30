/**
 * Tag-organized browsing: `getArtists`, `getArtist`, `getAlbum`, `getSong`.
 *
 * This is the view modern clients actually use (Symfonium, DSub, play:sub), and it
 * is the one that needs the materialized `songs` index — a recursive `PROPFIND` per
 * request cannot answer "every album by this artist, newest first".
 *
 * ### The grouping, and where it can be wrong
 *
 * Artists and albums are derived from the path convention *and* from tags, and
 * neither is authoritative. A library with no tags groups by folder name; a tagged
 * library groups by tag. Both are supported, which means the grouping is a
 * **view** over `songs` rather than a stored entity — and that is the reason album
 * ids are derived from `dir_path` and never from the album name: the name is
 * precisely the part that is allowed to change.
 */
import { albumElement, albumWithSongs, decodeId, elList, encodeId, ErrorCode, IdKind, songElement, SubsonicError, successResponse } from '@edge-sonic/subsonic';
import type { Album, ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import type { AnnotationLookup } from '../mappers';
import { albumKeyOf, albumNameOf, artistIndexGroups, artistNameOf, groupArtistRows, songToModel, toIso } from '../mappers';
import { resolveLibrary } from './libraries';

type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

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
    context.annotations.listPlayCounts(context.user.id),
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
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const limit = context.pageSize(context.params.optionalInt('size'), 500);
  const offset = context.params.int('offset', 0, { min: 0 });

  const rows = await context.songIndex.listArtists(library.id, limit + offset, 0);

  const groups = groupArtistRows(rows).slice(offset, offset + limit);
  const annotations = await annotationsFor(context, groups.length > 0);
  const indexes = artistIndexGroups(library, groups, annotations.stars);

  return respond(context, elList('artists', 'index', { ignoredArticles: 'The El La Los Las Le Les' }, indexes));
}

/**
`getArtist` — an artist's albums.
*/
async function getArtist(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const decoded = decodeId(id, IdKind.Artist);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  const artistName = decoded.path;

  const all = await context.songIndex.listArtists(library.id, 5000, 0);
  const mine = all.filter((row) => (row.artist ?? artistNameOf(row)).toLowerCase() === artistName.toLowerCase());
  if (mine.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');

  const annotations = await annotationsFor(context, true);
  const albums = groupAlbums(mine, library, annotations);
  return respond(context, elList('artist', 'album', { id, name: artistName, albumCount: albums.length }, albums));
}

/**
 * The album record, from its songs.
 *
 * **One function, because it is one album.** `getAlbum` and every album *list*
 * (`getArtist`, `getAlbumList2`, `search2`/`search3`) publish the same `id`, the same
 * name and the same `created`, read from the same first track. They were two literals,
 * and they had already diverged: `getAlbum`'s copy omitted `created` while the lists
 * emitted it.
 *
 * That is not cosmetic. A client whose `Album` model is
 * `@SerialName("created") val createdAt: Instant` — non-nullable, no default — throws
 * `MissingFieldException` on **every** `getAlbum`, for every album, because the key is
 * absent. The protocol types `created` as optional, so the omission was legal and the
 * breakage was invisible from here: a correct-looking response that one strict client
 * cannot read at all.
 *
 * @param songs The album's tracks, already ordered — the first one supplies the
 *   album-level fields, and it is also what `getAlbum` publishes as `track 1`.
 */
function albumModel(songs: readonly SongRow[], library: LibraryRow, annotations: AnnotationLookup, id: string): Album {
  const first = songs[0];
  return {
    id,
    name: albumNameOf(first),
    artist: first.artist ?? first.album_artist ?? undefined,
    artistId: encodeId(IdKind.Artist, library.id, first.artist ?? first.album_artist ?? artistNameOf(first)),
    songCount: songs.length,
    duration: songs.reduce((total, song) => total + song.duration, 0),
    year: first.year ?? undefined,
    genre: first.genre ?? undefined,
    coverArt: id,
    created: toIso(first.created_at),
    ...(annotations.stars.has(id) && { starred: toIso(first.mtime_ms) }),
    ...(annotations.ratings.has(id) && { userRating: annotations.ratings.get(id) }),
  };
}

/**
 * Group songs into album elements.
 *
 * **The key is `dir_path`, not the album name.** A starred album resolves back to
 * its songs through this key, so a name-derived key would orphan every star the
 * first time somebody fixed a typo in a folder name.
 */
function groupAlbums(rows: readonly SongRow[], library: LibraryRow, annotations: AnnotationLookup): ElementNode[] {
  const groups = new Map<string, SongRow[]>();
  for (const row of rows) {
    const key = albumKeyOf(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, songs]) => {
      songs.sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999) || a.name.localeCompare(b.name));
      return albumElement(albumModel(songs, library, annotations, encodeId(IdKind.Album, library.id, key)));
    });
}

/**
`getAlbum` — an album's songs.
*/
async function getAlbum(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const decoded = decodeId(id, IdKind.Album);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  TreeService.assertPath(decoded.path);

  const songs = await context.songs.listByAlbumDir(library.id, decoded.path);
  if (songs.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Album not found.');

  const annotations = await annotationsFor(context, songs.length > 0);
  const ordered = [...songs].sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999) || a.name.localeCompare(b.name));

  // `albumWithSongs`, not `albumElement` with children attached: the songs are a repeated
  // child of a record element, and an undeclared one collapses to a bare object for a
  // single-track album. See the builder for the failure that shipped.
  return respond(context, albumWithSongs(albumModel(ordered, library, annotations, id), ordered.map((song) => songToModel(song, library, annotations))));
}

/**
 * `getSong` — one track, enriched on demand.
 *
 * This is where `duration` and `bitRate` get filled in. The enrichment is a single
 * ranged read of the file's first bytes, cached in D1 and KV, and it is bounded by
 * "one per song the client actually opens" rather than "one per indexed track" —
 * which is the only way it fits under the subrequest limit.
 *
 * With the `SCAN` binding the parse runs in the library's DO isolate
 * (`ScanWorker.enrichSong`); without it the direct service runs in-fetch, which
 * is the path the suite exercises.
 */
async function getSong(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const decoded = decodeId(id, IdKind.Song);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  TreeService.assertPath(decoded.path);

  let song = await context.songs.findById(id);
  if (!song) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');

  const stub = context.scanStubFor(library.id);
  if (stub) {
    const updated = await stub.enrichSong(library.id, id);
    if (updated) song = updated;
  } else {
    await context.enrichment.enrich(library, song);
    // Re-read: the enrichment wrote duration, bitrate, and tags to D1, and the
    // in-memory row still has the pre-enrichment zeros.
    song = (await context.songs.findById(id)) ?? song;
  }

  const annotations = await annotationsFor(context, true);
  return respond(context, songElement(songToModel(song, library, annotations)));
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
  groupAlbums,
  albumModel,
  annotationsFor,
};

// `albumNameOf`/`artistNameOf`/`albumKeyOf` live in `../mappers`, beside the `songToModel`
// that reads the same two, and are re-exported here so `lists.ts` and `search.ts` keep
// importing the grouping helpers from one place rather than reaching into a mapper.
export {type AnnotationLookup as StructuredAnnotationLookup, albumNameOf, artistNameOf, albumKeyOf} from '../mappers';
