/**
/**
 * Per-user state: annotations, the play queue, now playing, and the auth throttle.
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
import type { StarItemType } from './rows';
import { nowSeconds } from './identity';


class AnnotationDAO extends BaseDAO {
  /**
   * The user's starred ids, with **when** each was starred.
   *
   * The timestamp is not a convenience. `starred` is a protocol attribute carrying an
   * ISO-8601 instant — the same shape as `created` on a song and album — and this DAO
   * selected only `item_id`, so the mapper had nothing to publish and reached for a
   * literal instead. Publishing `starred: undefined` produced **no attribute in XML and
   * no key in JSON at all**, because both serializers drop a nullish value: the star was
   * stored correctly and was unreachable to the one client call that reports it.
   * `getStarred` does not expand artist stars into albums, so `getArtists` is the only
   * place an artist star is visible, and it reported nothing.
   *
   * The column was already written and already the sort key; it was simply never read.
   */
  public async listStarredWithTime(userId: string, itemType: StarItemType): Promise<Map<string, number>> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT item_id, starred_at FROM stars WHERE user_id = ? AND item_type = ? ORDER BY starred_at DESC')
          .bind(userId, itemType)
          .all<{ item_id: string; starred_at: number }>(),
      'annotations.listStarredWithTime',
    );
    return new Map((result.results ?? []).map((row) => [row.item_id, row.starred_at]));
  }

  /**
   * Ids only, for the callers that order by recency and publish no timestamp.
   *
   * Deliberately **not** `listStarredWithTime` with the value discarded at the call site:
   * `getStarred` needs the ids in `starred_at DESC` order, and selecting a column it
   * never reads to satisfy a shared signature is how a query plan stops being the thing
   * you think it is.
   */
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

  public async star(userId: string, itemId: string, itemType: StarItemType, starredAt?: number): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('INSERT OR REPLACE INTO stars (user_id, item_id, item_type, starred_at) VALUES (?, ?, ?, ?)')
          .bind(userId, itemId, itemType, starredAt ?? nowSeconds())
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

  /**
   * Replace the play queue wholesale.
   *
   * Delete-then-insert rather than a diff: the protocol has no "add to queue"
   * operation, so a client that adds a track sends the entire list, and a diffing
   * implementation would have to guess which of the two shapes it received.
   */
  public async savePlayQueue(input: { userId: string; songIds: readonly string[]; currentSongId: string | null; positionMs: number; changed: string }): Promise<void> {
    const timestamp = nowSeconds();
    const statements = [this.prepare('DELETE FROM play_queue_entries WHERE user_id = ?').bind(input.userId)];
    input.songIds.forEach((songId, position) => {
      statements.push(
        this.prepare('INSERT INTO play_queue_entries (user_id, position, song_id) VALUES (?, ?, ?)').bind(input.userId, position, songId),
      );
    });
    statements.push(
      this.prepare(
        `INSERT INTO play_queue (user_id, current_song_id, position_ms, changed, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET current_song_id = excluded.current_song_id, position_ms = excluded.position_ms, changed = excluded.changed, updated_at = excluded.updated_at`,
      ).bind(input.userId, input.currentSongId, input.positionMs, input.changed, timestamp),
    );
    // All-or-nothing, and this is the case the option exists for. A play queue saved halfway
    // is a *shorter queue* — a wrong answer rather than an unfinished one, and
    // indistinguishable from a queue the client deliberately shortened. A `413` naming the
    // limit is recoverable; a silently truncated queue is not.
    await this.runWriteBatch(statements, 'annotations.savePlayQueue', { requireComplete: true });
  }

  /**
  The saved queue, in order. Empty when nothing is saved.
  */
  public async listPlayQueue(userId: string): Promise<{ currentSongId: string | null; positionMs: number; changedAt: number | null; songIds: string[] }> {
    const head = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT current_song_id, position_ms, updated_at FROM play_queue WHERE user_id = ?')
          .bind(userId)
          .first<{ current_song_id: string | null; position_ms: number; updated_at: number }>(),
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
      changedAt: head?.updated_at ?? null,
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

  /**
  Record one failure against the current window.

  **One statement, and it returns nothing.** This read the row back and returned the count, which
  doubled the statements every *failed* authentication spent — on the one path that exists to stop
  password guessing, and the only statement in it whose result was not used for a decision. It was
  also a non-atomic read of a value `ON CONFLICT DO UPDATE` had already computed authoritatively,
  so a caller added later would have seen a count two concurrent failures could both report.

  The decision this counter feeds is {@link countRecentFailures}, which reads the window itself and
  is the number that actually decides a lockout.
  */
  public async recordFailure(identity: string, bucket: number): Promise<void> {
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



export { AnnotationDAO, AuthThrottleDAO };
// Re-exported so `@edge-sonic/backend-data/dao` keeps one import path for all three.
// It lives in its own module because it is a different concern — a scan's lifecycle
// rather than a user's annotations — and folding it back in put this file over the
// god-file limit.
export { ScanStateDAO } from './ScanStateDAO';


export {type StarItemType} from './rows';