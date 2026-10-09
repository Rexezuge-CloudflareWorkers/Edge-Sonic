/**
 * Registered remote Subsonic instances, and the one place a stored credential becomes a client.
 *
 * ### Why this is a service and not route code
 *
 * **Because `apps/api` may not import `backend-data` values.** The layering rule
 * (`no-restricted-imports`) says a route reaches storage through a service, and
 * `LibraryService` has always owned the DAV credential's encrypt/decrypt for exactly that
 * reason. An import route that decrypted its own password would be the first thing in
 * `apps/api/src/user/` to hold a key.
 *
 * And the reason is not tidiness: **the credential would be read in two places.** The route
 * needs it to list the remote's playlists before the Workflow starts, and the workflow needs
 * it again per step — and a workflow payload is persisted by the platform, so a password can
 * never be part of one. Two readers of one stored secret is two implementations of "decrypt
 * it", free to disagree about which key, and the disagreement is a credential that decrypts in
 * one place and not the other.
 *
 * So this module owns both halves: {@link ImportSourceService.register} encrypts under the
 * **third** key, and {@link ImportSourceService.clientFor} is the only reader.
 *
 * ### The key is the third one, and never merged
 *
 * Two keys already exist because they guard different things with different exposure: the user
 * key can mint a valid Subsonic token for any account, and the WebDAV key is read on every
 * scan and every stream. A remote Subsonic credential is a third thing again — operator-supplied,
 * re-entered per source, granting read access to a whole other library — so rotating it must not
 * require re-entering any user's password, and a compromise of the most-read key must not yield
 * it. Merging any two would destroy a property invisibly.
 */
import { ConflictError, NotFoundError } from '@edge-sonic/backend-errors';
import { decryptData, encryptData } from '@edge-sonic/backend-data/crypto';
import { assertRemoteReachable, normalizeRemoteBaseUrl, normalizeRemoteUsername, normalizeSourceName } from './remoteOrigin';
import { RemoteSubsonicClient } from './remoteClient';
import type { ImportSourceRow } from '@edge-sonic/backend-data/dao';

interface SourceStore {
  findById(id: string): Promise<ImportSourceRow | null>;
  findByUsername(username: string): Promise<ImportSourceRow | null>;
  listSummaries(): Promise<ReadonlyArray<Omit<ImportSourceRow, 'password_ciphertext' | 'password_iv' | 'username_ci'>>>;
  create(input: {
    name: string;
    baseUrl: string;
    username: string;
    passwordCiphertext: string;
    passwordIv: string;
    musicFolderId: string | null;
  }): Promise<ImportSourceRow>;
  delete(id: string): Promise<void>;
}

class ImportSourceService {
  constructor(
    private readonly deps: {
      /**
       * A **thunk**, not the DAO.
       *
       * The same laziness every DAO binding in `requestScope.ts` uses, and for the same reason:
       * the bindings run while the container is still being populated, so a DAO constructed
       * eagerly would be built before the scope finished assembling itself. It also means this
       * service holds no statement handle for longer than a single call.
       */
      readonly sources: () => Promise<SourceStore>;
      /**
      The third key, memoized by the composition root.
      */
      readonly resolveKey: () => Promise<string>;
      readonly allowPrivateHosts: () => boolean;
      /**
       * How a client charges the invocation's subrequest meter.
       *
       * A **function**, not the meter, so this module holds no counter of its own. Two counters
       * would be two numbers that disagree — which is the defect the whole budget mechanism was
       * rebuilt to remove — and the client's `onRequest` hook is invoked inside its own request
       * path, so a charge per call site is a dozen chances to forget one and a forgotten charge
       * is invisible until the platform terminates the invocation.
       */
      readonly onRequest: () => void;
      readonly timeoutMs?: number;
    },
  ) {}

  /**
   * Register an instance.
   *
   * The order is the claim and is asserted through the HTTP surface: **normalize before the
   * credential is touched**, so a URL the SSRF gate refuses costs no key read and no exposure. A
   * form that encrypted first would spend a Secrets Store read on every rejected attempt — and
   * the gate would still be correct, so nothing downstream could see the difference.
   */
  public async register(input: {
    name: string;
    baseUrl: string;
    username: string;
    password: string;
    musicFolderId?: string | null;
  }): Promise<{ id: string; name: string; baseUrl: string }> {
    const name = normalizeSourceName(input.name);
    const baseUrl = normalizeRemoteBaseUrl(input.baseUrl, this.deps.allowPrivateHosts());
    const username = normalizeRemoteUsername(input.username);

    // Unique on the **username**, which is what the index is on: two sources may share a name,
    // and two sharing a *credential* is what would quietly import one server's data into
    // another's.
    //
    // A **`ConflictError`**, not a `BadRequestError`, and the distinction is the whole reason
    // this service exists rather than the route doing it: a caller that maps one error *class* to
    // one status turns "that URL is not allowed" into a 409 along with "that account is already
    // registered". So the class carries the status, and the route does not re-decide it.
    if (await (await this.deps.sources()).findByUsername(username)) {
      throw new ConflictError(`An import source for the user "${username}" already exists.`);
    }

    const key = await this.deps.resolveKey();
    const encrypted = await encryptData(input.password, key);
    const created = await (
      await this.deps.sources()
    ).create({
      name,
      baseUrl,
      username,
      passwordCiphertext: encrypted.ciphertext,
      passwordIv: encrypted.iv,
      musicFolderId: input.musicFolderId ?? null,
    });

    // Only the three display fields. The ciphertext is not merely omitted from the response, it
    // was never selected — and that is the difference between a projection and a filter in a
    // route, which a later edit could forget.
    return { id: created.id, name: created.name, baseUrl: created.base_url };
  }

  /**
   * Every registered instance, **without** any credential.
   *
   * A projection rather than `findById` per row: the ciphertext is not needed to render a list,
   * so it is not selected.
   */
  public async list(): Promise<ReadonlyArray<Omit<ImportSourceRow, 'password_ciphertext' | 'password_iv' | 'username_ci'>>> {
    return await (await this.deps.sources()).listSummaries();
  }

  /**
   * Delete an instance.
   *
   * Cascades to its runs and through them to their reports, and that is stated because it is
   * the one delete in this API that removes the operator's record of what happened: a report is
   * the only place a partially-completed import is written down, including which songs it could
   * not match.
   *
   * The `404` is explicit rather than a no-op success, so a client that deleted a source twice
   * can tell the second attempt did nothing.
   */
  public async remove(id: string): Promise<void> {
    if ((await (await this.deps.sources()).findById(id)) === null) throw new NotFoundError('Import source not found.');
    await (await this.deps.sources()).delete(id);
  }

  /**
   * A client for a stored source — or, explicitly, **which** refusal there was.
   *
   * ### Why a discriminated result rather than `null` or a throw
   *
   * Because there are **two** refusals and they are not the same thing:
   *
   * - the row is **gone** — a `DELETE`, or a cascade with the run — and there is nothing to retry;
   * - the host is **no longer permitted**, because an operator tightened
   *   `ALLOW_PRIVATE_WEBDAV_HOSTS` after the run started. The row is fine and the URL is fine.
   *
   * A method that answered `null` for one and threw for the other made every caller **guess**:
   * the Durable Object wrote `client === null` and so believed it covered both, while a tightening
   * arrived as a thrown `NotFoundError` that its `alarm` catch swallowed into a generic
   * "could not read the import source" — the walk re-armed and retried a host the policy had just
   * refused, for ever, with the real reason discarded.
   *
   * So the answer names the refusal, and each caller states what it does with each. That is the
   * whole point of a union over two booleans: the caller cannot handle one case and believe it
   * handled the other.
   */
  public async clientFor(
    sourceId: string,
  ): Promise<{ readonly ok: true; readonly client: RemoteSubsonicClient } | { readonly ok: false; readonly reason: string }> {
    const source = await (await this.deps.sources()).findById(sourceId);
    if (source === null) {
      // Not named as "the host is refused", because it is not: there is no host left to judge.
      return { ok: false, reason: 'The import source no longer exists.' };
    }

    // Re-checked on **read**, every time, because the policy can change after a row is written and
    // an operator who tightens it must not leave an existing private origin usable by a run that
    // is already in flight.
    try {
      assertRemoteReachable(source, this.deps.allowPrivateHosts());
    } catch {
      // The refusal's own message is deliberately **not** propagated: `assertRemoteReachable`
      // answers `NotFoundError('Import source not found.')` to avoid telling a caller that a row
      // exists whose URL they may no longer use, and repeating that sentence into a run report
      // would defeat the point — a report is read by the operator, but it is also served by
      // `GET /user/import/:id`, and the two must not be distinguishable to whoever calls it.
      return { ok: false, reason: 'The import source’s host is no longer permitted by this deployment’s SSRF policy.' };
    }

    const key = await this.deps.resolveKey();
    const password = await decryptData(source.password_ciphertext, source.password_iv, key);
    return {
      ok: true,
      // Constructed **per call**, never cached: it holds the plaintext password for its lifetime,
      // and a client that outlives the request that made it is a plaintext credential in a
      // longer-lived scope — a field, or a Workflow instance hibernating between steps.
      client: new RemoteSubsonicClient({
        baseUrl: source.base_url,
        username: source.username,
        password,
        timeoutMs: this.deps.timeoutMs ?? 10_000,
        onRequest: this.deps.onRequest,
      }),
    };
  }
}

export { ImportSourceService };
export type { SourceStore };
