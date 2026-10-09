import { describe, expect, it } from 'vitest';
import { AppConfiguration } from '@edge-sonic/backend-runtime/config';

/**
Re-exported from the facade rather than `validate.ts`, so the test reads the number the check used.
*/
const DERIVED_MARKER_MAX_LENGTH = AppConfiguration.DERIVED_MARKER_MAX_LENGTH;

/**
 * The fail-fast misconfiguration report, exercised as rules.
 *
 * Every failure mode here is **silent at request time**: a malformed numeric variable falls back
 * to its default, a `TEAM_DOMAIN` typo presents as an Access outage, and a bypass identity set in
 * production authenticates every unauthenticated request as a fixed user. Nothing else in the
 * product would say so — which is why these are the only tests in the suite that can be written
 * without standing up a Worker, and why they exist as a list rather than as a route test.
 *
 * The shape every assertion below follows is the pair the file's header argues for: a value the
 * operator would plausibly write, and the warning it must produce. Asserting only that *some*
 * warning appeared would pass for a check that fired on the wrong variable, which is the failure
 * mode a single `toContainSubstring` on the whole list has.
 */

/**
The four section objects `validateConfiguration` takes, read through the real facade.
*/
/**
 * The report, through the same call the worker makes.
 *
 * `AppConfiguration.validate()` rather than `validateConfiguration` directly, and the reason is
 * that the facade is where the five arguments are assembled: `AuthConfig` has no public getter
 * on `AppConfiguration` at all, so a test reaching for the section objects directly would either
 * construct an `AuthConfig` production never constructs or add an accessor only for the test.
 * Going through the public method also means a change to *which* section answers a check fails
 * here, which is the seam that matters.
 */
const warningsFor = (env: Record<string, string>): string[] => AppConfiguration.fromEnv(env).validate();

/**
Whether any warning mentions `variable`, as opposed to merely being present.
*/
function namesVariable(warnings: readonly string[], variable: string): boolean {
  return warnings.some((warning) => warning.includes(variable));
}

describe('a well-formed configuration', () => {
  it('reports nothing', () => {
    // The direction that matters most and is hardest to see: a check that always fires is
    // indistinguishable from a check that works until an operator ignores the output.
    expect(warningsFor({})).toEqual([]);
  });
});

describe('numeric variables', () => {
  it('names the variable whose value is not a positive integer', () => {
    const warnings = warningsFor({ MAX_LIBRARIES: 'many' });
    expect(warnings).toContain('Invalid configuration: MAX_LIBRARIES must be a positive integer');
  });

  it('reports each bad variable separately, so one is not hidden by another', () => {
    const warnings = warningsFor({ MAX_LIBRARIES: 'x', WEBDAV_TIMEOUT_MS: '0', AUTH_FAILURE_LIMIT: '-1' });
    expect(namesVariable(warnings, 'MAX_LIBRARIES')).toBe(true);
    expect(namesVariable(warnings, 'WEBDAV_TIMEOUT_MS')).toBe(true);
    expect(namesVariable(warnings, 'AUTH_FAILURE_LIMIT')).toBe(true);
  });

  it('accepts zero for TAG_READ_TAIL_BYTES, whose contract is >= 0', () => {
    // Deliberately absent from the positive-int list. Zero disables the Ogg tail read, which
    // is a supported configuration, so folding it in with the others would report a working
    // deployment as broken — and `isValidPositiveInt` is the wrong predicate for it.
    expect(warningsFor({ TAG_READ_TAIL_BYTES: '0' })).toEqual([]);
  });

  it('still rejects a negative TAG_READ_TAIL_BYTES', () => {
    const warnings = warningsFor({ TAG_READ_TAIL_BYTES: '-1' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('TAG_READ_TAIL_BYTES must be a non-negative integer');
  });
});

describe('clamps that are reported rather than applied quietly', () => {
  it('reports MAX_PAGE_SIZE above what one invocation can answer', () => {
    // A page size above the ceiling is a **failed** request, not a slow one, so clamping it
    // silently would leave an operator believing a limit is in force when the request was
    // already unservable.
    const warnings = warningsFor({ MAX_PAGE_SIZE: '100000' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('MAX_PAGE_SIZE=100000 exceeds');
    expect(warnings[0]).toContain('it is clamped');
  });

  it('reports SCAN_CHUNK_MAX_REQUESTS above the chunk budget, and says Free cannot raise it', () => {
    // The operator surface tells people to raise this one, so the advice is actively harmful on
    // Free — a chunk that spends more is terminated by the runtime rather than paused by its own
    // budget. The warning has to say so, or it documents the harmful advice.
    const warnings = warningsFor({ SCAN_CHUNK_MAX_REQUESTS: '500' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SCAN_CHUNK_MAX_REQUESTS=500 exceeds');
    expect(warnings[0]).toContain('terminated rather than slowed');
  });

  it('reports SCAN_CHUNK_FOLDERS above what the chunk can afford', () => {
    const warnings = warningsFor({ SCAN_CHUNK_FOLDERS: '500' });
    expect(warnings[0]).toContain('SCAN_CHUNK_FOLDERS=500 exceeds');
    expect(warnings[0]).toContain('cannot make a chunk finish');
  });

  it('reports SCAN_ENRICH_MAX_PER_FOLDER above what the chunk can afford', () => {
    const warnings = warningsFor({ SCAN_ENRICH_MAX_PER_FOLDER: '500' });
    expect(warnings[0]).toContain('SCAN_ENRICH_MAX_PER_FOLDER=500 exceeds');
  });

  it('reports every over-limit bound at once, in configuration order', () => {
    // One deployment with four bad bounds gets four warnings. Collapsing them into the first
    // would leave an operator fixing one variable, redeploying, and finding the next.
    const warnings = warningsFor({
      MAX_PAGE_SIZE: '100000',
      SCAN_CHUNK_MAX_REQUESTS: '500',
      SCAN_CHUNK_FOLDERS: '500',
      SCAN_ENRICH_MAX_PER_FOLDER: '500',
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.map((w) => /([A-Z_]+)=/.exec(w)?.[1])).toEqual([
      'MAX_PAGE_SIZE',
      'SCAN_CHUNK_MAX_REQUESTS',
      'SCAN_CHUNK_FOLDERS',
      'SCAN_ENRICH_MAX_PER_FOLDER',
    ]);
  });

  it('does not report a value exactly at the ceiling', () => {
    // The comparison is `>`, not `>=`. Reporting the boundary as over-limit would make the
    // number in the message and the number that works disagree by one.
    expect(warningsFor({ MAX_LIBRARIES: '10', TAG_READ_BYTES: '131072', TAG_READ_TAIL_BYTES: '65536' })).toEqual([]);
  });
});

describe('LOG_LEVEL', () => {
  it('accepts each documented level, case-insensitively', () => {
    for (const level of ['debug', 'info', 'warn', 'error', 'DEBUG', 'Info']) {
      expect(warningsFor({ LOG_LEVEL: level })).toEqual([]);
    }
  });

  it('names a level that is not one of them', () => {
    // The one variable whose value was silently unobservable: both loggers were module-level
    // constants, so the level resolved before `env` existed and `LOG_LEVEL=debug` produced
    // silence. `validate()` is the only place a typo becomes visible.
    const warnings = warningsFor({ LOG_LEVEL: 'verbose' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('LOG_LEVEL must be one of debug, info, warn, error');
  });

  it('accepts an unset LOG_LEVEL', () => {
    expect(warningsFor({ LOG_LEVEL: '' })).toEqual([]);
  });
});

describe('ALBUM_GROUP_BY', () => {
  it('names a grouping it does not recognise rather than falling back silently', () => {
    // `folder`, `album` and `album_artist` partition a library into different albums, so an
    // unrecognised value is a different answer than the operator asked for — not a degraded one
    // — and a mistyped setting has no error response for a client to see.
    const warnings = warningsFor({ ALBUM_GROUP_BY: 'album artist' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ALBUM_GROUP_BY must be one of');
  });

  it('accepts each documented grouping', () => {
    for (const grouping of ['folder', 'album', 'album_artist']) {
      expect(warningsFor({ ALBUM_GROUP_BY: grouping })).toEqual([]);
    }
  });
});

describe('DERIVED_MARKER', () => {
  it('refuses a control character, because the marker reaches an album id', () => {
    // `decodeId` runs `normalizeRelativePath` over a decoded payload and refuses control
    // characters, so a marker carrying one mints an `alk:` id this server cannot read back:
    // `getAlbum` answers `code=70` with nothing naming a cause.
    const warnings = warningsFor({ DERIVED_MARKER: 'live\u0001' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('DERIVED_MARKER must not contain control characters');
    expect(warnings[0]).toContain('code=70');
  });

  it('refuses a marker over the length ceiling, and states the number', () => {
    const warnings = warningsFor({ DERIVED_MARKER: 'x'.repeat(DERIVED_MARKER_MAX_LENGTH + 1) });
    expect(warnings[0]).toContain(`DERIVED_MARKER is ${DERIVED_MARKER_MAX_LENGTH + 1} characters`);
    expect(warnings[0]).toContain(String(DERIVED_MARKER_MAX_LENGTH));
  });

  it('accepts a marker exactly at the ceiling', () => {
    expect(warningsFor({ DERIVED_MARKER: 'x'.repeat(DERIVED_MARKER_MAX_LENGTH) })).toEqual([]);
  });

  it('accepts % and _, which the column comparison removed the need to refuse', () => {
    // The marker is bound as a parameter and the guard is a column comparison rather than a
    // `LIKE`, so these are ordinary characters. Refusing them would preserve the confusion that
    // column removed — and a real library carries both in folder names.
    expect(warningsFor({ DERIVED_MARKER: '100%_live' })).toEqual([]);
  });
});

describe('the auth bypass', () => {
  it('reports a bypass set outside the environments that honour it', () => {
    // The bypass present but **inert** is the dangerous direction: one edit to `ENVIRONMENT`
    // away from authenticating everyone as a fixed identity.
    const warnings = warningsFor({ ENVIRONMENT: 'production', DEV_AUTH_EMAIL: 'dev@example.com' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('DEV_AUTH_EMAIL/DEMO_MODE is set while ENVIRONMENT=production');
    expect(warnings[0]).toContain('Security:');
  });

  it('reports an inert DEMO_MODE the same way', () => {
    const warnings = warningsFor({ ENVIRONMENT: 'production', DEMO_MODE: 'true' });
    expect(warnings.some((w) => w.includes('DEV_AUTH_EMAIL/DEMO_MODE'))).toBe(true);
  });

  it('does not report an active bypass, which is the intended local setup', () => {
    // Warning about it would train an operator to ignore every line this emits.
    expect(warningsFor({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'dev@example.com' })).toEqual([]);
  });
});

describe('ALLOW_PRIVATE_WEBDAV_HOSTS', () => {
  it('reports the re-opened SSRF surface outside a bypass', () => {
    // The credential angle is what makes this worse than usual: the worker attaches the stored
    // WebDAV password to every request to that origin.
    const warnings = warningsFor({ ENVIRONMENT: 'production', ALLOW_PRIVATE_WEBDAV_HOSTS: 'true' });
    expect(warnings.some((w) => w.includes('Security: ALLOW_PRIVATE_WEBDAV_HOSTS=true'))).toBe(true);
    expect(warnings.some((w) => w.includes('stored WebDAV credential'))).toBe(true);
  });

  it('reports a setting that is inert in both directions, because the operator was told it did something', () => {
    // Set inside a bypass, `true` does nothing because private hosts are already allowed.
    const warning = warningsFor({ ENVIRONMENT: 'development', ALLOW_PRIVATE_WEBDAV_HOSTS: 'true' }).find((w) =>
      w.includes('has no effect'),
    );
    expect(warning).toContain('private hosts are already allowed');
  });

  it('names the other inert direction too', () => {
    // `false` outside a bypass does nothing, because private hosts are already denied.
    const warning = warningsFor({ ENVIRONMENT: 'production', ALLOW_PRIVATE_WEBDAV_HOSTS: 'false' }).find((w) =>
      w.includes('has no effect'),
    );
    expect(warning).toContain('private hosts are already denied');
  });

  it('reports the redundant setting in both directions, and never as a Security warning', () => {
    // A setting that agrees with the environment is reported as a Note, because an operator who
    // wrote it has been told it did something — but it is not a Security warning, because nothing
    // was opened. Conflating the two would make the word "Security" meaningless in the log.
    const denied = warningsFor({ ENVIRONMENT: 'production', ALLOW_PRIVATE_WEBDAV_HOSTS: 'false' });
    expect(denied.some((w) => w.startsWith('Note:') && w.includes('already denied'))).toBe(true);
    expect(denied.some((w) => w.startsWith('Security:'))).toBe(false);

    const allowed = warningsFor({ ENVIRONMENT: 'development', ALLOW_PRIVATE_WEBDAV_HOSTS: 'true' });
    expect(allowed.some((w) => w.startsWith('Note:') && w.includes('already allowed'))).toBe(true);
    expect(allowed.some((w) => w.startsWith('Security:'))).toBe(false);
  });

  it('says nothing at all when the variable was never set', () => {
    // The direction a refactor of this function got wrong once: `getAllowPrivateWebdavHosts` is
    // a tri-state, and treating its `null` as a value produced
    // `ALLOW_PRIVATE_WEBDAV_HOSTS=null has no effect` on every deployment that never set it — a
    // warning attached to the default configuration, which is how a report stops being read.
    for (const environment of ['production', 'development', 'staging']) {
      expect(warningsFor({ ENVIRONMENT: environment }).filter((w) => w.includes('ALLOW_PRIVATE_WEBDAV_HOSTS'))).toEqual([]);
    }
  });
});

describe('Access settings', () => {
  it('names a TEAM_DOMAIN that is not a hostname, which reads as an Access outage', () => {
    // `TEAM_DOMAIN` feeds the JWKS URL, so an unparsable value degrades JWT verification into a
    // 401 for every real user.
    const warnings = warningsFor({ ENVIRONMENT: 'production', TEAM_DOMAIN: 'not a host' });
    expect(warnings.some((w) => w.includes('TEAM_DOMAIN must be a hostname'))).toBe(true);
  });

  it('refuses a POLICY_AUD carrying several audiences', () => {
    const warnings = warningsFor({ ENVIRONMENT: 'production', POLICY_AUD: 'a,b' });
    expect(warnings.some((w) => w.includes('POLICY_AUD must be a single audience'))).toBe(true);
  });
});
