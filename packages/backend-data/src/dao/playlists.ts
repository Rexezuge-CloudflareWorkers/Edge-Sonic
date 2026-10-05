/**
 * Playlists: a named, ordered list of songs owned by one user.
 *
 * Split from `UserStateDAO` because it is a different shape of thing. Everything else in
 * that file is per-user **state** - a star, a rating, a saved queue - keyed by
 * `(user_id, item_id)` and read once per request. A playlist is a row with a name, a
 * comment, a public flag, its own entry table, and an order that is part of its identity
 * rather than a timestamp that happens to sort.
 *
 * ### The position gap is deliberate
 *
 * `removeEntriesAt` deletes the highest index first and does **not** renumber what is
 * left. Positions are the protocol's addressing scheme: a client is holding
 * `songIndexToRemove` values across a call, and renumbering mid-operation would make them
 * point at the wrong tracks. An append uses `MAX(position) + 1`, so a gap costs nothing -
 * and `song_count` is the number of entries rather than the highest position, because
 * that is the number a progress bar is drawn from.
 */
import { UUIDUtil } from '@edge-sonic/shared/utils';
import { BaseDAO } from './BaseDAO';
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import { nowSeconds } from './identity';
import type { PlaylistEntryRow, PlaylistRow, SongRow } from './rows';

class PlaylistDAO extends BaseDAO {
  public async findById(id: string): Promise<PlaylistRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM playlists WHERE id = ?').bind(id).first<PlaylistRow>(),
      'playlists.findById',
    );
  }

  /**
   * Playlists the user may see: their own, plus public ones.
   *
   * The visibility rule lives in SQL rather than in a service filter so that a
   * forgotten filter cannot leak another user's private playlist.
   */
  public async listVisible(userId: string): Promise<PlaylistRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM playlists WHERE owner_user_id = ? OR is_public = 1 ORDER BY name ASC')
          .bind(userId)
          .all<PlaylistRow>(),
      'playlists.listVisible',
    );
    return result.results ?? [];
  }

  /**
   * One user's own playlists, public ones excluded.
   *
   * A second reading, not a variant of {@link listVisible}. That one answers "what can I
   * see", which is `mine OR public` — and the protocol's `username` parameter asks "whose
   * are these", which is only the first half. Using it for the parameter meant an admin
   * asking for another user's playlists received their own plus every public playlist in the
   * server: an answer that grows with the library and is not the one that was asked for.
   *
   * `LOWER(username_ci) = LOWER(?)` would be the readable form and is **wrong** here: it
   * lowercases the column, which cannot use the index, so the authenticated hot path
   * becomes a table scan. The parameter is lowercased and bound against the stored
   * `username_ci`, which every writer maintains.
   */
  public async listForOwner(ownerUserId: string): Promise<PlaylistRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM playlists WHERE owner_user_id = ? ORDER BY name ASC')
          .bind(ownerUserId)
          .all<PlaylistRow>(),
      'playlists.listForOwner',
    );
    return result.results ?? [];
  }

  /**
   * The display name of a playlist's owner, or `null` when the row's user is gone.
   *
   * `playlists.owner` is a **name**, and publishing the caller's own name in its place is
   * what `requireVisible` used to permit: it deliberately lets one user read another's
   * public playlist, so `getPlaylist` on one reported `owner: <the reader>`. The row carries
   * `owner_user_id`; this resolves it. A LEFT JOIN rather than a second query per playlist,
   * because a grid of playlist rows is one request and an N+1 here is unbounded work in it.
   */
  public async ownerNamesFor(playlists: readonly PlaylistRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(playlists.map((playlist) => playlist.owner_user_id))];
    if (ids.length === 0) return new Map();
    // Batched rather than one `IN` per row, and re-indexed by id rather than by position:
    // an `IN` list returns rows in index-scan order, so a caller that trusted the order
    // would attribute playlists to the wrong users.
    const names = new Map<string, string>();
    for (const chunk of chunkArray(ids, bindChunkSize(1, 0))) {
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.withRetry(
        async () =>
          await this.database
            .prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
            .bind(...chunk)
            .all<{ id: string; username: string }>(),
        'playlists.ownerNamesFor',
      );
      for (const row of result.results ?? []) names.set(row.id, row.username);
    }
    return names;
  }

  public async listEntries(playlistId: string): Promise<PlaylistEntryRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM playlist_entries WHERE playlist_id = ? ORDER BY position ASC')
          .bind(playlistId)
          .all<PlaylistEntryRow>(),
      'playlists.listEntries',
    );
    return result.results ?? [];
  }

  /**
  Join playlist entries to their songs, in playlist order.
  */
  public async listEntrySongs(playlistId: string): Promise<SongRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT s.* FROM playlist_entries e INNER JOIN songs s ON s.id = e.song_id
             WHERE e.playlist_id = ? ORDER BY e.position ASC`,
          )
          .bind(playlistId)
          .all<SongRow>(),
      'playlists.listEntrySongs',
    );
    return result.results ?? [];
  }

  public async create(input: { ownerUserId: string; name: string; comment?: string | null; isPublic?: boolean }): Promise<PlaylistRow> {
    const timestamp = nowSeconds();
    const id = UUIDUtil.getRandomUUID();
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO playlists (id, owner_user_id, name, comment, is_public, song_count, duration, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
          )
          .bind(id, input.ownerUserId, input.name, input.comment ?? null, input.isPublic ? 1 : 0, timestamp, timestamp)
          .run(),
      'playlists.create',
    );
    const created = await this.findById(id);
    if (!created) throw new Error('playlists.create did not produce a readable row.');
    return created;
  }

  /**
   * Create a playlist under an id the caller chose.
   *
   * `INSERT OR REPLACE` rather than `INSERT`, and the reason is idempotency rather than
   * convenience. A Cloudflare Workflow step is cached by name and may be retried, so an import
   * that asks for the *same* playlist twice must not find it already there and fail — and a
   * plain `INSERT` would refuse, which the step's retry policy would re-attempt until it gave
   * up. So the second attempt replaces the row and the caller goes on to rewrite the entries.
   *
   * The replacement **cascades to the entries** (`playlist_entries.playlist_id` has
   * `ON DELETE CASCADE`), which is what makes this a retry rather than a second playlist
   * sharing the first's tracks. `replaceEntries` writes them again immediately afterwards, so
   * the gap is inside one statement's worth of work and never observable to a client.
   *
   * `createdAt` is carried rather than taken from the clock so a retry does not move the
   * playlist's creation time forward — a client's "added on" would drift by however many
   * times the step ran, which is exactly the sort of thing a user notices and cannot explain.
   */
  public async createWithId(input: {
    id: string;
    ownerUserId: string;
    name: string;
    comment?: string | null;
    isPublic?: boolean;
    createdAt?: number;
  }): Promise<PlaylistRow> {
    const timestamp = nowSeconds();
    const created = input.createdAt ?? timestamp;
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT OR REPLACE INTO playlists (id, owner_user_id, name, comment, is_public, song_count, duration, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
          )
          .bind(input.id, input.ownerUserId, input.name, input.comment ?? null, input.isPublic ? 1 : 0, created, timestamp)
          .run(),
      'playlists.createWithId',
    );
    const row = await this.findById(input.id);
    if (!row) throw new Error('playlists.createWithId did not produce a readable row.');
    return row;
  }

  public async updateMeta(id: string, patch: { name?: string; comment?: string | null; isPublic?: boolean }): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      assignments.push('name = ?');
      values.push(patch.name);
    }
    if (patch.comment !== undefined) {
      assignments.push('comment = ?');
      values.push(patch.comment);
    }
    if (patch.isPublic !== undefined) {
      assignments.push('is_public = ?');
      values.push(patch.isPublic ? 1 : 0);
    }
    if (assignments.length === 0) return;
    assignments.push('updated_at = ?');
    values.push(nowSeconds(), id);
    await this.withRetry(
      async () => await this.database.prepare(`UPDATE playlists SET ${assignments.join(', ')} WHERE id = ?`).bind(...values).run(),
      'playlists.updateMeta',
    );
  }

  public async delete(id: string): Promise<void> {
    await this.withRetry(async () => await this.database.prepare('DELETE FROM playlists WHERE id = ?').bind(id).run(), 'playlists.delete');
  }

  /**
   * Replace a playlist's entries wholesale.
   *
   * Delete-then-insert rather than a diff: the protocol has no "move entry"
   * operation, only `songIdToAdd` and `songIndexToRemove`, and a caller
   * reconstructing a list produces the same rows either way. The delete cascades
   * from nothing, so it is written explicitly.
   */
  public async replaceEntries(playlistId: string, songIds: readonly string[], totalDuration: number): Promise<number> {
    const timestamp = nowSeconds();
    const statements = [this.database.prepare('DELETE FROM playlist_entries WHERE playlist_id = ?').bind(playlistId)];
    songIds.forEach((songId, position) => {
      statements.push(
        this.database
          .prepare('INSERT INTO playlist_entries (playlist_id, position, song_id, created_at) VALUES (?, ?, ?, ?)')
          .bind(playlistId, position, songId, timestamp),
      );
    });
    statements.push(
      this.database
        .prepare('UPDATE playlists SET song_count = ?, duration = ?, updated_at = ? WHERE id = ?')
        .bind(songIds.length, totalDuration, timestamp, playlistId),
    );

    if (this.database.batch) {
      await this.withRetry(async () => {
        await this.database.batch!(statements);
        return { success: true };
      }, 'playlists.replaceEntries');
      return songIds.length;
    }
    for (const statement of statements) {
      await this.withRetry(async () => await statement.run(), 'playlists.replaceEntries');
    }
    return songIds.length;
  }

  /**
  Append songs, for `updatePlaylist?songIdToAdd=`.
  */
  public async appendEntries(playlistId: string, songIds: readonly string[]): Promise<number> {
    if (songIds.length === 0) return 0;
    const current = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT COALESCE(MAX(position), -1) AS max_position FROM playlist_entries WHERE playlist_id = ?')
          .bind(playlistId)
          .first<{ max_position: number }>(),
      'playlists.appendEntries.max',
    );
    let position = (current?.max_position ?? -1) + 1;
    const timestamp = nowSeconds();
    const statements = songIds.map((songId) =>
      this.database
        .prepare('INSERT INTO playlist_entries (playlist_id, position, song_id, created_at) VALUES (?, ?, ?, ?)')
        .bind(playlistId, position++, songId, timestamp),
    );
    await this.refreshTotals(playlistId, statements);
    return songIds.length;
  }

  /**
   * Remove entries by zero-based index, highest first.
   *
   * Highest-first is load-bearing: `songIndexToRemove` addresses positions, so
   * removing 2 then 3 against a shifting list deletes the wrong entry. The
   * protocol does not guarantee the order a client sends multiple removals in.
   */
  public async removeEntriesAt(playlistId: string, positions: readonly number[]): Promise<number> {
    const unique = [...new Set(positions)].filter((position) => Number.isInteger(position) && position >= 0).sort((a, b) => b - a);
    if (unique.length === 0) return 0;
    const statements = unique.map((position) =>
      this.database.prepare('DELETE FROM playlist_entries WHERE playlist_id = ? AND position = ?').bind(playlistId, position),
    );
    await this.refreshTotals(playlistId, statements);
    return unique.length;
  }

  /**
  Recompute `song_count`/`duration` from the surviving entries.
  */
  private async refreshTotals(playlistId: string, statements: ReturnType<BaseDAO['database']['prepare']>[]): Promise<void> {
    const timestamp = nowSeconds();
    const totals = this.database
      .prepare(
        `UPDATE playlists SET
           song_count = (SELECT COUNT(*) FROM playlist_entries WHERE playlist_id = ?),
           duration = (SELECT COALESCE(SUM(s.duration), 0) FROM playlist_entries e INNER JOIN songs s ON s.id = e.song_id WHERE e.playlist_id = ?),
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(playlistId, playlistId, timestamp, playlistId);
    const all = [...statements, totals];
    // The `totals` recompute is the statement that makes `song_count` and `duration` agree
    // with the entries, so a batch that stopped before it would publish a playlist whose
    // header describes a different set of songs than it holds. All-or-nothing, for the same
    // reason as the queue: a wrong count is worse than a refusal.
    await this.runWriteBatch(all, 'playlists.refreshTotals', { requireComplete: true });
  }
}

export { PlaylistDAO };
