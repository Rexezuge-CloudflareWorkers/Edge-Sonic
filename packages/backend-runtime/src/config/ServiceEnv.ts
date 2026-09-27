// Shared Edge-Sonic service env (Value Object).
//
// NOTE: D1 and KV are intentionally `unknown` here — `backend-runtime` (Layer 1)
// must not import `backend-data` (Layer 2) or the `cloudflare:workers` types.
// Narrow to `D1Queryable` / `KvNamespaceLike` at use sites.
//
// The per-feature secret bindings are Secrets Store bindings, not `vars`. They
// carry a `.get()` method, so their declared type is a structural interface
// rather than `string` — a mistake that typed them as `string` would compile and
// then resolve to `undefined` at runtime, turning every credential read into a
// silent failure. See `resolveKey` in `@edge-sonic/backend-services`.
interface SecretsStoreSecret {
  get(): Promise<string>;
}

interface ServiceEnv {
  DB: unknown;
  CACHE?: unknown;
  SUBSONIC_USER_ENCRYPTION_KEY_SECRET?: SecretsStoreSecret;
  WEBDAV_ENCRYPTION_KEY_SECRET?: SecretsStoreSecret;
  // Raw-key escape hatch for the integration pool and local dev without a Secrets
  // Store. TEST-ONLY: the production template does not declare these, and
  // `resolveKey` must never let them mask a broken production binding.
  SUBSONIC_USER_ENCRYPTION_KEY?: string;
  WEBDAV_ENCRYPTION_KEY?: string;
  DEBUG_MODE?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  SITE_URL?: string;
  MAX_LIBRARIES?: string;
  WEBDAV_TIMEOUT_MS?: string;
  SCAN_CHUNK_FOLDERS?: string;
  TAG_READ_BYTES?: string;
  MAX_PAGE_SIZE?: string;
  DEFAULT_PAGE_SIZE?: string;
  STREAM_RATE_LIMIT?: string;
  STREAM_TIMEOUT_MS?: string;
  AUTH_FAILURE_LIMIT?: string;
  AUTH_FAILURE_WINDOW_SECONDS?: string;
  ALLOW_PRIVATE_WEBDAV_HOSTS?: string;
  LOG_LEVEL?: string;
}

export type { ServiceEnv, SecretsStoreSecret };
