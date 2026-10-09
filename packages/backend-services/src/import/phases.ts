/**
 * The import phases.
 *
 * ### Every write is idempotent, because every step is retried
 *
 * A Cloudflare Workflow caches a step by name and re-runs it after a fault, so each phase
 * here must be safe to run twice. Three mechanisms, and each is the *right* one for its table
 * rather than a general "make it idempotent" wrapper:
 *
 * - **Playlists** take a derived id (`UUIDUtil.deterministicId`) and rewrite their entries
 *   wholesale, so a retry lands on the same playlist rather than a second one.
 * - **Stars, ratings and bookmarks** are `INSERT OR REPLACE` on `(user_id, item_id, type)`,
 *   which is what the protocol's own paths already do. A retry overwrites the same row.
 * - **The play queue** replaces wholesale, because the protocol has no partial update — the
 *   same reason `savePlayQueue` deletes before inserting.
 *
 * ### A star's timestamp is preserved, and that is a decision
 *
 * `stars.starred_at` is a sort key — `getStarred` orders by it — so a retry that stamped
 * `nowSeconds()` again would move every star to the top of the list. The phase therefore
 * stamps the **remote's** `starred` instant when it publishes one and only falls back to now.
 *
 * ### Rows are counted from the DAOs, not estimated
 *
 * `rowsWritten` comes from `WriteBatchResult`. Since 2026-09-01 an account over D1's 5,000
 * rows/day has *every* query fail until midnight UTC, so an estimate is a phase spending the
 * next writer's budget without knowing it.
 *
 * ### A write with no partial form refuses rather than truncating
 *
 * A playlist written halfway is a **shorter** playlist — a wrong answer rather than an
 * unfinished one, and indistinguishable from one the user deliberately trimmed.
 * `replaceEntries` already passes `requireComplete` and raises a `413`; that propagates rather
 * than being caught, because a phase that swallowed it would report success over a short
 * playlist.
 */
import { UUIDUtil } from '@edge-sonic/shared/utils';
import type { LibraryScope } from '@edge-sonic/backend-data/dao';
import { matchRemoteSongs } from './matchRemoteIds';
import { authorizedSongIds, toCandidate, unresolvedFor } from './phaseShared';
import { phase } from './report';
import type { PhaseStore } from './phaseShared';
import type { PhaseReport, UnresolvedItem } from './report';
import type { RemoteSong, RemoteSubsonicClient } from './remoteClient';

/**
How an album's remote identity becomes a local one, supplied by the composition root.
*/
type AlbumMatcher = (
  libraryId: LibraryScope,
  albums: ReadonlyArray<{ id: string; name: string | null; artist: string | null }>,
) => Promise<Map<string, string>>;

/**
How an artist's remote identity becomes a local one.
*/
type ArtistMatcher = (libraryId: LibraryScope, artists: ReadonlyArray<{ id: string; name: string | null }>) => Promise<Map<string, string>>;

interface PhaseContext {
  readonly runId: string;
  readonly userId: string;
  /**
   * The libraries a foreign id may resolve against — **every** one the target user was
   * granted, not the first.
   *
   * A list because a scope is what every lookup is scoped to, and because a user with two
   * libraries is not a user with a preference between them: a track in the second was reported
   * `not-found` and the operator sent to re-index a library that already held it. One element
   * is the single-library case, so a caller that genuinely wants one passes one.
   */
  readonly libraryId: LibraryScope;
  readonly store: PhaseStore;
  readonly remote: RemoteSubsonicClient;
  readonly matchAlbum: AlbumMatcher;
  readonly matchArtist: ArtistMatcher;
  /**
  Page size for the play-count walk's album enumeration.
  */
  readonly albumPageSize: number;
}

/**
 * Playlists.
 *
 * The highest-value phase and the largest by rows: 30 playlists of 100 tracks is ~3,000 rows,
 * which is most of a Free account's daily allowance. So the entries are written through
 * `replacePlaylistEntries`, which **refuses** rather than truncating.
 *
 * One `step.do` per playlist rather than one per phase, because a step is the unit the
 * Workflow caches and retries: a 30-playlist phase as one step would re-fetch and re-write all
 * thirty when the twenty-ninth failed, spending the allowance twice over for the first twenty-eight.
 */
async function runPlaylistsPhase(context: PhaseContext, remotePlaylistId: string): Promise<PhaseReport> {
  const { store, remote, userId, runId, libraryId } = context;
  const summary = (await remote.getPlaylists()).find((playlist) => playlist.id === remotePlaylistId);
  const name = summary?.name ?? 'Untitled playlist';
  const songs = await remote.getPlaylist(remotePlaylistId);

  // A playlist with nothing in it is imported as an **empty** playlist rather than skipped.
  // The remote says it exists; an operator who can see it on the other server and not here
  // would conclude the import dropped it, and an empty playlist is the truthful answer.
  const outcomes = songs.length === 0 ? [] : await matchRemoteSongs(store, libraryId, songs.map(toCandidate));
  const granted = await store.grantedLibraryIds(userId);
  const candidateIds = outcomes.flatMap((outcome) => (outcome.songId === null ? [] : [outcome.songId]));
  const permitted = await authorizedSongIds(store, granted, candidateIds);

  // The caller's order, filtered through the resolved set — **not** the matcher's order. A
  // playlist whose sequence reshuffles is worse than no playlist, and the same reason
  // `listIdsIn` re-establishes the caller's order after a chunked `IN`.
  const resolvedIds = outcomes.flatMap((outcome) => (outcome.songId !== null && permitted.has(outcome.songId) ? [outcome.songId] : []));
  const rows = await store.songsByIds(resolvedIds);
  const duration = rows.reduce((total, row) => total + row.duration, 0);

  // Derived, so a retried step rewrites this playlist rather than creating a second one.
  const playlistId = await UUIDUtil.deterministicId('edge-sonic:import:playlist', runId, remotePlaylistId);
  await store.createPlaylistWithId({
    id: playlistId,
    ownerUserId: userId,
    name,
    comment: summary?.comment ?? null,
    // A public playlist on the remote has no meaning here: this server's visibility is by
    // grant, and importing `public: true` would publish a private server's playlist to every
    // user of this one. Private is the only safe reading, and it is reversible afterwards.
    isPublic: false,
    // The remote's own timestamp when it published one, so "added on" does not drift forward
    // by however many times the step ran.
    createdAt: Date.now(),
  });
  const written = await store.replacePlaylistEntries(playlistId, resolvedIds, duration);

  const unresolved = unresolvedFor(songs, outcomes, 'playlist', name);
  const droppedForPermission = outcomes.filter((outcome) => outcome.songId !== null && !permitted.has(outcome.songId)).length;
  return phase({
    phase: `playlists:${name}`,
    status: unresolved.length === 0 ? 'imported' : 'partial',
    imported: resolvedIds.length,
    rowsWritten: written.written + 1,
    unresolved,
    unresolvedCount: unresolved.length + droppedForPermission,
    lastError: droppedForPermission > 0 ? `${droppedForPermission} matched a library this user cannot see, so it was not written.` : null,
  });
}

/**
 * Stars and ratings, from one `getStarred2`.
 *
 * Ratings ride along because `userRating` is an attribute on the same songs, and there is no
 * `getRatings` in the protocol — so a separate phase would be a second fetch for data already
 * in hand. They are reported as **separate lines** anyway: a partial failure has to be
 * attributable to one of them, and "0 ratings" must not be readable as "the phase was skipped".
 *
 * Album and artist stars are translated through the album key and the artist grouping rather
 * than by any local convention of their own, so a star lands on the album `getAlbum` can
 * resolve — a star on an id nothing else can read is invisible to every client.
 */
async function runStarsPhase(context: PhaseContext): Promise<PhaseReport> {
  const { store, remote, userId, libraryId, matchAlbum, matchArtist } = context;
  const { songs, albums, artists } = await remote.getStarred();
  const granted = await store.grantedLibraryIds(userId);

  const songOutcomes = songs.length === 0 ? [] : await matchRemoteSongs(store, libraryId, songs.map(toCandidate));
  const songIds = songOutcomes.flatMap((outcome) => (outcome.songId === null ? [] : [outcome.songId]));
  const permittedSongs = await authorizedSongIds(store, granted, songIds);

  // The remote's `starred` instant, parsed to epoch seconds. Preserved so a retried step does
  // not re-stamp every star and reorder the whole favourites list.
  let imported = 0;
  let rowsWritten = 0;
  const starredAt = (song: RemoteSong): number => {
    const parsed = song.starred === null ? NaN : Date.parse(song.starred);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
  };

  for (const outcome of songOutcomes) {
    if (outcome.songId === null || !permittedSongs.has(outcome.songId)) continue;
    const song = songs.find((candidate) => candidate.id === outcome.remoteId);
    if (!song) continue;
    const star = await store.upsertStar({ userId, itemId: outcome.songId, itemType: 'song', starredAt: starredAt(song) });
    rowsWritten += star.written;
    imported += 1;

    // Ratings only where the remote published one, and only within 1..5 as the protocol declares.
    // A rating of 0 means "unrated" on the wire, so writing it would create a row `getStarred2`
    // then publishes as a rating — a rating the user never gave.
    const rating = song.userRating;
    if (rating === null || rating < 1 || rating > 5) continue;
    const written = await store.upsertRating({ userId, itemId: outcome.songId, itemType: 'song', rating });
    rowsWritten += written.written;
  }

  const albumMap = await matchAlbum(libraryId, albums);
  for (const album of albums) {
    const localId = albumMap.get(album.id);
    if (localId === undefined) continue;
    const star = await store.upsertStar({
      userId,
      itemId: localId,
      itemType: 'album',
      starredAt: starredAt({ starred: null } as RemoteSong),
    });
    rowsWritten += star.written;
    imported += 1;
  }

  const artistMap = await matchArtist(libraryId, artists);
  for (const artist of artists) {
    const localId = artistMap.get(artist.id);
    if (localId === undefined) continue;
    const star = await store.upsertStar({
      userId,
      itemId: localId,
      itemType: 'artist',
      starredAt: starredAt({ starred: null } as RemoteSong),
    });
    rowsWritten += star.written;
    imported += 1;
  }

  const unresolved: UnresolvedItem[] = [
    ...unresolvedFor(songs, songOutcomes, 'star', 'starred'),
    ...albums
      .filter((album) => !albumMap.has(album.id))
      .map((album) => ({
        category: 'star',
        context: 'starred album',
        remoteId: album.id,
        label: `${album.artist ?? 'Unknown artist'} — ${album.name ?? album.id}`,
        reason: 'not-found' as const,
      })),
    ...artists
      .filter((artist) => !artistMap.has(artist.id))
      .map((artist) => ({
        category: 'star',
        context: 'starred artist',
        remoteId: artist.id,
        label: artist.name ?? artist.id,
        reason: 'not-found' as const,
      })),
  ];

  return phase({
    phase: 'stars',
    status: unresolved.length === 0 ? 'imported' : 'partial',
    imported,
    rowsWritten,
    unresolved,
    unresolvedCount: unresolved.length,
    lastError: null,
  });
}

/**
Bookmarks: one remote call, one upsert per bookmark.
*/
async function runBookmarksPhase(context: PhaseContext): Promise<PhaseReport> {
  const { store, remote, userId, libraryId } = context;
  const bookmarks = await remote.getBookmarks();
  if (bookmarks.length === 0) return phase({ phase: 'bookmarks', status: 'imported' });

  const outcomes = await matchRemoteSongs(
    store,
    libraryId,
    bookmarks.map((bookmark) => toCandidate(bookmark.song)),
  );
  const granted = await store.grantedLibraryIds(userId);
  const songIds = outcomes.flatMap((outcome) => (outcome.songId === null ? [] : [outcome.songId]));
  const permitted = await authorizedSongIds(store, granted, songIds);

  let imported = 0;
  let rowsWritten = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.songId === null || !permitted.has(outcome.songId)) continue;
    const bookmark = bookmarks[index];
    const written = await store.upsertBookmark({
      userId,
      songId: outcome.songId,
      // A bookmark's position is playback progress. A remote that omits it reported "the
      // beginning", and writing 0 is the truthful answer — an invented position would send a
      // client resuming mid-track with no reason why.
      positionMs: bookmark.positionMs ?? 0,
      comment: bookmark.comment,
    });
    rowsWritten += written.written;
    imported += 1;
  }

  const unresolved = unresolvedFor(
    bookmarks.map((bookmark) => bookmark.song),
    outcomes,
    'bookmark',
    'bookmarks',
  );
  return phase({
    phase: 'bookmarks',
    status: unresolved.length === 0 ? 'imported' : 'partial',
    imported,
    rowsWritten,
    unresolved,
    unresolvedCount: unresolved.length,
    lastError: null,
  });
}

/**
 * The play queue.
 *
 * **Opt-in, and the workflow skips it unless asked.** A saved queue is transient state: the
 * person who has just migrated does not want yesterday's half-finished queue restored, and a
 * default-on would import it without anybody deciding to.
 *
 * Replaced wholesale, matching `savePlayQueue`'s own reason: the protocol has no partial
 * update, so the remote's list is the whole list.
 */
async function runPlayQueuePhase(context: PhaseContext): Promise<PhaseReport> {
  const { store, remote, userId, libraryId } = context;
  const queue = await remote.getPlayQueue();
  if (queue.entries.length === 0) return phase({ phase: 'playQueue', status: 'imported' });

  // Ordered by `position` rather than by arrival. The field is a **string** on the wire for some
  // servers and a number for others, so it is parsed above; and a server that omits it entirely
  // answers `null`, which sorts **last** rather than first — an entry with no position keeps its
  // relative arrival order among the others, and does not jump to the head of the queue.
  const ordered = [...queue.entries].sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  // Matched on the entry's `Child`, which is what makes the path strategy available here — the
  // same strategy the playlist phase uses, for the same reason.
  const outcomes = await matchRemoteSongs(
    store,
    libraryId,
    ordered.map((entry) => toCandidate(entry.song)),
  );
  const granted = await store.grantedLibraryIds(userId);
  const songIds = outcomes.flatMap((outcome) => (outcome.songId === null ? [] : [outcome.songId]));
  const permitted = await authorizedSongIds(store, granted, songIds);

  const resolvedIds = outcomes.flatMap((outcome) => (outcome.songId !== null && permitted.has(outcome.songId) ? [outcome.songId] : []));
  const currentLocal = outcomes.find((outcome) => outcome.remoteId === queue.currentId)?.songId ?? null;
  const written = await store.savePlayQueue({
    userId,
    songIds: resolvedIds,
    currentSongId: currentLocal !== null && permitted.has(currentLocal) ? currentLocal : null,
    positionMs: queue.positionMs ?? 0,
    // The remote's own `changed`, when it published one, so a client resuming a queue is not
    // told it changed a second ago because of an import.
    changed: new Date().toISOString(),
  });

  // Named by the track, not by the id: an operator cannot look up an opaque remote id, and a
  // queue that lost three tracks is a queue that resumes from the wrong place.
  const unresolved = unresolvedFor(
    ordered.map((entry) => entry.song),
    outcomes,
    'playQueue',
    'play queue',
  );

  return phase({
    phase: 'playQueue',
    status: unresolved.length === 0 ? 'imported' : 'partial',
    imported: resolvedIds.length,
    rowsWritten: written.written,
    unresolved,
    unresolvedCount: unresolved.length,
    lastError: null,
  });
}

export { runPlaylistsPhase, runStarsPhase, runBookmarksPhase, runPlayQueuePhase };
export type { PhaseContext, AlbumMatcher, ArtistMatcher };
