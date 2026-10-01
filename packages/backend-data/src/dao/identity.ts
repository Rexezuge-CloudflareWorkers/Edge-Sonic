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
 * the answers match, and only the query plan differs. `test/integration` asserts
 * `EXPLAIN QUERY PLAN` for that reason.
 */
import { BaseDAO } from './BaseDAO';
import type { LibraryRow, UserRow } from './rows';
import { UUIDUtil } from '@edge-sonic/shared/utils';

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
    return await this.withRetry(async () => await this.database.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>(), 'users.findById');
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
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO users (id, username, username_ci, password_ciphertext, password_iv, key_version, token_epoch, email, is_admin, is_enabled, scrobbling_enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, 1, 1, ?, ?)`,
          )
          .bind(
            id,
            input.username,
            input.username.toLowerCase(),
            input.passwordCiphertext,
            input.passwordIv,
            input.email ?? null,
            input.isAdmin ? 1 : 0,
            timestamp,
            timestamp,
          )
          .run(),
      'users.create',
    );
    const created = await this.findById(id);
    if (!created) throw new Error('users.create did not produce a readable row.');
    return created;
  }

  /**
   * Change a password and invalidate every issued token.
   *
   * `token_epoch` is bumped in the SAME statement as the credential write. A
   * Subsonic token is valid forever, so without the bump there is no way to
   * revoke one after a password change — the client's saved credential keeps
   * working until the user notices.
   */
  public async updatePassword(id: string, passwordCiphertext: string, passwordIv: string, keyVersion: number): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('UPDATE users SET password_ciphertext = ?, password_iv = ?, key_version = ?, token_epoch = token_epoch + 1, updated_at = ? WHERE id = ?')
          .bind(passwordCiphertext, passwordIv, keyVersion, nowSeconds(), id)
          .run(),
      'users.updatePassword',
    );
  }

  public async setEnabled(id: string, isEnabled: boolean): Promise<void> {
    await this.withRetry(
      async () => await this.database.prepare('UPDATE users SET is_enabled = ?, updated_at = ? WHERE id = ?').bind(isEnabled ? 1 : 0, nowSeconds(), id).run(),
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
          .prepare('SELECT l.id AS id FROM libraries l INNER JOIN user_libraries ul ON ul.library_id = l.id WHERE ul.user_id = ? ORDER BY l.slug_ci ASC')
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

export { UserDAO, LibraryDAO, nowSeconds };
