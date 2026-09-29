/**
 * Regenerate `migrations/applied.lock.json`.
 *
 * Run after adding a migration. It rewrites the lock from the files on disk, so the
 * recorded hashes are computed rather than transcribed — a hand-typed digest is a
 * digest that is wrong the first time a comment changes, and a lock that is wrong in
 * the *permissive* direction is worse than no lock at all.
 *
 * ### Why this exits non-zero when it changes an existing entry
 *
 * The whole point of the lock is that a migration which has been applied must not
 * change. Regenerating it after editing `0001` would silently bless that edit — and
 * the operator running this is, by definition, the one making it. So an existing
 * entry that no longer matches is a hard failure, and the fix is to revert the file
 * and add a new numbered migration. Pass `--force` to override deliberately, which
 * should essentially never be right.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_PATH = join(MIGRATIONS_DIR, 'applied.lock.json');

/**
 * The `$comment` block, preserved verbatim across regeneration.
 *
 * Handled explicitly because `JSON.parse` drops it, and a lock file whose rationale
 * is regenerated away is a lock file nobody can justify six months later.
 */
function readComment(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const comment = (parsed as { $comment?: unknown }).$comment;
  if (!Array.isArray(comment) || comment.some((line) => typeof line !== 'string')) {
    throw new Error('migrations/applied.lock.json has no string-array "$comment".');
  }
  return comment as string[];
}

function files(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function digest(name: string): string {
  return createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, name))).digest('hex');
}

function main(): void {
  const force = process.argv.includes('--force');
  const existing = (JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { migrations: Record<string, string> }).migrations;
  const names = files();
  const next: Record<string, string> = {};

  const changed: string[] = [];
  const removed: string[] = [];
  for (const name of names) {
    const hash = digest(name);
    if (existing[name] !== undefined && existing[name] !== hash) changed.push(name);
    next[name] = hash;
  }
  for (const name of Object.keys(existing)) {
    if (!names.includes(name)) removed.push(name);
  }

  if (removed.length > 0) {
    // A deleted migration file is not a schema change; the database still has it.
    console.error(`Refusing to drop applied migrations from the lock: ${removed.join(', ')}`);
    console.error('A migration that has been applied cannot be un-applied. Revert the deletion.');
    process.exit(1);
  }
  if (changed.length > 0 && !force) {
    console.error('Refusing to re-hash a migration that has already been applied:');
    for (const name of changed) console.error(`  ${name}`);
    console.error('');
    console.error('D1 skips applied migrations by filename, so editing one changes the code');
    console.error('without changing the database. Revert it and add a new numbered file.');
    process.error('Override with --force only if this database has never been migrated.');
    process.exit(1);
  }

  writeFileSync(
    LOCK_PATH,
    `${JSON.stringify({ $comment: readComment(), migrations: next }, null, 2)}\n`,
    'utf8',
  );
  console.log(`Wrote migrations/applied.lock.json with ${names.length} migration(s).`);
  if (changed.length > 0) console.log(`Re-hashed (--force): ${changed.join(', ')}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
