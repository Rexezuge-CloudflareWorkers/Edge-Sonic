import type {
  AnnotationDAO,
  AuthThrottleDAO,
  ImportPlayCountProgressDAO,
  ImportRunDAO,
  ImportSourceDAO,
  IndexDropDAO,
  IndexStatsDAO,
  LibraryDAO,
  NodeDAO,
  PlaylistDAO,
  PlayCountDAO,
  ScanStateDAO,
  SongDAO,
  SongDerivationDAO,
  SongIndexDAO,
  SongMatchDAO,
  UserDAO,
} from '@edge-sonic/backend-data/dao';
import type { SubrequestCounter } from '@edge-sonic/shared';
import type { Token } from '@edge-sonic/backend-runtime/di';
import type { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { AccessAuthService } from '../auth/AccessAuthService';
import type { SubsonicAuthService } from '../auth/SubsonicAuthService';
import type { LibraryService } from '../library/LibraryService';
import type { IndexDropService } from '../library/IndexDropService';
import type { ScanService } from '../index/ScanService';
import type { TreeService } from '../index/TreeService';
import type { ImportSourceService } from '../import/sourceService';
import type { EnrichmentService } from '../index/EnrichmentService';

/**
 * Central token registry for the per-request composition root.
 *
 * Tokens carry their value type so `scope.get(Tokens.X)` infers the service type
 * without an explicit generic at the ~40 call sites that use it.
 */
const Tokens = {
  /**
   * The invocation's subrequest counter, and the one object every charge point writes to.
   *
   * A token rather than a constructor argument threaded through each service because the
   * charge points are constructed here and read from three layers down; passing it by hand
   * would be a chance to forget one, and a forgotten charge is invisible.
   */
  SubrequestMeter: Symbol('SubrequestMeter') as Token<SubrequestCounter>,
  KvCache: Symbol('KvCache') as Token<KvCache>,
  AppConfig: Symbol('AppConfig') as Token<AppConfiguration>,

  UserDAO: Symbol('UserDAO') as Token<() => Promise<UserDAO>>,
  LibraryDAO: Symbol('LibraryDAO') as Token<() => Promise<LibraryDAO>>,
  NodeDAO: Symbol('NodeDAO') as Token<() => Promise<NodeDAO>>,
  SongDAO: Symbol('SongDAO') as Token<() => Promise<SongDAO>>,
  /**
   * The derived-grouping backfill. Separate from `SongDAO` because it is a *version*
   * selection over many rows rather than one row by id, and because it is the only song
   * write the scan makes that is not gated on a file having changed.
   */
  SongDerivationDAO: Symbol('SongDerivationDAO') as Token<() => Promise<SongDerivationDAO>>,
  /**
  The aggregate reads. Separate from `SongDAO` because they page over groups, not rows.
  */
  SongIndexDAO: Symbol('SongIndexDAO') as Token<() => Promise<SongIndexDAO>>,
  PlaylistDAO: Symbol('PlaylistDAO') as Token<() => Promise<PlaylistDAO>>,
  AnnotationDAO: Symbol('AnnotationDAO') as Token<() => Promise<AnnotationDAO>>,
  /**
   * Play counts, bound separately from the annotations.
   *
   * One table, two semantics — `recordPlay` increments, `setPlayCounts` overwrites — and the
   * difference has no symptom. They are separate tokens so neither is reachable through the other's
   * name, which is the only way a caller picking the wrong one is prevented rather than warned.
   */
  PlayCountDAO: Symbol('PlayCountDAO') as Token<() => Promise<PlayCountDAO>>,
  AuthThrottleDAO: Symbol('AuthThrottleDAO') as Token<() => Promise<AuthThrottleDAO>>,
  ScanStateDAO: Symbol('ScanStateDAO') as Token<() => Promise<ScanStateDAO>>,
  /**
   * The path and `(album_ci, title_ci)` lookups an import resolves foreign ids with.
   *
   * Separate from `SongDAO` because it answers a question about a *foreign* row's identity for
   * exactly one caller, and because the pair-keyed predicate is the only place in the layer
   * that derives a batch size for two variables per key.
   */
  SongMatchDAO: Symbol('SongMatchDAO') as Token<() => Promise<SongMatchDAO>>,
  /**
   * The import's three stores. Bound through the scope rather than constructed by the workflow
   * or the Durable Object, so all three composition roots share one wiring — and so a test can
   * assert every token is bound in **both** of them, which is what `test/rate-limit.test.ts`
   * does for the rest.
   */
  ImportSourceDAO: Symbol('ImportSourceDAO') as Token<() => Promise<ImportSourceDAO>>,
  /**
   * The one reader of a remote instance's stored credential.
   *
   * A service rather than route code because `apps/api` may not import `backend-data` values, and
   * because the credential is read from **two** places — the route, to list the remote's playlists
   * before the Workflow starts, and the workflow, per step. Two readers is two implementations of
   * "decrypt it", free to disagree about which key.
   */
  ImportSourceService: Symbol('ImportSourceService') as Token<ImportSourceService>,
  ImportRunDAO: Symbol('ImportRunDAO') as Token<() => Promise<ImportRunDAO>>,
  ImportPlayCountProgressDAO: Symbol('ImportPlayCountProgressDAO') as Token<() => Promise<ImportPlayCountProgressDAO>>,
  /**
   * Remote album and artist id → local id.
   *
   * Bound rather than imported so the **grouping** is read once from the scope's configuration
   * and cannot differ between the matcher and the id `getAlbum` mints. A star on an album id
   * nothing resolves is invisible to every client, so the two must agree by construction.
   */
  MatchRemoteAlbums: Symbol('MatchRemoteAlbums') as Token<RemoteAlbumMatcher>,
  MatchRemoteArtists: Symbol('MatchRemoteArtists') as Token<RemoteArtistMatcher>,

  SubsonicAuthService: Symbol('SubsonicAuthService') as Token<SubsonicAuthService>,
  /**
   * Cloudflare Access, for `/user/*`. A token like every other service: resolved
   * from the scope rather than constructed at the call site, so it is reachable
   * from a test that wants a stub and shares the scope's one `AppConfiguration`.
   */
  AccessAuthService: Symbol('AccessAuthService') as Token<AccessAuthService>,
  LibraryService: Symbol('LibraryService') as Token<LibraryService>,
  /**
   * The Danger Zone's drop, and its cost projection.
   *
   * Separate from `LibraryService` because it **keeps** what `LibraryService.delete` removes:
   * the `libraries` row and its encrypted credential. A drop leaves a library registered and
   * scannable, so folding it into the service that deletes registrations would make two
   * opposite outcomes reachable through one name, and the difference between them is whether
   * the operator has to re-enter a WebDAV password.
   */
  IndexDropService: Symbol('IndexDropService') as Token<IndexDropService>,
  /**
   * The two Danger Zone DAOs, behind one token.
   *
   * Bound as a pair rather than two tokens because nothing outside this composition root has a
   * reason to hold one without the other: a caller projects a bill with one and spends it with
   * the other, and a token for each would be an invitation to quote a cost from one and act
   * without the other. The two DAOs are separate *classes* for the same reason the stats and the
   * drop are separate methods — one reads and one destroys.
   */
  IndexStore: Symbol('IndexStore') as Token<{ stats: IndexStatsDAO; drop: IndexDropDAO }>,
  TreeService: Symbol('TreeService') as Token<TreeService>,
  ScanService: Symbol('ScanService') as Token<ScanService>,
  EnrichmentService: Symbol('EnrichmentService') as Token<EnrichmentService>,

  // Per-feature encryption keys, as memoized thunks. Resolving one never fetches
  // the other — see `resolveKey` in `requestScope.ts`.
  UserKey: Symbol('UserKey') as Token<() => Promise<string>>,
  WebdavKey: Symbol('WebdavKey') as Token<() => Promise<string>>,
  /**
   * The third key, guarding a remote Subsonic instance's credential.
   *
   * Three, not two, and the third is not a merge. A remote credential is operator-supplied and
   * re-entered per source, so rotating this key must not require re-entering any Subsonic
   * user's password — and a compromise of the frequently-read WebDAV key must not yield it.
   */
  RemoteKey: Symbol('RemoteKey') as Token<() => Promise<string>>,
} satisfies Record<string, Token<unknown>>;

/**
The two matchers, as the shapes the composition root binds.
*/
type RemoteAlbumMatcher = (libraryId: string, albums: ReadonlyArray<{ id: string; name: string | null; artist: string | null }>) => Promise<Map<string, string>>;
type RemoteArtistMatcher = (libraryId: string, artists: ReadonlyArray<{ id: string; name: string | null }>) => Promise<Map<string, string>>;

export { Tokens };
export type { RemoteAlbumMatcher, RemoteArtistMatcher };
