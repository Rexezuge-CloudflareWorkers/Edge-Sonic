/**
 * A `D1Queryable` backed by `node:sqlite`.
 *
 * ### Why the DAOs run against Node's SQLite and not against D1
 *
 * The reference project this was scaffolded from carried
 * `lower(owner_email) = lower(?)` through an entire passing suite. Its D1 double
 * lowercased **both sides** in JavaScript, so the predicate was wrong in SQL, the rows
 * came back correct, and the only observable difference was the query plan — which a
 * double does not produce.
 *
 * D1 *is* SQLite, so `node:sqlite` is the same engine: real collation, real
 * `EXPLAIN QUERY PLAN`, real `ON DELETE CASCADE`, real `PRAGMA foreign_key_check`. A
 * test that asserts "this predicate uses an index" is only meaningful against a real
 * planner, and there is no reason to reach for a fake one.
 *
 * ### Why not the Workers integration pool
 *
 * The pool's Miniflare module locator resolves a bare specifier in its *entry* file and
 * not one reached through a relative import, so a monorepo's test files cannot import
 * the packages they test — the failure is "Cannot find package" for a package that
 * resolves under `tsc`, under Vite, and under `esbuild`. Working around that with
 * alias tables and a pre-bundle trades a lot of machinery for assertions that a real
 * SQLite gives directly. The pool is kept for the end-to-end worker tests, which need
 * the actual runtime and import nothing but `vitest` and `cloudflare:test`.
 *
 * ### What the adapter does and does not preserve
 *
 * It preserves the SQL. It does **not** emulate D1's `bind()` value coercion, its
 * `batch()` transaction semantics, or its `meta.changes` shape beyond what SQLite
 * reports — and a test that depends on any of those belongs in the pool suite, where
 * they are real.
 */
import { DatabaseSync } from 'node:sqlite';
import type { D1PreparedStatement, D1Queryable, D1Result } from '@edge-sonic/backend-data/utils';

/**
Thrown when a statement fails, carrying SQLite's message.
*/
class SqliteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteError';
  }
}

interface SqliteQueryable {
  readonly db: D1Queryable;
  /**
  The underlying handle, for `PRAGMA` and `EXPLAIN` a DAO never issues.
  */
  readonly raw: DatabaseSync;
  /**
  Statements executed, for plan and count assertions.
  */
  readonly log: string[];
  close(): void;
}

/**
 * Bind a value the way D1 does.
 *
 * D1 accepts `null`, `string`, `number`, and an `ArrayBuffer` view, and rejects
 * everything else. SQLite's driver is stricter about `undefined` (it throws), so an
 * absent optional becomes `null` — which is what D1's binding of a missing parameter
 * means, and what a `NOT NULL` column should then reject.
 */
/**
What SQLite's driver accepts, narrowed from `unknown` at the boundary.
*/
type Bindable = null | string | number | bigint | Uint8Array;

/**
 * Narrow an arbitrary value to what SQLite's driver accepts.
 *
 * The branches are one per accepted type rather than a `switch`, because each needs its
 * own comment: `boolean` becomes 0/1 because SQLite has no boolean type, an
 * `ArrayBuffer` becomes a view because the driver wants one, and anything left is JSON
 * rather than `String(...)` because `String` on an object yields `[object Object]`.
 */
// Every branch returns a `Bindable`; the rule does not narrow through the
// `typeof`/`instanceof` chain.
// eslint-disable-next-line sonarjs/function-return-type
function bindValue(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // SQLite has no boolean type, so a boolean is bound as 0 or 1 — which is what the
  // `is_enabled` columns are declared as.
  if (typeof value === 'boolean') return value ? 1 : 0;
  // Not `String(value)`: an object would stringify to `[object Object]` and SQLite would
  // store that silently rather than refusing it. JSON at least fails on a cycle.
  //
  // `JSON.stringify` returns `undefined` for a function or a symbol, and binding
  // `undefined` throws in the driver. `null` is the honest answer — there is no value
  // to store — and it is what the `undefined` branch above returns for the same reason.
  return JSON.stringify(value) ?? null;
}

/**
Build a `D1Queryable` over an in-memory SQLite database.
*/
function sqliteQueryable(path = ':memory:'): SqliteQueryable {
  const raw = new DatabaseSync(path);
  // Enforced for the lifetime of the handle, so a cascade test observes the same
  // behaviour a deployment does. D1 cannot toggle this mid-migration either, which is
  // why the schema may never `DROP TABLE` a parent.
  raw.exec('PRAGMA foreign_keys = ON');
  const log: string[] = [];

  const db: D1Queryable = {
    prepare(sql: string): D1PreparedStatement {
      const statement = raw.prepare(sql);
      let values: unknown[] = [];

      const run = (): D1Result => {
        log.push(sql);
        try {
          const result = statement.run(...values.map(bindValue));
          return { success: true, meta: { changes: Number(result.changes ?? 0) } };
        } catch (error) {
          throw new SqliteError(error instanceof Error ? error.message : String(error));
        }
      };

      return {
        bind(...next: unknown[]): D1PreparedStatement {
          values = next;
          return this;
        },
        async first<T>(): Promise<T | null> {
          log.push(sql);
          try {
            const row = statement.get(...values.map(bindValue));
            return (row === undefined ? null : (row as T)) as T | null;
          } catch (error) {
            throw new SqliteError(error instanceof Error ? error.message : String(error));
          }
        },
        async all<T>(): Promise<{ results: T[] }> {
          log.push(sql);
          try {
            return { results: statement.all(...values.map(bindValue)) as T[] };
          } catch (error) {
            throw new SqliteError(error instanceof Error ? error.message : String(error));
          }
        },
        async run(): Promise<D1Result> {
          return run();
        },
      };
    },
    /**
     * D1's `batch()` is atomic. Node's `DatabaseSync` has no multi-statement
     * transaction primitive, so the statements are wrapped in an explicit one.
     *
     * The DAO layer only ever uses `batch()` for writes, and a silent partial batch
     * would be exactly the sort of behaviour difference this adapter must not hide — so
     * a failure rolls the whole batch back.
     */
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      raw.exec('BEGIN');
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        raw.exec('COMMIT');
        return results;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };

  return { db, raw, log, close: () => raw.close() };
}

/**
Apply a SQL script, statement by statement.
*/
function execScript(handle: SqliteQueryable, sql: string): void {
  handle.raw.exec(sql);
}

/**
 * The query plan for a statement, as readable text.
 *
 * `EXPLAIN QUERY PLAN` is the only observable difference between a predicate that can
 * use an index and one that cannot: both return the same rows. A plan assertion is
 * therefore the only way a test can tell them apart, and it is the reason the DAOs are
 * exercised against a real planner here.
 */
function queryPlan(handle: SqliteQueryable, sql: string, args: unknown[] = []): string {
  const rows = handle.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args.map(bindValue)) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join(' | ');
}

export { sqliteQueryable, execScript, queryPlan, SqliteError };
export type { SqliteQueryable };
