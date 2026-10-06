// Minimal structural D1 types so backend-data (Layer 2) typechecks without
// Cloudflare workers-types. Real D1Database satisfies these structurally.
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<D1Result>;
}

/**
 * The SQL a statement was prepared from, **beside** the statement rather than on it.
 *
 * ### Why this exists, and why the statement has no `sql`
 *
 * Because the platform's statement does not carry one. workerd's own
 * `types/defines/d1.d.ts` declares `D1PreparedStatement` as `bind`, `first`, `run`,
 * `all` and `raw` and nothing else, and Cloudflare's own reference for `prepare()`
 * describes the return value as *"an object which only contains methods"*. There is no
 * `sql` property to read, so `statement.sql` is `undefined` on every write.
 *
 * It read as a `TypeError` — `Cannot read properties of undefined (reading 'replace')`,
 * from `billedRows.stripLeadingNoise` — on every write that measured its cost, so the
 * scan could neither seed its frontier nor advance a chunk while `scan_state` kept
 * reporting `scanning`. It was invisible here for two reasons, and each is its own
 * lesson. The interface below **declared** `sql: string` as required, under a comment
 * asserting that *"Real D1Database satisfies these structurally"* — a claim about the
 * platform that nothing checked, and `env.DB as D1Queryable` in `requestScope.ts` is
 * what let it compile: this type is a superset of the platform's, so a cast is legal in
 * one direction and the disagreement is never reported. And `test/helpers/sqlite.ts`
 * returned a statement *with* `sql`, so the one double in the suite modelled the type
 * this repository wrote rather than the one it runs against — which is the general rule
 * the `node:sqlite` adapter exists to satisfy, broken at the one member the adapter
 * invented.
 *
 * So the SQL travels **with** the statement, from the one place that has it.
 *
 * ### `bind` returns a new pair, because the platform's does
 *
 * Cloudflare's `bind()` returns a new statement rather than mutating and returning the
 * same one, so anything that hung the SQL off a statement object — a `WeakMap`, a
 * `defineProperty` — would resolve before `bind()` and miss after it. That fix would
 * have passed this repository's suite, whose double returned `this` from `bind()`, and
 * failed in production for the same reason the bug did. The double returns a fresh
 * object now, so the shape under test is the shape in production.
 */
interface TrackedStatement {
  /**
  The SQL this statement was prepared from, exactly as passed to `prepare()`.
  */
  readonly sql: string;
  /**
  The platform's statement. What `batch()` must be handed — never this wrapper.
  */
  readonly statement: D1PreparedStatement;
  bind(...values: unknown[]): TrackedStatement;
}

interface D1Result {
  success: boolean;
  error?: string;
  meta?: { changes?: number; [key: string]: unknown };
}

interface D1Queryable {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export type { D1PreparedStatement, D1Queryable, D1Result, TrackedStatement };
