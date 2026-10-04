import { EnvParser } from './EnvParser';
import { isLogLevel } from '../logger';
import type { LogLevel } from '../logger';
import {
  DEFAULT_DEBUG_MODE,
  DEFAULT_SITE_URL,
  MAX_PAGE_SIZE_CEILING,
} from './ConfigurationDefaults';
import {
  SCAN_CHUNK_FOLDER_LIMIT,
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SCAN_ENRICH_MAX_PER_FOLDER,
  SUBSREQUESTS_PER_ENRICHED_TRACK,
  SUBSREQUESTS_PER_FOLDER_BASE,
  WORKER_SUBSREQUEST_CEILING,
} from './subrequests';
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

  /**
  The configured log level, or `null` when unset or unrecognised.
  *
  * `null` rather than a fallback, because "unset" and "set to something invalid" are the
  * same case for the emitters — they use their own default — while `validate()` names the
  * invalid one. It is `LOG_LEVEL`, read here rather than at logger construction because
  * both of this product's loggers are module-level constants and `env` does not exist at
  * module scope in a Worker.
  */
  public getLogLevel(): LogLevel | null {
    const raw = EnvParser.string(this.env, 'LOG_LEVEL', '').trim().toLowerCase();
    return isLogLevel(raw) ? raw : null;
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

  public getScanChunkMaxRequests(): number {
    return this.scan.getScanChunkMaxRequests();
  }

  public getScanChunkDeadlineMs(): number {
    return this.scan.getScanChunkDeadlineMs();
  }

  public getTagReadBytes(): number {
    return this.scan.getTagReadBytes();
  }

  public getTagReadTailBytes(): number {
    return this.scan.getTagReadTailBytes();
  }

  public getScanEnrichMaxPerFolder(): number {
    return this.scan.getScanEnrichMaxPerFolder();
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
      'SCAN_CHUNK_MAX_REQUESTS',
      'SCAN_CHUNK_DEADLINE_MS',
      'SCAN_ENRICH_MAX_PER_FOLDER',
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

    // `TAG_READ_TAIL_BYTES` is absent from the list above, so a typo'd value fell back to
    // the 64 KB default and the Ogg duration was quietly absent for every track — the
    // exact failure the header says this method exists to catch. Checked separately
    // rather than by adding it to `numericKeys`, because its contract is `>= 0` and zero is
    // a supported value (`getTagReadTailBytes`), which `isValidPositiveInt` would report as
    // invalid. Two contracts, two checks.
    if (!EnvParser.isValidNonNegativeInt(this.env, 'TAG_READ_TAIL_BYTES')) {
      warnings.push('Invalid configuration: TAG_READ_TAIL_BYTES must be a non-negative integer (0 disables the Ogg tail read)');
    }

    // A page size above what one invocation can answer is a **failed** request, not a slow
    // one, so the clamp is reported rather than applied quietly. Reported separately from
    // the list above because the configured value *is* a valid positive integer — it is
    // the request it implies that is unservable, and nothing else here would say so.
    const requestedPageSize = this.requests.getRequestedMaxPageSize();
    if (requestedPageSize > MAX_PAGE_SIZE_CEILING) {
      warnings.push(
        `Configuration: MAX_PAGE_SIZE=${requestedPageSize} exceeds the ${MAX_PAGE_SIZE_CEILING} this server can answer in one request; ` +
          `it is clamped. A page is a promise to answer, not a budget to spend — raise it only with ` +
          `limits.subrequests in the wrangler config.`,
      );
    }

    // The three scan bounds, clamped for the same reason and reported for the same reason.
    //
    // The scan's is the sharper case, because the operator surface *tells people to raise this
    // one*: `stoppedBy: 'requests'` renders as "Paused at the per-chunk request limit. Raise
    // SCAN_CHUNK_MAX_REQUESTS to index more per poll." On a Free-plan account that advice is
    // actively harmful — the platform's ceiling is 50 and cannot be raised from here — so a
    // deployment that took it would get chunks terminated by the runtime instead of paused by
    // their own budget. The clamp makes the advice harmless and the warning says why.
    const requestedChunkRequests = this.scan.getRequestedScanChunkMaxRequests();
    if (requestedChunkRequests > SCAN_CHUNK_SUBSREQUEST_BUDGET) {
      warnings.push(
        `Configuration: SCAN_CHUNK_MAX_REQUESTS=${requestedChunkRequests} exceeds the ${SCAN_CHUNK_SUBSREQUEST_BUDGET} a chunk may spend ` +
          `under the platform's ${WORKER_SUBSREQUEST_CEILING}-subrequest ceiling; it is clamped. Workers Free does not raise that ceiling, ` +
          `so a chunk that spends more is terminated rather than slowed.`,
      );
    }
    const requestedChunkFolders = this.scan.getRequestedScanChunkFolders();
    if (requestedChunkFolders > SCAN_CHUNK_FOLDER_LIMIT) {
      warnings.push(
        `Configuration: SCAN_CHUNK_FOLDERS=${requestedChunkFolders} exceeds the ${SCAN_CHUNK_FOLDER_LIMIT} a chunk can afford at ` +
          `${SUBSREQUESTS_PER_FOLDER_BASE} subrequests a folder; it is clamped. Raising it cannot make a chunk finish.`,
      );
    }
    const requestedEnrichCap = this.scan.getRequestedScanEnrichMaxPerFolder();
    if (requestedEnrichCap > SCAN_ENRICH_MAX_PER_FOLDER) {
      warnings.push(
        `Configuration: SCAN_ENRICH_MAX_PER_FOLDER=${requestedEnrichCap} exceeds the ${SCAN_ENRICH_MAX_PER_FOLDER} a chunk can afford at ` +
          `${SUBSREQUESTS_PER_ENRICHED_TRACK} subrequests a track; it is clamped.`,
      );
    }

    // `LOG_LEVEL` is checked separately because it is an enum rather than a number, and
    // because it is the one variable whose value was silently unobservable: both loggers
    // are module-level constants, so the level was resolved before `env` existed and an
    // operator who set `LOG_LEVEL=debug` got silence — the log level you cannot see is not
    // a setting. `validate()` is where a typo becomes visible at all.
    const logLevel = EnvParser.string(this.env, 'LOG_LEVEL', '').trim();
    if (logLevel.length > 0 && !isLogLevel(logLevel.toLowerCase())) {
      warnings.push(`Invalid configuration: LOG_LEVEL must be one of debug, info, warn, error (got ${JSON.stringify(logLevel)})`);
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

/**
`TEAM_DOMAIN` feeds the JWKS URL, so a scheme-less value throws inside `jose`.
*/
function isParsableTeamDomain(value: string): boolean {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

export { AppConfiguration };
