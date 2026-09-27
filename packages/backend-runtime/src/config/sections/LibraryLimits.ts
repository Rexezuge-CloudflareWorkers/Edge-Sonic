import { EnvParser } from '../EnvParser';
import {
  DEFAULT_AUTH_FAILURE_LIMIT,
  DEFAULT_AUTH_FAILURE_WINDOW_SECONDS,
  DEFAULT_MAX_LIBRARIES,
  DEFAULT_MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SCAN_CHUNK_FOLDERS,
  DEFAULT_STREAM_RATE_LIMIT,
  DEFAULT_STREAM_TIMEOUT_MS,
  DEFAULT_TAG_READ_BYTES,
  DEFAULT_WEBDAV_TIMEOUT_MS,
} from '../ConfigurationDefaults';

/**
 * Library, scan, and request limits.
 *
 * One section per concern so `AppConfiguration` stays a thin facade and the
 * policy for each group of variables is readable in one place.
 */
class LibraryLimits {
  constructor(private readonly env: unknown) {}

  public getMaxLibraries(): number {
    return EnvParser.positiveInt(this.env, 'MAX_LIBRARIES', DEFAULT_MAX_LIBRARIES);
  }

  public getWebdavTimeoutMs(): number {
    return EnvParser.positiveInt(this.env, 'WEBDAV_TIMEOUT_MS', DEFAULT_WEBDAV_TIMEOUT_MS);
  }

  /**
   * Whether a library may point at a private, loopback, or link-local origin.
   *
   * This is an SSRF control with a specific threat: the worker fetches
   * `base_url` **with the stored WebDAV credential attached**, so a library
   * pointed at `http://169.254.169.254/` or a loopback admin port turns the
   * worker into a credentialed proxy into its own network, and the response is
   * readable back through `getMusicDirectory`.
   *
   * Unset follows the environment — allowed in development so a co-located
   * `wrangler dev` against a LAN Nextcloud works, denied in production. A deny
   * -list is not an option for the same reason as the auth bypass allow-list: a
   * new environment name must not silently enable it.
   */
  public getAllowPrivateWebdavHosts(): boolean | null {
    const raw = EnvParser.string(this.env, 'ALLOW_PRIVATE_WEBDAV_HOSTS', '');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed.toLowerCase() === 'true';
  }
}

class ScanLimits {
  constructor(private readonly env: unknown) {}

  /**
   * Folders descended into per scan chunk.
   *
   * Bounded by the 1,000-subrequest Worker limit rather than by taste; see the
   * note in `ConfigurationDefaults`.
   */
  public getScanChunkFolders(): number {
    return EnvParser.positiveInt(this.env, 'SCAN_CHUNK_FOLDERS', DEFAULT_SCAN_CHUNK_FOLDERS);
  }

  public getTagReadBytes(): number {
    return EnvParser.positiveInt(this.env, 'TAG_READ_BYTES', DEFAULT_TAG_READ_BYTES);
  }
}

class RequestLimits {
  constructor(private readonly env: unknown) {}

  /**
  Protocol maximum. A client asking for more is clamped, not refused.
  */
  public getMaxPageSize(): number {
    return EnvParser.positiveInt(this.env, 'MAX_PAGE_SIZE', DEFAULT_MAX_PAGE_SIZE);
  }

  public getDefaultPageSize(): number {
    return EnvParser.positiveInt(this.env, 'DEFAULT_PAGE_SIZE', DEFAULT_PAGE_SIZE);
  }

  public getStreamRateLimit(): number {
    return EnvParser.positiveInt(this.env, 'STREAM_RATE_LIMIT', DEFAULT_STREAM_RATE_LIMIT);
  }

  public getStreamTimeoutMs(): number {
    return EnvParser.positiveInt(this.env, 'STREAM_TIMEOUT_MS', DEFAULT_STREAM_TIMEOUT_MS);
  }
}

/**
 * Authentication throttling.
 *
 * ### Why this exists and why it is D1-backed
 *
 * Subsonic token auth is MD5, which is fast, and `/rest/*` is public. A captured
 * `u`+`t`+`s` is as much information as the password, so an attacker with one
 * request can brute force offline forever without ever touching this server. What
 * the server *can* do is stop an online attempt, and it can only do that if the
 * counter survives both a cold isolate and a KV outage — hence D1, not KV.
 *
 * ### Why it fails CLOSED
 *
 * The streaming rate limiter fails open, because a rate limiter that fails closed
 * takes down playback for every user when its own backing store wobbles. This one
 * is the opposite: if the counter cannot be read, a failed authentication is
 * refused rather than allowed, because the failure mode being defended against is
 * an attacker who is *already* being denied.
 */
class AuthThrottleConfig {
  constructor(private readonly env: unknown) {}

  public getFailureLimit(): number {
    return EnvParser.positiveInt(this.env, 'AUTH_FAILURE_LIMIT', DEFAULT_AUTH_FAILURE_LIMIT);
  }

  public getFailureWindowSeconds(): number {
    return EnvParser.positiveInt(this.env, 'AUTH_FAILURE_WINDOW_SECONDS', DEFAULT_AUTH_FAILURE_WINDOW_SECONDS);
  }
}

export { LibraryLimits, ScanLimits, RequestLimits, AuthThrottleConfig };
