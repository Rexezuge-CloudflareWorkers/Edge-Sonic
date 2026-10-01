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
import { albumChildElement, albumElement, el, elList, encodeId, IdKind, songElement } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { NO_ANNOTATIONS, songToModel } from '../mappers';
import { resolveLibrary } from './libraries';
import { annotationsFor, groupAlbums } from './structured';
import { albumKeyOf, artistNameOf } from '../mappers';


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

async function runSearch(context: RestContext, library: LibraryRow): Promise<{ songs: SongRow[]; spec: SearchSpec }> {
  const spec = readSpec(context);
  const limit = context.pageSize(context.params.optionalInt('songCount'), 20);
  const offset = context.params.int('songOffset', 0, { min: 0 });
  const songs = await context.songs.search(library.id, spec.term, { limit: limit + offset, offset: 0, field: spec.field });
  return { songs: songs.slice(offset, offset + limit), spec };
}

/**
`search` — the legacy single-group envelope.
*/
async function search(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const { songs } = await runSearch(context, library);
  const count = context.pageSize(context.params.optionalInt('count'), 20);
  const annotations = await annotationsFor(context, songs.length > 0);
  const nodes = songs.slice(0, count).map((song) => songElement(songToModel(song, library, annotations)));
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
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  const { songs } = await runSearch(context, library);
  const annotations = await annotationsFor(context, songs.length > 0);

  const artists = groupArtists(songs, library, context.pageSize(context.params.optionalInt('artistCount'), 20), context.params.int('artistOffset', 0, { min: 0 }));
  const albumOffset = context.params.int('albumOffset', 0, { min: 0 });
  const albums = groupAlbums(songs, library, NO_ANNOTATIONS).slice(
    albumOffset,
    albumOffset + context.pageSize(context.params.optionalInt('albumCount'), 20),
  );

  // The same split as the album lists, for the same reason: `searchResult2` is the
  // pre-1.4 shape and carries albums as `Child`, `searchResult3` carries them as
  // `AlbumID3`. The wrapper is the only thing that distinguishes the two, so the
  // wrapper is what decides the element type.
  const albumNodes =
    wrapperName === 'searchResult2' ? albums.map((album) => albumChildElement(album, album.artistId)) : albums.map((album) => albumElement(album));

  return respond(
    context,
    elList(
      wrapperName,
      // `searchResult2`/`searchResult3` hold all three kinds, and a client reads
      // whichever it wants — so all three are declared, or an empty one is `undefined`
      // rather than `[]`.
      ['artist', 'album', 'song'],
      {},
      [
        ...artists,
        ...albumNodes,
        ...songs.map((song) => songElement(songToModel(song, library, annotations))),
      ],
    ),
  );
}

/**
Distinct artists across the result set, as `artist` elements.
*/
function groupArtists(rows: readonly SongRow[], library: LibraryRow, limit: number, offset: number): ElementNode[] {
  const counts = new Map<string, { name: string; albums: Set<string> }>();
  for (const row of rows) {
    const name = row.artist ?? row.album_artist ?? artistNameOf(row);
    const key = name.toLowerCase();
    const existing = counts.get(key);
    if (existing) {
      existing.albums.add(albumKeyOf(row));
    } else {
      counts.set(key, { name, albums: new Set([albumKeyOf(row)]) });
    }
  }
  return [...counts.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(offset, offset + limit)
    .map((entry) => el('artist', { id: encodeId(IdKind.Artist, library.id, entry.name), name: entry.name, albumCount: entry.albums.size }));
}

async function search2(context: RestContext): Promise<EnvelopeResponse> {
  return await search2Or3(context, 'searchResult2');
}

async function search3(context: RestContext): Promise<EnvelopeResponse> {
  return await search2Or3(context, 'searchResult3');
}

const searchEndpoints = { search, search2, search3 };

export { searchEndpoints, search, search2, search3 };


