/**
 * Similar songs: `getSimilarSongs` and `getSimilarSongs2`.
 *
 * The protocol describes both as last.fm-backed "artist radio". This server has no last.fm
 * integration, so the question is answered from the index: an artist is similar to another
 * artist when the two share a genre in this library. That is a narrower claim, and it is
 * stated rather than hidden behind an empty panel or a failure.
 *
 * ### Two spellings, one seed
 *
 * `getSimilarSongs` accepts an artist, album or song id; `getSimilarSongs2` accepts an
 * artist id. Both resolve the id the same way and rank the same candidates, so a client
 * switching between the two spellings does not get two answers to one question. The only
 * difference is the wrapper element: `similarSongs` and `similarSongs2` respectively —
 * the endpoint name is not the wrapper name, and guessing it answers `200` with a field
 * no client reads.
 *
 * ### Why an absent id is `code=70`
 *
 * The general rule is `code=10` for a missing required parameter. An id here is a
 * **selector**, like `getArtist` and `getAlbum`: "no id" and "an id naming nothing" are
 * the same request — resolve this thing to a set of songs. Splitting the two mistakes
 * across two codes makes a client's error handling depend on which one it made.
 *
 * Nothing is written to D1 and no origin is contacted. Both statements are bounded by
 * the DAO's bind arithmetic, and an unresolvable id is `code=70` rather than an empty
 * answer: "that artist has no similar songs" and "that artist does not exist" look
 * identical in a panel and mean opposite things to whoever is debugging a library.
 */
import { decodeId, elList, ErrorCode, IdKind, songElement, SubsonicError } from '@edge-sonic/subsonic';
import type { ElementNode, IdKindValue } from '@edge-sonic/subsonic';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { songToModel } from '../mappers';
import { annotationsFor } from './structured';
import { libraryForAlbumId, resolveAlbumKey } from './albumRecord';
import { librariesForId } from './libraries';

interface Seed {
  readonly rows: readonly SongRow[];
  readonly libraries: readonly LibraryRow[];
  /**
  The one song a track id names, excluded from its own "similar" list.
  */
  readonly songId: string | null;
}

/**
 * The id, or the same "not found" a deleted id produces. See the module header.
 */
function requireSeedId(context: RestContext): string {
  const id = context.params.get('id');
  if (id === undefined || id.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');
  return id;
}

/**
 * The id's scope, and the rows it names.
 *
 * `librariesForId` is the only id→scope path on this surface. A group id (artist, tag
 * album) carries the spanning sentinel and reaches every granted library; a song id and
 * the folder-shaped album id name one library, and a grant failure is `code=70`, never
 * `code=50`, so the endpoint is not an oracle for which paths exist.
 */
async function resolveSeed(context: RestContext, kinds: readonly IdKindValue[]): Promise<Seed> {
  const id = requireSeedId(context);
  let decoded: ReturnType<typeof decodeId>;
  try {
    decoded = decodeId(id);
  } catch {
    throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');
  }
  if (!kinds.includes(decoded.kind)) throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');

  if (decoded.kind === IdKind.Song) {
    const song = await context.songs.findBySongId(id);
    if (song === null) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');
    return { rows: [song], libraries: await librariesForId(context, decoded.libraryId), songId: song.id };
  }

  if (decoded.kind === IdKind.Artist) {
    const libraries = await librariesForId(context, decoded.libraryId);
    // A seed is a bounded sample, not a discography: genres are what similarity reads, and
    // a dozen tracks of one artist say the same thing as a hundred. The bound is derived
    // from D1's ceiling inside the DAO.
    const rows = await context.songIndex.listArtistSeedRows(
      libraries.map((library) => library.id),
      decoded.path.toLowerCase(),
    );
    if (rows.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');
    return { rows, libraries, songId: null };
  }

  const { libraries, library, scope } = await libraryForAlbumId(context, id);
  const key = await resolveAlbumKey(context, id, library);
  if (key === null) throw new SubsonicError(ErrorCode.NotFound, 'Album not found.');
  const rows = await context.songIndex.listForAlbumKeys(scope, [key], context.albumsFor(library).grouping);
  if (rows.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Album not found.');
  return { rows, libraries, songId: null };
}

/**
 * The signals the ranking reads, from the `_ci` columns of the seed rows.
 *
 * Sorted before they reach the DAO: the DAO may sample the genre list to fit one
 * statement, and the sampled prefix must be a function of the seed rather than of a
 * Set's insertion order.
 */
function signalsOf(rows: readonly SongRow[]): { genreCi: string[]; artistCi: string[] } {
  const genres = new Set<string>();
  const artists = new Set<string>();
  for (const row of rows) {
    if (row.genre_ci) genres.add(row.genre_ci);
    if (row.artist_ci) artists.add(row.artist_ci);
    if (row.album_artist_ci) artists.add(row.album_artist_ci);
  }
  const byName = (a: string, b: string): number => a.localeCompare(b);
  return { genreCi: [...genres].sort(byName), artistCi: [...artists].sort(byName) };
}

async function similar(context: RestContext, wrapper: string, kinds: readonly IdKindValue[]): Promise<EnvelopeResponse> {
  const seed = await resolveSeed(context, kinds);
  // The protocol's default is 50, not the 20 used by searches and album lists. `optionalInt`
  // rather than `int`: the latter returns the number 0 for an absent parameter, which would
  // turn a client that omitted `count` into a client that asked for one song.
  const limit = context.pageSize(context.params.optionalInt('count'), 50);
  const signals = signalsOf(seed.rows);
  const scope = seed.libraries.map((library) => library.id);
  const ranked = await context.songIndex.listSimilarArtists({ scope, ...signals }, limit);
  const artists = [...signals.artistCi, ...ranked.map((artist) => artist.name)];
  const songs = await context.songIndex.listSimilarSongs({ scope, ...signals }, artists, seed.songId, limit);

  const annotations = await annotationsFor(context, songs.length > 0);
  const identityOf = context.albumsForScope(seed.libraries);
  const nodes: ElementNode[] = songs.map((song) => songElement(songToModel(song, identityOf, annotations)));
  return respond(context, elList(wrapper, 'song', {}, nodes));
}

async function getSimilarSongs(context: RestContext): Promise<EnvelopeResponse> {
  return await similar(context, 'similarSongs', [IdKind.Artist, IdKind.Album, IdKind.AlbumKey, IdKind.Song]);
}

async function getSimilarSongs2(context: RestContext): Promise<EnvelopeResponse> {
  return await similar(context, 'similarSongs2', [IdKind.Artist]);
}

const similarEndpoints = { getSimilarSongs, getSimilarSongs2 };

export { similarEndpoints, getSimilarSongs, getSimilarSongs2 };
