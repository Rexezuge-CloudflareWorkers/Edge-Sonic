import { describe, expect, it } from 'vitest';
import {
  baselineOf,
  checkMigrations,
  DIGEST_PREFIX,
  LOCK_VERSION,
  parseLock,
  type MigrationFile,
  type MigrationLock,
} from '../../scripts/migrations/lock-check';

/**
 * The lock rules, exercised as rules.
 *
 * The repository's own end of this is `test/schema.int.test.ts`, which asserts the
 * lock on disk agrees with the migrations directory. That is the *result*. What is
 * here is the behaviour, because a check that can only be seen passing is worth
 * nothing when the defect it exists for is an edit nobody notices.
 */

const digest = (n: string): string => `${DIGEST_PREFIX}${n.repeat(64)}`;

function files(...names: string[]): MigrationFile[] {
  return names.map((name, index) => ({ name, digest: digest(String(index + 1)) }));
}

function lock(migrations: Record<string, string>, baseline?: string): MigrationLock {
  return { version: LOCK_VERSION, ...(baseline !== undefined && { baseline }), migrations };
}

const kinds = (result: ReturnType<typeof checkMigrations>): string[] => result.findings.map((finding) => finding.kind).toSorted();

describe('parseLock', () => {
  it('reads a well-formed lock', () => {
    const { lock: parsed, findings } = parseLock(JSON.stringify(lock({ '0008_squash.sql': digest('a') }, '0008_squash.sql')));
    expect(findings).toEqual([]);
    expect(parsed?.baseline).toBe('0008_squash.sql');
    expect(parsed?.migrations['0008_squash.sql']).toBe(digest('a'));
  });

  it('reports an absent lock as recoverable, and names the fix', () => {
    // Distinct from malformed on purpose: `--write` is the remedy here and there is
    // nothing to refuse.
    const { lock: parsed, findings } = parseLock(null);
    expect(parsed).toBeNull();
    expect(kindsOf(findings)).toEqual(['absent']);
    expect(findings[0]?.detail).toContain('--write');
  });

  it('reports invalid JSON rather than throwing', () => {
    const { findings } = parseLock('{ not json');
    expect(kindsOf(findings)).toEqual(['malformed']);
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"lock"'],
    ['null', 'null'],
  ])('rejects %s at the top level', (_label, raw) => {
    expect(kindsOf(parseLock(raw).findings)).toEqual(['malformed']);
  });

  it('rejects a version it does not understand, so a future format fails loudly', () => {
    // Read as "nothing is locked yet" and silently rewritten is the failure this stops.
    const { findings } = parseLock(JSON.stringify({ version: 99, migrations: {} }));
    expect(kindsOf(findings)).toContain('malformed');
    expect(findings.find((finding) => finding.subject === 'version')).toBeDefined();
  });

  it('rejects a digest without the algorithm prefix, which is visibly wrong rather than merely unequal', () => {
    const { findings } = parseLock(JSON.stringify({ version: LOCK_VERSION, migrations: { '0001_a.sql': 'deadbeef' } }));
    expect(kindsOf(findings)).toEqual(['malformed']);
    expect(findings[0]?.detail).toContain(DIGEST_PREFIX);
  });

  it('reports a malformed lock alongside whatever else is wrong, rather than stopping', () => {
    const { findings } = parseLock(JSON.stringify({ version: 99, migrations: { '0001_a.sql': 'nope' } }));
    // One `malformed` per problem, so a single fix attempt may not clear the file.
    expect(kindsOf(findings)).toEqual(['malformed', 'malformed']);
  });

  it('preserves the absence of a baseline, which is a real state before any squash', () => {
    const { lock: parsed } = parseLock(JSON.stringify(lock({ '0001_a.sql': digest('a') })));
    expect(parsed?.baseline).toBeUndefined();
  });
});

const kindsOf = (findings: Array<{ kind: string }>): string[] => findings.map((finding) => finding.kind);

describe('baselineOf', () => {
  it('is absent when no squash is on disk, so every migration is immutable', () => {
    expect(baselineOf(['0001_a.sql', '0002_b.sql'])).toBeUndefined();
  });

  it('takes the highest-numbered squash, which is the one that absorbed the rest', () => {
    expect(baselineOf(['0005_squash.sql', '0011_squash.sql', '0012_c.sql'])).toBe('0011_squash.sql');
  });
});

describe('checkMigrations', () => {
  it('passes when the lock matches exactly', () => {
    const onDisk = files('0008_squash.sql');
    expect(kinds(checkMigrations(onDisk, lock({ '0008_squash.sql': onDisk[0]?.digest as string }, '0008_squash.sql')))).toEqual([]);
  });

  it('names a file on disk that the lock does not record', () => {
    // A new migration with no entry is a migration nobody has applied.
    const result = checkMigrations(files('0008_squash.sql', '0009_new.sql'), lock({ '0008_squash.sql': digest('1') }, '0008_squash.sql'));
    expect(result.findings.find((finding) => finding.kind === 'unlocked')?.subject).toBe('0009_new.sql');
  });

  it('names a lock entry with no file, which can never be reproduced from the repository', () => {
    const result = checkMigrations(files('0008_squash.sql'), lock({ '0008_squash.sql': digest('1'), '0009_gone.sql': digest('9') }, '0008_squash.sql'));
    expect(result.findings.find((finding) => finding.kind === 'orphan')?.subject).toBe('0009_gone.sql');
  });

  it('lets a file sorting before the newest locked one pass only if it is already locked', () => {
    // The same silent split the checksum exists to prevent: D1 applies in filename
    // order, so this would run on a fresh build and never on an existing database.
    const onDisk = files('0008_squash.sql', '0009_new.sql');
    const withEarly: MigrationFile[] = [{ name: '0007_early.sql', digest: digest('e') }, ...onDisk];
    const result = checkMigrations(withEarly, lock({ '0008_squash.sql': digest('1'), '0009_new.sql': onDisk[1]?.digest as string }, '0008_squash.sql'));
    expect(result.findings.find((finding) => finding.kind === 'out-of-order')?.subject).toBe('0007_early.sql');
  });

  it('reports two files sharing a 4-digit prefix', () => {
    // D1 orders by the REST of the filename, so which of two `0001_` files lands on a
    // given database is a lexicographic tiebreak nobody intended.
    const result = checkMigrations(files('0001_edge_sonic_init.sql', '0001_router_init.sql'), null);
    const duplicate = result.findings.find((finding) => finding.kind === 'duplicate-prefix');
    expect(duplicate?.subject).toBe('0001');
    expect(duplicate?.detail).toContain('0001_edge_sonic_init.sql');
    expect(duplicate?.detail).toContain('0001_router_init.sql');
  });

  it('does not report a migration as a duplicate of itself', () => {
    // The caller passes disk names and lock keys together, and every locked file is by
    // definition also on disk — without the dedupe, each one reports itself.
    const onDisk = files('0008_squash.sql');
    const result = checkMigrations(onDisk, lock({ '0008_squash.sql': onDisk[0]?.digest as string }, '0008_squash.sql'));
    expect(kinds(result)).not.toContain('duplicate-prefix');
  });

  it('rejects a name that does not match NNNN_snake_case.sql', () => {
    const result = checkMigrations(files('squash.sql'), null);
    expect(kinds(result)).toContain('name');
  });

  it('reports no per-file findings when the lock itself is absent, because one finding says it', () => {
    const result = checkMigrations(files('0001_a.sql', '0002_b.sql'), null, parseLock(null).findings);
    expect(kinds(result)).toEqual(['absent']);
  });

  it('refuses a stale baseline rather than trusting it to widen the exempt set', () => {
    // Derived from the files on disk, so a lock claiming a later baseline cannot
    // suppress the check on a migration that has not been squashed.
    const onDisk = files('0008_squash.sql', '0009_new.sql');
    const result = checkMigrations(onDisk, lock({ '0008_squash.sql': onDisk[0]?.digest as string }, '0012_never_existed.sql'));
    expect(result.findings.find((finding) => finding.kind === 'baseline')?.subject).toBe('baseline');
  });

  it('exempts the baseline and everything before it from `edited`, because a squash rewrites them', () => {
    const onDisk = files('0008_squash.sql');
    const result = checkMigrations(onDisk, lock({ '0008_squash.sql': digest('f') }, '0008_squash.sql'));
    expect(kinds(result)).toEqual([]);
  });

  describe('--write', () => {
    it('builds a lock from disk when none exists', () => {
      const onDisk = files('0008_squash.sql');
      const result = checkMigrations(onDisk, null);
      expect(result.updated?.migrations['0008_squash.sql']).toBe(onDisk[0]?.digest);
    });

    it('adds only the unlocked files', () => {
      const onDisk = files('0008_squash.sql', '0009_new.sql');
      const result = checkMigrations(onDisk, lock({ '0008_squash.sql': onDisk[0]?.digest as string }, '0008_squash.sql'));
      expect(result.missing.map((file) => file.name)).toEqual(['0009_new.sql']);
      expect(result.updated?.migrations['0009_new.sql']).toBe(onDisk[1]?.digest);
    });

    it('never touches another existing entry, so a drifted migration survives a --write', () => {
      // This is why `--force` is gone rather than replaced: a `--write` that could
      // bless a drift would be the operator blessing their own edit, and they are by
      // definition the one making it.
      const onDisk = files('0008_squash.sql', '0009_new.sql');
      const result = checkMigrations(onDisk, lock({ '0008_squash.sql': onDisk[0]?.digest as string, '0009_new.sql': digest('d') }, '0008_squash.sql'));
      expect(result.updated?.migrations['0009_new.sql']).toBe(digest('d'));
    });

    it('refuses to overwrite a lock it could not understand', () => {
      const result = checkMigrations(files('0008_squash.sql'), null, [{ kind: 'malformed', subject: '', detail: 'x' }]);
      expect(result.updated).toBeNull();
    });

    it('is idempotent, so a --write cannot create a diff for prettier to fix', () => {
      const onDisk = files('0008_squash.sql');
      const first = checkMigrations(onDisk, null);
      const second = checkMigrations(onDisk, first.updated);
      expect(second.updated).toEqual(first.updated);
      expect(kinds(second)).toEqual([]);
    });
  });
});