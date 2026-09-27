import { EnvParser } from './EnvParser';
import { DEFAULT_DEBUG_MODE, DEFAULT_SITE_URL } from './ConfigurationDefaults';
import { AuthConfig } from './sections/AuthConfig';
import { AuthThrottleConfig, LibraryLimits, RequestLimits, ScanLimits } from './sections/LibraryLimits';

/**
 * Injectable view over Edge-Sonic's environment configuration.
 *
 * Composed of focused section objects so this facade stays thin and each group of
 * variables has one readable policy. Read env through this, never inline: a
 * variable read directly from `env` bypasses `validate()`, and every failure mode
 * `validate()` checks is silent at request time.
 */
class AppConfiguration {
  private readonly library: LibraryLimits;
  private readonly scan: ScanLimits;
  private readonly requests: RequestLimits;
  private readonly throttle: AuthThrottleConfig;
  private readonly auth: AuthConfig;

  constructor(private readonly env: unknown) {
    this.library = new LibraryLimits(env);
    this.scan = new ScanLimits(env);
    this.requests = new RequestLimits(env);
    this.throttle = new AuthThrottleConfig(env);
    this.auth = new AuthConfig(env);
  }

  public static fromEnv(env: unknown): AppConfiguration {
    return new AppConfiguration(env);
  }

  public get libraryLimits(): LibraryLimits {
    return this.library;
  }

  public get scanLimits(): ScanLimits {
    return this.scan;
  }

  public get requestLimits(): RequestLimits {
    return this.requests;
  }

  public get authThrottle(): AuthThrottleConfig {
    return this.throttle;
  }

  public getDebugMode(): boolean {
    return EnvParser.boolean(this.env, 'DEBUG_MODE', DEFAULT_DEBUG_MODE);
  }

  public getSiteUrl(): string {
    let url = EnvParser.string(this.env, 'SITE_URL', DEFAULT_SITE_URL);
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  }

  public getMaxLibraries(): number {
    return this.library.getMaxLibraries();
  }

  public getWebdavTimeoutMs(): number {
    return this.library.getWebdavTimeoutMs();
  }

  public getAllowPrivateWebdavHosts(): boolean | null {
    return this.library.getAllowPrivateWebdavHosts();
  }

  public getScanChunkFolders(): number {
    return this.scan.getScanChunkFolders();
  }

  public getTagReadBytes(): number {
    return this.scan.getTagReadBytes();
  }

  public getMaxPageSize(): number {
    return this.requests.getMaxPageSize();
  }

  public getDefaultPageSize(): number {
    return this.requests.getDefaultPageSize();
  }

  public getStreamRateLimit(): number {
    return this.requests.getStreamRateLimit();
  }

  public getStreamTimeoutMs(): number {
    return this.requests.getStreamTimeoutMs();
  }

  public getAuthFailureLimit(): number {
    return this.throttle.getFailureLimit();
  }

  public getAuthFailureWindowSeconds(): number {
    return this.throttle.getFailureWindowSeconds();
  }

  public isDemoMode(): boolean {
    return this.auth.isDemoMode();
  }

  public getEnvironment(): string {
    return this.auth.getEnvironment();
  }

  public isBypassAllowed(): boolean {
    return this.auth.isBypassAllowed();
  }

  public getDevAuthEmail(): string | null {
    return this.auth.getDevAuthEmail();
  }

  public getDemoUserEmail(): string | null {
    return this.auth.getDemoUserEmail();
  }

  public getTeamDomain(): string | null {
    return this.auth.getTeamDomain();
  }

  public getPolicyAud(): string | null {
    return this.auth.getPolicyAud();
  }

  /**
   * Fail-fast misconfiguration report. Empty means clean.
   *
   * Call **once per isolate** on the first request and log the result. Every
   * failure mode below is silent at runtime: a bad numeric var quietly falls back
   * to its default, and a bypass identity set in production quietly
   * authenticates every unauthenticated request as a fixed user.
   */
  public validate(): string[] {
    const warnings: string[] = [];
    const numericKeys = [
      'MAX_LIBRARIES',
      'WEBDAV_TIMEOUT_MS',
      'SCAN_CHUNK_FOLDERS',
      'TAG_READ_BYTES',
      'MAX_PAGE_SIZE',
      'DEFAULT_PAGE_SIZE',
      'STREAM_RATE_LIMIT',
      'STREAM_TIMEOUT_MS',
      'AUTH_FAILURE_LIMIT',
      'AUTH_FAILURE_WINDOW_SECONDS',
    ];
    for (const key of numericKeys) {
      if (!EnvParser.isValidPositiveInt(this.env, key)) {
        warnings.push(`Invalid configuration: ${key} must be a positive integer`);
      }
    }

    // A bypass present but inert is the dangerous direction: one edit to
    // ENVIRONMENT away from authenticating everyone as a fixed identity. An
    // *active* bypass is the intended local setup and is not reported.
    if (!this.isBypassAllowed() && (this.getDevAuthEmail() !== null || this.isDemoMode())) {
      warnings.push(
        `Security: DEV_AUTH_EMAIL/DEMO_MODE is set while ENVIRONMENT=${this.getEnvironment()}. ` +
          `The bypass is ignored in this environment; remove the variable so it cannot become live if ENVIRONMENT changes.`,
      );
    }

    // An unparsable TEAM_DOMAIN silently degrades JWT verification into a 401 for
    // every real user, which reads as an Access outage rather than a typo.
    const teamDomain = this.getTeamDomain();
    if (teamDomain !== null && !isParsableTeamDomain(teamDomain)) {
      warnings.push(`Invalid configuration: TEAM_DOMAIN must be a hostname (got ${JSON.stringify(teamDomain)})`);
    }
    const policyAud = this.getPolicyAud();
    if (policyAud !== null && policyAud.includes(',')) {
      warnings.push('Invalid configuration: POLICY_AUD must be a single audience; multiple values are not supported');
    }

    const allowPrivate = this.getAllowPrivateWebdavHosts();

    // Production plus private hosts re-opens the SSRF surface the default exists
    // to close, and the credential angle is what makes it worse than usual: the
    // worker attaches the stored WebDAV password to every request to that origin.
    if (!this.isBypassAllowed() && allowPrivate === true) {
      warnings.push(
        `Security: ALLOW_PRIVATE_WEBDAV_HOSTS=true while ENVIRONMENT=${this.getEnvironment()}. ` +
          `Libraries may target loopback and private-network origins, and the worker sends the stored WebDAV credential to them.`,
      );
    }
    if (allowPrivate === true && this.isBypassAllowed()) {
      warnings.push(
        `Note: ALLOW_PRIVATE_WEBDAV_HOSTS=true has no effect while ENVIRONMENT=${this.getEnvironment()} (private hosts are already allowed).`,
      );
    }
    if (allowPrivate === false && !this.isBypassAllowed()) {
      warnings.push(
        `Note: ALLOW_PRIVATE_WEBDAV_HOSTS=false has no effect while ENVIRONMENT=${this.getEnvironment()} (private hosts are already denied).`,
      );
    }

    return warnings;
  }
}

/** `TEAM_DOMAIN` feeds the JWKS URL, so a scheme-less value throws inside `jose`. */
function isParsableTeamDomain(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

export { AppConfiguration };
