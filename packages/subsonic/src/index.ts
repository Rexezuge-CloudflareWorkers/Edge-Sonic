/**
 * `@edge-sonic/subsonic` — the Subsonic REST protocol, and nothing else.
 *
 * Layer 0: no `@edge-sonic/*` dependencies, no `fetch`, no D1, no KV. Everything
 * here is a pure function of its arguments, which is what makes the whole
 * protocol surface testable from the node suite with no Workers runtime and no
 * test doubles.
 *
 * The split that matters for the rest of the codebase:
 *
 * - `./params` parses *transport* (query string, form body, repeated params).
 * - `./ids` parses *untrusted IDs*.
 * - `./envelope` is the only way a response leaves the process.
 * - `./builders` is the only place a Subsonic field name is spelled.
 * - `./extensions` is the OpenSubsonic layer over it, kept separate so a reader can tell
 *   what the core protocol declares from what an extension-aware client reads.
 */
export * from './constants';
export * from './errors';
export * from './nodes';
export * from './serialize';
export * from './envelope';
export * from './params';
export * from './ids';
export * from './types';
export * from './builders';
export * from './extensions';
export { md5Hex, md5Bytes } from './md5';
