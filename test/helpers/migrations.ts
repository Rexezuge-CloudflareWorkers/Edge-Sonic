/**
 * Reading the migration directory, and knowing which of it has shipped.
 *
 * ### Why the directory, and not one file
 *
 * `test/schema.int.test.ts` used to `exec` a hardcoded `0001_edge_sonic_init.sql`. A
 * test that names one file cannot tell **a new migration** from **an edit to an old
 * one** — the two produce identical bytes on the database it is building — so it went
 * on passing through a schema change that never reached production. Reading the
 * directory and applying every file in order is what makes the suite model what
 * Wrangler does.
 *
 * ### Why the lock
 *
 * D1 records applied migrations by *filename* in `d1_migrations`, so a migration that
 * has run is skipped by every later `wrangler d1 migrations apply` — silently. An
 * applied migration is therefore immutable in fact while being an ordinary text file
 * in appearance, and nothing in the repository says so.
 *
 * So the fact the deployment actually depends on — which files have already been
 * applied — is recorded here and asserted, rather than left to be inferred from a
 * filename. A **comment is not a measurement**: this is the measurement.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const LOCK_PATH = fileURLToPath(new URL('../../migrations/applied.lock.json', import.meta.url));

/**
 * Every migration file, in the order Wrangler applies them.
 *
 * Sorted by filename, because that is how Wrangler orders a migrations directory,
 * and a test that builds the schema in a different order than production is a test
 * that can pass on a schema production never had.
 */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * The SQL of every migration, in order — what a fresh database is built from.
 */
function migrationSql(): string {
  return migrationFiles()
    .map((name) => readFileSync(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), 'utf8'))
    .join('\n');
}

function sha256(name: string): string {
  return createHash('sha256').update(readFileSync(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)))).digest('hex');
}

interface MigrationLock {
  readonly migrations: Record<string, string>;
}

/**
 * The committed record of what has already been applied.
 *
 * Throws rather than defaulting: a lock that is missing is the exact condition it
 * exists to detect, and an empty default would report "nothing has shipped" against
 * a database where everything has.
 */
function readLock(): MigrationLock {
  const parsed: unknown = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const migrations = (parsed as { migrations?: unknown }).migrations;
  if (typeof migrations !== 'object' || migrations === null) {
    throw new Error('migrations/applied.lock.json has no "migrations" object.');
  }
  for (const [name, hash] of Object.entries(migrations as Record<string, unknown>)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`migrations/applied.lock.json: "${name}" is not a sha256 digest.`);
    }
  }
  return { migrations: migrations as Record<string, string> };
}

/**
 * Migrations on disk that the lock does not record, and recorded ones whose bytes
 * have changed. Both are the same defect: the repository and the database disagree.
 */
function migrationDrift(): { added: string[]; changed: string[] } {
  const lock = readLock().migrations;
  const onDisk = migrationFiles();
  return {
    added: onDisk.filter((name) => lock[name] === undefined),
    changed: onDisk.filter((name) => lock[name] !== undefined && lock[name] !== sha256(name)),
  };
}

export { MIGRATIONS_DIR, LOCK_PATH, migrationFiles, migrationSql, sha256, readLock, migrationDrift };
export type { MigrationLock };
