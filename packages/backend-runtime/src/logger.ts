/**
 * Namespaced logging.
 *
 * ### The message is a separate argument, and that is not cosmetic
 *
 * Cloudflare's log pipeline only indexes JSON fields for **non-string** arguments. Folding
 * a message into the prefix flattens it into one opaque blob and its fields become
 * unqueryable, so the message and any context object are passed as their own `console`
 * arguments and the prefix stays first for human readability.
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

const DEFAULT_LOG_LEVEL: LogLevel = 'info';

function isLogLevel(level: string): level is LogLevel {
  return (['debug', 'info', 'warn', 'error'] as const).includes(level as LogLevel);
}

/**
 * The configured level, read **lazily on every emit**.
 *
 * ### Why not once, at construction
 *
 * Both of this product's loggers are module-level `const`s:
 * `KvCache.ts` and `embeddedArt.ts` both call `createLogger('…')` at import time. In a
 * Worker, `env` does not exist at module scope, so a level resolved in the constructor can
 * only ever come from `process.env` — which workerd does not have. So the level was
 * permanently `info`, `minLevel` was permanently `1`, and `logger.debug` could never emit
 * in a deployed Worker.
 *
 * `LOG_LEVEL` was declared in `ServiceEnv`, shipped as `"info"` in the wrangler template,
 * validated by nothing, and inert: an operator who set it to `debug` to diagnose the very
 * outage the knob exists for got silence. The coverage report proved it rather than
 * suggesting it — every `console.*` call in this file sat in an arm that only runs at
 * `minLevel <= 0`, which is why they were the uncovered lines.
 *
 * Reading per emit makes the knob work from the only place `env` does exist: the request.
 * The cost is a property read and a comparison per log line, which is not a cost worth
 * optimizing in a Worker that pays per request rather than per statement.
 */
function resolveLogLevel(): LogLevel {
  const injected = (globalThis as { __edgeSonicLogLevel?: LogLevel }).__edgeSonicLogLevel;
  if (injected !== undefined && isLogLevel(injected)) return injected;
  const fromEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL;
  return fromEnv !== undefined && isLogLevel(fromEnv) ? fromEnv : DEFAULT_LOG_LEVEL;
}

function createLogger(namespace?: string, fullRepoName?: string) {
  const argsStr = [fullRepoName, namespace]
    .filter(Boolean)
    .map((s) => `[${s}]`)
    .join(' ');

  const enabled = (level: LogLevel): boolean => LOG_LEVELS[level] >= LOG_LEVELS[resolveLogLevel()];

  return {
    debug: (...args: unknown[]) => {
      if (enabled('debug')) console.debug(`[DEBUG] ${argsStr}`, ...args);
    },
    info: (...args: unknown[]) => {
      if (enabled('info')) console.info(`[INFO] ${argsStr}`, ...args);
    },
    warn: (...args: unknown[]) => {
      if (enabled('warn')) console.warn(`[WARN] ${argsStr}`, ...args);
    },
    error: (...args: unknown[]) => {
      if (enabled('error')) console.error(`[ERROR] ${argsStr}`, ...args);
    },
  };
}

/**
 * Set the level for loggers already constructed.
 *
 * A module-scope logger cannot read `env`, so the request scope publishes the level here
 * once per request instead — which is the only point at which `c.env` exists for a logger
 * that was created at import time. Absent, `resolveLogLevel` falls back to `process.env`
 * for local tooling and to `info` everywhere else.
 *
 * Storing the parsed `LogLevel` rather than the raw string is deliberate: an operator typo
 * (`"verbose"`, `"DEBUG"`) is rejected by `AppConfiguration.validate()` and reported, and
 * this is where a validated value becomes the one the emitters compare against.
 */
function setLogLevel(level: unknown): void {
  const target = globalThis as { __edgeSonicLogLevel?: LogLevel };
  if (typeof level === 'string' && isLogLevel(level)) {
    target.__edgeSonicLogLevel = level;
    return;
  }
  delete target.__edgeSonicLogLevel;
}

export { createLogger, setLogLevel, isLogLevel };
export type { LogLevel };
