/**
 * Per-user state the filesystem cannot hold: bookmarks and the play queue.
 */
import { decodeId, el, elList, ErrorCode, IdKind, songElement, SubsonicError, successResponse } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { RestContext } from '../context';
import { songToModel } from '../mappers';
import { annotationsFor } from './structured';

type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

/**
 * Bookmarks: a resume position and a note, per song.
 *
 * `createBookmark` is an upsert keyed on `(user, song)`, which is what the protocol
 * means by "create" — a client re-bookmarks a song it has already bookmarked
 * whenever the position moves, and a plain insert would fail on the second one.
 */
async function getBookmarks(context: RestContext): Promise<EnvelopeResponse> {
  const library = await context.libraries.listForUser(context.user.id);
  if (library.length === 0) return respond(context, elList('bookmarks', 'bookmark', {}));

  const rows = await context.annotations.listBookmarks(context.user.id);
  const annotations = await annotationsFor(context, rows.map((row) => row.song_id));
  const nodes: ElementNode[] = [];
  for (const row of rows) {
    const decoded = safeDecode(row.song_id, IdKind.Song);
    if (!decoded) continue;
    // A bookmark for a library this user cannot see is dropped, not rejected: the
    // user may legitimately have had access revoked since bookmarking.
    const songLibrary = library.find((candidate) => candidate.id === decoded.libraryId);
    if (!songLibrary) continue;
    const song = await context.songs.findById(row.song_id);
    if (!song) continue;
    nodes.push({
      // Renamed to `bookmark`: the element name is the JSON key a client reads, so a
      // `song` element inside a `bookmarks` wrapper produces `bookmarks.song` and leaves
      // `bookmarks.bookmark` as the empty seed.
      ...songElement(songToModel(song, songLibrary, annotations)),
      name: 'bookmark',
      children: [
        el('position', {}, [row.position_ms]),
        el('username', {}, [context.username]),
        ...(row.comment ? [el('comment', {}, [row.comment])] : []),
        el('created', {}, [new Date(row.created_at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')]),
        el('changed', {}, [new Date(row.updated_at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')]),
      ],
    });
  }
  return respond(context, elList('bookmarks', 'bookmark', {}, nodes));
}

async function createBookmark(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const decoded = decodeId(id, IdKind.Song);
  void context.libraries.requireForUser(context.user.id, decoded.libraryId);
  const position = context.params.int('position', 0, { min: 0 });
  const comment = context.params.get('comment');
  await context.annotations.createBookmark(context.user.id, id, position, comment ?? null);
  return respond(context, null);
}

async function deleteBookmark(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  // The bookmark may legitimately not exist — the client is syncing state it no
  // longer has — so a zero-row delete is success, not `code=70`.
  await context.annotations.deleteBookmark(context.user.id, id);
  return respond(context, null);
}

/**
 * The play queue: cross-device continuity for a long listen.
 *
 * `savePlayQueue` replaces the queue wholesale. The protocol has no "add to queue"
 * operation, so a client that adds a track sends the whole list, and a diffing
 * implementation would have to guess which of the two shapes it received.
 */
async function getPlayQueue(context: RestContext): Promise<EnvelopeResponse> {
  const library = (await context.libraries.listForUser(context.user.id))[0];
  // An empty `subsonic-response` is the spec's way of saying "no queue saved", and
  // some clients treat a `playQueue` element with no children as an error.
  if (library === undefined) return respond(context, null);

  const saved = await context.annotations.listPlayQueue(context.user.id);
  if (saved.songIds.length === 0) return respond(context, null);
  const queue = await context.songs.listIdsIn(library.id, saved.songIds);
  if (queue.length === 0) return respond(context, null);

  const annotations = await annotationsFor(context, queue.map((song) => song.id));
  return respond(context, elList('playQueue', 'entry', {}, queue.map((song) => songElement(songToModel(song, library, annotations)))));
}

async function savePlayQueue(context: RestContext): Promise<EnvelopeResponse> {
  const ids = context.params.ids('id');
  const current = context.params.get('current') ?? null;
  const position = context.params.int('position', 0, { min: 0 });

  // Validate every id against this user's libraries *before* replacing the queue, so
  // a bad id in the middle cannot leave a half-saved queue.
  for (const id of ids) {
    const decoded = decodeId(id, IdKind.Song);
    void context.libraries.requireForUser(context.user.id, decoded.libraryId);
  }
  if (current !== null) {
    const decoded = decodeId(current, IdKind.Song);
    void context.libraries.requireForUser(context.user.id, decoded.libraryId);
  }

  await context.annotations.savePlayQueue({
    userId: context.user.id,
    songIds: ids,
    currentSongId: current,
    positionMs: position,
    changed: context.params.get('changed') ?? new Date().toISOString(),
  });
  return respond(context, null);
}

function safeDecode(id: string, kind: string) {
  try {
    return decodeId(id, kind as never);
  } catch {
    return null;
  }
}

const stateEndpoints = { getBookmarks, createBookmark, deleteBookmark, getPlayQueue, savePlayQueue };

export { stateEndpoints, getBookmarks, createBookmark, deleteBookmark, getPlayQueue, savePlayQueue, SubsonicError, ErrorCode };
