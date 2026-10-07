/**
 * Per-user state the filesystem cannot hold: bookmarks and the play queue.
 */
import { el, elList, ErrorCode, songElement, SubsonicError } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { songToModel, toIso } from '../mappers';
import { annotationsFor } from './structured';

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
    const song = await context.songs.findBySongId(row.song_id);
    if (!song) continue;
    // A bookmark for a library this user cannot see is dropped, not rejected: the
    // user may legitimately have had access revoked since bookmarking.
    const songLibrary = library.find((candidate) => candidate.id === song.library_id);
    if (!songLibrary) continue;
    nodes.push({
      // Renamed to `bookmark`: the element name is the JSON key a client reads, so a
      // `song` element inside a `bookmarks` wrapper produces `bookmarks.song` and leaves
      // `bookmarks.bookmark` as the empty seed.
      ...songElement(songToModel(song, songLibrary, context.albumsFor(songLibrary), annotations)),
      name: 'bookmark',
      children: [
        el('position', {}, [row.position_ms]),
        el('username', {}, [context.username]),
        ...(row.comment ? [el('comment', {}, [row.comment])] : []),
        el('created', {}, [toIso(row.created_at)!]),
        el('changed', {}, [toIso(row.updated_at)!]),
      ],
    });
  }
  return respond(context, elList('bookmarks', 'bookmark', {}, nodes));
}

async function createBookmark(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const song = await context.songs.findBySongId(id);
  if (!song) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');
  // Awaited, before the write. `void` started the grant check and discarded its
  // rejection, so the bookmark was written for a library the caller cannot see; the
  // `bookmarks` table has no foreign key to `songs` to catch it, and `getBookmarks`
  // filters by library, so the row was invisible and permanent. The same defect the
  // play queue had at `savePlayQueue` below.
  await context.libraries.requireForUser(context.user.id, song.library_id);
  const position = context.params.int('position', 0, { min: 0 });
  const comment = context.params.get('comment');
  // Canonical id: a client holding a legacy long id migrates to the short one here.
  await context.annotations.createBookmark(context.user.id, song.id, position, comment ?? null);
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
  // Every library the caller can see, not `libraries[0]`. The queue is a **per-user** row
  // whose ids came from whatever libraries that user was granted, so resolving one library
  // and filtering silently dropped every entry from the others — a queue that shortened
  // itself each time the caller's first library happened not to contain it.
  const libraries = await context.libraries.listForUser(context.user.id);

  // An empty queue is reported as an **empty `playQueue` element**, not as an absent
  // one. Both were tried: the comment this replaces claimed some clients treat a
  // childless `playQueue` as an error, which is true of exactly the clients that then
  // do `response.playQueue.entry.map(...)` — for those, an absent key throws and
  // `{"entry": []}` renders an empty queue. The element is what the schema describes,
  // and `elList` guarantees the array is present even with no children.
  if (libraries.length === 0) return respond(context, elList('playQueue', 'entry', {}, []));

  const saved = await context.annotations.listPlayQueue(context.user.id);
  if (saved.songIds.length === 0) return respond(context, elList('playQueue', 'entry', {}, []));
  // Across every granted library. `listIdsIn` is library-scoped and correct for the
  // per-library endpoints; this row is not scoped to one, so it uses the sibling that is
  // not. Every id in it was authorized by `savePlayQueue` before it was written.
  const queue = await context.songs.listIdsAcrossLibraries(saved.songIds);
  // A track whose library the caller no longer has must not be rendered, or the queue would
  // disclose the existence of a song outside the caller's grants. Dropping it is the same
  // rule `getBookmarks` applies.
  const visible = new Set(libraries.map((library) => library.id));
  const renderable: SongRow[] = queue.filter((song) => visible.has(song.library_id));
  // Every queued track was deleted or lost access since the queue was saved. The
  // position and current track are still the user's, so they are reported; only the
  // entries are gone. Spread rather than passed as extra arguments, because `elList`'s
  // signature *is* the list contract and a childless list still has to declare its key.
  if (renderable.length === 0) {
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

  const annotations = await annotationsFor(context, renderable.length > 0);
  // Canonical current: a client holding a legacy long id for a rotated row
  // resolves to the same track, so the comparison is on what the row holds now.
  let currentCanonical: string | null = null;
  if (saved.currentSongId !== null) {
    const current = await context.songs.findBySongId(saved.currentSongId);
    currentCanonical = current?.id ?? null;
  }
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
        ...(currentCanonical !== null && renderable.some((song) => song.id === currentCanonical) ? [el('current', {}, [currentCanonical])] : []),
        el('position', {}, [saved.positionMs]),
        // `username` and `changed` are part of the same element, and a client that syncs a
        // queue between devices needs to know whose queue it is and when it moved.
        el('username', {}, [context.username]),
        ...(saved.changedAt === null ? [] : [el('changed', {}, [toIso(saved.changedAt)!])]),
        // Renamed: see the note on `getBookmarks`. The element name is the key, so a
        // `song` element here would put the queue under `playQueue.song`.
        ...renderable.map((song) => ({ ...songElement(songToModel(song, libraryOf(libraries, song.library_id), context.albumsFor(libraryOf(libraries, song.library_id)), annotations)), name: 'entry' })),
      ],
    ),
  );
}

/**
 * The library a song belongs to, for the `libraryId` a song record carries.
 *
 * `songToModel` needs the row to encode an album id, and the id is
 * `kind:base64url(libraryId \n path)` — so a song from the caller's *second* library
 * cannot be rendered with the first one's id. `getBookmarks` already resolves per song;
 * this is the same derivation for the play queue.
 */
function libraryOf(libraries: readonly LibraryRow[], libraryId: string): LibraryRow {
  const found = libraries.find((candidate) => candidate.id === libraryId);
  // Unreachable for a row that survived `visible`, but a fabricated id would produce an
  // album id pointing into the wrong library — a worse failure than a missing one.
  if (!found) throw new SubsonicError(ErrorCode.NotFound, `No library for ${libraryId}.`);
  return found;
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
  //
  // Resolved through the row, not decoded: short ids carry no library to decode,
  // and the canonical id is stored so a legacy id migrates on save.
  const canonical: string[] = [];
  for (const id of ids) {
    const song = await context.songs.findBySongId(id);
    if (!song) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');
    await context.libraries.requireForUser(context.user.id, song.library_id);
    canonical.push(song.id);
  }
  let canonicalCurrent: string | null = null;
  if (current !== null) {
    const song = await context.songs.findBySongId(current);
    if (!song) throw new SubsonicError(ErrorCode.NotFound, 'Song not found.');
    await context.libraries.requireForUser(context.user.id, song.library_id);
    canonicalCurrent = song.id;
  }

  await context.annotations.savePlayQueue({
    userId: context.user.id,
    songIds: canonical,
    currentSongId: canonicalCurrent,
    positionMs: position,
    changed: context.params.get('changed') ?? new Date().toISOString(),
  });
  return respond(context, null);
}

const stateEndpoints = { getBookmarks, createBookmark, deleteBookmark, getPlayQueue, savePlayQueue };

export { stateEndpoints, getBookmarks, createBookmark, deleteBookmark, getPlayQueue, savePlayQueue };

export {ErrorCode, SubsonicError} from '@edge-sonic/subsonic';