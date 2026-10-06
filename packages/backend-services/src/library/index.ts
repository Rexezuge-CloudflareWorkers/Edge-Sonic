export { LibraryService, normalizeBaseUrl, normalizeRootPath, normalizeSlug } from './LibraryService';
export {
  reachable,
  fromStatus,
  policyBlocked,
  malformedUrl,
  credentialUnreadable,
  unreachable,
  classifyBeforeRequest,
  describeWebDavStatus,
} from './probeOutcome';
export type { ProbeOutcome } from './probeOutcome';
export type { LibraryDeps, ResolvedLibrary } from './LibraryService';
// The Danger Zone's drop. Separate from `LibraryService` because it **keeps** what
// `LibraryService.delete` removes — the registration and its encrypted WebDAV credential — so
// the two are opposite outcomes reachable through one name otherwise.
export { IndexDropService } from './IndexDropService';
export type { IndexDropStore, ScanControl, IndexDropOutcome } from './IndexDropService';
