// DAO barrels. Import from the root barrel, or from a group for readability.
//
// `identity` and the two index DAOs are separate modules because they answer
// different questions — "who is this user and what may they see" versus "what is
// in this library" — and mixing them in one file would produce a module well
// past the god-file limit.
export { BaseDAO } from './BaseDAO';
export { buildSetClause } from './UpdateClause';
export type { SetAssignment, SetClause } from './UpdateClause';
export { UserDAO, LibraryDAO, nowSeconds } from './identity';
export { NodeDAO } from './NodeDAO';
export type { NodeInput, NodePatch } from './NodeDAO';
export { SongDAO, chunkArray } from './SongDAO';
export type { SongUpsertInput } from './SongDAO';
export { PlaylistDAO, AnnotationDAO, AuthThrottleDAO, ScanStateDAO } from './UserStateDAO';
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
