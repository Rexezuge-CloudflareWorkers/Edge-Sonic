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
export { SongDAO } from './SongDAO';
export { chunkArray } from './chunking';
export type { SongUpsertInput } from './SongDAO';
export { SongIndexDAO } from './songIndex';
export type { GenreCountRow } from './songIndex';
export { AnnotationDAO, AuthThrottleDAO, ScanStateDAO } from './UserStateDAO';
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
