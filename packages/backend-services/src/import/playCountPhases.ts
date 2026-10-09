/**
 * The play-count walk, one album and one page at a time.
 *
 * ### Why these two are not with the other phases
 *
 * Because they are the **only** phases here that are not bounded by a Workflow step.
 *
 * There is no `getPlayCounts` in Subsonic or OpenSubsonic — `playCount` is an *attribute on a
 * song* — so the only way to read them off another server is to enumerate its albums and fetch
 * each one. That is ~1 remote call per album, and Workflows Free allows **1,024 steps per
 * instance** at 10 ms of CPU each: an 80-album library fits and a 2,000-album one does not
 * complete. So this runs in `PlayCountImportWorker`, alarm-chained, and gets a **fresh
 * 50-subrequest external budget per alarm** — which is what makes an unbounded walk possible at
 * all. See `docs/issues/subrequest-budgets-are-two-not-one.md` for the measurement.
 *
 * ### `playCount` is written as an **absolute** value, never added
 *
 * `recordPlay` increments, and correctly — a scrobble *is* an event. An import is not a scrobble:
 * it is the current count read off another server. Adding would inflate every count by however
 * many times the step ran, and unlike a playlist there is **no observable difference** between
 * "played twice" and "imported twice" — which is exactly why this cannot be left to a retry.
 */

import { matchRemoteSongs } from './matchRemoteIds';
import { authorizedSongIds, toCandidate, unresolvedFor } from './phaseShared';
import { phase } from './report';

import type { PhaseContext } from './phases';
import type { PhaseReport } from './report';

/**
 * **One** album of the play-count walk.
 *
 * The Durable Object walks album by album without
 * re-fetching the enumeration for each one — the page phase is a *loop* over this, so both
 * callers issue the same work rather than two implementations of it.
 *
 * `playCount` is written as an **absolute** value, never added to the existing one. A retry that
 * re-imported an album and *added* to a count already set would inflate every play count in the
 * library by however many times the step ran — and unlike a playlist, there is no observable
 * difference between "played twice" and "imported twice".
 *
 * An album with **no** counted song is a success with nothing imported, not a failure: most
 * albums nobody has played are the common case, and a remote that reported `playCount: 0` for
 * every track is saying the truth about a library nobody listens to.
 */
async function runPlayCountAlbumPhase(
  context: PhaseContext,
  album: { readonly id: string; readonly name: string | null },
): Promise<PhaseReport> {
  const { store, remote, userId, libraryId } = context;
  const songs = await remote.getAlbumSongs(album.id);
  const withCounts = songs.filter((song) => song.playCount !== null && song.playCount > 0);
  if (withCounts.length === 0) return phase({ phase: `playCounts:album:${album.name ?? album.id}`, status: 'imported' });

  const outcomes = await matchRemoteSongs(store, libraryId, withCounts.map(toCandidate));
  const granted = await store.grantedLibraryIds(userId);
  const songIds = outcomes.flatMap((outcome) => (outcome.songId === null ? [] : [outcome.songId]));
  const permitted = await authorizedSongIds(store, granted, songIds);

  const counts = outcomes.flatMap((outcome) => {
    if (outcome.songId === null || !permitted.has(outcome.songId)) return [];
    const song = withCounts.find((candidate) => candidate.id === outcome.remoteId);
    if (song?.playCount === null || song?.playCount === undefined) return [];
    return [{ songId: outcome.songId, playCount: song.playCount }];
  });

  const unresolved = unresolvedFor(withCounts, outcomes, 'playCount', album.name ?? album.id);
  if (counts.length === 0) {
    return phase({
      phase: `playCounts:album:${album.name ?? album.id}`,
      status: unresolved.length === 0 ? 'imported' : 'partial',
      unresolved,
      unresolvedCount: unresolved.length,
      lastError: unresolved.length === 0 ? null : "None of this album's counted tracks resolved to a local song.",
    });
  }

  const written = await store.setPlayCounts({ userId, counts });
  return phase({
    phase: `playCounts:album:${album.name ?? album.id}`,
    status: unresolved.length === 0 ? 'imported' : 'partial',
    imported: counts.length,
    rowsWritten: written.written,
    unresolved,
    unresolvedCount: unresolved.length,
    lastError: null,
  });
}

export { runPlayCountAlbumPhase };
