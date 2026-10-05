// DAO barrels. Import from the root barrel, or from a group for readability.
//
// `identity` and the two index DAOs are separate modules because they answer
// different questions — "who is this user and what may they see" versus "what is
// in this library" — and mixing them in one file would produce a module well
// past the god-file limit.
export { BaseDAO } from './BaseDAO';
export { UserDAO, LibraryDAO, nowSeconds } from './identity';
export { NodeDAO } from './NodeDAO';
export type { NodeInput } from './NodeDAO';
export { SongDAO } from './SongDAO';
export { chunkArray } from './chunking';
// The measured ceiling, and the arithmetic every `IN (...)` batch size is derived from.
// Exported because the number is a *platform* fact that keeps being assumed rather than
// read, and a fact that is not reachable from a test cannot be defended.
export { D1_MAX_BIND_PARAMETERS, bindChunkSize } from './sqlLimits';
export type { WriteBatchResult } from './BaseDAO';
// Many rows by id, in the caller's order. Its own class because it is a different-shaped
// question from "one row by id", and because it is the query that had to be batched to
// D1's ceiling — which put `SongDAO` over the god-file limit.
export { SongIdLookupDAO } from './songIdLookup';
export type { SongUpsertInput } from './SongDAO';
export { deriveFromPath, DERIVED_VERSION } from './pathConvention';
export type { DerivedNames } from './pathConvention';
// Provenance of the grouping columns, and why it cannot be a suffix on the value. The
// marker is operator-configurable, and a configured string interpolated into a `LIKE` is
// either a match-all or a wildcard — so the guard is a column.
export { GROUPING_SOURCE_DERIVED } from './groupingSource';
export type { GroupingSource } from './groupingSource';
// Own module rather than a method on `SongDAO`: the backfill is a bounded pass over
// *many* rows selected by a version stamp, which is a different question from "one song
// row, by id" — and folding it in put `SongDAO` over the god-file limit.
export { SongDerivationDAO } from './songDerivation';
export type { DerivableRow, DerivationWrite } from './songDerivation';
export { SongIndexDAO } from './songIndex';
export type { GenreCountRow } from './songIndex';
// Looking a song up by **path** or by `(album_ci, title_ci)` — the two ways an import can
// resolve a foreign id. Its own module because `SongDAO` is one row and already over the
// soft god-file limit, and because the pair-keyed predicate is the only place in the layer
// that has to derive a batch size for two variables per key.
export { SongMatchDAO, keyForPair } from './songMatch';
export { AnnotationDAO, AuthThrottleDAO } from './UserStateDAO';
// Per-user play counts. Its own module because one table carries **two** semantics — a scrobble
// increments, an import overwrites — and the difference is silent, so the two writers stay where each
// can name the other.
export { PlayCountDAO } from './playCounts';
export { ScanStateDAO } from './ScanStateDAO';
export { PlaylistDAO } from './playlists';
export type { StarItemType } from './UserStateDAO';
// Registered remote Subsonic instances and the runs that import from them. A separate DAO
// from `LibraryDAO` because a remote server is not a library: it holds no music, and its
// credential is guarded by a different key.
export { ImportSourceDAO, ImportRunDAO, IMPORT_PHASES } from './imports';
// The play-count walk's cursor: its own lifecycle (a Durable Object resume point) and its own
// reader, so it is not beside the runs an operator creates.
export { ImportPlayCountProgressDAO } from './importProgress';
export type { ImportPlayCountProgressRow } from './importProgress';
export type { ImportPhase } from './imports';
export type {
  UserRow,
  LibraryRow,
  NodeRow,
  SongRow,
  ScanStateRow,
  PlaylistRow,
  PlaylistEntryRow,
  CountRow,
  IndexVersionRow,
  ImportSourceRow,
  ImportRunRow,
} from './rows';
