/**
 * Search: `search`, `search2`, `search3`.
 *
 * All three share one implementation and differ only in the envelope shape, because
 * Subsonic deprecated `search` in 1.4.0 and every modern client sends `search2` or
 * `search3`. Implementing them separately would be three places for a search bug to
 * hide in.
 *
 * ### Why infix search is a scan, and why that is fine here
 *
 * `songs.title_ci LIKE '%term%'` cannot use an index for the term — a leading `%`
 * makes the pattern's start unknown. The leading `library_id = ?` does use one, so
 * the cost is a scan of *this library's* rows. A personal library is thousands of
 * rows and SQLite does that in single-digit milliseconds.
 *
 * FTS5 is the fix if a query plan ever says otherwise, and the migration says so
 * at the index. What is *not* acceptable is silently shipping a full-table scan
 * across every library, which is what dropping the `library_id` predicate would do.
 */
import { albumChildElement, albumElement, artistIdOf, el, elList, songElement } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryScope, SongRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { NO_ANNOTATIONS, songToModel } from '../mappers';
import { resolveLibraries } from './libraries';
import { annotationsFor } from './structured';
import { groupAlbumsOf } from './albumRecord';
import { artistNameOf } from '../mappers';
import type { AlbumIdentity } from '../albumIdentity';

interface SearchSpec {
  readonly term: string;
  readonly field: 'any' | 'title' | 'artist' | 'album';
}

/**
 * `search` takes four separate criteria; `search2`/`search3` take one `query`.
 *
 * They are normalized here rather than in three handlers so that `search`'s
 * multi-field form produces the same result set as `search3` with the same terms —
 * which is what a client switching between them expects.
 */
function readSpec(context: RestContext): SearchSpec {
  const any = context.params.get('any');
  if (any !== undefined) return { term: any, field: 'any' };
  const title = context.params.get('title');
  if (title !== undefined) return { term: title, field: 'title' };
  const artist = context.params.get('artist');
  if (artist !== undefined) return { term: artist, field: 'artist' };
  const album = context.params.get('album');
  return album === undefined ? { term: context.params.require('query'), field: 'any' } : { term: album, field: 'album' };
}

/**
 * The song page of a search.
 *
 * The offset is paged **in SQL**, and bounded. It used to read `limit + offset` rows at
 * `offset: 0` and discard all but the page with a `slice` — so `?songOffset=9007199254740991` bound
 * `LIMIT 9007199254740991` and pulled the whole matching set into Worker memory to throw away. See
 * `../paging` for why the ceiling is derived from the page size rather than typed.
 */
async function runSearch(context: RestContext, scope: LibraryScope): Promise<{ songs: SongRow[]; spec: SearchSpec }> {
  const spec = readSpec(context);
  const limit = context.pageSize(context.params.optionalInt('songCount'), 20);
  const offset = context.params.int('songOffset', 0, { min: 0, max: context.maxOffset });
  const songs = await context.songs.search(scope, spec.term, { limit, offset, field: spec.field });
  return { songs, spec };
}

/**
`search` — the legacy single-group envelope.
*/
async function search(context: RestContext): Promise<EnvelopeResponse> {
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const scope = libraries.map((row) => row.id);
  const identityOf = context.albumsForScope(libraries);
  const { songs } = await runSearch(context, scope);
  const count = context.pageSize(context.params.optionalInt('count'), 20);
  const annotations = await annotationsFor(context, songs.length > 0);
  const nodes = songs.slice(0, count).map((song) => songElement(songToModel(song, identityOf, annotations)));
  return respond(context, elList('searchResult', 'song', {}, nodes));
}

/**
 * `search2` / `search3` — artists, albums, and songs in one envelope.
 *
 * `search2` and `search3` are identical here: the difference in the original
 * protocol is that `search3` is organized by ID3 tags, and a WebDAV library has
 * only one organization. Both are answered from the same grouped view.
 */
async function search2Or3(context: RestContext, wrapperName: 'searchResult2' | 'searchResult3'): Promise<EnvelopeResponse> {
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const scope = libraries.map((row) => row.id);
  const identityOf = context.albumsForScope(libraries);
  const grouping = context.albumsFor(libraries[0]).grouping;
  const { songs } = await runSearch(context, scope);
  const annotations = await annotationsFor(context, songs.length > 0);

  const artists = groupArtists(
    songs,
    identityOf,
    context.pageSize(context.params.optionalInt('artistCount'), 20),
    context.params.int('artistOffset', 0, { min: 0, max: context.maxOffset }),
  );
  const albumOffset = context.params.int('albumOffset', 0, { min: 0, max: context.maxOffset });
  // **Completed, then grouped.** `songs` is the matched subset, so grouping it alone publishes
  // an album holding the tracks the term happened to hit — and the same album id then reports a
  // different `songCount`, `duration` and `artist` here than everywhere else. The protocol's own
  // shape agrees: `searchResult3` carries albums as `AlbumID3` records with no songs attached,
  // so the album's numbers are supposed to be the album's. One statement per 49 keys, against a
  // default page of 20 albums.
  const albumKeys = [...new Set(songs.map((song) => identityOf(song).keyOf(song)))];
  const complete = await context.songIndex.listForAlbumKeys(scope, albumKeys, grouping);
  const albums = groupAlbumsOf(complete, identityOf, NO_ANNOTATIONS).slice(
    albumOffset,
    albumOffset + context.pageSize(context.params.optionalInt('albumCount'), 20),
  );

  // The same split as the album lists, for the same reason: `searchResult2` is the
  // pre-1.4 shape and carries albums as `Child`, `searchResult3` carries them as
  // `AlbumID3`. The wrapper is the only thing that distinguishes the two, so the
  // wrapper is what decides the element type.
  const albumNodes =
    wrapperName === 'searchResult2'
      ? albums.map((album) => albumChildElement(album, album.artistId))
      : albums.map((album) => albumElement(album));

  return respond(
    context,
    elList(
      wrapperName,
      // `searchResult2`/`searchResult3` hold all three kinds, and a client reads
      // whichever it wants — so all three are declared, or an empty one is `undefined`
      // rather than `[]`.
      ['artist', 'album', 'song'],
      {},
      [...artists, ...albumNodes, ...songs.map((song) => songElement(songToModel(song, identityOf, annotations)))],
    ),
  );
}

/**
 * Distinct artists across the result set, as `artist` elements.
 *
 * `albumCount` counts distinct album **keys**, so a compilation counts once for every artist
 * who contributed a track to it — see `groupArtistRows`, which answers the same question for
 * `getArtists` and has to agree with this or the two browses disagree about an artist's
 * discography.
 */
function groupArtists(
  rows: readonly SongRow[],
  identityOf: (song: SongRow) => AlbumIdentity,
  limit: number,
  offset: number,
): ElementNode[] {
  const counts = new Map<string, { name: string; albums: Set<string> }>();
  for (const row of rows) {
    const name = row.artist ?? row.album_artist ?? artistNameOf(row);
    const key = name.toLowerCase();
    // Per row: the album key names the row's own library under `folder` grouping, and `rows`
    // spans the caller's whole granted scope.
    const albumKey = identityOf(row).keyOf(row);
    const existing = counts.get(key);
    if (existing) {
      existing.albums.add(albumKey);
    } else {
      counts.set(key, { name, albums: new Set([albumKey]) });
    }
  }
  return [...counts.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(offset, offset + limit)
    .map((entry) => {
      const id = artistIdOf(entry.name);
      // Same contract as `getArtists`/`getArtist`: the artist id is its own cover id,
      // so a client can request `getCoverArt` without a second lookup.
      return el('artist', { id, name: entry.name, albumCount: entry.albums.size, coverArt: id });
    });
}

async function search2(context: RestContext): Promise<EnvelopeResponse> {
  return await search2Or3(context, 'searchResult2');
}

async function search3(context: RestContext): Promise<EnvelopeResponse> {
  return await search2Or3(context, 'searchResult3');
}

const searchEndpoints = { search, search2, search3 };

export { searchEndpoints, search, search2, search3 };
