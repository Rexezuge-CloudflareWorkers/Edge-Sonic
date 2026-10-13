/**
 * Namespaced logging.
 *
 * `createLogger`, `isLogLevel` and `setLogLevel` are `@rexezuge/runtime`'s. The
 * two behaviours this file used to carry went into the kit, and both were
 * properties of the logger rather than of this product:
 *
 * ### The level is read per emit, not per construction
 *
 * Both of this product's loggers are module-level `const`s — `KvCache` and
 * `embeddedArt` each call `createLogger('…')` at import time. In a Worker, `env`
 * does not exist at module scope, so a level resolved in the constructor could
 * only ever come from `process.env`, which workerd does not have: the level was
 * permanently `info` and `logger.debug` could never emit in a deployed Worker.
 * `LOG_LEVEL` shipped as `"info"` in the wrangler template, was validated by
 * nothing, and was inert — an operator who set it to `debug` to diagnose the very
 * outage the knob exists for got silence. The coverage report proved it: every
 * `console.*` in the old file sat in an arm that only ran at `minLevel <= 0`.
 *
 * ### The message is a separate argument, and that is not cosmetic
 *
 * Cloudflare's log pipeline only indexes JSON fields for **non-string** arguments.
 * Folding a message into the prefix flattens it into one opaque blob and its
 * fields become unqueryable — so the kit's logger keeps the prefix first and
 * passes everything else as its own `console` argument.
 *
 * ### The third source in the chain
 *
 * `setLogLevel` is the kit's, and the request scope publishes to it once per
 * request. It ranks **below** an injected `env` and below `process.env`, so an
 * explicit scope outranks a process-wide default and a developer's shell outranks
 * both; only what neither can answer falls through to it.
 */
export { createLogger, isLogLevel, setLogLevel } from '@rexezuge/runtime';
export type { LogLevel, Logger } from '@rexezuge/runtime';
