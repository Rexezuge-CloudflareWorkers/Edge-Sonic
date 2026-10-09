import { describe, expect, it } from 'vitest';
import { BACKUP_FILE_PREFIX, backupFileName, backupStamp } from '../../scripts/backup/naming';
import { DEFAULT_BASE_PATH, REMOTE, remoteTargetDir } from '../../scripts/backup/webdav-target';
import { BACKUP_PREFIX, isBackupArtifact, parseS3ListRow, shouldDeleteBackup } from '../../scripts/backup/s3-prune';
import { retentionCutoff } from '../../scripts/backup/retention';

/**
 * Where a backup lands, and what the prune is allowed to delete.
 *
 * The prune is the one destructive operation in the workflow, so its rules are asserted
 * here rather than trusted: it runs unattended against a real bucket, and every rule it
 * gets wrong is either data loss or a directory that grows for ever.
 */

describe('backupStamp', () => {
  it('formats the UTC timestamp for a filename', () => {
    expect(backupStamp(new Date('2026-10-01T04:15:09Z'))).toBe('2026-10-01_04-15-09');
  });

  it('is UTC regardless of the runner’s timezone', () => {
    // The runner is whatever GitHub gives us; a local-time stamp would put consecutive
    // backups on different days across a DST boundary and sort them wrongly.
    expect(backupStamp(new Date('2026-10-01T23:30:00Z'))).toBe('2026-10-01_23-30-00');
  });
});

describe('backupFileName', () => {
  it('names the product, so a bucket shared with another project is readable', () => {
    expect(backupFileName(new Date('2026-10-01T04:15:00Z'))).toBe('edge-sonic_prod_2026-10-01_04-15-00.sql.xz.enc');
  });

  it('produces lexicographically sortable names', () => {
    const earlier = backupFileName(new Date('2026-09-28T04:15:00Z'));
    const later = backupFileName(new Date('2026-10-01T04:15:00Z'));

    expect(earlier < later).toBe(true);
  });

  it('carries the encrypted extension and the prefix the workflow globs for', () => {
    // `backup-d1.yml` uploads with `path: edge-sonic_prod_*.sql.xz.enc` and
    // `if-no-files-found: error`. So the shape here has to match that glob, or the
    // artifact never arrives and both upload jobs fail on a missing download — a
    // rename nobody would connect to this function.
    const name = backupFileName(new Date('2026-10-01T04:15:00Z'));
    expect(name).toBe(`${BACKUP_FILE_PREFIX}2026-10-01_04-15-00.sql.xz.enc`);
    expect(name).toMatch(/^edge-sonic_prod_.*\.sql\.xz\.enc$/);
    expect(isBackupArtifact(name)).toBe(true);
  });
});

describe('remoteTargetDir', () => {
  it('nests backups under a production directory on the remote', () => {
    expect(remoteTargetDir('edge-sonic')).toBe('webdav:edge-sonic/production');
  });

  it('honours a custom base path', () => {
    expect(remoteTargetDir('team/backups')).toBe('webdav:team/backups/production');
  });

  it('falls back to the default when the base path is empty', () => {
    // `WEBDAV_BASE_PATH` defaults in the workflow, so this only fires when someone sets
    // it to an empty string — which must not produce `webdav:/production`.
    expect(remoteTargetDir('')).toBe(`webdav:${DEFAULT_BASE_PATH}/production`);
  });

  it('uses one default and one remote name', () => {
    // The reference project declares `DEFAULT_BASE_PATH` in both `webdav-target.ts` and
    // `upload-webdav.ts`. Two declarations of one default are free to disagree, and the
    // disagreement is invisible until a backup lands where nobody is looking.
    expect(REMOTE).toBe('webdav');
    expect(DEFAULT_BASE_PATH).toBe('edge-sonic');
  });
});

describe('shouldDeleteBackup', () => {
  const CUTOFF = '2026-09-01';

  it('deletes an encrypted backup past the retention window', () => {
    expect(shouldDeleteBackup({ fileDate: '2026-08-01', fileName: 'edge-sonic_prod_2026-08-01_04-15-00.sql.xz.enc' }, CUTOFF)).toBe(true);
  });

  it('keeps a backup inside the retention window', () => {
    expect(shouldDeleteBackup({ fileDate: '2026-09-28', fileName: 'edge-sonic_prod_2026-09-28_04-15-00.sql.xz.enc' }, CUTOFF)).toBe(false);
  });

  it('keeps anything that is not a backup artifact, even when it is ancient', () => {
    // The paired negative. Without it, a check that returned `true` for everything
    // would pass every other case here.
    expect(shouldDeleteBackup({ fileDate: '2020-01-01', fileName: 'README-do-not-delete.md' }, CUTOFF)).toBe(false);
    expect(shouldDeleteBackup({ fileDate: '2020-01-01', fileName: 'some-other-app.tar.gz' }, CUTOFF)).toBe(false);
  });

  it('treats a same-day object as still inside the window', () => {
    // `<` rather than `<=`: pruning today's backup because its date equals the cutoff
    // would leave a window one day shorter than configured.
    expect(shouldDeleteBackup({ fileDate: CUTOFF, fileName: 'edge-sonic_prod_2026-09-01_04-15-00.sql.xz.enc' }, CUTOFF)).toBe(false);
  });
});

describe('BACKUP_PREFIX', () => {
  it('namespaces this project, so a shared bucket cannot be pruned by another app’s rule', () => {
    // The prune lists `s3://<bucket>/<prefix>/` and nothing else. A generic prefix would
    // let a bucket shared with an unrelated project have its objects deleted on our
    // schedule — the one irreversible thing this workflow does.
    expect(BACKUP_PREFIX).toBe('edge-sonic/production');
  });
});

describe('isBackupArtifact', () => {
  it('accepts both the compressed plaintext and the encrypted form', () => {
    expect(isBackupArtifact('backup.sql.xz')).toBe(true);
    expect(isBackupArtifact('backup.sql.xz.enc')).toBe(true);
  });

  it('still accepts backups written before the switch to xz', () => {
    // Dropping `.gz` would strand every pre-switch object in the bucket for ever, since
    // nothing else prunes the prefix.
    expect(isBackupArtifact('backup.sql.gz')).toBe(true);
    expect(isBackupArtifact('backup.sql.gz.enc')).toBe(true);
  });

  it('rejects near misses', () => {
    expect(isBackupArtifact('backup.sql')).toBe(false);
    expect(isBackupArtifact('backup.sql.xz.sig')).toBe(false);
    expect(isBackupArtifact('backup.sql.gz.sig')).toBe(false);
    expect(isBackupArtifact('')).toBe(false);
  });
});

describe('parseS3ListRow', () => {
  it('splits the date, time, size and key columns', () => {
    expect(parseS3ListRow('2026-08-01 04:15:00       1024 edge-sonic_prod_2026-08-01_04-15-00.sql.xz.enc')).toEqual({
      fileDate: '2026-08-01',
      fileName: 'edge-sonic_prod_2026-08-01_04-15-00.sql.xz.enc',
    });
  });

  it('ignores blank and truncated rows', () => {
    // `Total Objects: 3` is three fields, so treating it as a row would try to delete
    // a key literally named "Total".
    expect(parseS3ListRow('')).toBeUndefined();
    expect(parseS3ListRow('Total Objects: 3')).toBeUndefined();
  });
});

describe('retentionCutoff', () => {
  it('returns the ISO date N days before now', () => {
    expect(retentionCutoff(new Date('2026-10-01T04:15:00Z'), 30)).toBe('2026-09-01');
    expect(retentionCutoff(new Date('2026-10-01T04:15:00Z'), 1)).toBe('2026-09-30');
  });

  it('crosses a month boundary', () => {
    expect(retentionCutoff(new Date('2026-10-05T04:15:00Z'), 7)).toBe('2026-09-28');
  });
});
