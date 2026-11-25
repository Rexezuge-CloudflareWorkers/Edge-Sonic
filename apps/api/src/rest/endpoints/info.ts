/**
 * Album and artist info: `getAlbumInfo`, `getAlbumInfo2`, `getArtistInfo`, `getArtistInfo2`.
 *
 * ### A local claim, not a last.fm proxy
 *
 * The protocol describes all four as last.fm-backed. This server has no external integration,
 * so prose and MusicBrainz ids come from the track's own tags and similar artists from shared
 * genres in the index. That is narrower than the reference server's answer, and it is stated
 * rather than hidden behind a failure or a promise in a table.
 *
 * ### Two names for one answer, and two element types for one question
 *
 * Both album spellings answer under `albumInfo`; the two artist spellings answer under their
 * own wrappers. `artistInfo.similarArtist` is an array of `artist`, `artistInfo2.similarArtist`
 * an array of `ArtistID3` — one builder would publish one element's fields on the other, so
 * the builder is told which spelling it is serving.
 *
 * ### An id is a selector, and the read is grant-scoped
 *
 * An absent or undecodable id is `code=70`, the same answer an id naming nothing gets: "no id"
 * and "an id naming nothing" are the same request. An id for a library the caller cannot see
 * is `code=70` too, never `code=50`, so the endpoint is not an oracle for which paths exist.
 * The tag read then uses a row from the resolved scope, not `libraries[0]` over a union.
 */
import {
  albumInfoElement,
  artistIdOf,
  artistInfoElement,
  decodeId,
  ErrorCode,
  IdKind,
  infoArtistElement,
  SubsonicError,
} from '@edge-sonic/subsonic';
import type { ElementNode, IdKindValue } from '@edge-sonic/subsonic';
import type { LibraryRow, LibraryScope, SongRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { artistNameOf } from '../mappers';
import { compareAlbumTracks } from '../albumIdentity';
import { libraryForAlbumId, resolveAlbumKey } from './albumRecord';
import { librariesForId } from './libraries';
import { signalsOf } from './similar';

interface Seed {
  /**
  Every library the resolved id may reach — the union for a group id.
  */
  readonly libraries: readonly LibraryRow[];
  readonly scope: LibraryScope;
  /**
  The rows that define the group, for the genre signals.
  */
  readonly rows: readonly SongRow[];
  /**
  The row whose tags are read, first in the group's own deterministic order.
  */
  readonly tagSong: SongRow;
}

function requireId(context: RestContext, what: string): string {
  const id = context.params.get('id');
  if (id === undefined || id.length === 0) throw new SubsonicError(ErrorCode.NotFound, `${what} not found.`);
  return id;
}

/**
 * The row's own library, from the resolved scope — never `libraries[0]` over a union, which
 * would mint a read against a library the row does not belong to.
 */
function libraryOf(seed: Seed, song: SongRow): LibraryRow {
  const library = seed.libraries.find((candidate) => candidate.id === song.library_id);
  if (library === undefined) throw new SubsonicError(ErrorCode.NotFound, 'Not found.');
  return library;
}

function notFound(what: string): never {
  throw new SubsonicError(ErrorCode.NotFound, `${what} not found.`);
}

/**
 * An album id, resolved to its whole group in protocol order.
 *
 * Both kinds are accepted: `alk:` is what the server mints, `al:` is the folder form still
 * held by old annotations, and a song id names the album its row belongs to. The first row in
 * `compareAlbumTracks` order is the tag source — the same row `getAlbum` uses for the
 * album-level fields, so the answer is a function of the album rather than of statement order.
 */
async function albumSeed(context: RestContext, id: string): Promise<Seed> {
  let rows: SongRow[];
  let libraries: readonly LibraryRow[];
  let scope: LibraryScope;

  // A song id is resolved through the row, never decoded: the derived short form carries
  // no library to decode, and older clients still hold the reversible one.
  if (id.startsWith('s:')) {
    const song = await context.songs.findBySongId(id);
    if (song === null) notFound('Album');
    libraries = await librariesForId(context, song.library_id);
    scope = libraries.map((library) => library.id);
    const key = context.albumsFor(libraries[0]).keyOf(song);
    rows = await context.songIndex.listForAlbumKeys(scope, [key], context.albumsFor(libraries[0]).grouping);
  } else {
    let decoded: ReturnType<typeof decodeId>;
    try {
      decoded = decodeId(id);
    } catch {
      return notFound('Album');
    }
    if (decoded.kind !== IdKind.Album && decoded.kind !== IdKind.AlbumKey) return notFound('Album');
    const resolved = await libraryForAlbumId(context, id);
    libraries = resolved.libraries;
    scope = resolved.scope;
    const key = await resolveAlbumKey(context, id, resolved.library);
    if (key === null) return notFound('Album');
    rows = await context.songIndex.listForAlbumKeys(scope, [key], context.albumsFor(resolved.library).grouping);
  }

  if (rows.length === 0) return notFound('Album');
  const ordered = [...rows].sort(compareAlbumTracks);
  return { libraries, scope, rows: ordered, tagSong: ordered[0] };
}

/**
 * An artist id, an album id, or a song id, resolved to the artist's rows.
 *
 * A group id carries the spanning sentinel, so `librariesForId` reaches every granted library;
 * a song id names one. The first row from `listArtistSeedRows` is the tag source — that query
 * already orders by library and path, so the choice is stable across statement plans.
 */
async function artistSeed(context: RestContext, id: string): Promise<Seed> {
  let libraries: readonly LibraryRow[];
  let scope: LibraryScope;
  let name: string;

  if (id.startsWith('s:')) {
    const song = await context.songs.findBySongId(id);
    if (song === null) notFound('Artist');
    libraries = await librariesForId(context, song.library_id);
    scope = libraries.map((library) => library.id);
    name = song.artist ?? artistNameOf(song);
  } else {
    let decoded: ReturnType<typeof decodeId>;
    try {
      decoded = decodeId(id);
    } catch {
      return notFound('Artist');
    }
    const kinds: readonly IdKindValue[] = [IdKind.Artist, IdKind.Album, IdKind.AlbumKey];
    if (!kinds.includes(decoded.kind)) return notFound('Artist');
    if (decoded.kind === IdKind.Artist) {
      libraries = await librariesForId(context, decoded.libraryId);
      scope = libraries.map((library) => library.id);
      name = decoded.path;
    } else {
      const album = await albumSeed(context, id);
      name = album.tagSong.artist ?? artistNameOf(album.tagSong);
      const rows = await context.songIndex.listArtistSeedRows(album.scope, name.toLowerCase());
      if (rows.length === 0) return notFound('Artist');
      return { ...album, rows };
    }
  }

  const rows = await context.songIndex.listArtistSeedRows(scope, name.toLowerCase());
  if (rows.length === 0) return notFound('Artist');
  return { libraries, scope, rows, tagSong: rows[0] };
}

async function albumInfo(context: RestContext): Promise<EnvelopeResponse> {
  const seed = await albumSeed(context, requireId(context, 'Album'));
  const info = await context.entityInfo.forSong(libraryOf(seed, seed.tagSong), seed.tagSong);
  return respond(context, albumInfoElement(info.notes, info.albumMusicBrainzId));
}

/**
 * Display spellings for the lowercase keys the similarity ranking returns.
 *
 * `getArtist` resolves the same way: `listArtists` produces one representative row per
 * group, and that row's tagged name is what a client sees everywhere else. Using the
 * ranking key directly would publish `other band` beside an `Other Band` that every browse
 * endpoint renders in title case.
 */
async function artistDisplayNames(context: RestContext, scope: LibraryScope, needed: boolean): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!needed) return names;
  const rows = await context.songIndex.listArtists(scope, 5000, 0);
  for (const row of rows) {
    const name = row.artist ?? artistNameOf(row);
    const key = row.artist_ci ?? name.toLowerCase();
    if (!names.has(key)) names.set(key, name);
  }
  return names;
}

/**
 * The two artist spellings, over one seed and one ranking.
 *
 * `count` defaults to 20, not the 50 of the similar-song endpoints, and `optionalInt` rather
 * than `int`: the latter returns the number 0 for an absent parameter, which would turn a
 * client that omitted `count` into one that asked for no similar artists.
 */
async function artistInfo(context: RestContext, wrapper: 'artistInfo' | 'artistInfo2', id3: boolean): Promise<EnvelopeResponse> {
  const seed = await artistSeed(context, requireId(context, 'Artist'));
  const info = await context.entityInfo.forSong(libraryOf(seed, seed.tagSong), seed.tagSong);
  const limit = context.pageSize(context.params.optionalInt('count'), 20);
  const ranked = await context.songIndex.listSimilarArtists({ scope: seed.scope, ...signalsOf(seed.rows) }, limit);
  // The ranking is keyed on `artist_ci`, which is lowercased for matching. Publishing that
  // key as a display name would render every artist in lower case, so resolve it through the
  // same representative rows `getArtists` publishes — one bounded read, only when there is
  // something to name.
  const displayNames = await artistDisplayNames(context, seed.scope, ranked.length > 0);
  const similar: ElementNode[] = ranked.map((artist) => {
    const name = displayNames.get(artist.name) ?? artist.name;
    return infoArtistElement(artistIdOf(name), name, id3);
  });
  return respond(context, artistInfoElement(wrapper, info.notes, info.artistMusicBrainzId, similar));
}

async function getAlbumInfo(context: RestContext): Promise<EnvelopeResponse> {
  return await albumInfo(context);
}

async function getAlbumInfo2(context: RestContext): Promise<EnvelopeResponse> {
  return await albumInfo(context);
}

async function getArtistInfo(context: RestContext): Promise<EnvelopeResponse> {
  return await artistInfo(context, 'artistInfo', false);
}

async function getArtistInfo2(context: RestContext): Promise<EnvelopeResponse> {
  return await artistInfo(context, 'artistInfo2', true);
}

const infoEndpoints = { getAlbumInfo, getAlbumInfo2, getArtistInfo, getArtistInfo2 };

export { infoEndpoints, getAlbumInfo, getAlbumInfo2, getArtistInfo, getArtistInfo2 };
