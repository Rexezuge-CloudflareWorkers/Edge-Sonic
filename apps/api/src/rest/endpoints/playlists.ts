/**
 * Playlists: `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`,
 * `deletePlaylist`.
 *
 * Playlists are the one feature with **no WebDAV representation** — a filesystem
 * cannot express an ordered, named, per-user list of songs that may live in
 * different folders — so they live in D1 and nowhere else.
 *
 * ### `songIndexToRemove` is addressed by position
 *
 * Removing "the song at index 3" from a list whose positions shift as you delete is
 * order-dependent, and the protocol does not say in which order a client sends
 * multiple `songIndexToRemove` parameters. So the DAO removes **highest index
 * first**, which makes the result identical regardless of the order received.
 */
import { elList, ErrorCode, playlistElement, songElement, SubsonicError, successResponse } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { PlaylistRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { songToModel } from '../mappers';
import { annotationsFor } from './structured';

type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

function isoOrUndefined(epochSeconds: number): string | undefined {
  return epochSeconds > 0 ? new Date(epochSeconds * 1000).toISOString() : undefined;
}

function toPlaylistModel(playlist: PlaylistRow, ownerUsername: string) {
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment ?? undefined,
    owner: ownerUsername,
    isPublic: playlist.is_public === 1,
    songCount: playlist.song_count,
    duration: playlist.duration,
    created: isoOrUndefined(playlist.created_at),
    changed: isoOrUndefined(playlist.updated_at),
  };
}

/**
 * A playlist the caller may read.
 *
 * A private playlist belonging to somebody else is reported as **not found**, not
 * as "forbidden" — `code=50` would confirm the playlist exists, turning the id
 * space into an oracle for other users' private playlists.
 */
async function requireVisible(context: RestContext, id: string): Promise<PlaylistRow> {
  const playlist = await context.playlists.findById(id);
  if (!playlist) throw new SubsonicError(ErrorCode.NotFound, 'Playlist not found.');
  const owned = playlist.owner_user_id === context.user.id;
  if (!owned && playlist.is_public !== 1) throw new SubsonicError(ErrorCode.NotFound, 'Playlist not found.');
  return playlist;
}

/**
Only the owner may mutate a playlist. `code=50` here is correct and safe.
*/
function requireOwner(context: RestContext, playlist: PlaylistRow): void {
  if (playlist.owner_user_id !== context.user.id) {
    throw new SubsonicError(ErrorCode.NotAuthorized, 'Only the owner may modify this playlist.');
  }
}

async function getPlaylists(context: RestContext): Promise<EnvelopeResponse> {
  const requested = context.params.get('username');
  // Asking for another user's playlists requires the admin role, per the spec.
  if (requested !== undefined && requested.toLowerCase() !== context.username.toLowerCase() && context.user.is_admin !== 1) {
    throw new SubsonicError(ErrorCode.NotAuthorized, "Only an admin may list another user's playlists.");
  }
  const playlists = await context.playlists.listVisible(context.user.id);
  return respond(context, elList('playlists', 'playlist', {}, playlists.map((playlist) => playlistElement(toPlaylistModel(playlist, context.username)))));
}

/**
 * `getPlaylist` — entries in playlist order.
 *
 * `listEntrySongs` already joins and orders by position, so the only work here is
 * dropping entries the caller may not see. An entry whose song is gone is dropped
 * too: a client cannot play an entry it cannot resolve, and reporting a count that
 * includes unplayable rows makes the client's progress bar lie.
 */
/**
 * Render a playlist, resolving its songs.
 *
 * Split out because `createPlaylist` and `getPlaylist` both need it and neither can
 * reach the other through the dispatcher: a create request has no `id` parameter, so
 * re-deriving the playlist from the request answers `code=10` for a call that
 * succeeded — the client gets a failure for a playlist that was actually written.
 */
async function respondWithPlaylist(context: RestContext, playlist: PlaylistRow): Promise<EnvelopeResponse> {
  const library = await resolvePlaylistLibrary(context);
  if (library === null) throw new SubsonicError(ErrorCode.NotFound, 'No library is available for this playlist.');

  const joined = await context.playlists.listEntrySongs(playlist.id);
  const rows = joined.filter((song) => song.library_id === library.id);
  const annotations = await annotationsFor(context, rows.map((song) => song.id));

  // The protocol names a playlist's songs `entry`, not `song`. Both spellings appear
  // in the wild, but `entry` is what the schema specifies and what every client
  // documents — a client reading `playlist.entry` gets nothing at all from
  // `playlist.song`, and a client reading `playlist.song` on a one-entry playlist gets
  // an object rather than an array. So the element is renamed here rather than
  // duplicating the whole song attribute set in `builders.ts`.
  return respond(
    context,
    {
      ...playlistElement(toPlaylistModel(playlist, context.username)),
      children: rows.map((song) => ({ ...songElement(songToModel(song, library, annotations)), name: 'entry', array: true as const })),
      listKey: 'entry',
    },
  );
}

async function getPlaylist(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  return await respondWithPlaylist(context, await requireVisible(context, id));
}

async function resolvePlaylistLibrary(context: RestContext) {
  const libraries = await context.libraries.listForUser(context.user.id);
  return libraries.length > 0 ? libraries[0] : null;
}

/**
Resolve the song ids a client asked for, filtered to the caller's library.
*/
async function resolveSongIds(context: RestContext, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const library = await resolvePlaylistLibrary(context);
  if (library === null) return [];
  const rows = await context.songs.listIdsIn(library.id, ids);
  const found = new Set(rows.map((row) => row.id));
  // Preserve the client's order. `listIdsIn` batches with `IN (...)` and SQLite
  // does not promise result order, so filtering the caller's list is what keeps
  // a playlist's sequence intact.
  return ids.filter((songId) => found.has(songId));
}

async function totalDurationOf(context: RestContext, ids: readonly string[]): Promise<number> {
  const library = await resolvePlaylistLibrary(context);
  if (library === null) return 0;
  const rows = await context.songs.listIdsIn(library.id, ids);
  return rows.reduce((total, row) => total + row.duration, 0);
}

/**
 * `createPlaylist` — creates, or replaces the entries of an existing one.
 *
 * The spec allows `createPlaylist` to act as an update when `playlistId` is given,
 * and several clients use it that way instead of calling `updatePlaylist`. Since
 * 1.14.0 the created playlist is returned, so that is what this does.
 */
async function createPlaylist(context: RestContext): Promise<EnvelopeResponse> {
  const existingId = context.params.get('playlistId');
  const songIds = context.params.ids('songId');
  const name = context.params.get('name');

  if (existingId !== undefined) {
    const playlist = await requireVisible(context, existingId);
    requireOwner(context, playlist);
    const resolved = await resolveSongIds(context, songIds);
    await context.playlists.replaceEntries(playlist.id, resolved, await totalDurationOf(context, resolved));
    // Re-read: `replaceEntries` recomputes `song_count` and `duration` in the
    // database, and the row in hand still carries the pre-update totals. A client
    // rendering a progress bar from them would show 0 of 12.
    return await respondWithPlaylist(context, (await context.playlists.findById(playlist.id)) ?? playlist);
  }

  if (name === undefined || name.trim().length === 0) {
    throw new SubsonicError(ErrorCode.MissingParameter, 'Required parameter is missing: name');
  }
  const created = await context.playlists.create({
    ownerUserId: context.user.id,
    name: name.trim(),
    comment: context.params.get('comment') ?? null,
    isPublic: context.params.bool('public', false),
  });
  if (songIds.length > 0) {
    const resolved = await resolveSongIds(context, songIds);
    await context.playlists.replaceEntries(created.id, resolved, await totalDurationOf(context, resolved));
    return await respondWithPlaylist(context, (await context.playlists.findById(created.id)) ?? created);
  }
  return await respondWithPlaylist(context, created);
}

/**
 * `updatePlaylist` — the three-way partial update.
 *
 * Renames, adds, and removes are applied in that order, and removals are
 * position-based against the **pre-update** list, which is why they are collected
 * before the add and applied after it inside the DAO's highest-first ordering.
 */
async function updatePlaylist(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('playlistId');
  const playlist = await requireVisible(context, id);
  requireOwner(context, playlist);

  const name = context.params.get('name');
  const comment = context.params.get('comment');
  const isPublic = context.params.has('public') ? context.params.bool('public', false) : undefined;
  if (name !== undefined || comment !== undefined || isPublic !== undefined) {
    await context.playlists.updateMeta(playlist.id, {
      ...((name !== undefined) && { name: name.trim() }),
      ...((comment !== undefined) && { comment }),
      ...((isPublic !== undefined) && { isPublic }),
    });
  }

  const toAdd = context.params.ids('songIdToAdd');
  if (toAdd.length > 0) {
    await context.playlists.appendEntries(playlist.id, await resolveSongIds(context, toAdd));
  }

  // `songIndexToRemove` is `Int` in some client schemas and a repeated string in
  // others, so both spellings are read. The DAO sorts descending, so the order the
  // client sent them in does not matter.
  const rawRemovals = [
    ...context.params.getAll('songIndexToRemove'),
    ...context.params.getAll('songIndexToRemove[]'),
  ];
  const positions = rawRemovals
    .flatMap((value) => value.split(','))
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0);
  if (positions.length > 0) {
    await context.playlists.removeEntriesAt(playlist.id, positions);
  }

  return respond(context, null);
}

async function deletePlaylist(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const playlist = await requireVisible(context, id);
  requireOwner(context, playlist);
  await context.playlists.delete(playlist.id);
  return respond(context, null);
}

const playlistEndpoints = { getPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist };

export { playlistEndpoints, getPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist };
