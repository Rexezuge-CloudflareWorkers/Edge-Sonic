/**
 * Registered remote Subsonic instances, and the runs that import from them.
 *
 * Its own module rather than methods on `LibraryDAO` because a remote Subsonic server
 * and a WebDAV library are different things that would otherwise look alike:
 *
 * - a **library** is indexed — it holds music, and its credential is read on every scan
 *   and every stream, so it is guarded by the most-exposed key in the product;
 * - an **import source** is read, occasionally, and holds no music at all.
 *
 * Folding the second into the first would put a remote instance in `getMusicFolders`,
 * where a client would try to browse it, and would make "the list of places this music
 * comes from" and "the list of places this user came from" one query with two answers.
 */
import { BaseDAO } from './BaseDAO';
import { UUIDUtil } from '@edge-sonic/shared/utils';
import { nowSeconds } from './identity';
import type { CountRow, ImportRunRow, ImportSourceRow } from './rows';

/**
The phases an operator can ask for, in the order they run.
*/
const IMPORT_PHASES = ['playlists', 'stars', 'bookmarks', 'playQueue', 'playCounts'] as const;

type ImportPhase = (typeof IMPORT_PHASES)[number];

/**
 * A registered remote instance.
 *
 * Reads the **whole** row rather than a projection, because every caller needs the
 * ciphertext: nothing here is displayable without it. The operator surface reads the
 * row through `listSummaries` instead, which is the one place a row is read without
 * the secret and the projection is what keeps the secret out of a JSON response.
 */
class ImportSourceDAO extends BaseDAO {
  public async findById(id: string): Promise<ImportSourceRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM import_sources WHERE id = ?').bind(id).first<ImportSourceRow>(),
      'importSources.findById',
    );
  }

  /**
   * By the remote account name — the column the unique index is on.
   *
   * The index is `username_ci`, not a name index, because **two sources may share a name** (a
   * staging server called "music" beside a production one called "music" is ordinary) while two
   * sources sharing a *credential* is the thing that would silently import one server's data into
   * another's. So the lookup and the constraint agree, which is the only way `create` can refuse a
   * duplicate rather than storing two rows this query cannot tell apart.
   */
  public async findByUsername(username: string): Promise<ImportSourceRow | null> {
    return await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT * FROM import_sources WHERE username_ci = ?')
          .bind(username.toLowerCase())
          .first<ImportSourceRow>(),
      'importSources.findByUsername',
    );
  }

  /**
   * Every source, **without** the ciphertext.
   *
   * A projection rather than `SELECT *` because this is what the operator API returns,
   * and a row carrying `password_ciphertext` is a secret one JSON response away from a
   * browser. The column is not needed to render a list, so it is not selected —
   * which is also why this is a named method and not `list()` with the caller filtering.
   */
  public async listSummaries(): Promise<Array<Omit<ImportSourceRow, 'password_ciphertext' | 'password_iv' | 'username_ci'>>> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT id, name, base_url, username, music_folder_id, key_version, created_at, updated_at
             FROM import_sources ORDER BY username_ci ASC`,
          )
          .all<Omit<ImportSourceRow, 'password_ciphertext' | 'password_iv' | 'username_ci'>>(),
      'importSources.listSummaries',
    );
    return result.results ?? [];
  }

  public async create(input: {
    name: string;
    baseUrl: string;
    username: string;
    passwordCiphertext: string;
    passwordIv: string;
    musicFolderId: string | null;
  }): Promise<ImportSourceRow> {
    const timestamp = nowSeconds();
    const id = UUIDUtil.getRandomUUID();
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO import_sources
               (id, name, base_url, username, username_ci, password_ciphertext, password_iv, key_version, music_folder_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          )
          .bind(
            id,
            input.name,
            input.baseUrl,
            input.username,
            input.username.toLowerCase(),
            input.passwordCiphertext,
            input.passwordIv,
            input.musicFolderId,
            timestamp,
            timestamp,
          )
          .run(),
      'importSources.create',
    );
    const created = await this.findById(id);
    if (!created) throw new Error('importSources.create did not produce a readable row.');
    return created;
  }

  public async delete(id: string): Promise<void> {
    await this.withRetry(
      async () => await this.database.prepare('DELETE FROM import_sources WHERE id = ?').bind(id).run(),
      'importSources.delete',
    );
  }
}

/**
 * One import run, and its progress.
 *
 * Separate from {@link ImportSourceDAO} for the same reason `playlists.ts` is separate
 * from `UserStateDAO`: a source is a credential-bearing registration, a run is a state
 * machine, and they have different lifetimes and different readers.
 */
class ImportRunDAO extends BaseDAO {
  public async create(input: { sourceId: string; targetUserId: string; phases: readonly ImportPhase[] }): Promise<ImportRunRow> {
    const timestamp = nowSeconds();
    const id = UUIDUtil.getRandomUUID();
    await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `INSERT INTO import_runs (id, source_id, target_user_id, status, phases_json, started_at, updated_at)
             VALUES (?, ?, ?, 'running', ?, ?, ?)`,
          )
          // `JSON.stringify` of a validated list of known phases. The phases are a closed set
          // checked by the service, so there is nothing to escape and nothing to parse back:
          // a run is read for its status and its report, never for its phase list.
          .bind(id, input.sourceId, input.targetUserId, JSON.stringify(input.phases), timestamp, timestamp)
          .run(),
      'importRuns.create',
    );
    const created = await this.findById(id);
    if (!created) throw new Error('importRuns.create did not produce a readable row.');
    return created;
  }

  public async findById(id: string): Promise<ImportRunRow | null> {
    return await this.withRetry(
      async () => await this.database.prepare('SELECT * FROM import_runs WHERE id = ?').bind(id).first<ImportRunRow>(),
      'importRuns.findById',
    );
  }

  /**
   * A run for this user that is still going.
   *
   * One, not a list, because the import **pauses the scan** and a second concurrent run
   * would have two writers competing for the same daily row allowance — which is the
   * outage the daily-limit work exists to prevent. `LIMIT 1` alongside a count so a
   * caller can tell "one is running" from "several are running", because refusing the
   * second is the whole point and the operator should be told which.
   */
  public async findRunningForUser(targetUserId: string): Promise<{ readonly one: ImportRunRow | null; readonly running: number }> {
    const rows = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT * FROM import_runs WHERE target_user_id = ? AND status IN ('running', 'paused') ORDER BY started_at DESC LIMIT 2`,
          )
          .bind(targetUserId)
          .all<ImportRunRow>(),
      'importRuns.findRunningForUser',
    );
    return { one: rows.results?.[0] ?? null, running: rows.results?.length ?? 0 };
  }

  /**
   * Record progress.
   *
   * `workflowId` and `playCountWorker` are `string | null` and a `null` is written as
   * `NULL` rather than skipped, because a caller clearing one is saying so. The
   * alternative — building the assignment list from whatever is non-undefined — makes
   * "clear it" and "do not mention it" the same call.
   */
  public async update(
    id: string,
    patch: {
      status?: ImportRunRow['status'];
      lastError?: string | null;
      workflowId?: string | null;
      playCountWorker?: string | null;
      finishedAt?: number | null;
    },
  ): Promise<void> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      assignments.push('status = ?');
      values.push(patch.status);
    }
    if (patch.lastError !== undefined) {
      assignments.push('last_error = ?');
      values.push(patch.lastError);
    }
    if (patch.workflowId !== undefined) {
      assignments.push('workflow_id = ?');
      values.push(patch.workflowId);
    }
    if (patch.playCountWorker !== undefined) {
      assignments.push('play_count_worker = ?');
      values.push(patch.playCountWorker);
    }
    if (patch.finishedAt !== undefined) {
      assignments.push('finished_at = ?');
      values.push(patch.finishedAt);
    }
    if (assignments.length === 0) return;
    assignments.push('updated_at = ?');
    values.push(nowSeconds(), id);
    await this.withRetry(
      async () =>
        await this.database
          .prepare(`UPDATE import_runs SET ${assignments.join(', ')} WHERE id = ?`)
          .bind(...values)
          .run(),
      'importRuns.update',
    );
  }

  /**
   * Store the per-phase report, replacing whatever was there.
   *
   * Wholesale rather than merged because the report is produced by steps that may run
   * again after a retry: a merged report would accumulate the *same* unresolved item once
   * per attempt, and an operator would read a duplicate as two different problems.
   */
  public async writeReport(id: string, report: string): Promise<void> {
    await this.withRetry(
      async () =>
        await this.database
          .prepare('UPDATE import_runs SET report_json = ?, updated_at = ? WHERE id = ?')
          .bind(report, nowSeconds(), id)
          .run(),
      'importRuns.writeReport',
    );
  }

  public async readReport(id: string): Promise<string | null> {
    const row = await this.withRetry(
      async () =>
        await this.database.prepare('SELECT report_json FROM import_runs WHERE id = ?').bind(id).first<{ report_json: string | null }>(),
      'importRuns.readReport',
    );
    return row?.report_json ?? null;
  }

  public async countForSource(sourceId: string): Promise<number> {
    const row = await this.withRetry(
      async () =>
        await this.database.prepare('SELECT COUNT(*) AS cnt FROM import_runs WHERE source_id = ?').bind(sourceId).first<CountRow>(),
      'importRuns.countForSource',
    );
    return row?.cnt ?? 0;
  }

  /**
   * The most recent runs, with their source's display name resolved.
   *
   * `names` is passed in rather than joined, because a `LEFT JOIN` here would be one statement
   * instead of two and `playlists.ownerNamesFor` already set the precedent in the other
   * direction: a name that cannot be resolved comes back `null` rather than being replaced with
   * the caller's own, so a run whose source was deleted reads as *unknown source* rather than as
   * belonging to whatever the reader happens to be.
   *
   * Bounded, and **not** paginated. This is an operator's "what has happened" list on a personal
   * deployment, and an unpaginated list of a feature nobody has used yet is not a risk worth
   * building a cursor for.
   */
  public async listRecent(
    limit: number,
    names: ReadonlyMap<string, string>,
  ): Promise<
    Array<{
      id: string;
      sourceId: string;
      sourceName: string | null;
      targetUsername: string | null;
      status: string;
      lastError: string | null;
      startedAt: number;
      finishedAt: number | null;
    }>
  > {
    const rows = await this.withRetry(
      async () =>
        await this.database
          .prepare(
            `SELECT r.id, r.source_id, r.target_user_id, r.status, r.last_error, r.started_at, r.finished_at, u.username
             FROM import_runs r
             LEFT JOIN users u ON u.id = r.target_user_id
             ORDER BY r.started_at DESC
             LIMIT ?`,
          )
          .bind(Math.max(1, Math.floor(limit)))
          .all<{
            id: string;
            source_id: string;
            target_user_id: string;
            status: string;
            last_error: string | null;
            started_at: number;
            finished_at: number | null;
            username: string | null;
          }>(),
      'importRuns.listRecent',
    );
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      sourceName: names.get(row.source_id) ?? null,
      targetUsername: row.username ?? null,
      status: row.status,
      lastError: row.last_error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  }
}

export { ImportSourceDAO, ImportRunDAO, IMPORT_PHASES };
export type { ImportPhase };
