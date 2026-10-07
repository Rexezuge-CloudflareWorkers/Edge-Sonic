/**
 * Reading the migration directory, and knowing which part of it is locked.
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
 * ### Why the lock, and why it is not reimplemented here
 *
 * D1 records applied migrations by *filename* in `d1_migrations`, so a migration
 * that has run is skipped on every later `wrangler d1 migrations apply` — silently.
 * An applied migration is therefore immutable in fact while being an ordinary text
 * file in appearance, and nothing in the repository says so.
 *
 * So the fact the deployment actually depends on — which files have already been
 * applied — is recorded in `migrations/migrations.lock.json` and asserted rather
 * than left to be inferred from a filename. **A comment is not a measurement**:
 * this is the measurement.
 *
 * The comparison itself lives in `scripts/migrations/lock-check.ts`, which is the
 * one implementation the CI check (`pnpm run validate:migrations`) also runs. An
 * earlier version of this helper parsed the lock and compared digests itself; that
 * is a second implementation of a thing already written, free to disagree with it
 * about the rules, and the two disagreeing would leave a suite green against a lock
 * the CI gate rejects.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkMigrations, parseLock, type Finding, type MigrationFile } from '../../scripts/migrations/lock-check';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const LOCK_PATH = fileURLToPath(new URL('../../migrations/migrations.lock.json', import.meta.url));

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

/**
 * One migration file's SQL, by name.
 *
 * Separate from `migrationSql()` because the two answer different questions, and conflating
 * them is what makes a rule look universal when it is not. `migrationSql()` is "what does a
 * fresh database become" — every file, in apply order. This is "what does *this* file say",
 * which is what an assertion scoped to one file needs: reading the joined set to assert
 * something about a single member asserts against all the others too.
 */
function migrationSqlOf(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), 'utf8');
}

function sha256(name: string): string {
  return createHash('sha256').update(readFileSync(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)))).digest('hex');
}

/**
 * The on-disk migrations, in apply order, as `checkMigrations` wants them.
 *
 * The digest is `sha256:<hex>` — the same string the lock stores and the same one
 * `verify-migrations.ts` writes — so a drift reported here and a drift reported by
 * CI are the same comparison rather than two that agree today.
 */
function migrationDigests(): MigrationFile[] {
  return migrationFiles().map((name) => ({ name, digest: `sha256:${sha256(name)}` }));
}

/**
 * Every way the repository and the lock disagree, in `checkMigrations` vocabulary.
 *
 * Returns an empty array when they agree. Throws only when the lock is malformed,
 * which is a finding `checkMigrations` reports rather than a reason to stop.
 */
function migrationFindings(): Finding[] {
  const raw = (() => {
    try {
      return readFileSync(LOCK_PATH, 'utf8');
    } catch {
      return null;
    }
  })();
  const { lock, findings } = parseLock(raw);
  return checkMigrations(migrationDigests(), lock, findings).findings;
}

/**
 * The findings this repository most wants surfaced by name, so a failure reads as
 * the defect rather than as a count.
 */
function migrationFindingsOfKind(...kinds: readonly Finding['kind'][]): Finding[] {
  return migrationFindings().filter((finding) => kinds.includes(finding.kind));
}

export {
  MIGRATIONS_DIR,
  LOCK_PATH,
  migrationFiles,
  migrationSql,
  migrationSqlOf,
  migrationDigests,
  sha256,
  migrationFindings,
  migrationFindingsOfKind,
};