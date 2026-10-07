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
// The port the API worker resolves once, so "is a Durable Object carrying this scan?" is asked
// in one place rather than at every call site.
export { InProcessScanDriver } from './ScanDriver';
export type { ScanDriver, ScanRunner } from './ScanDriver';
// The enrichment port, beside the scan's for the same reason: "is a Durable Object carrying
// this run?" asked once rather than at every call site, and a different port because the two
// answer different questions about what is running.
export { InProcessEnrichDriver } from './EnrichDriver';
export type { EnrichDriver, EnrichRunner } from './EnrichDriver';
// The Danger Zone's drop. Separate from `LibraryService` because it **keeps** what
// `LibraryService.delete` removes — the registration and its encrypted WebDAV credential — so
// the two are opposite outcomes reachable through one name otherwise.
export { IndexDropService } from './IndexDropService';
export type { IndexDropStore, ScanControl, IndexDropOutcome } from './IndexDropService';
