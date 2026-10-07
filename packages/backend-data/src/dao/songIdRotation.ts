/**
 * Rotating legacy long song ids to short ones.
 *
 * Its own module because `SongDAO` owns one row and is already at the
 * god-file limit, and because this answers a different question from "one
 * song, by id": which rows still carry a reversible id, and rename one of
 * them. The scan's id backfill is the only caller.
 */
import { SONG_LEGACY_ID_LENGTH_THRESHOLD } from '@edge-sonic/subsonic';
import { BaseDAO } from './BaseDAO';
import type { WriteBatchResult } from './BaseDAO';
import type { SongRow } from './rows';
import { nowSeconds } from './identity';

class SongIdRotationDAO extends BaseDAO {
  /**
   * Rows still carrying a reversible long id, oldest path first.
   *
   * `LENGTH(id) > threshold` is the whole selection: short ids are 24 chars
   * and production legacy ids are 50+, so no second predicate is needed and a
   * rotated row can never be re-selected.
   */
  public async listLegacySongIds(libraryId: string, limit: number): Promise<readonly Pick<SongRow, 'id' | 'library_id' | 'path'>[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT id, library_id, path FROM songs WHERE library_id = ? AND LENGTH(id) > ? ORDER BY path ASC LIMIT ?')
          .bind(libraryId, SONG_LEGACY_ID_LENGTH_THRESHOLD, limit)
          .all<Pick<SongRow, 'id' | 'library_id' | 'path'>>(),
      'songs.listLegacySongIds',
    );
    return result.results ?? [];
  }

  /**
   * Rotate one song's id from its legacy long form to a short one.
   *
   * All-or-nothing with the playlist entries naming it: `listEntrySongs` joins
   * `songs` on `s.id = e.song_id`, so a song rotated without its entries
   * disappears from every playlist, and entries rewritten without their song
   * point at nothing. Other annotation tables (stars, ratings, bookmarks, play
   * queue, play counts) hold ids too but resolve through the legacy fallback
   * and check both forms at read time — see `songToModel` — so they migrate
   * lazily as clients re-mark under the short id.
   */
  public async rotateSongId(libraryId: string, path: string, oldId: string, newId: string): Promise<WriteBatchResult> {
    const timestamp = nowSeconds();
    return await this.runWriteBatch(
      [
        this.prepare('UPDATE songs SET id = ?, updated_at = ? WHERE library_id = ? AND path = ? AND id = ?').bind(
          newId,
          timestamp,
          libraryId,
          path,
          oldId,
        ),
        this.prepare('UPDATE playlist_entries SET song_id = ? WHERE song_id = ?').bind(newId, oldId),
      ],
      'songs.rotateSongId',
      { requireComplete: true },
    );
  }
}

export { SongIdRotationDAO };
