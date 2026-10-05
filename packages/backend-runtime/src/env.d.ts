// Edge-Sonic binding shape for isolated package typechecks.
//
// `apps/api` additionally includes the generated `worker-configuration.d.ts` at the
// repository root and narrows to `Cloudflare.Env`, so this file exists purely so a
// Layer-1 package can be typechecked on its own. Bindings are `any` here rather
// than typed, because the real shapes come from Wrangler and asserting a second,
// hand-maintained copy of them is how the two drift apart.
//
// It declares `Env` and not `Cloudflare.Env` on purpose: `apps/api` uses the
// generated namespace explicitly, and a global `Env` alias is exactly the thing
// that makes a typo in a binding name compile.
declare global {
  interface EdgeSonicBindings {
    DB: unknown;
    CACHE?: unknown;
    SUBSONIC_USER_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> };
    WEBDAV_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> };
    /**
     * The third key, guarding a remote Subsonic instance's credential.

     * One per feature, never merged — see `migrations/0009_subsonic_import.sql` for why a
     * remote credential cannot live under the user key or the WebDAV key.
     */
    SUBSONIC_REMOTE_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> };
    SUBSONIC_USER_ENCRYPTION_KEY?: string;
    WEBDAV_ENCRYPTION_KEY?: string;
    SUBSONIC_REMOTE_ENCRYPTION_KEY?: string;
    ENVIRONMENT?: string;
    DEBUG_MODE?: string;
    SITE_URL?: string;
    TEAM_DOMAIN?: string;
    POLICY_AUD?: string;
    DEV_AUTH_EMAIL?: string;
    DEMO_MODE?: string;
    LOG_LEVEL?: string;
  }
}

export {};
