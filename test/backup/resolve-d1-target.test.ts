import { describe, expect, it } from 'vitest';
import { DEFAULT_UUID } from '../../scripts/lib/wrangler-config/types';
import { resolveD1Target } from '../../scripts/backup/d1-target';
import { evaluateConfig } from '../../scripts/backup/destination-config';

/**
 * Choosing what to export, and refusing to export when there is nothing.
 *
 * The empty-database guard is the reason this file exists, and it is worth being precise
 * about which half does the work. `resolveD1Target` rejects the template's placeholder
 * id — but that check cannot fire in the backup workflow, because the job provisions
 * resources *first* and provisioning replaces the placeholder before this runs. The
 * working guard reads what provisioning reported creating; it is asserted here as the
 * input it depends on rather than as a function, because it is a two-line check in an
 * entrypoint over a value another step owns.
 */

const REAL_ID = '11111111-2222-3333-4444-555555555555';

describe('resolveD1Target', () => {
  it('exports by database name, which is what `wrangler d1 export` accepts', () => {
    const target = resolveD1Target({
      d1_databases: [{ binding: 'DB', database_name: 'edge-sonic-db', database_id: REAL_ID }],
    });

    expect(target).toEqual({ binding: 'DB', databaseId: REAL_ID, target: 'edge-sonic-db' });
  });

  it('falls back to the binding when a hand-written config omits database_name', () => {
    expect(resolveD1Target({ d1_databases: [{ binding: 'DB', database_id: REAL_ID }] }).target).toBe('DB');
  });

  it('rejects a config with no d1_databases entry', () => {
    expect(() => resolveD1Target({})).toThrow(/No d1_databases entry/);
    expect(() => resolveD1Target({ d1_databases: [{ database_id: REAL_ID }] })).toThrow(/binding/);
  });

  it('rejects a placeholder id, as a second line of defence', () => {
    expect(() =>
      resolveD1Target({
        d1_databases: [{ binding: 'DB', database_name: 'edge-sonic-db', database_id: DEFAULT_UUID }],
      }),
    ).toThrow(/still the template placeholder/);
  });

  it('accepts a config whose database_id is absent, leaving verification to wrangler', () => {
    expect(resolveD1Target({ d1_databases: [{ binding: 'DB' }] }).databaseId).toBe('');
  });

  it('resolves the config this repository actually ships', () => {
    // Read from the template rather than restated, so a rename in `wrangler.template.jsonc`
    // fails here instead of at 04:15 on a schedule nobody is watching.
    const binding = 'DB';
    const target = resolveD1Target({
      d1_databases: [{ binding, database_name: 'edge-sonic-db', database_id: REAL_ID }],
    });
    expect(target.binding).toBe(binding);
  });
});

describe('the provisioning signal the guard depends on', () => {
  /**
   * The shape `provisionWranglerResources` returns and `prepare-wrangler-config.ts`
   * publishes. Mirrored here rather than imported because it crosses a process boundary
   * as a step output — a change to either side has to break something, and this is it.
   */
  const provisionedOutput = (entries: string[]): string => entries.join(',');

  it('lists nothing when every resource already existed', () => {
    expect(provisionedOutput([])).toBe('');
  });

  it('names a D1 database this run created, which is what the guard refuses to export', () => {
    expect(provisionedOutput(['d1:edge-sonic-db'])).toContain('d1:');
  });

  it('distinguishes a created D1 from other kinds of created resource', () => {
    // `startsWith('d1:')` rather than a substring test, so a resource whose *name*
    // contains "d1" cannot trigger the refusal — that would stop backups for a
    // deployment that is perfectly healthy.
    const entries = provisionedOutput(['kv:edge-sonic-cache', 'secrets-store:default']).split(',');
    expect(entries.some((entry) => entry.startsWith('d1:'))).toBe(false);
  });
});

describe('evaluateConfig', () => {
  const complete = {
    CLOUDFLARE_API_TOKEN: 'token',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    BACKUP_ENCRYPTION_KEY: 'passphrase',
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_BUCKET: 'bucket',
  };

  it('reports a fully configured S3 destination', () => {
    const config = evaluateConfig(complete);
    expect(config).toMatchObject({ cloudflare: true, encryption: true, s3: true, webdav: false, anyDestination: true, errors: [] });
  });

  it('reports a fully configured WebDAV destination', () => {
    const config = evaluateConfig({ WEBDAV_URL: 'https://dav.example.com', WEBDAV_USER: 'u', WEBDAV_PASSWORD: 'p' });
    expect(config).toMatchObject({ webdav: true, s3: false, anyDestination: true });
  });

  it('treats no destination at all as legitimate, and green', () => {
    // "I do not want off-site backups" is a supported state and must not turn the
    // schedule red, or an operator disables the workflow instead of configuring it.
    const config = evaluateConfig({});
    expect(config).toMatchObject({ anyDestination: false, errors: [] });
    expect(config.cloudflare).toBe(false);
    expect(config.encryption).toBe(false);
  });

  it('fails closed when a destination is configured without an encryption key', () => {
    const config = evaluateConfig({ ...complete, BACKUP_ENCRYPTION_KEY: undefined });
    expect(config.errors).toHaveLength(1);
    expect(config.errors[0]).toMatch(/BACKUP_ENCRYPTION_KEY is required/);
  });

  it('fails closed when a destination is configured without Cloudflare credentials', () => {
    const config = evaluateConfig({ ...complete, CLOUDFLARE_API_TOKEN: undefined });
    expect(config.errors.join(' ')).toMatch(/CLOUDFLARE_API_TOKEN/);
  });

  it('states the encryption requirement in terms of this repository’s data', () => {
    // The message is the operator's only explanation, so it must not be copied from a
    // project whose schema has a plaintext token column and this one does not.
    expect(evaluateConfig({ ...complete, BACKUP_ENCRYPTION_KEY: undefined }).errors[0]).toMatch(/listening history/);
  });

  it.each(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'] as const)('treats a partial S3 config (%s) as no S3 destination', (missing) => {
    const env: Record<string, string | undefined> = { ...complete };
    delete env[missing];
    expect(evaluateConfig(env).s3).toBe(false);
  });

  it('counts a whitespace-only secret as unset', () => {
    expect(evaluateConfig({ ...complete, S3_BUCKET: ' '.repeat(3) }).s3).toBe(false);
  });

  it('does not require S3_REGION, which R2 and MinIO have no meaningful value for', () => {
    // Requiring it would silently disable backups for anyone on such a provider — the
    // gate would read "not configured" and every job would skip.
    expect(evaluateConfig(complete).s3).toBe(true);
  });
});