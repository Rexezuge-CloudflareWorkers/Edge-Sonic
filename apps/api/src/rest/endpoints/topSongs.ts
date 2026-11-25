/**
 * `getTopSongs`: an artist's most-played tracks, ranked from the calling user's play
 * counts in the index.
 *
 * ### A local claim, not a last.fm chart
 *
 * The protocol describes this endpoint as last.fm-backed. There is no last.fm integration
 * here, so the answer is deliberately narrower: the songs of that artist **this user**
 * has played, in descending play count. A global chart would be a claim about data this
 * server does not have; an empty wrapper when there are no plays is a claim it can keep.
 * See `packages/backend-data/src/dao/songTop.ts` for the statement.
 *
 * ### The artist is a name, not an id
 *
 * The protocol keys this call on `artist` and has no `id` parameter unless the optional
 * `topSongsByArtistId` extension is advertised — which this server does not advertise.
 * The name is lowercased here, on the **parameter**, and matched against the stored `_ci`
 * twins; lowercasing the column in SQL would drop the artist index. A missing name is
 * `code=10` (`params.require`), which is the contract the empty-result entry held before
 * this implementation: "name an artist" is the one thing the caller can act on.
 *
 * ### Scope and shape
 *
 * No `musicFolderId` means the union of the caller's grants, exactly as on every other
 * list; an explicit one narrows it. The wrapper is `topSongs` — not the endpoint's name —
 * and its repeated child is `song`, built as a `Child` element like `getSimilarSongs`'s.
 * One song is still an array; no songs is an absent key, which is the serializer's rule.
 */
import { elList, songElement } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { songToModel } from '../mappers';
import { annotationsFor } from './structured';
import { resolveLibraries } from './libraries';

/**
 * The protocol's own default for `count`. `optionalInt` rather than `int`: the latter
 * returns the number `0` for an absent parameter, which `pageSize` would clamp to one.
 */
const DEFAULT_TOP_SONGS = 50;

async function getTopSongs(context: RestContext): Promise<EnvelopeResponse> {
  const artist = context.params.require('artist');
  const limit = context.pageSize(context.params.optionalInt('count'), DEFAULT_TOP_SONGS);
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const songs = await context.songIndex.listTopSongs(
    libraries.map((library) => library.id),
    context.user.id,
    artist.toLowerCase(),
    limit,
  );

  const annotations = await annotationsFor(context, songs.length > 0);
  const identityOf = context.albumsForScope(libraries);
  const nodes: ElementNode[] = songs.map((song) => songElement(songToModel(song, identityOf, annotations)));
  return respond(context, elList('topSongs', 'song', {}, nodes));
}

const topSongsEndpoints = { getTopSongs };

export { getTopSongs, topSongsEndpoints };
