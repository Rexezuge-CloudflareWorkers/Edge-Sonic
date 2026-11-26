/**
 * Shares: a capability over a frozen, ordered selection of songs.
 *
 * ### Why the entry read is a join, and why that is the correct answer
 *
 * `share_entries.song_id` has no foreign key to `songs` (see the migration): the scan
 * prunes song rows, and a cascade would silently shorten a share that somebody had already
 * sent. An `INNER JOIN` makes the drop visible at read time — a deleted track simply stops
 * being listed — which is the same rule `getBookmarks` and `getPlayQueue` apply.
 *
 * ### Why the entry write is chunked multi-row `INSERT`
 *
 * A share may name up to `MAX_IDS_PER_REQUEST` songs. One statement per entry would spend a
 * subrequest each, and the Workers ceiling is 50 per invocation — so a 500-track share
 * would terminate the invocation rather than answer it. The batch size is derived from
 * D1's measured bind ceiling (`bindChunkSize(3)`, because each row binds share, position and
 * song), not typed here.
 */
import { BaseDAO } from './BaseDAO';
import type { WriteBatchResult } from './BaseDAO';
import { chunkArray } from './chunking';
import { bindChunkSize } from './sqlLimits';
import type { SongRow } from './rows';

interface ShareRow {
  id: string;
  owner_user_id: string;
  description: string | null;
  created_at: number;
  /**
   * Epoch **seconds**, or `null` for never. See the migration for why the protocol's
   * milliseconds are converted at the boundary.
   */
  expires_at: number | null;
  last_visited_at: number | null;
  visit_count: number;
}

interface ShareEntryRow {
  share_id: string;
  position: number;
  song_id: string;
}

/**
A song row carrying the share it was resolved through.
*/
type ShareEntrySongRow = SongRow & { share_id: string };

class ShareDAO extends BaseDAO {
  public async findById(id: string): Promise<ShareRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM shares WHERE id = ?').bind(id).first<ShareRow>(),
      'shares.findById',
    );
  }

  /**
   * The caller's own shares, newest first.
   *
   * There is no "all shares" read and no listing endpoint that could reach another user's
   * share. `getShares` is defined by the protocol as the caller's shares, and the owner
   * predicate is here rather than in the endpoint so a future caller cannot forget it.
   */
  public async listForOwner(ownerUserId: string): Promise<ShareRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM shares WHERE owner_user_id = ? ORDER BY created_at DESC, id ASC')
          .bind(ownerUserId)
          .all<ShareRow>(),
      'shares.listForOwner',
    );
    return result.results ?? [];
  }

  public async listEntries(shareId: string): Promise<ShareEntryRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM share_entries WHERE share_id = ? ORDER BY position ASC')
          .bind(shareId)
          .all<ShareEntryRow>(),
      'shares.listEntries',
    );
    return result.results ?? [];
  }

  /**
  The share's songs, in share order, with deleted rows absent by the join.
  */
  public async listEntrySongs(shareId: string): Promise<SongRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT s.* FROM share_entries e INNER JOIN songs s ON s.id = e.song_id
             WHERE e.share_id = ? ORDER BY e.position ASC`,
          )
          .bind(shareId)
          .all<SongRow>(),
      'shares.listEntrySongs',
    );
    return result.results ?? [];
  }

  /**
   * Every entry of every share one owner has, in one statement.
   *
   * `getShares` returns each share with its entries, so the per-share form is an N+1 on a
   * dashboard request — one share is a row, a hundred shares are a hundred statements
   * against a 50-subrequest ceiling. The grouping back into shares happens in the service,
   * where the owner's grant filter is applied once to the whole set.
   */
  public async listEntrySongsForOwner(ownerUserId: string): Promise<ShareEntrySongRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT e.share_id AS share_id, s.*
               FROM shares sh
               INNER JOIN share_entries e ON e.share_id = sh.id
               INNER JOIN songs s ON s.id = e.song_id
              WHERE sh.owner_user_id = ?
              ORDER BY sh.created_at DESC, sh.id ASC, e.position ASC`,
          )
          .bind(ownerUserId)
          .all<ShareEntrySongRow>(),
      'shares.listEntrySongsForOwner',
    );
    return result.results ?? [];
  }

  public async create(input: {
    id: string;
    ownerUserId: string;
    description: string | null;
    createdAt: number;
    expiresAt: number | null;
  }): Promise<ShareRow> {
    await this.runWriteStatement(
      this.prepare(
        `INSERT INTO shares (id, owner_user_id, description, created_at, expires_at, last_visited_at, visit_count)
         VALUES (?, ?, ?, ?, ?, NULL, 0)`,
      ).bind(input.id, input.ownerUserId, input.description, input.createdAt, input.expiresAt),
      'shares.create',
    );
    const created = await this.findById(input.id);
    if (!created) throw new Error('shares.create did not produce a readable row.');
    return created;
  }

  /**
   * Replace a share's entries wholesale.
   *
   * `requireComplete` because a share is a set: half a share is a **wrong** share, not an
   * unfinished one. The caller deletes the share row when this throws, so a partial write
   * cannot survive as a link that plays some of what it promised.
   *
   * The delete and the inserts are separate statements — D1's `batch` would make them one
   * transaction, but the regular path here is a single create where the row has no entries
   * yet, so there is nothing to lose between them. `replaceEntries` on an existing share is
   * not exposed by any endpoint today; if it becomes one, this needs a transaction.
   */
  public async replaceEntries(shareId: string, songIds: readonly string[]): Promise<WriteBatchResult> {
    await this.runWriteStatement(this.prepare('DELETE FROM share_entries WHERE share_id = ?').bind(shareId), 'shares.replaceEntries.clear');
    if (songIds.length === 0) return { changes: 0, written: 0, truncated: false, billedRows: 0 };

    const rowsPerStatement = bindChunkSize(3, 0);
    const statements = chunkArray(songIds, rowsPerStatement).map((chunk, chunkIndex) => {
      const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
      const values: unknown[] = [];
      for (const [offset, songId] of chunk.entries()) {
        values.push(shareId, chunkIndex * rowsPerStatement + offset, songId);
      }
      return this.prepare(`INSERT INTO share_entries (share_id, position, song_id) VALUES ${placeholders}`).bind(...values);
    });
    return await this.runWriteBatch(statements, 'shares.replaceEntries', { requireComplete: true });
  }

  public async update(id: string, input: { description: string | null; expiresAt: number | null }): Promise<ShareRow | null> {
    await this.runWriteStatement(
      this.prepare('UPDATE shares SET description = ?, expires_at = ? WHERE id = ?').bind(input.description, input.expiresAt, id),
      'shares.update',
    );
    return await this.findById(id);
  }

  /**
   * Delete a share owned by `ownerUserId`.
   *
   * Zero rows is **success**, not an error: a client syncing a deleted share, or retrying a
   * delete whose response was lost, is doing exactly what it should. A share belonging to
   * somebody else also matches zero rows, which is the right answer — the caller cannot
   * tell it exists.
   */
  public async delete(ownerUserId: string, id: string): Promise<void> {
    await this.runWriteStatement(
      this.prepare('DELETE FROM shares WHERE id = ? AND owner_user_id = ?').bind(id, ownerUserId),
      'shares.delete',
    );
  }

  /**
   * Count one landing-page view, and return the share in the same statement.
   *
   * `UPDATE … RETURNING` rather than a read followed by a write: the row is the answer and
   * the increment is the side effect, so one statement is both. Expiry is in the `WHERE`, so
   * an expired share matches nothing and is indistinguishable from an unknown id — the 404
   * cannot be used to confirm that an id was once real.
   *
   * The write is why the landing route is rate-limited. `visit_count` is a claim, and the
   * only honest way to keep it is to count the thing it names.
   */
  public async recordVisit(id: string, now: number): Promise<ShareRow | null> {
    return await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `UPDATE shares SET visit_count = visit_count + 1, last_visited_at = ?
              WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)
              RETURNING *`,
          )
          .bind(now, id, now)
          .first<ShareRow>(),
      'shares.recordVisit',
    );
  }
}

export { ShareDAO };
export type { ShareRow, ShareEntryRow, ShareEntrySongRow };
