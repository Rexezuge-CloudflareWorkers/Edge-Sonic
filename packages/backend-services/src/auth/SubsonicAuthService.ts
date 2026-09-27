/**
 * Subsonic client authentication.
 *
 * ### The protocol wart, stated once
 *
 * `t = md5(password + salt)`. MD5 is one-way, so a server that stores only a
 * password **hash** cannot compute `t` and cannot authenticate a token client —
 * which is what every real client uses. The password must therefore be
 * recoverable. It is stored AES-GCM encrypted rather than hashed; see
 * `@edge-sonic/backend-data/crypto` for exactly what that does and does not buy.
 *
 * ### What that makes this endpoint attractive
 *
 * Possession of a captured `u`+`t`+`s` is possession of the password, because
 * the token is `md5(password + salt)` over data the attacker already has. They
 * can brute force it offline, forever, without ever touching this server.
 *
 * So the only defence available here is to stop the *online* attempt:
 *
 * - a **D1-backed, fail-closed** failure counter (never KV — a cache-only
 *   throttle is a disabled throttle during the incident it exists for),
 * - keyed on a hash of `username|ip` so the table never records the pair in the
 *   clear,
 * - written **only on failure**, so legitimate traffic spends none of the daily
 *   D1 write allowance,
 * - cleared on success, so one typo does not lock a user out.
 */
import { DatabaseError, UnauthorizedError } from '@edge-sonic/backend-errors';
import { decryptData, timingSafeEqualStrings } from '@edge-sonic/backend-data/crypto';
import type { UserRow } from '@edge-sonic/backend-data/dao';
import { decodeLegacyPassword, ErrorCode, md5Hex, SubsonicError } from '@edge-sonic/subsonic';

interface AuthThrottle {
  countRecentFailures(identity: string, oldestBucket: number, currentBucket: number): Promise<number>;
  recordFailure(identity: string, bucket: number): Promise<number>;
  clearFailures(identity: string): Promise<void>;
  pruneOldBuckets(identity: string, oldestBucket: number): Promise<number>;
}

interface UserLookup {
  findByUsername(username: string): Promise<UserRow | null>;
}

interface AuthDeps {
  /** Returns the base64 key. Throws when the binding is missing or unusable. */
  resolveKey: () => Promise<string>;
  users: UserLookup;
  throttle: AuthThrottle;
  failureLimit: number;
  windowSeconds: number;
  /** Epoch seconds. Injected so the bucket arithmetic is testable. */
  now?: () => number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

class SubsonicAuthService {
  constructor(private readonly deps: AuthDeps) {}

  /**
   * Authenticate a request.
   *
   * @param username The `u` parameter.
   * @param token The `t` parameter, or `null` when absent.
   * @param salt The `s` parameter.
   * @param legacyPassword The `p` parameter, already `enc:`-decoded or `null`.
   * @param clientIp Trusted connecting IP, used only to key the throttle.
   *
   * @throws SubsonicError `code=40` for any credential failure, and `code=0`
   *   when the throttle has engaged. Both are indistinguishable to a caller by
   *   design — see the note in `throttleOrThrow`.
   */
  public async authenticate(input: { username: string; token: string | null; salt: string | null; legacyPassword: string | null; clientIp: string }): Promise<UserRow> {
    const identity = throttleIdentity(input.username, input.clientIp);
    const now = this.deps.now ? this.deps.now() : nowSeconds();
    const bucket = Math.floor(now / this.deps.windowSeconds);
    const oldestBucket = bucket - 1;

    // Fails CLOSED. If the counter cannot be read, a login is refused rather than
    // allowed — the failure mode being defended against is an attacker who is
    // already being turned away, and an unreadable counter is exactly when the
    // server has no idea how many attempts it has absorbed.
    let failures: number;
    try {
      failures = await this.deps.throttle.countRecentFailures(identity, oldestBucket, bucket);
    } catch (error) {
      if (error instanceof DatabaseError) throw new SubsonicError(ErrorCode.Generic, 'Authentication is temporarily unavailable.');
      throw error;
    }
    if (failures >= this.deps.failureLimit) {
      throw new SubsonicError(ErrorCode.Generic, 'Too many failed authentication attempts. Try again later.');
    }

    const user = await this.deps.users.findByUsername(input.username);
    if (!user || user.is_enabled !== 1) {
      await this.recordFailure(identity, bucket, oldestBucket);
      throw new SubsonicError(ErrorCode.WrongCredentials);
    }

    const verified = await this.verifyCredential(user, input.token, input.salt, input.legacyPassword);
    if (!verified) {
      await this.recordFailure(identity, bucket, oldestBucket);
      throw new SubsonicError(ErrorCode.WrongCredentials);
    }

    // Success clears the counter, so one mistyped password does not accumulate
    // into a lockout. This is the only write on the success path.
    try {
      await this.deps.throttle.clearFailures(identity);
    } catch {
      // A failed clear is a hygiene problem, not an authentication one: the
      // window expires on its own. Failing here would reject a valid login
      // because of a bookkeeping write.
    }
    return user;
  }

  private async recordFailure(identity: string, bucket: number, oldestBucket: number): Promise<void> {
    try {
      await this.deps.throttle.recordFailure(identity, bucket);
    } catch {
      // Swallowed deliberately. A counter that fails to increment must not turn a
      // 401 into a 500, and must not tell the caller the counter is broken.
    }
    try {
      await this.deps.throttle.pruneOldBuckets(identity, oldestBucket);
    } catch {
      // Best-effort: `countRecentFailures` bounds its own range, so an unpruned
      // bucket is harmless.
    }
  }

  /**
   * Check `t` first, then `p`.
   *
   * Token auth is preferred and legacy `p` is a fallback, matching the spec's
   * "either `p` or both `t` and `s`" rule. `t` without `s` is not a valid
   * credential and falls through to `p` rather than being computed against an
   * empty salt — `md5(password + "")` would be a *valid* token for an attacker
   * who chose an empty salt, and the protocol has no reason to accept it.
   */
  private async verifyCredential(user: UserRow, token: string | null, salt: string | null, legacyPassword: string | null): Promise<boolean> {
    const key = await this.deps.resolveKey();

    let password: string;
    try {
      password = await decryptData(user.password_ciphertext, user.password_iv, key);
    } catch {
      // A wrong key, a rotated key without a re-encrypt, or a tampered row all
      // land here. All of them mean "this credential cannot be checked", which is
      // a failed authentication and not a 500.
      return false;
    }

    if (token !== null && salt !== null && token.length > 0 && salt.length > 0) {
      if (!/^[\da-f]{32}$/i.test(token)) return false;
      const expected = md5Hex(password + salt);
      // Constant-time: a `===` on a digest short-circuits on the first differing
      // byte, which leaks a prefix of the expected token to a timing attacker.
      // That is a real attack here, because the expected value is precisely what
      // the attacker is guessing.
      return timingSafeEqualStrings(expected.toLowerCase(), token.toLowerCase());
    }

    if (legacyPassword !== null && legacyPassword.length > 0) {
      return timingSafeEqualStrings(password, legacyPassword);
    }

    return false;
  }

  /** Convenience for the admin API, which sets a password rather than checking one. */
  public static async encryptPassword(plaintext: string, key: string): Promise<{ ciphertext: string; iv: string }> {
    const { encryptData } = await import('@edge-sonic/backend-data/crypto');
    return await encryptData(plaintext, key);
  }
}

/**
 * The throttle key.
 *
 * A hash rather than the raw `username|ip`, for two reasons: the table would
 * otherwise record every attacker's chosen usernames next to real users' IP
 * addresses, and an unbounded set of attacker-chosen usernames would grow the
 * table with one row per guess regardless of IP.
 *
 * The username is lowercased first so `Ann` and `ann` share a counter — the same
 * rule the DAOs use, and for the same reason: one identity, one counter.
 */
function throttleIdentity(username: string, clientIp: string): string {
  const material = `${username.trim().toLowerCase()}|${clientIp}`;
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  // 64 bits from two independent 32-bit rounds: an attacker's username space is
  // unbounded, so a 32-bit table key is birthday-bound at ~77k rows.
  let hash2 = 0xc2b2_ae35;
  for (let index = material.length - 1; index >= 0; index -= 1) {
    hash2 ^= material.charCodeAt(index);
    hash2 = Math.imul(hash2, 0x85eb_ca6b);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}${(hash2 >>> 0).toString(16).padStart(8, '0')}`;
}

export { SubsonicAuthService, throttleIdentity, decodeLegacyPassword, UnauthorizedError };
