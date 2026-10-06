/**
 * The Danger Zone's routes: what a drop costs, and performing it.
 *
 * Its own module rather than more handlers in `user/routes.ts`, which is at the god-file warn
 * threshold, and for a second reason — `librarySummary.ts` was split out for the same reason
 * and the pattern is established here rather than being the second departure from a convention.
 *
 * ### Why these are `POST`s
 *
 * For the reason `probe` and `scan/step` are: two of the three do live outbound work or write
 * to the day's allowance, and a `GET` a link — or a prefetcher — can trigger is a `GET` none
 * of them should be. The cost projection is a `GET` because it is a pure read of counts, but
 * it is registered as one **only** because it cannot mutate; `IndexStatsDAO` has no write
 * method, which is asserted rather than assumed.
 *
 * ### The confirmation is the operator's, not the server's
 *
 * There is no confirmation token here. Every caller of `/user/*` is already an operator — the
 * Cloudflare Access application **is** the authorization boundary, and `users.is_admin` is
 * written but read only to render a badge. A server-side "are you sure" gate would be a second
 * authorization model with no second authority behind it.
 *
 * So the two-step confirmation lives entirely in the SPA, and what this side owes is
 * **honesty about cost**: the figure in the dialog comes from the same `billedRowsForTable`
 * that will charge the delete, so what the operator consents to is what they pay.
 */
import { Tokens } from '@edge-sonic/backend-services/composition';
import { BadRequestError } from '@edge-sonic/backend-errors';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { UserContext } from '../endpoints/BaseRoute';

/**
 * Read a path parameter the route pattern guarantees exists.
 *
 * `c.req.param` is typed `string | undefined`, and a `!` at the call site would hide the real
 * question — which is that an absent id must not become the string `"undefined"` and query for
 * it. `user/routes.ts` has the identical helper; it is written out here rather than imported
 * because `routes.ts` is at the god-file warn threshold, this is a fourth concern that belongs
 * in its own module, and a four-line duplication is a cheaper thing for the next reader to
 * compare than a cross-module import to follow.
 */
function requireParam(c: UserContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new BadRequestError(`Missing path parameter "${name}".`);
  }
  return value;
}

/**
 * What dropping every library's index would cost, per library and in total.
 *
 * The shape carries **both** the per-library rows and the total because the Danger Zone
 * renders a row per library *and* a global action, and the two have to agree: the global
 * confirm phrase is agreed against a sum of the same numbers the per-library rows show. Two
 * endpoints would be two answers to "what does this cost", and the one an operator consents
 * to would be whichever they happened to read.
 */
async function indexStats(c: UserContext): Promise<Response> {
  const scope = BaseRoute.getScope(c);
  const libraryIds = (await scope.get(Tokens.LibraryService).listAll()).map((library) => library.id);
  const stats = await scope.get(Tokens.IndexDropService).statsAcrossLibraries(libraryIds);
  return c.json({
    libraries: stats.libraries.map((entry) => ({
      libraryId: entry.libraryId,
      songs: entry.stats.songs,
      nodes: entry.stats.nodes,
      scanStates: entry.stats.scanStates,
      billedRows: entry.stats.billedRows,
    })),
    total: stats.total,
  });
}

/**
 * Drop one library's index.
 *
 * The library row and its encrypted WebDAV credential **survive** — that is what separates
 * this from `DELETE /user/libraries/:id`, which cascades and takes the credential with it. The
 * per-user annotations survive too, because a song id is derived from `(libraryId, path)` and a
 * rescan recreates it byte-identically, so every star and play count re-attaches.
 *
 * A 404 for an unknown id rather than a silent success, because an operator who mistypes and
 * is told "done" will press Rescan and find the index they meant to drop still there.
 */
async function dropLibraryIndex(c: UserContext): Promise<Response> {
  const id = requireParam(c, 'id');
  const scope = BaseRoute.getScope(c);
  const service = scope.get(Tokens.LibraryService);
  // `some`, not `find`: the row itself is not used, only its existence. `deleteLibrary` below in
  // `routes.ts` binds the row because `LibraryService.delete` takes an id and validating it is
  // what it does — here the existence check is the whole reason this read is here at all.
  if ((await service.listAll()).every((candidate) => candidate.id !== id)) return BaseRoute.jsonError(c, 'Library not found.', 404);
  const outcome = await scope.get(Tokens.IndexDropService).dropLibrary(id);
  return c.json({ ok: true, ...outcome });
}

/**
 * Drop **every** library's index, leaving every registration in place.
 *
 * No path parameter and no body, so the scope of the destruction is the route itself — which
 * is why the SPA's confirm phrase for this one is a literal (`drop-all-index`) rather than a
 * library name. There is nothing in the request to name the thing being destroyed, so the
 * operator types the fact that everything is.
 *
 * `libraryIds` is read here rather than inside the service: the list is needed to stop every
 * scan object before the deletes, and the request already has a `LibraryService` in hand.
 */
async function dropAllIndexes(c: UserContext): Promise<Response> {
  const scope = BaseRoute.getScope(c);
  const libraryIds = (await scope.get(Tokens.LibraryService).listAll()).map((library) => library.id);
  const outcome = await scope.get(Tokens.IndexDropService).dropAll(libraryIds);
  return c.json({ ok: true, ...outcome });
}

/**
 * Register the Danger Zone routes.
 *
 * Registered **before** `registerUserRoutes` and after nothing that could be shadowed:
 * `/user/index/stats` and `/user/index/drop` share a static second segment, so neither can
 * capture the other, and both sit outside the `/user/libraries/:id` and `/user/import/*`
 * families entirely. The comment in `user/routes.ts` about `/user/import/:id` shadowing
 * `/user/import/sources` is about a `:id` under a prefix this shares, and there is none here.
 *
 * `registerUserRoutes` takes an `app` with a fixed method set; this module declares the same
 * shape rather than widening it, because the registration order between the two modules is
 * asserted in `test/user-api.test.ts` and a wider type would let a future caller add a method
 * the worker's app happens to have without noticing it is not part of the contract.
 */
function registerIndexDropRoutes(app: {
  get: (path: string, handler: (c: UserContext) => Promise<Response>) => unknown;
  post: (path: string, handler: (c: UserContext) => Promise<Response>) => unknown;
}): void {
  app.get('/user/index/stats', indexStats);
  app.post('/user/index/drop', dropAllIndexes);
  /**
   * Per-library. A `POST` for the reason `dropAllIndexes` is one, and **not** a `DELETE` on
   * the library: `DELETE /user/libraries/:id` already exists and means "forget this origin and
   * its credential", so a `DELETE` on a sub-path of the same resource would give two
   * destructive routes under one id that differ in whether the operator has to re-enter a
   * password. Different verb, same reason the projection is a `GET` and the drop is a `POST`:
   * the shape says what happens to the registration.
   */
  app.post('/user/libraries/:id/index/drop', dropLibraryIndex);
}

export { registerIndexDropRoutes };
