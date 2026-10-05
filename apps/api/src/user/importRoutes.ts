/**
 * `/user/import/*` — registering a remote Subsonic instance, and running an import from it.
 *
 * ### Why this is on `/user` and not `/rest`
 *
 * `/rest` authenticates with a Subsonic credential and answers the protocol; `/user` sits behind
 * Cloudflare Access and is the operator surface. An import is an **operator action** — it needs a
 * remote credential, a chosen target account, and a decision about which categories to move — and
 * none of the three is expressible in the protocol. So it lives here, and every route reads the
 * Access identity rather than a Subsonic credential.
 *
 * ### The route holds no credential, and that is a layer rule rather than a style choice
 *
 * `apps/api` may not import `backend-data` values (`no-restricted-imports`): a route reaches
 * storage through a service. `LibraryService` has always owned the DAV credential's encrypt and
 * decrypt for that reason, and `ImportSourceService` owns this one.
 *
 * The reason is not tidiness. **The credential is read from two places** — here, to list the
 * remote's playlists before the Workflow starts, and inside the Workflow, per step, because a
 * Workflow payload is persisted by the platform and a password can never be part of one. Two
 * readers of one stored secret is two implementations of "decrypt it", free to disagree about
 * which key, and the disagreement is a credential that decrypts in one place and not the other.
 * So both go through {@link ImportSourceService.clientFor}.
 *
 * ### Every route that performs work is a `POST`
 *
 * For the reason `probeLibrary` and `stepScan` are. A `GET` a link can trigger is a `GET` a
 * prefetcher can trigger, and starting an import spends a day's D1 row-write allowance.
 *
 * ### The preconditions are refusals, not waits
 *
 * An import refuses to start while any library is scanning, and while another import is in flight
 * against the same user. Both are about **not writing rows** rather than about a conflict in the
 * ordinary sense: since 2026-09-01 an account over its 5,000-rows/day allowance has *every* query
 * fail until midnight UTC, so two writers racing for the last rows take the whole product down,
 * `/rest` authentication included, and the remedy is a clock rather than a change.
 *
 * A wait would be worse than either. An import that waited would hold an HTTP request open for as
 * long as the scan took, against the same client timeout the scan's own deadline exists for — and
 * the operator's answer to "it did nothing" would be to press the button again.
 */
import { BadRequestError } from '@edge-sonic/backend-errors';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { IMPORT_PHASES, assertScansIdle, isImportInFlight, parseReport } from '@edge-sonic/backend-services/import';
import type { ImportPhase, RemoteSubsonicClient } from '@edge-sonic/backend-services/import';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { UserContext } from '../endpoints/BaseRoute';

/**
 * The most remote playlist ids one import may carry.
 *
 * A bound rather than a limit on the remote: each becomes a **Workflow step**, and Workflows Free
 * allows 1,024 per instance. Truncating is the honest direction — the report names the playlists
 * that were not read, rather than a step budget quietly exceeded with no error.
 */
const MAX_PLAYLIST_IDS = 500;

function requireString(body: Record<string, unknown>, name: string, max: number): string {
  return BaseRoute.requireString(body, name, max);
}

/**
 * A path parameter the route pattern guarantees exists.
 *
 * `c.req.param` is typed `string | undefined`, and a `!` at each call site would hide the real
 * question — which is that an absent id must not become the string `"undefined"` and be queried
 * for. The same helper `user/routes.ts` uses, for the same reason.
 */
function requirePathParam(c: UserContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new BadRequestError(`Missing path parameter "${name}".`);
  }
  return value;
}

/**
 * `POST /user/import/sources` — register a remote instance.
 *
 * Every field here is a secret or a destination for one, and the route passes them on without
 * reading any of them again: the service normalizes, encrypts and stores. A password that came
 * back in the response would be a credential this surface had no reason to hold twice.
 */
async function createSource(c: UserContext): Promise<Response> {
  const { malformed, oversized, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return BaseRoute.jsonError(c, 'Request body is not valid JSON.', 400);
  if (oversized) return BaseRoute.jsonError(c, 'Request body is too large.', 413);

  // Thrown, not caught. `BaseRoute.toErrorResponse` is the documented single way a `/user` route
  // answers a failure, and the **error class** carries the status: a `BadRequestError` from the
  // SSRF gate is a 400 and a `ConflictError` from the uniqueness check is a 409.
  //
  // Catching here and mapping by class would have been the same mistake in miniature — it makes
  // one class mean one status, so "that URL is not allowed" and "that account is already
  // registered" would arrive under one number, and the operator would read a rejected URL as a
  // conflict they should resolve by renaming.
  const created = await BaseRoute.getScope(c).get(Tokens.ImportSourceService).register({
    name: requireString(body, 'name', 64),
    baseUrl: requireString(body, 'baseUrl', 2048),
    username: requireString(body, 'username', 256),
    password: requireString(body, 'password', 256),
    musicFolderId: BaseRoute.optionalString(body, 'musicFolderId', 64),
  });

  return c.json(created, 201);
}

/**
`GET /user/import/sources` — the registered instances, **without** their credentials.
*/
async function listSources(c: UserContext): Promise<Response> {
  return c.json({ sources: await BaseRoute.getScope(c).get(Tokens.ImportSourceService).list() });
}

/**
 * `DELETE /user/import/sources/:id`.
 *
 * Cascades to the runs and through them to their reports. Stated because it is the one delete in
 * this API that removes the operator's record of what happened: a report is the only place a
 * partially-completed import is written down, including which songs it could not match.
 */
async function deleteSource(c: UserContext): Promise<Response> {
  await BaseRoute.getScope(c).get(Tokens.ImportSourceService).remove(requirePathParam(c, 'id'));
  return c.json({ ok: true });
}

/**
 * The remote's playlist ids, read once so the Workflow's step names are stable.
 *
 * Read **here** rather than inside the workflow, because a step name is a **cache key**:
 * `playlist <remoteId>` has to be nameable before the first step runs, and re-listing inside the
 * workflow would make the names depend on a call whose result is not part of the payload.
 *
 * A failure is **not** fatal to the import — the other four categories do not need this list — so
 * it yields `[]` and the playlist phase reports nothing, rather than failing a whole run because a
 * remote refused one call. An operator who asked for playlists then sees a playlist phase with
 * nothing in it, and every other category still lands.
 */
async function listRemotePlaylistIds(client: RemoteSubsonicClient): Promise<string[]> {
  try {
    return (await client.getPlaylists())
      .map((playlist) => playlist.id)
      .slice(0, MAX_PLAYLIST_IDS);
  } catch (error) {
    console.error('[import] could not list the remote playlists; the playlist phase will report nothing');
    console.error(error);
    return [];
  }
}

/**
 * `POST /user/import` — start an import.
 *
 * Two refusals before any work, and both are about **not writing rows** rather than about a
 * conflict in the ordinary sense: a scan is running, or another import is in flight against the
 * same user. See this module's header for why that is an outage and not a slow response.
 */
async function startImport(c: UserContext): Promise<Response> {
  const { malformed, oversized, body } = await BaseRoute.readJson<Record<string, unknown>>(c);
  if (malformed) return BaseRoute.jsonError(c, 'Request body is not valid JSON.', 400);
  if (oversized) return BaseRoute.jsonError(c, 'Request body is too large.', 413);

  const scope = BaseRoute.getScope(c);
  const runs = await scope.get(Tokens.ImportRunDAO)();
  const sources = scope.get(Tokens.ImportSourceService);

  const sourceId = requireString(body, 'sourceId', 64);
  // Built here **and again inside the workflow**, from the same stored row, by the same service —
  // so the two reads cannot disagree about the key or about whether the host is still permitted.
  //
  // **Both refusals answer one 404**, deliberately. The service tells them apart for the callers
  // that can act on the difference; over HTTP it is not actionable and saying which it is would
  // leak that a row exists whose URL the caller may no longer use — the same reasoning
  // `assertRemoteReachable` applies.
  const opened = await sources.clientFor(sourceId);
  if (!opened.ok) return BaseRoute.jsonError(c, 'Import source not found.', 404);

  const targetUserId = requireString(body, 'targetUserId', 64);
  const target = await (await scope.get(Tokens.UserDAO)()).findById(targetUserId);
  if (target === null) return BaseRoute.jsonError(c, 'Target user not found.', 404);
  if (target.is_enabled !== 1) {
    // A disabled account cannot authenticate, so its imported data would be invisible to it and
    // to the operator watching the run. Said here rather than discovered at the end of a walk.
    return BaseRoute.jsonError(c, 'The target user is disabled, so nothing imported would be reachable.', 409);
  }

  // One statement for every library's scan state, not one per library. `listByLibraries` exists
  // for this question and is a **read** — `ensure` would turn this into a write per library, on a
  // POST that already spends the day's row allowance.
  //
  // Converted to an array so `assertScansIdle` sees the same shape whatever feeds it: `null` for
  // a library never scanned, which must not read as "scanning".
  await assertScansIdle({
    listAll: async () => {
      const libraries = await scope.get(Tokens.LibraryService).listAll();
      const states = await (await scope.get(Tokens.ScanStateDAO)()).listByLibraries(libraries.map((library) => library.id));
      return libraries.map((library) => states.get(library.id) ?? null);
    },
  });

  const existing = await runs.findRunningForUser(targetUserId);
  if (isImportInFlight(existing)) {
    return BaseRoute.jsonError(c, 'An import is already running for that user. Wait for it to finish before starting another.', 409);
  }

  // The library is resolved against one library's grants. A user granted two gets their imports
  // matched against one, and the unmatched tracks appear in the report rather than silently
  // resolving somewhere else — which is stated rather than hidden because `matchRemoteSongs`
  // scopes every lookup to one library by design.
  const libraryId = BaseRoute.optionalString(body, 'libraryId', 64) ?? (await scope.get(Tokens.LibraryService).listForUser(targetUserId))[0]?.id;
  if (libraryId === undefined) {
    return BaseRoute.jsonError(c, 'The target user has no granted library, so no imported song could be matched.', 409);
  }

  const phases = readPhases(body.phases);
  const run = await runs.create({ sourceId, targetUserId, phases });
  const playlistIds = await listRemotePlaylistIds(opened.client);

  const workflow = (c.env as unknown as { IMPORT_WORKFLOW?: Workflow<unknown> }).IMPORT_WORKFLOW;
  if (workflow === undefined) {
    // No binding configured — tests, local dev. The run is still recorded and its reason stored,
    // so the refusal is visible in the operator's list rather than being an error with no row.
    await runs.update(run.id, { status: 'failed', lastError: 'No import workflow binding is configured on this deployment.' });
    return BaseRoute.jsonError(c, 'Imports are not available on this deployment: no import workflow is configured.', 501);
  }

  const instance = await workflow.create({
    id: run.id,
    // The **run id** and the ids the steps are named after. Never the password: a Workflow payload
    // is persisted by the platform, and the workflow re-reads the source through the same service.
    params: { runId: run.id, sourceId, userId: targetUserId, libraryId, phases, playlistIds },
  });
  await runs.update(run.id, { workflowId: instance.id, status: 'running', lastError: null });
  return c.json({ id: run.id, workflowId: instance.id, phases }, 202);
}

/**
 * The phases the operator asked for.
 *
 * **Defaulted without the play queue.** A saved queue is transient state — the person who has just
 * moved servers does not want yesterday's half-finished queue restored — and a default-on would
 * import it without anybody deciding to.
 *
 * An unrecognised phase is a **refusal**, not a skip: silently dropping a category an operator
 * named is the same failure as silently dropping a song, one level up. The report would show four
 * phases imported and no mention of the fifth that was asked for.
 */
function readPhases(raw: unknown): ImportPhase[] {
  if (raw === undefined) return IMPORT_PHASES.filter((name) => name !== 'playQueue');
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new BadRequestError('Field "phases" must be an array of strings.');
  }
  const unknown = (raw as string[]).filter((name) => !IMPORT_PHASES.includes(name as ImportPhase));
  if (unknown.length > 0) {
    throw new BadRequestError(
      `Unknown import phase${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Known phases are ${IMPORT_PHASES.join(', ')}.`,
    );
  }
  return raw as ImportPhase[];
}

/**
 * `GET /user/import/:id` — a run's status and its report.
 *
 * A **read**, and that is the point: the operator's page *polls* this while an import runs, and a
 * status read that wrote would spend the allowance it is reporting on. A write here is the same
 * defect `ScanStateDAO.ensure` caused on the libraries page, one surface over.
 */
async function importStatus(c: UserContext): Promise<Response> {
  const runId = requirePathParam(c, 'id');
  const runs = await BaseRoute.getScope(c).get(Tokens.ImportRunDAO)();
  const run = await runs.findById(runId);
  if (run === null) return BaseRoute.jsonError(c, 'Import run not found.', 404);

  const progress = await (await BaseRoute.getScope(c).get(Tokens.ImportPlayCountProgressDAO)()).read(runId);
  return c.json({
    id: run.id,
    status: run.status,
    lastError: run.last_error,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    playCounts: progress === null ? null : { albumsDone: progress.albums_done, songsImported: progress.songs_imported },
    report: parseReport(await runs.readReport(runId)),
  });
}

/**
`GET /user/import` — the runs, newest first.
*/
async function listImports(c: UserContext): Promise<Response> {
  const scope = BaseRoute.getScope(c);
  // One source read for the whole list rather than one per row: a page of runs is one request,
  // and an N+1 here is unbounded work inside it.
  const names = new Map((await scope.get(Tokens.ImportSourceService).list()).map((source) => [source.id, source.name]));
  return c.json({ runs: await (await scope.get(Tokens.ImportRunDAO)()).listRecent(20, names) });
}

/**
 * Register the routes.
 *
 * Order matters within this module: `GET /user/import/:id` would shadow
 * `GET /user/import/sources` if it were registered first, and a route table where one entry
 * silently captures another's is one nothing tests.
 */
function registerImportRoutes(app: {
  get: (path: string, handler: (c: UserContext) => Promise<Response>) => unknown;
  post: (path: string, handler: (c: UserContext) => Promise<Response>) => unknown;
  delete: (path: string, handler: (c: UserContext) => Promise<Response>) => unknown;
}): void {
  app.get('/user/import/sources', listSources);
  app.post('/user/import/sources', createSource);
  app.delete('/user/import/sources/:id', deleteSource);
  app.get('/user/import', listImports);
  app.post('/user/import', startImport);
  app.get('/user/import/:id', importStatus);
}

export { registerImportRoutes, readPhases, listRemotePlaylistIds, requirePathParam, MAX_PLAYLIST_IDS };