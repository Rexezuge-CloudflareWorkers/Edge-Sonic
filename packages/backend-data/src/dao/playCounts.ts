/**
 * Per-user play counts, and the two **different** semantics one table carries.
 *
 * ### Why these three live together rather than in `UserStateDAO`
 *
 * Because the property worth keeping is not "the table"; it is that {@link recordPlay}
 * **increments** and {@link setPlayCounts} **overwrites**, and the difference between them is
 * completely silent. An import that added to a count already set inflates every count in the
 * library, and — unlike a playlist — nothing anywhere can tell the result from a user who really
 * did listen twice as much.
 *
 * So the readers and writers of one table stay in one file, and each one's docstring names the
 * other. Splitting them apart across a file boundary would put the two semantics where a caller is
 * most likely to reach for the wrong one without seeing the difference spelled out.
 *
 * ### And `UserStateDAO` keeps the rest
 *
 * `stars`, `ratings`, `bookmarks`, the play queue and now-playing are all annotation state — a
 * user's own marks on a shared library — and `AuthThrottleDAO`'s buckets live beside them because
 * they are the other per-user row. `deleteUser` cascades every one of them; play counts cascade the
 * same way, but the arithmetic that writes them has its own rule, and that is what this file is.
 */
import { BaseDAO } from './BaseDAO';
import { nowSeconds } from './identity';

/**
 * One user's play counts.
 *
 * The table is `play_counts (user_id, song_id)`, and **both** writers below depend on that
 * composite key being the one D1 upserts against: a statement with only `song_id` in its conflict
 * target would make two users' counts for one track collide, so the second listener's scrobble
 * would increment the first's count. That has no symptom beyond a wrong number.
 */
class PlayCountDAO extends BaseDAO {
  /**
   * Record one play: **increment**.
   *
   * Increments, and correctly — a scrobble *is* an event, and `last_played_at` is a real fact about
   * it. It is the other writer, {@link setPlayCounts}, that must not be used for the same event.
   */
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
      'playCounts.recordPlay',
    );
  }

  /**
  Every count for this user, keyed by song id.
  */
  public async listPlayCounts(userId: string): Promise<Map<string, number>> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT song_id, play_count FROM play_counts WHERE user_id = ?')
          .bind(userId)
          .all<{ song_id: string; play_count: number }>(),
      'playCounts.listPlayCounts',
    );
    return new Map((result.results ?? []).map((row) => [row.song_id, row.play_count]));
  }

  /**
   * Play counts, as **absolute** values.
   *
   * Absolute rather than additive, and the difference is the whole point of the method existing.
   * {@link PlayCountDAO.recordPlay} increments — correctly, because a scrobble *is* an event — but
   * an import is not a scrobble: it is the current count read off another server. Adding would
   * inflate every count by however many times the step ran, and unlike a playlist there is **no
   * observable difference** between "played twice" and "imported twice". So this overwrites.
   *
   * Batched through `runWriteBatch`, and `requireComplete`, for the reason a play queue refuses
   * rather than truncating: a partially-applied page of counts is a set of numbers that is right in
   * places and wrong in others, and nothing downstream can tell which is which.
   *
   * Returns the **rows written**, not the counts supplied, because the daily row allowance is
   * spent from statements and a caller metering its day needs the figure the platform charges.
   */
  public async setPlayCounts(
    userId: string,
    counts: ReadonlyArray<{ readonly songId: string; readonly playCount: number }>,
  ): Promise<number> {
    if (counts.length === 0) return 0;
    const timestamp = nowSeconds();
    const statements = counts.map((entry) =>
      this.prepare(
        `INSERT INTO play_counts (user_id, song_id, play_count, last_played_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, song_id) DO UPDATE SET play_count = excluded.play_count`,
      )
        // `last_played_at` is written on the insert and **not** on the update: the remote published
        // no play *time* for a count it read back, so setting it would claim the import is when the
        // listener last played the track. `last_played_at` is what "last played" surfaces as.
        .bind(userId, entry.songId, Math.max(0, Math.floor(entry.playCount)), timestamp),
    );
    const result = await this.runWriteBatch(statements, 'playCounts.setPlayCounts', { requireComplete: true });
    return result.written;
  }
}

export { PlayCountDAO };
