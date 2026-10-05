/**
 * Composition root: builds one `Container` per request.
 *
 * Table-driven DAO wiring and service wiring live in sibling modules; this file
 * owns only scope lifecycle and the two per-feature keys.
 */
import { SubrequestCounter } from '@edge-sonic/shared';
import { Container } from '@edge-sonic/backend-runtime/di';
import { AppConfiguration, WORKER_SUBSREQUEST_CEILING } from '@edge-sonic/backend-runtime/config';
import { KvCache } from '@edge-sonic/backend-runtime/kv';
import { setLogLevel } from '@edge-sonic/backend-runtime/logger';
import type { KvNamespaceLike } from '@edge-sonic/backend-runtime/kv';
import { AnnotationDAO, AuthThrottleDAO, LibraryDAO, NodeDAO, PlaylistDAO, ScanStateDAO, SongDAO, SongDerivationDAO, SongIndexDAO, UserDAO } from '@edge-sonic/backend-data/dao';
import type { D1Queryable } from '@edge-sonic/backend-data/utils';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { AccessAuthService } from '../auth/AccessAuthService';
import { SubsonicAuthService } from '../auth/SubsonicAuthService';
import { LibraryService } from '../library/LibraryService';
import { ScanService } from '../index/ScanService';
import { TreeService } from '../index/TreeService';
import { EnrichmentService } from '../index/EnrichmentService';
import { resolveKey } from './serviceFactory';
import type { RequestScopeEnv } from './serviceFactory';
import { Tokens } from './tokens';

function createRequestScope(env: RequestScopeEnv): Container {
  const scope = new Container();
  const config = AppConfiguration.fromEnv(env);

  // Publish the log level for loggers that were built at import time.
  //
  // `KvCache`'s and `embeddedArt`'s loggers are module-level constants, so they were
  // constructed long before any `env` existed — which is why `LOG_LEVEL` was inert in a
  // deployed Worker even though it was declared and shipped in the wrangler template. The
  // only point at which `c.env` is reachable is here, so it is set here, once per scope, and
  // read per emit.
  //
  // `null` deliberately clears any inherited value: two scopes in one isolate (a test
  // driving two configurations, or a future background worker with a different env) must
  // not inherit the other's level.
  setLogLevel(config.getLogLevel());

  // The invocation's subrequest budget, and the first thing constructed in this scope because
  // everything below charges it.
  //
  // **One per scope**, because a scope is one invocation: the DAOs, the KV cache, the WebDAV
  // client's `onRequest` and the scan's own budget all hold a reference to *this* object, and
  // a second counter anywhere would be a second number that disagrees with the platform's.
  // `ScanBudget` resets it at the start of each chunk and then reads it, which is what makes
  // "how much has this chunk spent" and "how much has this invocation spent" one measurement
  // at two windows rather than two measurements.
  //
  // It used not to exist, and every bound that needed one invented its own — which is how a
  // chunk of 40 folders came to be budgeted at 40 requests while spending ~240 of them.
  const subrequests = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
  scope.bindValue(Tokens.SubrequestMeter, subrequests);

  // Fail-soft: an absent `CACHE` binding yields a cache that misses, and every
  // read falls through to D1. That is the whole "works when KV is down"
  // requirement, and it starts here.
  //
  // The meter is passed because a KV operation is a subrequest like any other. It was not, so
  // a cold scan chunk spent 20 cache reads per folder against a budget that had never heard of
  // them — see `docs/issues/free-plan-subrequest-ceiling.md`.
  scope.bindValue(Tokens.KvCache, new KvCache((env as { CACHE?: KvNamespaceLike }).CACHE ?? null, subrequests));
  scope.bindValue(Tokens.AppConfig, config);

  // Per-feature keys. Two separate bindings on purpose:
  //
  // The user key can MINT a valid Subsonic token for any account, so it is the
  // credential with catastrophic blast radius. The WebDAV key is read on every
  // scan and every stream — a far larger exposure surface — but only yields
  // library credentials. Separating them means compromising the frequently-read key
  // cannot be escalated into impersonating a user.
  //
  // Merging them into one master key destroys that property invisibly.
  scope.bindValue(
    Tokens.UserKey,
    resolveKey(
      (env as { SUBSONIC_USER_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> } }).SUBSONIC_USER_ENCRYPTION_KEY_SECRET,
      (env as { SUBSONIC_USER_ENCRYPTION_KEY?: string }).SUBSONIC_USER_ENCRYPTION_KEY,
      'SUBSONIC_USER_ENCRYPTION_KEY_SECRET',
      'SUBSONIC_USER_ENCRYPTION_KEY',
      subrequests,
    ),
  );
  scope.bindValue(
    Tokens.WebdavKey,
    resolveKey(
      (env as { WEBDAV_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> } }).WEBDAV_ENCRYPTION_KEY_SECRET,
      (env as { WEBDAV_ENCRYPTION_KEY?: string }).WEBDAV_ENCRYPTION_KEY,
      'WEBDAV_ENCRYPTION_KEY_SECRET',
      'WEBDAV_ENCRYPTION_KEY',
      subrequests,
    ),
  );

  // DAOs. Bound as thunks so construction stays lazy and a handler that never
  // touches songs does not construct the songs DAO.
  // Every DAO is given the scope's counter. A DAO without one still works — its writes are
  // simply issued whole and nothing counts them — which is exactly why the wiring is asserted
  // in `test/subrequest-budget.test.ts` rather than trusted: an unmetered DAO is a path that
  // spends nothing because nothing was watching it, and it fails by being invisible.
  const db = env.DB as D1Queryable;
  // The derived-name marker is read once here and passed to both DAOs that write a grouping.
  // It cannot be a module constant in either: `backend-data` is a lower layer and cannot
  // import the configuration, and a DAO reading it per call would let one page be derived
  // against two markers if a test drove two configurations in one isolate.
  const derivedMarker = config.getDerivedMarker();
  scope.bindValue(Tokens.UserDAO, async () => new UserDAO(db, subrequests));
  scope.bindValue(Tokens.LibraryDAO, async () => new LibraryDAO(db, subrequests));
  scope.bindValue(Tokens.NodeDAO, async () => new NodeDAO(db, subrequests));
  scope.bindValue(Tokens.SongDAO, async () => new SongDAO(db, derivedMarker, subrequests));
  scope.bindValue(Tokens.SongDerivationDAO, async () => new SongDerivationDAO(db, derivedMarker, subrequests));
  scope.bindValue(Tokens.SongIndexDAO, async () => new SongIndexDAO(db, subrequests));
  scope.bindValue(Tokens.PlaylistDAO, async () => new PlaylistDAO(db, subrequests));
  scope.bindValue(Tokens.AnnotationDAO, async () => new AnnotationDAO(db, subrequests));
  scope.bindValue(Tokens.AuthThrottleDAO, async () => new AuthThrottleDAO(db, subrequests));
  scope.bindValue(Tokens.ScanStateDAO, async () => new ScanStateDAO(db, subrequests));

  const userKey = scope.get(Tokens.UserKey);
  const webdavKey = scope.get(Tokens.WebdavKey);

  const libraries = async () => await scope.get(Tokens.LibraryDAO)();

  scope.bindValue(
    Tokens.LibraryService,
    new LibraryService({
      libraries: {
        findById: async (id) => (await libraries()).findById(id),
        findBySlug: async (slug) => (await libraries()).findBySlug(slug),
        list: async () => (await libraries()).list(),
        listForUser: async (userId) => (await libraries()).listForUser(userId),
        create: async (input) => (await libraries()).create(input),
        update: async (id, input) => (await libraries()).update(id, input),
        updatePassword: async (id, c, iv, v) => (await libraries()).updatePassword(id, c, iv, v),
        delete: async (id) => (await libraries()).delete(id),
      },
      resolveKey: webdavKey,
      timeoutMs: config.getWebdavTimeoutMs(),
      allowPrivateHosts: () => config.getAllowPrivateWebdavHosts() ?? config.isBypassAllowed(),
    }),
  );

  // The optional `onRequest` is the caller's subrequest meter. It is threaded here
  // rather than at each service so a range read and a `PROPFIND` are charged to the
  // same budget by the same rule — the scan's chunk bound only works because the
  // enrichment reads inside its loop are counted too.
  //
  // The **default** `onRequest` charges the scope's counter, so every WebDAV request in the
  // product is counted even when the caller had no budget of its own to pass — `getCoverArt`,
  // the read-through browse, `stream`. The scan still passes its own callback, which charges
  // the same counter through its budget, so the two paths cannot drift apart.
  const clientFor = async (row: LibraryRow, onRequest?: () => void) =>
    await scope.get(Tokens.LibraryService).clientFor(row, onRequest ?? (() => subrequests.charge(1, 'fetch')));

  scope.bindValue(
    Tokens.TreeService,
    new TreeService({
      nodes: {
        find: async (libraryId, path) => (await scope.get(Tokens.NodeDAO)()).find(libraryId, path),
        listChildren: async (libraryId, parentPath) => (await scope.get(Tokens.NodeDAO)()).listChildren(libraryId, parentPath),
        listRoots: async (libraryId) => (await scope.get(Tokens.NodeDAO)()).listRoots(libraryId),
        upsertMany: async (inputs) => (await scope.get(Tokens.NodeDAO)()).upsertMany(inputs),
        countByLibrary: async (libraryId) => (await scope.get(Tokens.NodeDAO)()).countByLibrary(libraryId),
      },
      songs: {
        listByDirectory: async (libraryId, dirPath) => (await scope.get(Tokens.SongDAO)()).listByDirectory(libraryId, dirPath),
        upsertFileFacts: async (inputs) => (await scope.get(Tokens.SongDAO)()).upsertFileFacts(inputs),
      },
      clientFor,
      timeoutMs: config.getWebdavTimeoutMs(),
    }),
  );

  scope.bindValue(
    Tokens.ScanService,
    new ScanService({
      nodes: {
        find: async (libraryId, path) => (await scope.get(Tokens.NodeDAO)()).find(libraryId, path),
        listChildren: async (libraryId, parentPath) => (await scope.get(Tokens.NodeDAO)()).listChildren(libraryId, parentPath),
        listRoots: async (libraryId) => (await scope.get(Tokens.NodeDAO)()).listRoots(libraryId),
        listFrontier: async (libraryId, limit) => (await scope.get(Tokens.NodeDAO)()).listFrontier(libraryId, limit),
        upsertMany: async (inputs) => (await scope.get(Tokens.NodeDAO)()).upsertMany(inputs),
        deleteSubtree: async (libraryId, path) => (await scope.get(Tokens.NodeDAO)()).deleteSubtree(libraryId, path),
        countByLibrary: async (libraryId) => (await scope.get(Tokens.NodeDAO)()).countByLibrary(libraryId),
      },
      songs: {
        upsertFileFacts: async (inputs) => (await scope.get(Tokens.SongDAO)()).upsertFileFacts(inputs),
        deleteInDirectoryNotIn: async (libraryId, dirPath, keep) => (await scope.get(Tokens.SongDAO)()).deleteInDirectoryNotIn(libraryId, dirPath, keep),
        deleteSubtree: async (libraryId, dirPath) => (await scope.get(Tokens.SongDAO)()).deleteSubtree(libraryId, dirPath),
        countByLibrary: async (libraryId) => (await scope.get(Tokens.SongDAO)()).countByLibrary(libraryId),
      },
      scanState: {
        find: async (libraryId) => (await scope.get(Tokens.ScanStateDAO)()).find(libraryId),
        ensure: async (libraryId) => (await scope.get(Tokens.ScanStateDAO)()).ensure(libraryId),
        markScanning: async (libraryId, total) => (await scope.get(Tokens.ScanStateDAO)()).markScanning(libraryId, total),
        saveProgress: async (libraryId, scanned, cursor) => (await scope.get(Tokens.ScanStateDAO)()).saveProgress(libraryId, scanned, cursor),
        complete: async (libraryId, scanned) => (await scope.get(Tokens.ScanStateDAO)()).complete(libraryId, scanned),
        fail: async (libraryId, error) => (await scope.get(Tokens.ScanStateDAO)()).fail(libraryId, error),
      },
      // The derived-grouping backfill, for rows the file-change path will never revisit.
      // Every other song write the scan makes is gated on a file having changed, so a
      // library nobody has touched since it was indexed would otherwise never group —
      // and `getArtists`/`getAlbumList2`/`getGenres`/`search3` would answer `[]` while
      // the per-track endpoints looked healthy, because the song mapper falls back to the
      // folder name for display. It reads `dir_path` off the row, so it spends no *WebDAV*
      // subrequests and it runs ahead of the walk on every poll — but its two D1 statements
      // are charged like every other, because the claim that D1 "cannot spend" the ceiling is
      // what let a 200-row batch run unbudgeted at the top of every poll. Its page size is
      // derived from the chunk budget for the same reason: the write refuses rather than
      // truncating, so an oversized page is not a slow repair but a permanent failure that
      // fires before `listFrontier` and stops the walk running at all. See `deriveBackfill`.
      derivation: {
        listNeedingDerivation: async (libraryId, limit) => (await scope.get(Tokens.SongDerivationDAO)()).listNeedingDerivation(libraryId, limit),
        // An instance method rather than a static one, so the configured marker is used. A
        // static `deriveFor` could only have read a module constant, which is the value the
        // operator is explicitly no longer forced to take.
        deriveFor: async (rows) => (await scope.get(Tokens.SongDerivationDAO)()).deriveFor(rows),
        applyDerivation: async (writes) => (await scope.get(Tokens.SongDerivationDAO)()).applyDerivation(writes),
      },
      subrequests,
      clientFor,
      timeoutMs: config.getWebdavTimeoutMs(),
      chunkFolders: config.getScanChunkFolders(),
      // The three bounds a chunk runs under, and all three are derived from the platform's
      // subrequest ceiling rather than typed beside the code that has to honour them:
      // `chunkMaxRequests` is the ceiling less the invocation's own overhead,
      // `chunkDeadlineMs` is what makes a poll return on a slow origin, and
      // `chunkFolders` shapes one level of the tree. See `ConfigurationDefaults`.
      chunkMaxRequests: config.getScanChunkMaxRequests(),
      chunkDeadlineMs: config.getScanChunkDeadlineMs(),
      // The scan enriches what it changed, through the same `EnrichmentService` a
      // `getSong` uses, so browsing reports a real duration and the artist/album/genre
      // aggregates have rows to group on.
      //
      // `onRequest` is the chunk's meter. Forwarding it is what keeps a range read
      // counted against the same budget as the `PROPFIND` that found the file.
      enrichSong: async (library, facts, onRequest) => {
        await scope.get(Tokens.EnrichmentService).enrichFacts(library, facts, onRequest);
      },
      enrichMaxPerFolder: config.getScanEnrichMaxPerFolder(),
    }),
  );

  scope.bindValue(
    Tokens.EnrichmentService,
    new EnrichmentService({
      songs: {
        findById: async (id) => (await scope.get(Tokens.SongDAO)()).findById(id),
        applyMetadata: async (id, metadata) => (await scope.get(Tokens.SongDAO)()).applyMetadata(id, metadata),
      },
      clientFor,
      kv: scope.get(Tokens.KvCache),
      resolveKey: webdavKey,
      readBytes: config.getTagReadBytes(),
      readTailBytes: config.getTagReadTailBytes(),
      timeoutMs: config.getWebdavTimeoutMs(),
    }),
  );

  // Cloudflare Access, for `/user/*`. Shares the scope's `config` rather than
  // re-deriving one per request, and reads the platform-provisioned `ACCESS`
  // binding off `env` — the one place that binding is visible at Layer 3.
  scope.bindValue(Tokens.AccessAuthService, new AccessAuthService(env, config));

  scope.bindValue(
    Tokens.SubsonicAuthService,
    new SubsonicAuthService({
      resolveKey: userKey,
      users: {
        findByUsername: async (username) => (await scope.get(Tokens.UserDAO)()).findByUsername(username),
      },
      throttle: {
        countRecentFailures: async (identity, oldest, current) => (await scope.get(Tokens.AuthThrottleDAO)()).countRecentFailures(identity, oldest, current),
        recordFailure: async (identity, bucket) => (await scope.get(Tokens.AuthThrottleDAO)()).recordFailure(identity, bucket),
        clearFailures: async (identity) => (await scope.get(Tokens.AuthThrottleDAO)()).clearFailures(identity),
        pruneOldBuckets: async (identity, oldest) => (await scope.get(Tokens.AuthThrottleDAO)()).pruneOldBuckets(identity, oldest),
      },
      failureLimit: config.getAuthFailureLimit(),
      windowSeconds: config.getAuthFailureWindowSeconds(),
    }),
  );

  return scope;
}

export { createRequestScope };


export {type RequestScopeEnv} from './serviceFactory';