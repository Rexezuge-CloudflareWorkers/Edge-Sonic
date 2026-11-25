/**
 * Lyrics: the legacy `getLyrics` and OpenSubsonic's `getLyricsBySongId`.
 *
 * Two shapes over one answer. The legacy endpoint takes `artist` and `title` and returns a
 * single plain `value`; the OpenSubsonic one takes a song id and returns structured lines
 * with millisecond offsets. Both go through `context.lyrics`, so the precedence between a
 * sidecar and the tags cannot differ between a client that uses the old call and one that
 * uses the new one.
 *
 * ### `getLyrics` answers empty rather than `code=10`
 *
 * The protocol marks `artist` and `title` optional, and a client may call the endpoint with
 * neither — some do that on an instrumental to learn whether a panel is worth opening. A
 * bare request therefore answers `{"lyrics":{"value":""}}`: the empty answer is what tells
 * the client there is nothing to draw, and `code=10` would say the server could not read the
 * request. The registry used to blank this endpoint for the same reason; it is implemented
 * now, with the same empty answer for the case it cannot resolve.
 *
 * ### The id path is validated before it answers
 *
 * `getLyricsBySongId` is keyed on a song id, so a missing row is `code=70` and not an empty
 * list. "That song does not exist" and "that song has no lyrics" render identically in a
 * lyric panel and mean opposite things to whoever is debugging a library — the rule the
 * registry's empty-result table applies to every id-bearing endpoint.
 */
import { el, elList, elText, ErrorCode, SubsonicError } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { resolveLibraries } from './libraries';

/**
 * The library a resolved song belongs to, with the grant and reachability checks the other
 * media endpoints apply.
 */
async function libraryForSong(context: RestContext, songLibraryId: string): Promise<LibraryRow> {
  const library = await context.libraries.requireForUser(context.user.id, songLibraryId);
  context.libraries.assertReachable(library);
  return library;
}

/**
 * The empty legacy payload. Present and empty, which is the distinction the old
 * `EMPTY_RESULT` entry existed to make.
 */
function emptyLyrics(): ElementNode {
  return elText('lyrics', 'value', '');
}

/**
 * `getLyrics` — by `artist` and `title`.
 *
 * The song is looked up in the caller's **granted** libraries only, so the lookup is not an
 * oracle for tracks in a library they cannot see. A title is required to match anything; an
 * artist narrows the match when present, and a request with neither is the empty answer
 * described above rather than a failure.
 */
async function getLyrics(context: RestContext): Promise<EnvelopeResponse> {
  const title = context.params.get('title');
  if (title === undefined || title.trim().length === 0) return respond(context, emptyLyrics());

  const artist = context.params.get('artist');
  const libraries = await resolveLibraries(context, context.params.get('musicFolderId'));
  const song = await context.songs.findByArtistAndTitle(
    libraries.map((library) => library.id),
    artist === undefined || artist.trim().length === 0 ? null : artist.toLowerCase(),
    title.toLowerCase(),
  );
  if (song === null) return respond(context, emptyLyrics());

  const library = await libraryForSong(context, song.library_id);
  const lyrics = await context.lyrics.forSong(library, song);
  return respond(context, elText('lyrics', 'value', lyrics?.text ?? ''));
}

/**
 * `getLyricsBySongId` — the OpenSubsonic structured payload.
 *
 * `lang` is `und` because the tag format carries no language and guessing one from the text
 * is worse than saying "undetermined". `synced` is whether the lines carry offsets — the
 * client uses it to decide between a scrolling panel and a block of text — and a line with
 * no timestamp omits `start` rather than claiming zero.
 */
async function getLyricsBySongId(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const song = await context.songs.findBySongId(id);
  if (song === null) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');
  TreeService.assertPath(song.path);

  const library = await libraryForSong(context, song.library_id);
  const lyrics = await context.lyrics.forSong(library, song);
  if (lyrics === null) return respond(context, elList('lyricsList', 'structuredLyrics', {}, []));

  const structured = el(
    'structuredLyrics',
    {
      lang: 'und',
      synced: lyrics.synced,
      ...(song.title !== null && { displayTitle: song.title }),
      ...(song.artist !== null && { displayArtist: song.artist }),
    },
    // Every line is flagged as a list element. `structuredLyrics.line` is an **array** in
    // the schema, and the serializer collapses a lone child to a bare object — so a
    // one-line lyric would publish `line: {value: …}` and a client iterating it would
    // read the object's keys instead of the lines.
    lyrics.lines.map((line) => ({
      ...elText('line', 'value', line.text, line.startMs === null ? undefined : { start: line.startMs }),
      array: true,
    })),
  );

  return respond(context, elList('lyricsList', 'structuredLyrics', {}, [structured]));
}

const lyricsEndpoints = { getLyrics, getLyricsBySongId };

export { lyricsEndpoints, getLyrics, getLyricsBySongId };
