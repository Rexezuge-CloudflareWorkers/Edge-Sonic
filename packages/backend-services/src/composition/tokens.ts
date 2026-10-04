import type {
  AnnotationDAO,
  AuthThrottleDAO,
  LibraryDAO,
  NodeDAO,
  PlaylistDAO,
  ScanStateDAO,
  SongDAO,
  SongDerivationDAO,
  SongIndexDAO,
  UserDAO,
} from '@edge-sonic/backend-data/dao';
import type { SubrequestCounter } from '@edge-sonic/shared';
import type { Token } from '@edge-sonic/backend-runtime/di';
import type { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import type { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { AccessAuthService } from '../auth/AccessAuthService';
import type { SubsonicAuthService } from '../auth/SubsonicAuthService';
import type { LibraryService } from '../library/LibraryService';
import type { ScanService } from '../index/ScanService';
import type { TreeService } from '../index/TreeService';
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
  AuthThrottleDAO: Symbol('AuthThrottleDAO') as Token<() => Promise<AuthThrottleDAO>>,
  ScanStateDAO: Symbol('ScanStateDAO') as Token<() => Promise<ScanStateDAO>>,

  SubsonicAuthService: Symbol('SubsonicAuthService') as Token<SubsonicAuthService>,
  /**
   * Cloudflare Access, for `/user/*`. A token like every other service: resolved
   * from the scope rather than constructed at the call site, so it is reachable
   * from a test that wants a stub and shares the scope's one `AppConfiguration`.
   */
  AccessAuthService: Symbol('AccessAuthService') as Token<AccessAuthService>,
  LibraryService: Symbol('LibraryService') as Token<LibraryService>,
  TreeService: Symbol('TreeService') as Token<TreeService>,
  ScanService: Symbol('ScanService') as Token<ScanService>,
  EnrichmentService: Symbol('EnrichmentService') as Token<EnrichmentService>,

  // Per-feature encryption keys, as memoized thunks. Resolving one never fetches
  // the other — see `resolveKey` in `requestScope.ts`.
  UserKey: Symbol('UserKey') as Token<() => Promise<string>>,
  WebdavKey: Symbol('WebdavKey') as Token<() => Promise<string>>,
} satisfies Record<string, Token<unknown>>;

export { Tokens };
