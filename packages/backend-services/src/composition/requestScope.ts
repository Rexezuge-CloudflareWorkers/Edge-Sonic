/**
 * Composition root: builds one `Container` per request.
 *
 * Table-driven DAO wiring and service wiring live in sibling modules; this file
 * owns only scope lifecycle and the two per-feature keys.
 */
import { Container } from '@edge-sonic/backend-runtime/di';
import { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import { KvCache } from '@edge-sonic/backend-runtime/kv';
import type { KvNamespaceLike } from '@edge-sonic/backend-runtime/kv';
import { AnnotationDAO, AuthThrottleDAO, LibraryDAO, NodeDAO, PlaylistDAO, ScanStateDAO, SongDAO, SongIndexDAO, UserDAO } from '@edge-sonic/backend-data/dao';
import type { D1Queryable } from '@edge-sonic/backend-data/utils';
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

  // Fail-soft: an absent `CACHE` binding yields a cache that misses, and every
  // read falls through to D1. That is the whole "works when KV is down"
  // requirement, and it starts here.
  scope.bindValue(Tokens.KvCache, new KvCache((env as { CACHE?: KvNamespaceLike }).CACHE ?? null));
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
    ),
  );
  scope.bindValue(
    Tokens.WebdavKey,
    resolveKey(
      (env as { WEBDAV_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> } }).WEBDAV_ENCRYPTION_KEY_SECRET,
      (env as { WEBDAV_ENCRYPTION_KEY?: string }).WEBDAV_ENCRYPTION_KEY,
      'WEBDAV_ENCRYPTION_KEY_SECRET',
      'WEBDAV_ENCRYPTION_KEY',
    ),
  );

  // DAOs. Bound as thunks so construction stays lazy and a handler that never
  // touches songs does not construct the songs DAO.
  const db = env.DB as D1Queryable;
  scope.bindValue(Tokens.UserDAO, async () => new UserDAO(db));
  scope.bindValue(Tokens.LibraryDAO, async () => new LibraryDAO(db));
  scope.bindValue(Tokens.NodeDAO, async () => new NodeDAO(db));
  scope.bindValue(Tokens.SongDAO, async () => new SongDAO(db));
  scope.bindValue(Tokens.SongIndexDAO, async () => new SongIndexDAO(db));
  scope.bindValue(Tokens.PlaylistDAO, async () => new PlaylistDAO(db));
  scope.bindValue(Tokens.AnnotationDAO, async () => new AnnotationDAO(db));
  scope.bindValue(Tokens.AuthThrottleDAO, async () => new AuthThrottleDAO(db));
  scope.bindValue(Tokens.ScanStateDAO, async () => new ScanStateDAO(db));

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
        countForUser: async (userId) => (await libraries()).countForUser(userId),
        create: async (input) => (await libraries()).create(input),
        update: async (id, input) => (await libraries()).update(id, input),
        updatePassword: async (id, c, iv, v) => (await libraries()).updatePassword(id, c, iv, v),
        setEnabled: async (id, enabled) => (await libraries()).setEnabled(id, enabled),
        delete: async (id) => (await libraries()).delete(id),
      },
      resolveKey: webdavKey,
      timeoutMs: config.getWebdavTimeoutMs(),
      allowPrivateHosts: () => config.getAllowPrivateWebdavHosts() ?? config.isBypassAllowed(),
    }),
  );

  const clientFor = async (row: Parameters<LibraryService['clientFor']>[0]) => await scope.get(Tokens.LibraryService).clientFor(row);

  scope.bindValue(
    Tokens.TreeService,
    new TreeService({
      nodes: {
        find: async (libraryId, path) => (await scope.get(Tokens.NodeDAO)()).find(libraryId, path),
        listChildren: async (libraryId, parentPath) => (await scope.get(Tokens.NodeDAO)()).listChildren(libraryId, parentPath),
        listRoots: async (libraryId) => (await scope.get(Tokens.NodeDAO)()).listRoots(libraryId),
        upsertMany: async (inputs) => (await scope.get(Tokens.NodeDAO)()).upsertMany(inputs),
        patch: async (libraryId, path, patch) => (await scope.get(Tokens.NodeDAO)()).patch(libraryId, path, patch),
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
        patch: async (libraryId, path, patch) => (await scope.get(Tokens.NodeDAO)()).patch(libraryId, path, patch),
        deleteChildrenNotIn: async (libraryId, parentPath, keep) => (await scope.get(Tokens.NodeDAO)()).deleteChildrenNotIn(libraryId, parentPath, keep),
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
      clientFor,
      timeoutMs: config.getWebdavTimeoutMs(),
      chunkFolders: config.getScanChunkFolders(),
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
      timeoutMs: config.getWebdavTimeoutMs(),
    }),
  );

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