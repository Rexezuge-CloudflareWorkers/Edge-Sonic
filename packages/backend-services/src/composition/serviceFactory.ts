/**
 * Minimal structural env for scope creation, and the `resolveKey` policy.
 *
 * ### No index signature, on purpose
 *
 * `RequestScopeEnv` deliberately has no `[key: string]: unknown`. An interface with
 * one carries an implicit index signature, so it would make this type accept
 * *any* object — including a bare `{}` — and a typo in a binding name would
 * compile. Extra bindings remain assignable structurally, so `Env` still passes.
 *
 * ### `resolveKey`: the whole per-feature key policy, in one place
 *
 * Three rules, and each exists because of a specific failure:
 *
 * 1. **Secrets Store binding first.** That is where the key lives in production.
 * 2. **A raw `*_ENCRYPTION_KEY` var is a test-only escape hatch.** It exists so the
 *    integration pool and local `wrangler dev` work without a Secrets Store. It
 *    must never appear in the production template, and it must never *mask* a
 *    broken production binding.
 * 3. **Otherwise throw, fail closed.** A missing key means every stored credential
 *    is unrecoverable. Degrading to "no key, so no users can log in" silently is
 *    how a lost store turns into an unexplained "nobody's credentials work"
 *    support ticket instead of a clear configuration error.
 *
 * A *declared but unreadable* binding still throws, because `binding.get()`
 * rejecting is a broken production configuration and the var fallback must not
 * paper over it.
 */


import type { SubrequestMeter } from '@edge-sonic/shared';
import { isUsableKey } from '@edge-sonic/backend-data/crypto';

interface SecretsStoreSecret {
  get(): Promise<string>;
}

interface RequestScopeEnv {
  DB: unknown;
  CACHE?: unknown;
  SUBSONIC_USER_ENCRYPTION_KEY_SECRET?: SecretsStoreSecret;
  WEBDAV_ENCRYPTION_KEY_SECRET?: SecretsStoreSecret;
  SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET?: SecretsStoreSecret;
  /**
  The platform-provisioned Cloudflare Access binding.

  Declared here so it survives the trip from `c.env` into the request scope and on
  to `AccessAuthService`. It is not a wrangler declaration, so `wrangler types`
  never emits it — hence this hand-written structural shape, which a Layer 3
  package needs in any case.
  */
  ACCESS?: { getIdentity(): Promise<{ email?: string | null } | undefined> };
  /**
  Test-only. Never declared in the production template.
  */
  SUBSONIC_USER_ENCRYPTION_KEY?: string;
  /**
  Test-only. Never declared in the production template.
  */
  WEBDAV_ENCRYPTION_KEY?: string;
  /**
  Test-only remote key escape hatch. Never declared in the production template.
  */
  SUBSONIC_REMOTE_ENCRYPTION_KEY?: string;
  ENVIRONMENT?: string;
  SCAN_QUEUE?: unknown;
}

/**
A memoized key provider. Throws on use when unconfigured.
*/
type KeyProvider = () => Promise<string>;

/**
 * @param meter The invocation's counter, charged once per `binding.get()`. A Secrets Store read
 *   is a request to a Cloudflare service and therefore a subrequest like any other; it is
 *   memoized, so it is at most one per scope per key, but it is counted because "at most two"
 *   is a fact this file should not have to be trusted about — a third key and a third charge
 *   would appear with no test noticing.
 */
function resolveKey(
  binding: SecretsStoreSecret | undefined,
  rawVar: string | undefined,
  bindingName: string,
  varName: string,
  meter?: SubrequestMeter,
): KeyProvider {
  let pending: Promise<string> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      if (binding) {
        // Deliberately no fallback to `rawVar` on failure: a binding that throws is
        // a broken production configuration, and silently using a var instead
        // would produce credentials encrypted under a key nobody is tracking.
        meter?.charge(1, 'secret');
        const value = await binding.get();
        if (!isUsableKey(value)) {
          throw new Error(`${bindingName} is present but is not a 32-byte base64 key.`);
        }
        return value;
      }
      if (rawVar) {
        if (!isUsableKey(rawVar)) {
          throw new Error(`${varName} is set but is not a 32-byte base64 key.`);
        }
        return rawVar;
      }
      throw new Error(
        `${bindingName} is not configured for this scope. ` +
          `Set the Secrets Store binding in production, or ${varName} for tests.`,
      );
    })();
    // A rejection must not be cached: the next call retries, so a transient
    // Secrets Store failure does not poison the whole request scope.
    pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
}

export { resolveKey,  };
export type { RequestScopeEnv, SecretsStoreSecret, KeyProvider,  };

export {KvCache, type KvNamespaceLike} from '@edge-sonic/backend-runtime/kv';