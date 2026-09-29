import { Tokens } from '@edge-sonic/backend-services/composition';
import { UUIDUtil } from '@edge-sonic/shared/utils';
import { BadRequestError, ConflictError, NotFoundError } from '@edge-sonic/backend-errors';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { AdminContext } from '../endpoints/BaseRoute';

/**
 * Read a path parameter that the route pattern guarantees exists.
 *
 * `c.req.param` is typed `string | undefined`, and a `!` at every call site would
 * hide the real question — which is that an absent id must not become the string
 * "undefined" and query for it.
 */
function requireParam(c: AdminContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new BadRequestError(`Missing path parameter "${name}".`);
  }
  return value;
}

async function listLibraries(c: AdminContext): Promise<Response> {
  const scope = BaseRoute.getScope(c);
  const libraries = await scope.get(Tokens.LibraryService).listAll();
  return c.json({
    libraries: libraries.map((library) => ({
      id: library.id,
      slug: library.slug,
      displayName: library.display_name,
      baseUrl: library.base_url,
      rootPath: library.root_path,
      davUsername: library.dav_username,
      isEnabled: library.is_enabled === 1,
      songCount: 0,
      createdAt: library.created_at,
    })),
  });
}

async function createLibrary(c: AdminContext): Promise<Response> {
  const { malformed, oversized, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return BaseRoute.jsonError(c, 'Request body is not valid JSON.', 400);
  if (oversized) return BaseRoute.jsonError(c, 'Request body is too large.', 413);

  const scope = BaseRoute.getScope(c);
  const created = await scope.get(Tokens.LibraryService).create({
    ownerId: c.get('AdminEmail'),
    slug: BaseRoute.requireString(body, 'slug', 64),
    baseUrl: BaseRoute.requireString(body, 'baseUrl', 2048),
    rootPath: BaseRoute.optionalString(body, 'rootPath', 1024) ?? '/',
    davUsername: BaseRoute.requireString(body, 'davUsername', 256),
    davPassword: BaseRoute.requireString(body, 'davPassword', 256),
    displayName: BaseRoute.optionalString(body, 'displayName', 128),
  });
  return c.json({ id: created.id, slug: created.slug }, 201);
}

async function updateLibrary(c: AdminContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const { malformed, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return BaseRoute.jsonError(c, 'Request body is not valid JSON.', 400);

  const scope = BaseRoute.getScope(c);
  const service = scope.get(Tokens.LibraryService);
  const existing = await service.listAll().then((all) => all.find((library) => library.id === id));
  if (!existing) return BaseRoute.jsonError(c, 'Library not found.', 404);

  const password = BaseRoute.optionalString(body, 'davPassword', 256);
  await service.update(id, {
    slug: BaseRoute.requireString(body, 'slug', 64),
    baseUrl: BaseRoute.requireString(body, 'baseUrl', 2048),
    rootPath: BaseRoute.optionalString(body, 'rootPath', 1024) ?? existing.root_path,
    davUsername: BaseRoute.requireString(body, 'davUsername', 256),
    displayName: BaseRoute.optionalString(body, 'displayName', 128),
  });
  if (password !== null) await service.setPassword(id, password);
  return c.json({ ok: true });
}

async function deleteLibrary(c: AdminContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  await scope.get(Tokens.LibraryService).delete(id);
  return c.json({ ok: true });
}

/**
 * Probe a library.
 *
 * The one admin action that performs a live outbound request with the stored
 * credential, so it is a separate route rather than a query flag on `GET
 * /libraries`: an operator clicking "test" should be able to do it without a
 * `GET` being able to.
 */
async function probeLibrary(c: AdminContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  const service = scope.get(Tokens.LibraryService);
  const library = (await service.listAll()).find((candidate) => candidate.id === id);
  if (!library) return BaseRoute.jsonError(c, 'Library not found.', 404);
  return c.json(await service.probe(library));
}

async function startScan(c: AdminContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  const service = scope.get(Tokens.LibraryService);
  const library = (await service.listAll()).find((candidate) => candidate.id === id);
  if (!library) return BaseRoute.jsonError(c, 'Library not found.', 404);
  return c.json(await scope.get(Tokens.ScanService).start(library));
}

async function scanStatus(c: AdminContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  return c.json(await scope.get(Tokens.ScanService).status(id));
}

async function listUsers(c: AdminContext): Promise<Response> {
  const scope = BaseRoute.getScope(c);
  const users = await (await scope.get(Tokens.UserDAO)()).list();
  // Granted libraries are resolved per user. These are few enough that the N+1 is
  // cheaper than a join, and the admin list is not a hot path.
  const grants = new Map<string, string[]>();
  for (const user of users) {
    grants.set(user.id, await (await scope.get(Tokens.UserDAO)()).listLibraryIds(user.id));
  }
  return c.json({
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      isAdmin: user.is_admin === 1,
      isEnabled: user.is_enabled === 1,
      libraryIds: grants.get(user.id) ?? [],
      createdAt: user.created_at,
    })),
  });
}

/**
 * Create a Subsonic user.
 *
 * This is the only place a Subsonic password is set, and it is written encrypted
 * under the *user* key — never the WebDAV key, so the frequently-read key cannot
 * mint a streaming session.
 */
async function createUser(c: AdminContext): Promise<Response> {
  const { malformed, oversized, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return BaseRoute.jsonError(c, 'Request body is not valid JSON.', 400);
  if (oversized) return BaseRoute.jsonError(c, 'Request body is too large.', 413);

  const scope = BaseRoute.getScope(c);
  const username = BaseRoute.requireString(body, 'username', 64);
  const password = BaseRoute.requireString(body, 'password', 256);
  const key = await scope.get(Tokens.UserKey)();
  const { encryptData } = await import('@edge-sonic/backend-data/crypto');
  const encrypted = await encryptData(password, key);

  const users = await scope.get(Tokens.UserDAO)();
  if (await users.findByUsername(username)) {
    return BaseRoute.jsonError(c, 'A user with that username already exists.', 409);
  }
  const created = await users.create({
    username,
    passwordCiphertext: encrypted.ciphertext,
    passwordIv: encrypted.iv,
    email: BaseRoute.optionalString(body, 'email', 256),
    isAdmin: body.isAdmin === true,
  });
  return c.json({ id: created.id, username: created.username }, 201);
}

async function setUserEnabled(c: AdminContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const enabled = c.req.query('enabled') === 'true';
  const scope = BaseRoute.getScope(c);
  await (await scope.get(Tokens.UserDAO)()).setEnabled(id, enabled);
  return c.json({ ok: true });
}

async function deleteUser(c: AdminContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  await (await scope.get(Tokens.UserDAO)()).delete(id);
  return c.json({ ok: true });
}

async function setUserLibraries(c: AdminContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const { malformed, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return BaseRoute.jsonError(c, 'Request body is not valid JSON.', 400);
  const raw = body.libraryIds;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new BadRequestError('Field "libraryIds" must be an array of strings.');
  }
  const scope = BaseRoute.getScope(c);
  const config = scope.get(Tokens.AppConfig);
  if (raw.length > config.getMaxLibraries()) {
    throw new ConflictError(`A user may be granted at most ${config.getMaxLibraries()} libraries.`);
  }

  // Every id is checked before any write. Without this the insert fails on a foreign
  // key, which surfaces as a 500 — an answer that says the *server* is broken when the
  // request was simply wrong, and one that names neither the user nor the library.
  const libraries = await scope.get(Tokens.LibraryService).listAll();
  const known = new Set(libraries.map((library) => library.id));
  const unknown = (raw as string[]).filter((libraryId) => !known.has(libraryId));
  if (unknown.length > 0) {
    throw new NotFoundError(`Unknown librar${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}`);
  }

  await (await scope.get(Tokens.UserDAO)()).setLibraryGrants(id, raw as string[]);
  return c.json({ ok: true });
}

async function whoami(c: AdminContext): Promise<Response> {
  return c.json({ email: c.get('AdminEmail'), workerId: UUIDUtil.getRandomUUID() });
}

/**
 * Register the admin API.
 *
 * `app.use('/admin/*', adminAuthentication)` must already have run — the order is
 * set in the worker constructor, and every route here reads `c.get('AdminEmail')`,
 * so a route registered before that middleware would see an undefined identity
 * rather than fail loudly.
 */
function registerAdminRoutes(app: {
  get: (path: string, handler: (c: AdminContext) => Promise<Response>) => unknown;
  post: (path: string, handler: (c: AdminContext) => Promise<Response>) => unknown;
  patch: (path: string, handler: (c: AdminContext) => Promise<Response>) => unknown;
  delete: (path: string, handler: (c: AdminContext) => Promise<Response>) => unknown;
}): void {
  app.get('/admin/me', whoami);

  app.get('/admin/libraries', listLibraries);
  app.post('/admin/libraries', createLibrary);
  app.patch('/admin/libraries/:id', updateLibrary);
  app.delete('/admin/libraries/:id', deleteLibrary);
  app.post('/admin/libraries/:id/probe', probeLibrary);
  app.post('/admin/libraries/:id/scan', startScan);
  app.get('/admin/libraries/:id/scan', scanStatus);

  app.get('/admin/users', listUsers);
  app.post('/admin/users', createUser);
  app.patch('/admin/users/:id/enabled', setUserEnabled);
  app.patch('/admin/users/:id/libraries', setUserLibraries);
  app.delete('/admin/users/:id', deleteUser);
}

export { registerAdminRoutes };
