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
    const all = [...statements, totals];    await this.runWriteBatch(all, 'playlists.refreshTotals');
  }
}

export { PlaylistDAO };
