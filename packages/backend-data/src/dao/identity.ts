/**
 * Identity and library DAOs.
 *
 * ### The predicate rule
 *
 * Every lookup in this file compares a **lowercased parameter** against a
 * **`_ci` column** (`WHERE username_ci = ?`, bound with `username.toLowerCase()`),
 * never the reverse. `lower(col)` compares a computed value, so it cannot use an
 * index and turns the authenticated hot path into a full table scan.
 *
 * This is easy to get backwards because a D1 test double that lowercases *both*
 * sides in JavaScript returns identical rows either way — the predicate is wrong,
 * the answers match, and only the query plan differs. `test/schema.int.test.ts` asserts
 * `EXPLAIN QUERY PLAN` for that reason.
 */
import { ConflictError, NotFoundError } from '@rexezuge/errors';
import { BaseDAO } from './BaseDAO';
import type { LibraryRow, UserRow } from './rows';
import { UUIDUtil } from '@rexezuge/shared';

/**
Epoch seconds. Every timestamp column in this schema is seconds.
*/
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

class UserDAO extends BaseDAO {
  public async findByUsername(username: string): Promise<UserRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM users WHERE username_ci = ?').bind(username.toLowerCase()).first<UserRow>(),
      'users.findByUsername',
    );
  }

  public async findById(id: string): Promise<UserRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>(),
      'users.findById',
    );
  }

  public async list(): Promise<UserRow[]> {
    const result = await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM users ORDER BY username_ci ASC').all<UserRow>(),
      'users.list',
    );
    return result.results ?? [];
  }

  public async create(input: {
    username: string;
    passwordCiphertext: string;
    passwordIv: string;
    email?: string | null;
    isAdmin?: boolean;
  }): Promise<UserRow> {
    const timestamp = nowSeconds();
    const id = UUIDUtil.getRandomUUID();
    // The anchor (`email`) is first-seen and frozen; `current_email` is the
    // mutable sign-in address, lowercased like every other `_ci`-style lookup
    // key in this file. `NULL` when no address was given — `UNIQUE` permits
    // multiple `NULL`s, so address-less accounts neither conflict nor register.
    // A blank string counts as absent: registering `''` would spend the one
    // empty slot the unique index allows and 500 every later blank create.
    const trimmed = input.email?.trim() ?? '';
    const address = trimmed === '' ? null : trimmed.toLowerCase();
    // A verified address already held elsewhere refuses with a `409` rather
    // than re-pointing — silently taking another account's address would hand
    // its history over — while a revoked (unverified) row is re-pointed,
    // releasing the address. Checked before the insert, like the username
    // conflict in `UserService`, so a refusal leaves no user row behind it.
    if (address !== null) {
      const holder = await new UserEmailDAO(this.database, this.subrequests).resolveVerified(address);
      if (holder) {
        throw new ConflictError('That email address is already registered to another user.');
      }
    }
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO users (id, username, username_ci, password_ciphertext, password_iv, key_version, email, current_email, is_admin, is_enabled, scrobbling_enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 1, ?, ?)`,
          )
          .bind(
            id,
            input.username,
            input.username.toLowerCase(),
            input.passwordCiphertext,
            input.passwordIv,
            input.email ?? null,
            address,
            input.isAdmin ? 1 : 0,
            timestamp,
            timestamp,
          )
          .run(),
      'users.create',
    );
    // The registry mirrors the anchor, verified: creation by an operator is the
    // same claim the `0011` backfill makes for existing rows.
    if (address !== null) {
      const emails = new UserEmailDAO(this.database, this.subrequests);
      await emails.register({ email: address, userId: id, isVerified: true, now: timestamp });
    }
    const created = await this.findById(id);
    if (!created) throw new Error('users.create did not produce a readable row.');
    return created;
  }

  /**
   * Change a password and invalidate every issued token.
   *
   * A Subsonic token is `md5(password + salt)`, so it is derived from the
   * credential rather than issued by the server — there is no session row and
   * nothing to revoke. Changing the password changes **what the token is computed
   * from**, so every already-issued token stops verifying at this statement, and
   * revocation is a consequence of the write rather than a second mechanism.
   *
   * `token_epoch` used to be bumped here "in the SAME statement" to invalidate
   * tokens. It was compared by nothing and could not have worked: the column
   * recorded how many times the password had changed while no credential carried
   * the epoch a client held, so there was no value to compare against. Dropped in
   * `migrations/0010_drop_token_epoch.sql`.
   *
   * `key_version` **is** load-bearing — it is the rotation handle. Re-encrypt
   * under a new version, then drop the old one.
   */
  public async updatePassword(id: string, passwordCiphertext: string, passwordIv: string, keyVersion: number): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('UPDATE users SET password_ciphertext = ?, password_iv = ?, key_version = ?, updated_at = ? WHERE id = ?')
          .bind(passwordCiphertext, passwordIv, keyVersion, nowSeconds(), id)
          .run(),
      'users.updatePassword',
    );
  }

  /**
   * Point an account at a new sign-in address.
   *
   * The id, the frozen anchor, and every id-keyed row are untouched: only which
   * address authenticates moves. Order is load-bearing — claim first, move
   * `current_email` second, revoke third — so a failure never leaves the
   * account with no authenticating address. Rejects an address already verified
   * for another account: an unverified change would let anyone claim an address
   * and inherit its history.
   *
   * No route calls this yet (there is no address-change endpoint); it is the
   * operation the registry exists for, asserted in `test/schema.int.test.ts`
   * like every other DAO method, so the move half of the lifecycle is not a
   * paragraph describing a call nobody can make.
   */
  public async setCurrentEmail(id: string, email: string): Promise<UserRow> {
    const address = email.toLowerCase();
    const timestamp = nowSeconds();
    const current = await this.findById(id);
    if (!current) throw new NotFoundError('That user does not exist.');
    if (current.current_email === address) return current;
    const emails = new UserEmailDAO(this.database, this.subrequests);
    const holder = await emails.resolveVerified(address);
    if (holder && holder.user_id !== id) {
      throw new ConflictError('That email address is already registered to another user.');
    }
    await emails.register({ email: address, userId: id, isVerified: true, now: timestamp });
    await this.withRetry(
      async () =>
        await this.database.prepare('UPDATE users SET current_email = ?, updated_at = ? WHERE id = ?').bind(address, timestamp, id).run(),
      'users.setCurrentEmail',
    );
    // Revoke every other verified address, so only the new one authenticates.
    await emails.revokeAllVerified(id, address);
    const moved = await this.findById(id);
    if (!moved) throw new Error('users.setCurrentEmail did not produce a readable row.');
    return moved;
  }

  public async setEnabled(id: string, isEnabled: boolean): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('UPDATE users SET is_enabled = ?, updated_at = ? WHERE id = ?')
          .bind(isEnabled ? 1 : 0, nowSeconds(), id)
          .run(),
      'users.setEnabled',
    );
  }

  public async delete(id: string): Promise<void> {
    // The children (playlists, stars, bookmarks, …) cascade from here, which is
    // exactly why `users` must never be REBUILT as a migration — see the header
    // note in `migrations/0001`.
    await this.withRetry(async () => await this.database.prepare('DELETE FROM users WHERE id = ?').bind(id).run(), 'users.delete');
  }

  /**
  Library ids this user may see. Empty means "none", never "all".
  */
  public async listLibraryIds(userId: string): Promise<string[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            'SELECT l.id AS id FROM libraries l INNER JOIN user_libraries ul ON ul.library_id = l.id WHERE ul.user_id = ? ORDER BY l.slug_ci ASC',
          )
          .bind(userId)
          .all<{ id: string }>(),
      'users.listLibraryIds',
    );
    return (result.results ?? []).map((row) => row.id);
  }

  public async setLibraryGrants(userId: string, libraryIds: readonly string[]): Promise<void> {
    const statements = [
      this.database.prepare('DELETE FROM user_libraries WHERE user_id = ?').bind(userId),
      ...libraryIds.map((libraryId) =>
        this.database
          .prepare('INSERT OR IGNORE INTO user_libraries (user_id, library_id, created_at) VALUES (?, ?, ?)')
          .bind(userId, libraryId, nowSeconds()),
      ),
    ];
    if (this.database.batch) {
      await this.withRetry(async () => {
        await this.database.batch!(statements);
        return { success: true };
      }, 'users.setLibraryGrants');
      return;
    }
    for (const statement of statements) {
      await this.withRetry(async () => await statement.run(), 'users.setLibraryGrants');
    }
  }
}

/**
 * One known address for an account, and the registry operations on it.
 *
 * The statements are `@rexezuge/identity`'s `UserEmailDAO` verbatim — the
 * registry is the kit's design (frozen anchor, verified-only resolution,
 * revocable-and-re-pointable rows) — re-homed here because every DAO in this
 * layer constructs with the invocation's `SubrequestMeter` and the kit's DAO
 * takes none. If the kit's SQL changes, this class ports it; the two must
 * never drift, because a registry that resolves differently from the design
 * hands one account's history to another.
 *
 * `is_verified` gates authentication: `1` may resolve the account, `0` was
 * changed away from and is retained only so rows written before the change
 * stay attributable. A revoked row is re-pointed (not deleted) when a later
 * account legitimately claims the address, so an address is never permanently
 * reserved. Login itself stays username-based (`findByUsername`); the registry
 * is what a future address change moves through, and what `resolveVerified`
 * answers today.
 */
interface UserEmailRow {
  email: string;
  user_id: string;
  is_verified: number;
  created_at: number;
}

type EmailClaim = 'claimed' | 'already-claimed';

class UserEmailDAO extends BaseDAO {
  /**
   * Claim an address for an account.
   *
   * An existing verified row is left alone: the address already belongs to
   * someone, and silently re-pointing it would hand one account's identity to
   * another. Callers check `resolveVerified` first and reject on a hit.
   * An unverified (revoked) row is re-pointed, which releases the address.
   */
  public async register(input: { email: string; userId: string; isVerified: boolean; now: number }): Promise<EmailClaim> {
    const email = input.email.toLowerCase();
    const existing = await this.get(email);
    if (existing && existing.is_verified === 1) return 'already-claimed';
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO user_emails (email, user_id, is_verified, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, is_verified = excluded.is_verified`,
          )
          .bind(email, input.userId, input.isVerified ? 1 : 0, input.now)
          .run(),
      'userEmails.register',
    );
    return 'claimed';
  }

  public async get(email: string): Promise<UserEmailRow | null> {
    // Lowercase the *parameter*: the column is stored lowercased by every
    // writer, so `lower(email) = ?` matched identically while making the
    // primary key unusable.
    return await this.withRetry(
      async () =>
        await this.database.prepare('SELECT * FROM user_emails WHERE email = ? LIMIT 1').bind(email.toLowerCase()).first<UserEmailRow>(),
      'userEmails.get',
    );
  }

  /*
   * Resolution for authentication: only a verified address identifies an
   * account.
   */
  public async resolveVerified(email: string): Promise<UserEmailRow | null> {
    return await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM user_emails WHERE email = ? AND is_verified = 1 LIMIT 1')
          .bind(email.toLowerCase())
          .first<UserEmailRow>(),
      'userEmails.resolveVerified',
    );
  }

  public async listByUserId(userId: string): Promise<UserEmailRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM user_emails WHERE user_id = ? ORDER BY is_verified DESC, created_at ASC')
          .bind(userId)
          .all<UserEmailRow>(),
      'userEmails.listByUserId',
    );
    return result.results ?? [];
  }

  /*
   * Revoke an address for authentication while keeping it attributable.
   */
  public async revoke(email: string): Promise<void> {
    await this.withRetry(
      async () => await this.database.prepare('UPDATE user_emails SET is_verified = 0 WHERE email = ?').bind(email.toLowerCase()).run(),
      'userEmails.revoke',
    );
  }

  /**
   * Revoke every verified address for an account. Used when an account's login
   * address changes, so only the new address authenticates it.
   */
  public async revokeAllVerified(userId: string, exceptEmail: string): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('UPDATE user_emails SET is_verified = 0 WHERE user_id = ? AND email != ?')
          .bind(userId, exceptEmail.toLowerCase())
          .run(),
      'userEmails.revokeAllVerified',
    );
  }
}

class LibraryDAO extends BaseDAO {
  public async findById(id: string): Promise<LibraryRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM libraries WHERE id = ?').bind(id).first<LibraryRow>(),
      'libraries.findById',
    );
  }

  public async findBySlug(slug: string): Promise<LibraryRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM libraries WHERE slug_ci = ?').bind(slug.toLowerCase()).first<LibraryRow>(),
      'libraries.findBySlug',
    );
  }

  public async list(): Promise<LibraryRow[]> {
    const result = await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM libraries ORDER BY slug_ci ASC').all<LibraryRow>(),
      'libraries.list',
    );
    return result.results ?? [];
  }

  public async listForUser(userId: string): Promise<LibraryRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT l.* FROM libraries l
             INNER JOIN user_libraries ul ON ul.library_id = l.id
             WHERE ul.user_id = ? AND l.is_enabled = 1
             ORDER BY l.slug_ci ASC`,
          )
          .bind(userId)
          .all<LibraryRow>(),
      'libraries.listForUser',
    );
    return result.results ?? [];
  }

  public async create(input: {
    slug: string;
    baseUrl: string;
    rootPath: string;
    davUsername: string;
    passwordCiphertext: string;
    passwordIv: string;
    displayName?: string | null;
  }): Promise<LibraryRow> {
    const timestamp = nowSeconds();
    const id = UUIDUtil.getRandomUUID();
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
          )
          .bind(
            id,
            input.slug,
            input.slug.toLowerCase(),
            input.baseUrl,
            input.rootPath,
            input.davUsername,
            input.passwordCiphertext,
            input.passwordIv,
            input.displayName ?? null,
            timestamp,
            timestamp,
          )
          .run(),
      'libraries.create',
    );
    const created = await this.findById(id);
    if (!created) throw new Error('libraries.create did not produce a readable row.');
    return created;
  }

  public async update(
    id: string,
    input: { slug: string; baseUrl: string; rootPath: string; davUsername: string; displayName?: string | null },
  ): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `UPDATE libraries SET slug = ?, slug_ci = ?, base_url = ?, root_path = ?, dav_username = ?, display_name = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(
            input.slug,
            input.slug.toLowerCase(),
            input.baseUrl,
            input.rootPath,
            input.davUsername,
            input.displayName ?? null,
            nowSeconds(),
            id,
          )
          .run(),
      'libraries.update',
    );
  }

  public async updatePassword(id: string, passwordCiphertext: string, passwordIv: string, keyVersion: number): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('UPDATE libraries SET password_ciphertext = ?, password_iv = ?, key_version = ?, updated_at = ? WHERE id = ?')
          .bind(passwordCiphertext, passwordIv, keyVersion, nowSeconds(), id)
          .run(),
      'libraries.updatePassword',
    );
  }

  public async delete(id: string): Promise<void> {
    // Cascades to `nodes`, `songs`, and `scan_state` — which is the point: a
    // deleted library takes its index with it in one statement.
    await this.withRetry(async () => await this.database.prepare('DELETE FROM libraries WHERE id = ?').bind(id).run(), 'libraries.delete');
  }
}

export { UserDAO, UserEmailDAO, LibraryDAO, nowSeconds };
export type { UserEmailRow, EmailClaim };
