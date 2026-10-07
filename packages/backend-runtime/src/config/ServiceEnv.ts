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
  SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET?: SecretsStoreSecret;
  // Raw-key escape hatch for the integration pool and local dev without a Secrets
  // Store. TEST-ONLY: the production template does not declare these, and
  // `resolveKey` must never let them mask a broken production binding.
  SUBSONIC_USER_ENCRYPTION_KEY?: string;
  WEBDAV_ENCRYPTION_KEY?: string;
  SUBSONIC_REMOTE_ENCRYPTION_KEY?: string;
  ENVIRONMENT?: string;
  DEBUG_MODE?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  DEMO_USER_EMAIL?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  SITE_URL?: string;
  MAX_LIBRARIES?: string;
  WEBDAV_TIMEOUT_MS?: string;
  SCAN_CHUNK_FOLDERS?: string;
  SCAN_CHUNK_MAX_REQUESTS?: string;
  SCAN_CHUNK_DEADLINE_MS?: string;
  TAG_READ_BYTES?: string;
  TAG_READ_TAIL_BYTES?: string;
  SCAN_ENRICH_MAX_PER_FOLDER?: string;
  MAX_PAGE_SIZE?: string;
  DEFAULT_PAGE_SIZE?: string;
  /**
   * Which tracks are one album: `folder`, `album` or `album_artist`. Decided per deployment
   * rather than per request, because it is a property of how somebody's library is laid out
   * and no answer is right for both layouts. `@edge-sonic/subsonic` owns the vocabulary.
   */
  ALBUM_GROUP_BY?: string;
  /**
   * Appended to a path-derived artist or album name. Empty by default, which is what makes a
   * derived `X` and a tagged `X` the same album rather than two. It reaches `songs.artist`,
   * `songs.album` and their `_ci` twins, so it is not presentational in the sense of being
   * free: changing it re-derives every wholly-derived row. See `ConfigurationDefaults`.
   */
  DERIVED_MARKER?: string;
  STREAM_RATE_LIMIT?: string;
  STREAM_TIMEOUT_MS?: string;
  AUTH_FAILURE_LIMIT?: string;
  AUTH_FAILURE_WINDOW_SECONDS?: string;
  ALLOW_PRIVATE_WEBDAV_HOSTS?: string;
  LOG_LEVEL?: string;
}

export type { ServiceEnv, SecretsStoreSecret };
