import type { Context } from 'hono';
import { BadRequestError, ConflictError } from '@edge-sonic/backend-errors';
import { createRequestScope, Tokens } from '@edge-sonic/backend-services/composition';
import { getRequestScope, asScopedContext } from '@edge-sonic/backend-runtime/di';
import { toAdminResponse } from '@edge-sonic/backend-services/errors';
import { UUIDUtil } from '@edge-sonic/shared/utils';
import { SPA_HTML } from '../generated/spa-shell';

type WorkerEnv = { Bindings: Cloudflare.Env; Variables: { AdminEmail: string } };
type AdminContext = Context<WorkerEnv>;

/** Admin JSON body cap. Small by design — no admin call carries media. */
const MAX_JSON_BODY_BYTES = 64 * 1024;

abstract class BaseRoute {
  public static getScope(c: { get(key: string): unknown; env: unknown }): ReturnType<typeof createRequestScope> {
    try {
      return getRequestScope(asScopedContext(c));
    } catch {
      return createRequestScope(c.env as Cloudflare.Env);
    }
  }

  /**
   * Strict JSON body reader.
   *
   * Distinguishes *malformed* from *empty* because collapsing a parse error to `{}`
   * turns "your JSON is broken" into "the `name` field is required", which sends the
   * caller looking in the wrong place. Oversized bodies are rejected before they are
   * buffered.
   */
  public static async readJson<T>(c: AdminContext): Promise<{ malformed: boolean; oversized: boolean; body: T }> {
    const raw = c.req.header('content-length');
    const declared = raw === undefined ? Number.NaN : Number(raw);
    if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
      return { malformed: false, oversized: true, body: {} as T };
    }
    try {
      const body = (await c.req.json()) as T;
      return { malformed: false, oversized: false, body };
    } catch {
      return { malformed: true, oversized: false, body: {} as T };
    }
  }

  /**
   * Read a required string field.
   *
   * An explicit type check rather than a cast: `body.name.trim()` on a number that
   * arrived as JSON surfaces as a 500 where the answer is a 400.
   */
  public static requireString(body: Record<string, unknown>, field: string, maxLength = 512): string {
    const value = body[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestError(`Field "${field}" is required and must be a non-empty string.`);
    }
    if (value.length > maxLength) throw new BadRequestError(`Field "${field}" exceeds ${maxLength} characters.`);
    return value.trim();
  }

  public static optionalString(body: Record<string, unknown>, field: string, maxLength = 512): string | null {
    const value = body[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new BadRequestError(`Field "${field}" must be a string.`);
    if (value.length > maxLength) throw new BadRequestError(`Field "${field}" exceeds ${maxLength} characters.`);
    return value;
  }

  /** The error path for the admin API, which does read HTTP statuses. */
  public static toErrorResponse(c: AdminContext, error: unknown): Response {
    const mapped = toAdminResponse(error, c.req.header('accept-language'));
    return c.json(mapped.body, mapped.status as 400);
  }
}

type C = AdminContext;

function json(c: C, body: unknown, status: 200 | 201 = 200): Response {
  return c.json(body, status);
}

/**
 * Read a path parameter that the route pattern guarantees exists.
 *
 * `c.req.param` is typed `string | undefined`, and a `!` at every call site would
 * hide the real question — which is that an absent id must not become the string
 * "undefined" and query for it.
 */
function requireParam(c: C, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new BadRequestError(`Missing path parameter "${name}".`);
  }
  return value;
}

async function listLibraries(c: C): Promise<Response> {
  const scope = BaseRoute.getScope(c);
  const libraries = await scope.get(Tokens.LibraryService).listAll();
  return json(c, {
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

async function createLibrary(c: C): Promise<Response> {
  const { malformed, oversized, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return c.json({ error: { code: 'BadRequest', message: 'Request body is not valid JSON.' } }, 400);
  if (oversized) return c.json({ error: { code: 'PayloadTooLarge', message: 'Request body is too large.' } }, 413);

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
  return json(c, { id: created.id, slug: created.slug }, 201);
}

async function updateLibrary(c: C): Promise<Response> {
  const id = requireParam(c, 'id');
  const { malformed, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return c.json({ error: { code: 'BadRequest', message: 'Request body is not valid JSON.' } }, 400);

  const scope = BaseRoute.getScope(c);
  const service = scope.get(Tokens.LibraryService);
  const existing = await service.listAll().then((all) => all.find((library) => library.id === id));
  if (!existing) return c.json({ error: { code: 'NotFound', message: 'Library not found.' } }, 404);

  const password = BaseRoute.optionalString(body, 'davPassword', 256);
  await service.update(id, {
    slug: BaseRoute.requireString(body, 'slug', 64),
    baseUrl: BaseRoute.requireString(body, 'baseUrl', 2048),
    rootPath: BaseRoute.optionalString(body, 'rootPath', 1024) ?? existing.root_path,
    davUsername: BaseRoute.requireString(body, 'davUsername', 256),
    displayName: BaseRoute.optionalString(body, 'displayName', 128),
  });
  if (password !== null) await service.setPassword(id, password);
  return json(c, { ok: true });
}

async function deleteLibrary(c: C): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  await scope.get(Tokens.LibraryService).delete(id);
  return json(c, { ok: true });
}

/**
 * Probe a library.
 *
 * The one admin action that performs a live outbound request with the stored
 * credential, so it is a separate route rather than a query flag on `GET
 * /libraries`: an operator clicking "test" should be able to do it without a
 * `GET` being able to.
 */
async function probeLibrary(c: C): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  const service = scope.get(Tokens.LibraryService);
  const library = (await service.listAll()).find((candidate) => candidate.id === id);
  if (!library) return c.json({ error: { code: 'NotFound', message: 'Library not found.' } }, 404);
  return json(c, await service.probe(library));
}

async function startScan(c: C): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  const service = scope.get(Tokens.LibraryService);
  const library = (await service.listAll()).find((candidate) => candidate.id === id);
  if (!library) return c.json({ error: { code: 'NotFound', message: 'Library not found.' } }, 404);
  return json(c, await scope.get(Tokens.ScanService).start(library));
}

async function scanStatus(c: C): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  return json(c, await scope.get(Tokens.ScanService).status(id));
}

async function listUsers(c: C): Promise<Response> {
  const scope = BaseRoute.getScope(c);
  const users = await (await scope.get(Tokens.UserDAO)()).list();
  // Granted libraries are resolved per user. These are few enough that the N+1 is
  // cheaper than a join, and the admin list is not a hot path.
  const grants = new Map<string, string[]>();
  for (const user of users) {
    grants.set(user.id, await (await scope.get(Tokens.UserDAO)()).listLibraryIds(user.id));
  }
  return json(c, {
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
async function createUser(c: C): Promise<Response> {
  const { malformed, oversized, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return c.json({ error: { code: 'BadRequest', message: 'Request body is not valid JSON.' } }, 400);
  if (oversized) return c.json({ error: { code: 'PayloadTooLarge', message: 'Request body is too large.' } }, 413);

  const scope = BaseRoute.getScope(c);
  const username = BaseRoute.requireString(body, 'username', 64);
  const password = BaseRoute.requireString(body, 'password', 256);
  const key = await scope.get(Tokens.UserKey)();
  const { encryptData } = await import('@edge-sonic/backend-data/crypto');
  const encrypted = await encryptData(password, key);

  const users = await scope.get(Tokens.UserDAO)();
  if (await users.findByUsername(username)) {
    return c.json({ error: { code: 'Conflict', message: 'A user with that username already exists.' } }, 409);
  }
  const created = await users.create({
    username,
    passwordCiphertext: encrypted.ciphertext,
    passwordIv: encrypted.iv,
    email: BaseRoute.optionalString(body, 'email', 256),
    isAdmin: body.isAdmin === true,
  });
  return json(c, { id: created.id, username: created.username }, 201);
}

async function setUserEnabled(c: C): Promise<Response> {
  const id = requireParam(c, 'id');
  const enabled = c.req.query('enabled') === 'true';
  const scope = BaseRoute.getScope(c);
  await (await scope.get(Tokens.UserDAO)()).setEnabled(id, enabled);
  return json(c, { ok: true });
}

async function deleteUser(c: C): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  await (await scope.get(Tokens.UserDAO)()).delete(id);
  return json(c, { ok: true });
}

async function setUserLibraries(c: C): Promise<Response> {
  const id = requireParam(c, 'id');
  const { malformed, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return c.json({ error: { code: 'BadRequest', message: 'Request body is not valid JSON.' } }, 400);
  const raw = body.libraryIds;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new BadRequestError('Field "libraryIds" must be an array of strings.');
  }
  const scope = BaseRoute.getScope(c);
  const config = scope.get(Tokens.AppConfig);
  if (raw.length > config.getMaxLibraries()) {
    throw new ConflictError(`A user may be granted at most ${config.getMaxLibraries()} libraries.`);
  }
  await (await scope.get(Tokens.UserDAO)()).setLibraryGrants(id, raw as string[]);
  return json(c, { ok: true });
}

async function whoami(c: C): Promise<Response> {
  return json(c, { email: c.get('AdminEmail'), workerId: UUIDUtil.getRandomUUID() });
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
  get: (path: string, handler: (c: C) => Promise<Response>) => unknown;
  post: (path: string, handler: (c: C) => Promise<Response>) => unknown;
  patch: (path: string, handler: (c: C) => Promise<Response>) => unknown;
  delete: (path: string, handler: (c: C) => Promise<Response>) => unknown;
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

export { BaseRoute, registerAdminRoutes };
export type { AdminContext, WorkerEnv };
