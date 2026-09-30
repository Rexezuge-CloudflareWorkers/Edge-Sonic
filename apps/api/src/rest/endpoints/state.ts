/**
 * Per-user state the filesystem cannot hold: bookmarks and the play queue.
 */
import { decodeId, el, elList,  IdKind, songElement,  successResponse } from '@edge-sonic/subsonic';
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
  const annotations = await annotationsFor(context, rows.length > 0);
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
  // Awaited, before the write. `void` started the grant check and discarded its
  // rejection, so the bookmark was written for a library the caller cannot see; the
  // `bookmarks` table has no foreign key to `songs` to catch it, and `getBookmarks`
  // filters by library, so the row was invisible and permanent. The same defect the
  // play queue had at `savePlayQueue` below.
  await context.libraries.requireForUser(context.user.id, decoded.libraryId);
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
  const [library] = await context.libraries.listForUser(context.user.id);

  // An empty queue is reported as an **empty `playQueue` element**, not as an absent
  // one. Both were tried: the comment this replaces claimed some clients treat a
  // childless `playQueue` as an error, which is true of exactly the clients that then
  // do `response.playQueue.entry.map(...)` — for those, an absent key throws and
  // `{"entry": []}` renders an empty queue. The element is what the schema describes,
  // and `elList` guarantees the array is present even with no children.
  if (library === undefined) return respond(context, elList('playQueue', 'entry', {}, []));

  const saved = await context.annotations.listPlayQueue(context.user.id);
  if (saved.songIds.length === 0) return respond(context, elList('playQueue', 'entry', {}, []));
  const queue = await context.songs.listIdsIn(library.id, saved.songIds);
  // Every queued track was deleted or lost access since the queue was saved. The
  // position and current track are still the user's, so they are reported; only the
  // entries are gone. Spread rather than passed as extra arguments, because `elList`'s
  // signature *is* the list contract and a childless list still has to declare its key.
  if (queue.length === 0) {
    const empty: ElementNode = elList('playQueue', 'entry', {}, []);
    return respond(context, {
      ...empty,
      children: [
        el('current', {}, [saved.currentSongId ?? '']),
        el('position', {}, [saved.positionMs]),
        el('username', {}, [context.username]),
      ],
    });
  }

  const annotations = await annotationsFor(context, queue.length > 0);
  return respond(
    context,
    elList(
      'playQueue',
      'entry',
      {},
      [
        // `current` and `position` are what a client resumes from, so they are reported
        // on **every** path. They used to be emitted only when the queue was empty, which
        // is exactly backwards: a saved queue resumed from zero.
        //
        // `current` is reported only when the track is still in the queue. Naming an id
        // the client cannot resolve is worse than naming none.
        ...(saved.currentSongId !== null && queue.some((song) => song.id === saved.currentSongId) ? [el('current', {}, [saved.currentSongId])] : []),
        el('position', {}, [saved.positionMs]),
        // `username` and `changed` are part of the same element, and a client that syncs a
        // queue between devices needs to know whose queue it is and when it moved.
        el('username', {}, [context.username]),
        ...(saved.changedAt === null ? [] : [el('changed', {}, [new Date(saved.changedAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')])]),
        // Renamed: see the note on `getBookmarks`. The element name is the key, so a
        // `song` element here would put the queue under `playQueue.song`.
        ...queue.map((song) => ({ ...songElement(songToModel(song, library, annotations)), name: 'entry' })),
      ],
    ),
  );
}

async function savePlayQueue(context: RestContext): Promise<EnvelopeResponse> {
  const ids = context.params.ids('id');
  const current = context.params.get('current') ?? null;
  const position = context.params.int('position', 0, { min: 0 });

  // Validate every id against this user's libraries *before* replacing the queue, so a
  // bad id in the middle cannot leave a half-saved queue.
  //
  // **Awaited.** These calls used to be `void`ed, which started the check and discarded
  // its promise: the rejection surfaced as an unhandled rejection rather than as a
  // `code=50`, and the queue was written with an id pointing at a library the caller
  // cannot see. `getPlayQueue` then filtered it out, so the queue simply came back
  // shorter than it was saved — a silent data loss with an authorization hole under it.
  for (const id of ids) {
    const decoded = decodeId(id, IdKind.Song);
    await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  }
  if (current !== null) {
    const decoded = decodeId(current, IdKind.Song);
    await context.libraries.requireForUser(context.user.id, decoded.libraryId);
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

export { stateEndpoints, getBookmarks, createBookmark, deleteBookmark, getPlayQueue, savePlayQueue,   };

export {ErrorCode, SubsonicError} from '@edge-sonic/subsonic';