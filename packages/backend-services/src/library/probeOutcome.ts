/**
 * What a probe failure is, in terms an operator can act on.
 *
 * ### Why this is its own module
 *
 * `LibraryService.probe` had one `catch` and one sentence. Every failure without an
 * HTTP status became *"Library is unreachable."* — a claim about the operator's
 * WebDAV server that is false for three of the four causes:
 *
 * | Cause                                        | Reported as          | The actual fix                |
 * | -------------------------------------------- | -------------------- | ----------------------------- |
 * | `resolveKey` refused (no Secrets Store key)   | unreachable          | provision the secret          |
 * | `decryptData` failed (key rotated)            | unreachable          | re-enter the DAV password     |
 * | `assertReachable` refused (SSRF policy)       | unreachable          | `ALLOW_PRIVATE_WEBDAV_HOSTS`   |
 * | DNS / TLS / connection refused                | unreachable          | the network                   |
 *
 * The first two are faults in **this deployment** and the operator was told to go
 * debug someone else's server. A probe exists to shorten a diagnosis; collapsing
 * four causes into one sentence made the one diagnostic surface in the product
 * useless exactly when it was needed.
 *
 * ### What is deliberately absent
 *
 * No cause text, no upstream body, and no key material reach an operator. A GCM
 * auth failure's message names the operation and nothing else, and the upstream
 * body is attacker-influenced text, so the message is chosen here from the *shape*
 * of the failure rather than read out of it.
 */
import { NotFoundError, BadRequestError } from '@edge-sonic/backend-errors';

/**
The result of one probe. `status` is the origin's status when it answered, and
`null` when it never did — which is why it cannot be inferred from `ok`.
*/
interface ProbeOutcome {
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
}

/**
The origin answered. `207` is the only success a `PROPFIND` can return, and the
client refuses anything else, so the status is a constant rather than a lie about
a value that was never observed.
*/
function reachable(): ProbeOutcome {
  return { ok: true, status: 207, error: null };
}

/**
Map an HTTP status to the one thing the operator can do about it.

An unmapped status still produces a message: "the server responded 418" is
actionable where silence is not.
*/
function fromStatus(status: number): ProbeOutcome {
  return { ok: false, status, error: describeWebDavStatus(status) };
}

/**
`assertReachable` refused before any request was made.

Deliberately **not** folded into the unreachable case: the origin was never
contacted, so saying it was unreachable is a statement about something this server
chose not to do. The SSRF gate's own `NotFoundError` stays exactly as it is — it
is indistinguishable from a missing row on `/rest` on purpose — and only the way
the *operator* surface renders it changes.
*/
function policyBlocked(): ProbeOutcome {
  return {
    ok: false,
    status: null,
    error: 'This origin is now blocked by the private-host policy. Set ALLOW_PRIVATE_WEBDAV_HOSTS to permit it deliberately.',
  };
}

/**
A stored `base_url` that no longer parses.
*/
function malformedUrl(): ProbeOutcome {
  return { ok: false, status: null, error: 'The stored WebDAV URL is malformed. Re-enter the origin on the library.' };
}

/**
The stored credential could not be read — no key resolved, or the row was
encrypted under a key that no longer exists.

Distinct from every other failure because nothing about the origin was tested:
the request was never sent, and re-entering the password is the whole fix.
*/
function credentialUnreadable(): ProbeOutcome {
  return {
    ok: false,
    status: null,
    error:
      'This server cannot decrypt the stored WebDAV password. The WebDAV encryption key may have been rotated; re-enter the password on the library.',
  };
}

/**
The request went out and nothing came back. The one case where the sentence is
literally true.
*/
function unreachable(): ProbeOutcome {
  return { ok: false, status: null, error: 'Library is unreachable.' };
}

/**
Which domain a pre-request failure belongs to.

A `switch` on the error class rather than a message match, because the alternative
is a string comparison that a refactor can silently invert.
*/
function classifyBeforeRequest(error: unknown): ProbeOutcome {
  if (error instanceof NotFoundError) return policyBlocked();
  if (error instanceof BadRequestError) return malformedUrl();
  // `resolveKey` and `decryptData` are the two throws this can reach, and both
  // mean the same thing to an operator: the stored password is unreadable.
  return credentialUnreadable();
}

function describeWebDavStatus(status: number): string {
  if (status === 401) return 'The WebDAV username or password was rejected.';
  if (status === 403) return 'The WebDAV account may not read that path.';
  if (status === 404) return 'The library root path does not exist on the WebDAV server.';
  if (status === 408) return 'The WebDAV server did not answer before the timeout. A larger WEBDAV_TIMEOUT_MS may be needed.';
  if (status === 429) return 'The WebDAV server is rate limiting this worker.';
  return status >= 500 ? 'The WebDAV server returned a server error.' : `The WebDAV server responded ${status}.`;
}

export {
  reachable,
  fromStatus,
  policyBlocked,
  malformedUrl,
  credentialUnreadable,
  unreachable,
  classifyBeforeRequest,
  describeWebDavStatus,
};
export type { ProbeOutcome };
