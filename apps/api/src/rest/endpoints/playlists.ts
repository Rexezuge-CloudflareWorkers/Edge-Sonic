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
import { elList, ErrorCode, legacySongId, playlistElement, songElement, SubsonicError } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { PlaylistRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { songToModel, toIso } from '../mappers';
import { annotationsFor } from './structured';

function toPlaylistModel(playlist: PlaylistRow, ownerUsername: string) {
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment ?? undefined,
    owner: ownerUsername,
    isPublic: playlist.is_public === 1,
    songCount: playlist.song_count,
    duration: playlist.duration,
    created: toIso(playlist.created_at),
    changed: toIso(playlist.updated_at),
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

/**
 * A playlist element, with its **owner's** name.
 *
 * `owner` is a name, so it cannot be the caller's by default. `requireVisible`
 * deliberately lets one user read another's public playlist, so publishing
 * `context.username` here reported the *reader* as the owner of a list they had merely been
 * allowed to see — and a client editing that playlist would have written to the wrong
 * user's library.
 *
 * One batched lookup for the whole list rather than one per row: a playlist grid is one
 * request, and an N+1 inside it is unbounded work in a request that has no subrequest
 * ceiling of its own to stop it.
 */
async function playlistElements(context: RestContext, playlists: readonly PlaylistRow[]): Promise<ElementNode[]> {
  const owners = await context.playlists.ownerNamesFor(playlists);
  return playlists.map((playlist) => playlistElement(toPlaylistModel(playlist, owners.get(playlist.owner_user_id) ?? context.username)));
}

async function getPlaylists(context: RestContext): Promise<EnvelopeResponse> {
  const requested = context.params.get('username');
  // The protocol parameter is "returns all playlists for a user", so it is honoured rather
  // than merely **authorized** and dropped. It used to be checked and then ignored:
  // `listVisible(context.user.id)` answered the caller's own playlists plus every public
  // one, so an admin who asked for another user's playlists received their own back and no
  // indication that the parameter had been read.
  const target = requested ?? context.username;
  const isSelf = target.toLowerCase() === context.username.toLowerCase();
  if (!isSelf && context.user.is_admin !== 1) {
    throw new SubsonicError(ErrorCode.NotAuthorized, "Only an admin may list another user's playlists.");
  }

  const playlists = isSelf
    ? await context.playlists.listVisible(context.user.id)
    // A named user's own playlists, and **not** the public ones: `username` asks for one
    // user's playlists, so mixing in every public playlist from every user is a different
            // answer and would make an admin's list grow with the library.
    : await context.playlists.listForOwner(await ownerIdFor(context, target));
  return respond(context, elList('playlists', 'playlist', {}, await playlistElements(context, playlists)));
}

/**
 * The user id for a username, or `code=70`.
 *
 * `code=70` rather than `code=50` for the same reason `requireVisible` uses it: the id
 * space must not become an oracle for which usernames exist.
 */
async function ownerIdFor(context: RestContext, username: string): Promise<string> {
  const user = await context.users.findByUsername(username);
  if (!user) throw new SubsonicError(ErrorCode.NotFound, `No such user: ${username}.`);
  return user.id;
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
  // Every granted library, not `libraries[0]`. A playlist is a **per-user** row whose
  // entries came from whatever libraries that user was granted, so narrowing to one
  // silently dropped every entry from the others: no error, a shorter list, and a playlist
  // that lost songs. `getBookmarks` iterates all libraries and disagreed with both this and
  // `getPlayQueue`.
  const libraries = await context.libraries.listForUser(context.user.id);
  if (libraries.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'No library is available for this playlist.');
  const visible = new Map(libraries.map((library) => [library.id, library]));

  // An entry whose library the owner has since lost the grant to is dropped rather than
  // reported: the playlist is visible, the song outside the caller's grants is not.
  //
  // Resolved entry-by-entry rather than through the entry join: entries written
  // before the short-id rotation hold legacy long ids that no longer match
  // `songs.id`, so the join would drop them and the playlist would come back
  // shorter than it was saved.
  const entries = await context.playlists.listEntries(playlist.id);
  const entryRows = await context.songs.listIdsAcrossLibraries(entries.map((entry) => entry.song_id));
  const rows = entryRows.filter((song) => visible.has(song.library_id));
  const annotations = await annotationsFor(context, rows.length > 0);

  // The protocol names a playlist's songs `entry`, not `song`. Both spellings appear
  // in the wild, but `entry` is what the schema specifies and what every client
  // documents — a client reading `playlist.entry` gets nothing at all from
  // `playlist.song`, and a client reading `playlist.song` on a one-entry playlist gets
  // an object rather than an array. So the element is renamed here rather than
  // duplicating the whole song attribute set in `builders.ts`.
  const [element] = await playlistElements(context, [playlist]);
  return respond(
    context,
    {
      ...element,
      children: rows.map((song) => ({
        ...songElement(songToModel(song, visible.get(song.library_id) as LibraryRow, context.albumsFor(visible.get(song.library_id) as LibraryRow), annotations)),
        name: 'entry',
        array: true as const,
      })),
      listKey: 'entry',
    },
  );
}

async function getPlaylist(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  return await respondWithPlaylist(context, await requireVisible(context, id));
}


/**
 * The song ids a client asked for, filtered to the caller's grants, in the client's order.
 *
 * Across **every** granted library. This resolved `libraries[0]` and looked there, so with
 * two grants the songs in the second were treated as not found: `createPlaylist` wrote a
 * playlist missing half its tracks, and `updatePlaylist` dropped them. Silent — the call
 * succeeded and the id list came back shorter.
 *
 * The client's order is preserved by filtering *their* list rather than the DAO's: `IN
 * (...)` does not promise result order, and a playlist whose sequence is reshuffled is
 * worse than no playlist.
 */
async function resolveSongIds(context: RestContext, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const visible = await grantedLibraryIds(context);
  if (visible.size === 0) return [];
  const rows = await context.songs.listIdsAcrossLibraries(ids);
  // Both forms: a client holding a legacy long id for a rotated row resolves
  // to a short row, so the input matches under the id the row holds now *or*
  // the one it held when the client saw it. Canonical short ids are returned,
  // so a legacy playlist entry migrates on write.
  const found = new Set<string>();
  const canonicalOf = new Map<string, string>();
  for (const row of rows) {
    if (!visible.has(row.library_id)) continue;
    found.add(row.id);
    const legacy = legacySongId(row.library_id, row.path);
    found.add(legacy);
    canonicalOf.set(row.id, row.id);
    canonicalOf.set(legacy, row.id);
  }
  return ids.flatMap((songId) => (found.has(songId) ? [canonicalOf.get(songId)!] : []));
}

/**
 * The caller's granted library ids.
 *
 * An id for a library outside this set resolves to nothing, which is the authorization
 * rule every playlist path needs and the reason the lookup cannot be a plain `IN`.
 */
async function grantedLibraryIds(context: RestContext): Promise<Set<string>> {
  return new Set((await context.libraries.listForUser(context.user.id)).map((library) => library.id));
}

async function totalDurationOf(context: RestContext, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const visible = await grantedLibraryIds(context);
  if (visible.size === 0) return 0;
  const rows = await context.songs.listIdsAcrossLibraries(ids);
  return rows.filter((row) => visible.has(row.library_id)).reduce((total, row) => total + row.duration, 0);
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

export { playlistEndpoints };
