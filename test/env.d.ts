// The two names `@cloudflare/vitest-pool-workers` injects at runtime. Declared
// locally so the integration suite type-checks without depending on that package's
// types, which are not resolvable from an isolated `tsc` run.
declare module 'cloudflare:test' {
  export const SELF: Fetcher;
  export const env: Cloudflare.Env;
}

/**
 * Migrations injected by `test/integration/vitest.config.mts` as a **per-file map**,
 * not one blob, so a test can apply a prefix, seed rows, and then apply the rest.
 */
declare const __INTEGRATION_MIGRATIONS__: Record<string, string>;
