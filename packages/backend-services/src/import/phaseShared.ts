/**
 * The pieces every phase needs, and the two decisions they encode.
 *
 * ### Why these are not inline in each phase
 *
 * `narrow the resolved ids to the grants` and `name everything that did not resolve` are
 * **decisions**, and a decision written out four times is four chances to write it differently.
 * Both are load-bearing in a way that is invisible when they agree:
 *
 * - a phase that forgot the grant filter would write a star onto a track in a library its target
 *   user was never granted, and `getStarred` would publish it to them — an authorization
 *   failure with no error anywhere;
 * - a phase that reported only a *count* of unresolved items would be indistinguishable from one
 *   that dropped nothing, which is the failure the whole report exists to make visible.
 *
 * ### And they are here rather than in `phases.ts` because both phase files need them
 *
 * The play-count walk is a second file with its own budget and its own caller, and re-exporting
 * them from `phases.ts` would make one of the two files the place to look for a thing both own —
 * which is the inverse of the split and re-creates the god file the split removed.
 */
import type { MatchCandidate, MatchOutcome, MatchStore } from './matchRemoteIds';
import type { RemoteSong } from './remoteClient';
import type { UnresolvedItem } from './report';

interface PhaseStore extends MatchStore {
  /**
   * The libraries the target user may see. An import must not write outside them — it widens the
   * **lookup**, because a song id may belong to any library, and never the **permission**.
   */
  grantedLibraryIds(userId: string): Promise<ReadonlySet<string>>;
  /**
  Rows for resolved ids, in the caller's order, so a playlist's sequence survives.
  */
  songsByIds(ids: readonly string[]): Promise<ReadonlyArray<{ readonly id: string; readonly library_id: string; readonly duration: number }>>;
  findPlaylistById(id: string): Promise<{ readonly id: string } | null>;
  createPlaylistWithId(input: {
    id: string;
    ownerUserId: string;
    name: string;
    comment: string | null;
    isPublic: boolean;
    createdAt: number;
  }): Promise<void>;
  replacePlaylistEntries(playlistId: string, songIds: readonly string[], totalDuration: number): Promise<{ readonly written: number }>;
  /**
   * One per `(user, item, type)`.
   *
   * `starredAt` is **passed through** rather than defaulted by the store, because
   * `stars.starred_at` is a sort key — `getStarred` orders by it — so a store that stamped the
   * clock per item would move every star it touched to the top of the list in import order.
   */
  upsertStar(input: { userId: string; itemId: string; itemType: 'song' | 'album' | 'artist'; starredAt: number }): Promise<{ readonly written: number }>;
  upsertRating(input: { userId: string; itemId: string; itemType: 'song' | 'album' | 'artist'; rating: number }): Promise<{ readonly written: number }>;
  upsertBookmark(input: { userId: string; songId: string; positionMs: number; comment: string | null }): Promise<{ readonly written: number }>;
  savePlayQueue(input: { userId: string; songIds: readonly string[]; currentSongId: string | null; positionMs: number; changed: string }): Promise<{ readonly written: number }>;
  setPlayCounts(input: { userId: string; counts: ReadonlyArray<{ readonly songId: string; readonly playCount: number }> }): Promise<{ readonly written: number }>;
}

/**
A remote song reduced to a match candidate.
*/
function toCandidate(song: RemoteSong): MatchCandidate {
  return {
    remoteId: song.id,
    path: song.path,
    artist: song.artist,
    album: song.album,
    title: song.title,
    discNumber: song.discNumber,
    track: song.track,
  };
}

/**
What to call an item in the report — the name a person would recognise.
*/
function labelOf(song: RemoteSong): string {
  const parts = [song.title, song.artist, song.album].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join(' — ') : song.id;
}

function unresolvedFor(songs: readonly RemoteSong[], outcomes: readonly MatchOutcome[], category: string, context: string): UnresolvedItem[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.remoteId, outcome]));
  return songs
    .filter((song) => byId.get(song.id)?.songId === null)
    .map((song) => {
      const outcome = byId.get(song.id);
      return {
        category,
        context,
        remoteId: song.id,
        label: labelOf(song),
        // A remote song with neither a path nor an album/title pair cannot be matched by any
        // strategy, which is a different problem from "we looked and it is not here".
        reason: outcome?.reason ?? 'not-found',
      } satisfies UnresolvedItem;
    });
}

/**
 * Keep only the ids the target user is allowed to see.
 *
 * An import widens the *lookup* — a song id may belong to any library — but never the
 * *permission*. Without this filter an import would happily write a star onto a track in a
 * library its target user was never granted, and `getStarred` would publish it to them.
 */
function authorizedSongIds(
  store: PhaseStore,
  granted: ReadonlySet<string>,
  ids: readonly string[],
): Promise<Set<string>> {
  return store.songsByIds(ids).then((rows) => new Set(rows.filter((row) => granted.has(row.library_id)).map((row) => row.id)));
}
export { toCandidate, labelOf, unresolvedFor, authorizedSongIds };
export type { PhaseStore };
