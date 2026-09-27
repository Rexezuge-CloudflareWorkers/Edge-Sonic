/**
 * Album and song lists: `getAlbumList`, `getAlbumList2`, `getRandomSongs`,
 * `getSongsByGenre`, `getGenres`, `getStarred`, `getStarred2`, `getNowPlaying`.
 *
 * All aggregated from the `songs` index with an indexed `GROUP BY` rather than by
 * walking folders. `getAlbumList` (file-structure variant) and `getAlbumList2` (tag
 * variant) share one implementation, because a WebDAV library has no separate
 * "albums by file structure" — the albums *are* directories. They stay separate
 * endpoints because clients send both.
 */
import { decodeId, el, elList, IdKind, songElement, successResponse } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { songToModel } from '../mappers';
import { resolveLibrary } from './browse';
import {   annotationsFor, groupAlbums } from './structured';
import type { AnnotationLookup } from '../mappers';

type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

/**
How each album-list type maps onto a `songs` query.
*/
const ALBUM_ORDER_BY: Readonly<Record<string, string>> = {
  random: 'RANDOM()',
  newest: 'mtime_ms DESC',
  frequent: 'mtime_ms DESC',
  recent: 'mtime_ms DESC',
  highest: 'mtime_ms DESC',
  alphabeticalByName: 'album_ci ASC',
  alphabeticalByArtist: 'album_artist_ci ASC, album_ci ASC',
  byYear: 'year ASC, album_ci ASC',
  byGenre: 'genre_ci ASC, album_ci ASC',
};

const EMPTY_ANNOTATIONS: AnnotationLookup = { stars: new Set(), ratings: new Map(), playCounts: new Map() };

/**
Decode an id, or `null` when it is not of this kind or is malformed.
*/
function safeDecodeId(id: string, kind: string): ReturnType<typeof decodeId> | null {
  try {
    return decodeId(id, kind as never);
  } catch {
    // A star whose id this server can no longer decode — a deleted library, or a
    // row written before an id scheme change. Skipped rather than failing the
    // whole list: one stale star must not hide every other one.
    return null;
  }
}

async function albumList(context: RestContext, wrapperName: 'albumList' | 'albumList2'): Promise<EnvelopeResponse> {
  const type = context.params.getOr('type', 'random');
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const size = context.pageSize(context.params.optionalInt('size'), 10);
  const offset = context.params.int('offset', 0, { min: 0 });

  if (type === 'starred') {
    const starredIds = await context.annotations.listStarred(context.user.id, 'album');
    const rows: SongRow[] = [];
    for (const id of starredIds) {
      const decoded = safeDecodeId(id, IdKind.Album);
      if (decoded && decoded.libraryId === library.id) {
        rows.push(...(await context.songs.listByAlbumDir(library.id, decoded.path)));
      }
    }
    const annotations = await annotationsFor(context, starredIds);
    return respond(context, elList(wrapperName, 'album', {}, groupAlbums(rows, library, annotations)));
  }

  const needsRange = type === 'byYear' || type === 'byGenre';
  const rawFrom = context.params.int('fromYear', Number.MIN_SAFE_INTEGER);
  const rawTo = context.params.int('toYear', Number.MAX_SAFE_INTEGER);
  // A reversed range is the protocol's way of asking for reverse chronological.
  const fromYear = needsRange ? Math.min(rawFrom, rawTo) : Number.MIN_SAFE_INTEGER;
  const toYear = needsRange ? Math.max(rawFrom, rawTo) : Number.MAX_SAFE_INTEGER;
  const genre = type === 'byGenre' ? context.params.get('genre') : undefined;

  const rows = await context.songIndex.listAlbums(library.id, {
    genreCi: genre ? genre.toLowerCase() : null,
    ...(needsRange && { fromYear, toYear }),
    limit: size,
    offset,
    orderBy: ALBUM_ORDER_BY[type] ?? ALBUM_ORDER_BY.random,
  });

  return respond(context, elList(wrapperName, 'album', {}, groupAlbums(rows, library, EMPTY_ANNOTATIONS)));
}

async function getAlbumList(context: RestContext): Promise<EnvelopeResponse> {
  return await albumList(context, 'albumList');
}

async function getAlbumList2(context: RestContext): Promise<EnvelopeResponse> {
  return await albumList(context, 'albumList2');
}

/**
Wrap rows as song elements with one set of annotation lookups for the page.
*/
async function songNodes(context: RestContext, library: LibraryRow, rows: readonly SongRow[]): Promise<ElementNode[]> {
  const ids = rows.map((row) => row.id);
  const annotations = await annotationsFor(context, ids);
  return rows.map((row) => songElement(songToModel(row, library, annotations)));
}

async function getRandomSongs(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const size = context.pageSize(context.params.optionalInt('size'), 10);
  const genre = context.params.get('genre');
  const fromYear = context.params.int('fromYear', Number.MIN_SAFE_INTEGER);
  const toYear = context.params.int('toYear', Number.MAX_SAFE_INTEGER);
  const rows = await context.songs.listRandom(library.id, {
    genreCi: genre ? genre.toLowerCase() : null,
    ...((fromYear !== Number.MIN_SAFE_INTEGER) && { fromYear }),
    ...((toYear !== Number.MAX_SAFE_INTEGER) && { toYear }),
    limit: size,
  });
  return respond(context, elList('randomSongs', 'song', {}, await songNodes(context, library, rows)));
}

async function getSongsByGenre(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const genre = context.params.require('genre');
  const count = context.pageSize(context.params.optionalInt('count'), 10);
  const offset = context.params.int('offset', 0, { min: 0 });
  const rows = await context.songs.listByGenre(library.id, genre.toLowerCase(), count + offset, 0);
  return respond(context, elList('songsByGenre', 'song', {}, await songNodes(context, library, rows.slice(offset, offset + count))));
}

/**
 * `getGenres` — the library's genres, with real song and album counts.
 *
 * The counts come from the aggregate in `listGenres` rather than from counting rows
 * here. That used to be the implementation, over a `GROUP BY genre_ci` result whose
 * rows are one track each — so every genre reported `songCount: 1`, and a client using
 * the count to decide whether to offer a genre filter was reading a number that had
 * nothing to do with the library.
 */
async function getGenres(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const rows = await context.songIndex.listGenres(library.id);
  const nodes = rows
    .filter((row) => row.value.trim().length > 0)
    .map((row) => el('genre', { value: row.value, songCount: row.song_count, albumCount: row.album_count }));
  return respond(context, elList('genres', 'genre', {}, nodes));
}

/**
 * `getStarred` / `getStarred2` — starred songs and albums.
 *
 * Artist stars are **not** expanded into albums here. A starred artist can have
 * hundreds of albums, and a client calling `getStarred` expects a page, not a
 * library; expanding it would make one request proportional to a whole discography.
 * Starred artists are visible through `getArtists`, which reports `starred` on the
 * artist element itself.
 */
async function starred(context: RestContext, wrapperName: 'starred' | 'starred2'): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const [songIds, albumIds] = await Promise.all([
    context.annotations.listStarred(context.user.id, 'song'),
    context.annotations.listStarred(context.user.id, 'album'),
  ]);

  const songIdsHere = songIds.filter((id) => safeDecodeId(id, IdKind.Song)?.libraryId === library.id);
  const songs = await context.songs.listIdsIn(library.id, songIdsHere);

  const albumRows: SongRow[] = [];
  for (const id of albumIds) {
    const decoded = safeDecodeId(id, IdKind.Album);
    if (decoded && decoded.libraryId === library.id) {
      albumRows.push(...(await context.songs.listByAlbumDir(library.id, decoded.path)));
    }
  }

  const annotations = await annotationsFor(context, [...songIds, ...albumIds]);
  return respond(context, elList(wrapperName, ['album', 'song'], {}, [...groupAlbums(albumRows, library, annotations), ...(await songNodes(context, library, songs))]));
}

async function getStarred(context: RestContext): Promise<EnvelopeResponse> {
  return await starred(context, 'starred');
}

async function getStarred2(context: RestContext): Promise<EnvelopeResponse> {
  return await starred(context, 'starred2');
}

/**
 * `getNowPlaying` — populated by `scrobble`, and deliberately narrow.
 *
 * Only entries whose song is still in the index are reported, and only for the
 * caller's library. A scrobble for a track that has since been deleted is silently
 * dropped rather than shown as a broken entry.
 */
async function getNowPlaying(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, undefined);
  const entries = await context.annotations.listNowPlaying();
  const nodes: ElementNode[] = [];
  for (const entry of entries) {
    if (!entry.song_id || (safeDecodeId(entry.song_id, IdKind.Song)?.libraryId !== library.id)) continue;
    const song = await context.songs.findById(entry.song_id);
    if (!song) continue;
    nodes.push({
      ...songElement(songToModel(song, library)),
      // The wrapper declares `entry` as its list key, and the element name is the JSON
      // key a client reads. Leaving this as `song` puts the payload under
      // `nowPlaying.song` and leaves `nowPlaying.entry` as its empty seed, so a client
      // following the schema sees nobody playing forever.
      name: 'entry',
      children: [
        el('username', {}, [entry.username]),
        el('minutesAgo', {}, [entry.minutes_ago]),
        ...(entry.player_name ? [el('playerName', {}, [entry.player_name])] : []),
        ...(entry.player_id ? [el('playerId', {}, [entry.player_id])] : []),
      ],
    });
  }
  return respond(context, elList('nowPlaying', 'entry', {}, nodes));
}

const listEndpoints = {
  getAlbumList,
  getAlbumList2,
  getRandomSongs,
  getSongsByGenre,
  getGenres,
  getStarred,
  getStarred2,
  getNowPlaying,
};

export { listEndpoints, getAlbumList, getAlbumList2, getRandomSongs, getSongsByGenre, getGenres, getStarred, getStarred2, getNowPlaying, ALBUM_ORDER_BY };


export {albumKeyOf, albumNameOf} from './structured';