/**
 * `@edge-sonic/backend-services/import` — bringing a user's player data in from another
 * Subsonic server.
 *
 * ### Why this is a feature and not a migration script
 *
 * WebDAV stays the only origin for **music**. Everything imported here is state that exists
 * nowhere but in a database: playlists, stars, ratings, bookmarks, a play queue, play counts.
 * There is no file representation of a favourite, so this has to travel over the protocol
 * rather than be copied off a filesystem — and it has to *reconcile* rather than copy, because
 * a foreign song id means nothing here.
 *
 * ### The module split, and why each file is its own answer
 *
 * | File | Owns |
 * | --- | --- |
 * | `remoteOrigin` | the SSRF gate on an operator-supplied host |
 * | `remoteClient` | speaking `/rest` to a server this repository does not control |
 * | `matchRemoteIds` | turning a foreign id into a local one |
 * | `phases` | what each category does, and what it could not do |
 * | `report` | the named list of everything that did not resolve |
 * | `importPause` | refusing to run beside a scan |
 *
 * ### The invariant the whole module exists to hold
 *
 * **An unresolved id is reported, never substituted, and never silently dropped.** Every
 * phase returns the *named* items it could not match, with the reason. A playlist that lost
 * three tracks is a wrong answer rather than an unfinished one, and it is indistinguishable
 * from one the user deliberately shortened — so the operator gets a list rather than a count.
 */
// One import for "talk to a remote Subsonic server": the transport here, the parse rules
// re-exported from it so a caller cannot reach a second answer about how a collapsed list is read.
export { RemoteSubsonicClient, RemoteSubsonicError, unwrapEnvelope, asArray } from './remoteClient';
export type { RemoteSubsonicClientOptions, RemoteSong, RemoteAlbum, RemoteArtist, RemotePlaylist, RemoteBookmark, RemoteQueueEntry } from './remoteClient';
export { ImportSourceService } from './sourceService';
export type { SourceStore } from './sourceService';
export { ci, albumKeyFor, resolveGrouping, matchRemoteAlbums, matchRemoteArtists } from './albumIdentity';
export type { AlbumMatchStore } from './albumIdentity';
export { normalizeRemoteBaseUrl, normalizeMountPath, normalizeSourceName, normalizeRemoteUsername, assertRemoteReachable } from './remoteOrigin';
export { matchRemoteSongs, metadataKeyOf, narrow } from './matchRemoteIds';
export { runPlaylistsPhase, runStarsPhase, runBookmarksPhase, runPlayQueuePhase } from './phases';
export { runPlayCountAlbumPhase, runPlayCountPagePhase } from './playCountPhases';
export { toCandidate, labelOf, unresolvedFor, authorizedSongIds } from './phaseShared';
export { buildReport, collectUnresolved, parseReport, phase, serializeReport, MAX_REPORTED_UNRESOLVED } from './report';
export { assertScansIdle, importDailyRowBudget, isImportInFlight, SCANNING_STATUSES } from './importPause';
// The phase vocabulary is a **closed set the server validates against**, so it belongs beside the
// phases that consume it. Re-exported rather than imported from `backend-data` because
// `apps/api` may not import that package's values at all — and the route that validates an
// operator's `phases` array needs the exact list it refuses anything outside of.
export { IMPORT_PHASES } from '@edge-sonic/backend-data/dao';
export type { ImportPhase } from '@edge-sonic/backend-data/dao';
export type { MatchCandidate, MatchOutcome, MatchStore } from './matchRemoteIds';
export type { ImportReport, PhaseReport, UnresolvedItem } from './report';
export type { PhaseContext, AlbumMatcher, ArtistMatcher } from './phases';
export type { PhaseStore } from './phaseShared';