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
export { deriveFromPath, DERIVED_MARKER, DERIVED_VERSION } from './pathConvention';
export type { DerivedNames } from './pathConvention';
// Own module rather than a method on `SongDAO`: the backfill is a bounded pass over
// *many* rows selected by a version stamp, which is a different question from "one song
// row, by id" — and folding it in put `SongDAO` over the god-file limit.
export { SongDerivationDAO } from './songDerivation';
export type { DerivableRow, DerivationWrite } from './songDerivation';
export { SongIndexDAO } from './songIndex';
export type { GenreCountRow } from './songIndex';
export { AnnotationDAO, AuthThrottleDAO } from './UserStateDAO';
export { ScanStateDAO } from './ScanStateDAO';
export { PlaylistDAO } from './playlists';
export type { StarItemType } from './UserStateDAO';
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
} from './rows';
