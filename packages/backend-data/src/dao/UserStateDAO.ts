/**
 * User state: playlists, annotations, and the auth throttle.
 *
 * All of it lives in D1 and none of it is cached. Two reasons:
 *
 * - A **filesystem cannot hold any of it**, so there is no WebDAV representation
 *   to fall back to — D1 is the only copy, which is also why these tables are
 *   where a missing KV binding is least consequential.
 * - These rows are small, read once per request, and mostly *written*, which is
 *   the opposite of a good cache candidate. A cache would add an invalidation
 *   problem to a table that costs one indexed read to answer.
 */
import { BaseDAO } from './BaseDAO';
import type { PlaylistEntryRow, PlaylistRow, ScanStateRow, SongRow } from './rows';
import { UUIDUtil } from '@edge-sonic/shared/utils';
import { nowSeconds } from './identity';

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

  /** Join playlist entries to their songs, in playlist order. */
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

  /** Append songs, for `updatePlaylist?songIdToAdd=`. */
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

  public async deleteById(playlistId: string): Promise<void> {
    await this.delete(playlistId);
  }

  /** Recompute `song_count`/`duration` from the surviving entries. */
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

type StarItemType = 'song' | 'album' | 'artist';

class AnnotationDAO extends BaseDAO {
  public async listStarred(userId: string, itemType: StarItemType): Promise<string[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT item_id FROM stars WHERE user_id = ? AND item_type = ? ORDER BY starred_at DESC')
          .bind(userId, itemType)
          .all<{ item_id: string }>(),
      'annotations.listStarred',
    );
    return (result.results ?? []).map((row) => row.item_id);
  }

  public async star(userId: string, itemId: string, itemType: StarItemType): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('INSERT OR REPLACE INTO stars (user_id, item_id, item_type, starred_at) VALUES (?, ?, ?, ?)')
          .bind(userId, itemId, itemType, nowSeconds())
          .run(),
      'annotations.star',
    );
  }

  public async unstar(userId: string, itemId: string, itemType: StarItemType): Promise<number> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('DELETE FROM stars WHERE user_id = ? AND item_id = ? AND item_type = ?')
          .bind(userId, itemId, itemType)
          .run(),
      'annotations.unstar',
    );
    return result.meta?.changes ?? 0;
  }

  public async setRating(userId: string, itemId: string, itemType: StarItemType, rating: number): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('INSERT OR REPLACE INTO ratings (user_id, item_id, item_type, rating, updated_at) VALUES (?, ?, ?, ?, ?)')
          .bind(userId, itemId, itemType, rating, nowSeconds())
          .run(),
      'annotations.setRating',
    );
  }

  public async listRatings(userId: string, itemType: StarItemType): Promise<Map<string, number>> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT item_id, rating FROM ratings WHERE user_id = ? AND item_type = ?')
          .bind(userId, itemType)
          .all<{ item_id: string; rating: number }>(),
      'annotations.listRatings',
    );
    return new Map((result.results ?? []).map((row) => [row.item_id, row.rating]));
  }

  public async listBookmarks(userId: string): Promise<Array<{ song_id: string; position_ms: number; comment: string | null; created_at: number; updated_at: number }>> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT song_id, position_ms, comment, created_at, updated_at FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC')
          .bind(userId)
          .all<{ song_id: string; position_ms: number; comment: string | null; created_at: number; updated_at: number }>(),
      'annotations.listBookmarks',
    );
    return result.results ?? [];
  }

  public async createBookmark(userId: string, songId: string, positionMs: number, comment: string | null): Promise<void> {
    const timestamp = nowSeconds();
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO bookmarks (user_id, song_id, position_ms, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, song_id) DO UPDATE SET position_ms = excluded.position_ms, comment = excluded.comment, updated_at = excluded.updated_at`,
          )
          .bind(userId, songId, positionMs, comment, timestamp, timestamp)
          .run(),
      'annotations.createBookmark',
    );
  }

  public async deleteBookmark(userId: string, songId: string): Promise<number> {
    const result = await this.withRetry(
      async () => await this.database.prepare('DELETE FROM bookmarks WHERE user_id = ? AND song_id = ?').bind(userId, songId).run(),
      'annotations.deleteBookmark',
    );
    return result.meta?.changes ?? 0;
  }

  public async recordPlay(userId: string, songId: string): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO play_counts (user_id, song_id, play_count, last_played_at) VALUES (?, ?, 1, ?)
             ON CONFLICT (user_id, song_id) DO UPDATE SET play_count = play_count + 1, last_played_at = excluded.last_played_at`,
          )
          .bind(userId, songId, nowSeconds())
          .run(),
      'annotations.recordPlay',
    );
  }

  public async listPlayCounts(userId: string): Promise<Map<string, number>> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT song_id, play_count FROM play_counts WHERE user_id = ?')
          .bind(userId)
          .all<{ song_id: string; play_count: number }>(),
      'annotations.listPlayCounts',
    );
    return new Map((result.results ?? []).map((row) => [row.song_id, row.play_count]));
  }

  /**
   * Replace the play queue wholesale.
   *
   * Delete-then-insert rather than a diff: the protocol has no "add to queue"
   * operation, so a client that adds a track sends the entire list, and a diffing
   * implementation would have to guess which of the two shapes it received.
   */
  public async savePlayQueue(input: { userId: string; songIds: readonly string[]; currentSongId: string | null; positionMs: number; changed: string }): Promise<void> {
    const timestamp = nowSeconds();
    const statements = [this.database.prepare('DELETE FROM play_queue_entries WHERE user_id = ?').bind(input.userId)];
    input.songIds.forEach((songId, position) => {
      statements.push(
        this.database
          .prepare('INSERT INTO play_queue_entries (user_id, position, song_id) VALUES (?, ?, ?)')
          .bind(input.userId, position, songId),
      );
    });
    statements.push(
      this.database
        .prepare(
          `INSERT INTO play_queue (user_id, current_song_id, position_ms, changed, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET current_song_id = excluded.current_song_id, position_ms = excluded.position_ms, changed = excluded.changed, updated_at = excluded.updated_at`,
        )
        .bind(input.userId, input.currentSongId, input.positionMs, input.changed, timestamp),
    );
    await this.runWriteBatch(statements, 'annotations.savePlayQueue');
  }

  /** The saved queue, in order. Empty when nothing is saved. */
  public async listPlayQueue(userId: string): Promise<{ currentSongId: string | null; positionMs: number; songIds: string[] }> {
    const head = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT current_song_id, position_ms FROM play_queue WHERE user_id = ?')
          .bind(userId)
          .first<{ current_song_id: string | null; position_ms: number }>(),
      'annotations.listPlayQueue.head',
    );
    const entries = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT song_id FROM play_queue_entries WHERE user_id = ? ORDER BY position ASC')
          .bind(userId)
          .all<{ song_id: string }>(),
      'annotations.listPlayQueue.entries',
    );
    return {
      currentSongId: head?.current_song_id ?? null,
      positionMs: head?.position_ms ?? 0,
      songIds: (entries.results ?? []).map((row) => row.song_id),
    };
  }

  public async setNowPlaying(input: { userId: string; username: string; songId: string | null; playerName: string | null; playerId: string | null }): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO now_playing (user_id, song_id, player_name, player_id, username, minutes_ago, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)
             ON CONFLICT (user_id) DO UPDATE SET song_id = excluded.song_id, player_name = excluded.player_name, player_id = excluded.player_id, minutes_ago = 0, updated_at = excluded.updated_at`,
          )
          .bind(input.userId, input.songId, input.playerName, input.playerId, input.username, nowSeconds())
          .run(),
      'annotations.setNowPlaying',
    );
  }

  public async listNowPlaying(): Promise<Array<{ username: string; player_name: string | null; player_id: string | null; minutes_ago: number; song_id: string | null }>> {
    // `minutes_ago` is computed in SQL from `updated_at`, so a stale row reports
    // as minutes-old rather than as "now" forever.
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT username, player_name, player_id, song_id, CAST((? - updated_at) / 60 AS INTEGER) AS minutes_ago
             FROM now_playing ORDER BY updated_at DESC`,
          )
          .bind(nowSeconds())
          .all<{ username: string; player_name: string | null; player_id: string | null; song_id: string | null; minutes_ago: number }>(),
      'annotations.listNowPlaying',
    );
    return (result.results ?? []).filter((row) => row.minutes_ago <= 60);
  }
}

/**
 * Failed-authentication counters.
 *
 * D1, not KV, and that is the whole point: a KV-only counter is a *disabled*
 * throttle exactly when the namespace is having an incident, which is when an
 * attacker is most likely to be trying. This table is the one piece of state
 * where losing the cache would be a security regression rather than a latency
 * change — which is also why the KV outage test asserts scan *and* auth behave
 * identically with no binding present.
 *
 * `identity` is a hash of `username|ip`, never the raw pair: the table is the
 * one place an attacker's chosen usernames and a user's IP address would
 * otherwise be written down together.
 */
class AuthThrottleDAO extends BaseDAO {
  /**
   * Failures recorded inside the window ending at `currentBucket`.
   *
   * A single indexed range read. Deliberately *not* "count every bucket for this
   * identity" — that grows with the age of the table and turns a throttle check
   * on the request path into a table scan.
   */
  public async countRecentFailures(identity: string, oldestBucket: number, currentBucket: number): Promise<number> {
    const row = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT COALESCE(SUM(failures), 0) AS cnt FROM auth_failures WHERE identity = ? AND bucket >= ? AND bucket <= ?')
          .bind(identity, oldestBucket, currentBucket)
          .first<{ cnt: number }>(),
      'throttle.countRecentFailures',
    );
    return row?.cnt ?? 0;
  }

  /** Record one failure against the current window. */
  public async recordFailure(identity: string, bucket: number): Promise<number> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO auth_failures (identity, bucket, failures, last_at) VALUES (?, ?, 1, ?)
             ON CONFLICT (identity, bucket) DO UPDATE SET failures = failures + 1, last_at = excluded.last_at`,
          )
          .bind(identity, bucket, nowSeconds())
          .run(),
      'throttle.recordFailure',
    );
    const row = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT failures FROM auth_failures WHERE identity = ? AND bucket = ?')
          .bind(identity, bucket)
          .first<{ failures: number }>(),
      'throttle.recordFailure.read',
    );
    return row?.failures ?? 1;
  }

  /**
   * Clear the counter after a successful authentication.
   *
   * Called on success, not on failure, so legitimate traffic spends **zero**
   * writes on the throttle — which matters because the daily D1 write allowance is
   * shared with the scan.
   */
  public async clearFailures(identity: string): Promise<void> {
    await this.withRetry(
      async () => await this.database.prepare('DELETE FROM auth_failures WHERE identity = ?').bind(identity).run(),
      'throttle.clearFailures',
    );
  }

  /**
   * Delete buckets older than the window.
   *
   * Best-effort maintenance on the failure path: an unpruned row is harmless
   * because `countRecentFailures` bounds its own range, so this is tidiness
   * rather than correctness and is never worth failing a login over.
   */
  public async pruneOldBuckets(identity: string, oldestBucket: number): Promise<number> {
    const result = await this.withRetry(
      async () => await this.database.prepare('DELETE FROM auth_failures WHERE identity = ? AND bucket < ?').bind(identity, oldestBucket).run(),
      'throttle.pruneOldBuckets',
    );
    return result.meta?.changes ?? 0;
  }
}

class ScanStateDAO extends BaseDAO {
  public async find(libraryId: string): Promise<ScanStateRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM scan_state WHERE library_id = ?').bind(libraryId).first<ScanStateRow>(),
      'scanState.find',
    );
  }

  public async ensure(libraryId: string): Promise<ScanStateRow> {
    const existing = await this.find(libraryId);
    if (existing) return existing;
    await this.withRetry(
      async () =>
        await this.database
          .prepare('INSERT OR IGNORE INTO scan_state (library_id, status, scanned_count, total_count, index_version, updated_at) VALUES (?, ?, 0, 0, 1, ?)')
          .bind(libraryId, 'idle', nowSeconds())
          .run(),
      'scanState.ensure',
    );
    const created = await this.find(libraryId);
    if (!created) throw new Error('scan_state.ensure did not produce a readable row.');
    return created;
  }

  public async markScanning(libraryId: string, totalCount: number): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare("UPDATE scan_state SET status = 'scanning', total_count = ?, scanned_count = 0, cursor_path = NULL, last_error = NULL, started_at = ?, updated_at = ? WHERE library_id = ?")
          .bind(totalCount, nowSeconds(), nowSeconds(), libraryId)
          .run(),
      'scanState.markScanning',
    );
  }

  public async saveProgress(libraryId: string, scannedCount: number, cursorPath: string | null): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('UPDATE scan_state SET status = ?, scanned_count = ?, cursor_path = ?, updated_at = ? WHERE library_id = ?')
          .bind('scanning', scannedCount, cursorPath, nowSeconds(), libraryId)
          .run(),
      'scanState.saveProgress',
    );
  }

  /**
   * Finish a scan and bump `index_version`.
   *
   * The bump is what invalidates every cached aggregate for this library — not by
   * deleting anything, but by making the old keys unreachable. See
   * `KvDomains.ts` for why that matters against a 1,000-writes-per-day plan.
   */
  public async complete(libraryId: string, scannedCount: number): Promise<number> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare("UPDATE scan_state SET status = 'idle', scanned_count = ?, cursor_path = NULL, last_error = NULL, updated_at = ?, index_version = index_version + 1 WHERE library_id = ?")
          .bind(scannedCount, nowSeconds(), libraryId)
          .run(),
      'scanState.complete',
    );
    const row = await this.find(libraryId);
    return row?.index_version ?? 1;
  }

  public async fail(libraryId: string, error: string): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare("UPDATE scan_state SET status = 'failed', last_error = ?, updated_at = ? WHERE library_id = ?")
          .bind(error.slice(0, 500), nowSeconds(), libraryId)
          .run(),
      'scanState.fail',
    );
  }
}


export { PlaylistDAO, AnnotationDAO, AuthThrottleDAO, ScanStateDAO };
export type { StarItemType };
