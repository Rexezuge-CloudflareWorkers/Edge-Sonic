import type { D1Queryable, D1Result } from '../utils/D1Types';
import { executeD1WithRetry } from '../utils/D1Utils';

/**
 * Base for every D1 DAO.
 *
 * It owns exactly one concern: retrying transient D1 faults. Everything else
 * (SQL text, binding order, result shaping) belongs to the concrete DAO, which is
 * the only place that knows its table's shape.
 */
abstract class BaseDAO {
  constructor(protected readonly database: D1Queryable) {}

  /**
   * Run a statement — or a read — with bounded retries on transient faults.
   *
   * `context` names the operation so a failure is attributable in logs; it is the
   * only place D1's own message is allowed to become user-facing (via
   * `DatabaseError`), which is why it must be descriptive. A D1 error carries
   * table and column names, so a context string is the part that reaches an
   * operator.
   *
   * Generic so reads get the same retry as writes; see `executeD1WithRetry`.
   */
  protected withRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    return executeD1WithRetry(operation, context);
  }

  /**
   * Run a write batch, falling back to sequential statements when the binding
   * does not support `batch`.
   *
   * The fallback is not hypothetical: the D1 doubles used in the unit suite are
   * plain objects, and a code path that only works against real D1 is a code path
   * with no test coverage at all.
   */
  protected async runWriteBatch(
    statements: ReturnType<D1Queryable['prepare']>[],
    context: string,
  ): Promise<number> {
    if (statements.length === 0) return 0;
    if (this.database.batch) {
      const results: D1Result[] = await this.withRetry(async () => await this.database.batch!(statements), context);
      return (results ?? []).reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
    }
    let changes = 0;
    for (const statement of statements) {
      const result: D1Result = await this.withRetry(async () => await statement.run(), context);
      changes += result.meta?.changes ?? 0;
    }
    return changes;
  }
}

export { BaseDAO };
