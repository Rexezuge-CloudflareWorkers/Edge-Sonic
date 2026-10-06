import { EnvParser } from './EnvParser';
import type { AlbumGroupingValue } from '@edge-sonic/subsonic';
import { isLogLevel } from '../logger';
import type { LogLevel } from '../logger';
import { DEFAULT_DEBUG_MODE, DEFAULT_SITE_URL } from './ConfigurationDefaults';
import { AuthConfig } from './sections/AuthConfig';
import { AuthThrottleConfig, LibraryLimits, RequestLimits, ScanLimits } from './sections/LibraryLimits';
import { DERIVED_MARKER_MAX_LENGTH, validateConfiguration } from './validate';

/**
 * Injectable view over Edge-Sonic's environment configuration.
 *
 * Composed of focused section objects so this facade stays thin and each group of
 * variables has one readable policy. Read env through this, never inline: a
 * variable read directly from `env` bypasses `validate()`, and every failure mode
 * `validate()` checks is silent at request time.
 *
 * ### What is deliberately *not* here
 *
 * The checks themselves. `validate()` delegates to `validateConfiguration` in `validate.ts`,
 * because this class is a facade with one getter per setting and the checks are a list of policy
 * that had grown to a hundred and eighty lines on top of it. The limit below is re-exported for
 * the same reason — a check and the number it enforces have to be read together, and a caller
 * asserting the boundary should not have to import the checker to find it.
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

  /**
   * The longest a `DERIVED_MARKER` may be.
   *
   * Owned by `validate.ts` beside the check that enforces it, and re-exported here so the
   * boundary is readable from the facade. It is a cap rather than a preference because the marker
   * is appended to **every** derived name: it lands in `artist`/`album` and their `_ci` twins, in
   * the sort order, and base64url-encoded into every album id the server mints. An unbounded
   * string is an unbounded album key, and the key is part of a `WHERE` clause as well as a URL
   * path — so its cost is paid on every request, not once.
   */
  public static readonly DERIVED_MARKER_MAX_LENGTH = DERIVED_MARKER_MAX_LENGTH;

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

  /**
   * Which tracks are one album. See `subsonic/albumKey.ts` for what each value means and
   * what it costs — this only decides which one is in force.
   */
  public getAlbumGroupBy(): AlbumGroupingValue {
    return this.requests.getAlbumGroupBy();
  }

  /**
   * The marker appended to a path-derived artist or album name.
   *
   * See `ConfigurationDefaults` for why empty is the default and what that merges. Threaded into
   * the DAOs by constructor at the composition root — `backend-data` is a lower layer and cannot
   * import this one, which is the same reason `ALBUM_GROUP_BY` is carried per request rather than
   * read from a module.
   */
  public getDerivedMarker(): string {
    return this.requests.getDerivedMarker();
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

  public getDemoUserEmail(): string {
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
   * Call **once per isolate** on the first request and log the result. Every failure mode it
   * checks is silent at request time: a bad numeric var quietly falls back to its default, and a
   * bypass identity set in production quietly authenticates every unauthenticated request as a
   * fixed user.
   */
  public validate(): string[] {
    return validateConfiguration(this.library, this.scan, this.requests, this.auth, this.env);
  }
}

export { AppConfiguration };