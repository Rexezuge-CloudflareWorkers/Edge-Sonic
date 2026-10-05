/**
 * `LibraryImportWorkflow` — the bounded import phases.
 *
 * ### Why a Workflow at all, rather than reusing `ScanWorker`'s alarm chain
 *
 * **Because a Workflow step is cached by name, and that is idempotency for free.** A step re-runs
 * only if it did not *complete*, so `step.do('playlist <remoteId>')` cannot write the same
 * playlist twice — which is the whole problem, because "create this playlist" is not idempotent
 * and `PlaylistDAO.create` mints a v4. The alarm chain has no equivalent: its only defence is
 * that every write is idempotent by construction, and here that is achieved by deriving playlist
 * ids from `(run, remotePlaylistId)` so a retry lands on the same row.
 *
 * ### One step per playlist, and the step's own result is the report entry
 *
 * A 30-playlist phase as a single step would re-fetch and re-write **all thirty** when the
 * twenty-ninth failed, spending the daily row allowance twice over for the first twenty-eight.
 *
 * The other half is that {@link LibraryImportWorkflow.recordPhase} runs **outside** the step and
 * consumes the step's **return value**. Recording inside the step would be cached with it — so a
 * step that completed but whose record was lost would never be re-recorded. Recording outside
 * with the returned outcome means the recording is re-derived on every pass and is keyed by phase
 * name, so a retried step overwrites its own line rather than appending a second one.
 *
 * ### The play-count walk is **not** here
 *
 * There is no `getPlayCounts` in the protocol — `playCount` is only an attribute on a song — so
 * play counts are readable only by walking the remote's albums. That is unbounded in a way the
 * Free plan's **1,024-step ceiling** cannot hold, and each step costs 10 ms of CPU. So it runs in
 * `PlayCountImportWorker`, alarm-chained, and this workflow's play-count step only **starts** it.
 *
 * The split is not a convenience: a DO alarm invocation gets a **fresh 50-subrequest budget**,
 * which is what makes an unbounded walk possible at all.
 *
 * ### The run does not report `completed` while the walk is outstanding
 *
 * An operator told "imported" with half the play counts still walking has no way to know. So
 * {@link LibraryImportWorkflow.settle} checks whether a play-count worker was started and leaves
 * the run `running` if so, naming the worker in the report.
 *
 * ### Step names are cache keys
 *
 * Every name is derived from **stable** values — the run, the phase, the remote id. A name built
 * from a timestamp or a loop index is a different step on every pass, so nothing is ever cached
 * and the idempotency above is lost while still appearing to be there.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ImportPhase } from '@edge-sonic/backend-data/dao';
import { runWorkflow } from '@edge-sonic/backend-runtime/base';
import { Tokens } from '@edge-sonic/backend-services/composition';

import {
  buildReport,
  parseReport,
  runBookmarksPhase,
  runPlayQueuePhase,
  runPlaylistsPhase,
  runStarsPhase,
  serializeReport,
} from '@edge-sonic/backend-services/import';
import type { PhaseContext, PhaseReport, PhaseStore } from '@edge-sonic/backend-services/import';
import { createScanWorkerScope } from './ScanWorkerFactory';

/**
The event payload. Serializable, so it crosses the Workflow's storage as JSON.
*/
interface ImportWorkflowPayload {
  readonly runId: string;
  readonly sourceId: string;
  readonly userId: string;
  readonly libraryId: string;
  readonly phases: readonly ImportPhase[];
  /**
  The remote's playlist ids, so the workflow does not re-list just to learn its step names.
  */
  readonly playlistIds: readonly string[];
}

/**
A step's wall-clock ceiling. Well under the 30 minutes the docs cap a step at.
*/
const STEP_TIMEOUT = '5 minutes';

/**
 * Retries per step, bounded and bounded **low**.
 *
 * A step that fails because the remote is down fails identically three times, and each attempt
 * spends external subrequests — and for a write step, rows against the daily allowance. Three is
 * enough to ride out a dropped connection and not enough to turn a dead remote into a long loop.
 */
const STEP_RETRIES = { limit: 3, delay: '10 seconds', backoff: 'exponential' } as const;

class LibraryImportWorkflow extends WorkflowEntrypoint<Cloudflare.Env, ImportWorkflowPayload> {
  public async run(event: Readonly<WorkflowEvent<ImportWorkflowPayload>>, step: WorkflowStep): Promise<{ readonly runId: string }> {
    return await runWorkflow('LibraryImportWorkflow', async () => {
      await this.onWorkflow(event, step);
      return { runId: event.payload.runId };
    });
  }

  private async onWorkflow(event: Readonly<WorkflowEvent<ImportWorkflowPayload>>, step: WorkflowStep): Promise<void> {
    const { runId, sourceId, userId, libraryId, phases, playlistIds } = event.payload;
    const context = { runId, sourceId, userId, libraryId };

    if (phases.includes('playlists')) {
      for (const remotePlaylistId of playlistIds) {
        const outcome = await step.do(`playlist ${remotePlaylistId}`, { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
          const scope = await this.phaseContext(context);
          return await runPlaylistsPhase(scope, remotePlaylistId);
        });
        await this.recordPhase(runId, outcome);
      }
    }

    if (phases.includes('stars')) {
      const outcome = await step.do('stars', { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        return await runStarsPhase(await this.phaseContext(context));
      });
      await this.recordPhase(runId, outcome);
    }

    if (phases.includes('bookmarks')) {
      const outcome = await step.do('bookmarks', { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        return await runBookmarksPhase(await this.phaseContext(context));
      });
      await this.recordPhase(runId, outcome);
    }

    if (phases.includes('playQueue')) {
      const outcome = await step.do('playQueue', { retries: STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
        return await runPlayQueuePhase(await this.phaseContext(context));
      });
      await this.recordPhase(runId, outcome);
    }

    // Play counts are **started** here and **walked** in the Durable Object.
    let walkStarted = false;
    if (phases.includes('playCounts')) {
      walkStarted = await this.startPlayCountWorker(runId);
      if (walkStarted) {
        await this.recordPhase(
          runId,
          {
            phase: 'playCounts',
            // `partial`, not `imported`: the walk has begun and the numbers are not here yet. A
            // status of `imported` would be a claim about work this step did not do.
            status: 'partial',
            imported: 0,
            rowsWritten: 0,
            unresolvedCount: 0,
            unresolved: [],
            lastError: 'The play-count walk is running in its own Durable Object; counts appear here as it proceeds.',
          },
          false,
        );
      }
    }

    await this.settle(runId, walkStarted);
  }

  /**
   * Build the phase context: a decrypted client, and the store the phases write through.
   *
   * The credential is decrypted **here** and nowhere else, and the client is built per step
   * rather than held on the instance — because it holds the plaintext password for its lifetime,
   * and a Workflow instance hibernates between steps. A field would carry that password through
   * storage the platform does not encrypt for us.
   */
  private async phaseContext(context: { runId: string; sourceId: string; userId: string; libraryId: string }): Promise<PhaseContext> {
    const scope = createScanWorkerScope(this.env);
    // The **same** service the route used to list the remote's playlists, for the same row and
    // therefore the same key. Two readers of one stored credential is two implementations of
    // "decrypt it", free to disagree about which key — and the disagreement is a credential that
    // decrypts in one place and not the other, discovered only when a step cannot read the remote.
    //
    // The client is built **per step**, never held on the instance: it holds the plaintext
    // password for its lifetime, and a Workflow instance hibernates between steps, so a field
    // would carry that password through storage the platform does not encrypt for us.
    const opened = await scope.get(Tokens.ImportSourceService).clientFor(context.sourceId);
    if (!opened.ok) {
      // `NonRetryableError`, and **both** refusals map to it: the source is gone, or its host is no
      // longer permitted. Neither becomes true again within a step's retry window — the second one
      // is an operator's deliberate configuration change — so retrying three times would re-read a row
      // that will not answer, and then report a failed instance rather than a running one.
      throw new NonRetryableError(opened.reason);
    }

    return {
      runId: context.runId,
      userId: context.userId,
      libraryId: context.libraryId,
      store: this.phaseStore(scope, context.userId),
      // No cast: the client satisfies the phase's reader port structurally, and the cast that used
      // to be here was a hole in the compiler where a divergence would have gone unread.
      remote: opened.client,
      matchAlbum: (libraryId, albums) => scope.get(Tokens.MatchRemoteAlbums)(libraryId, albums),
      matchArtist: (libraryId, artists) => scope.get(Tokens.MatchRemoteArtists)(libraryId, artists),
      albumPageSize: 500,
    };
  }

  /**
   * The store the phases write through.
   *
   * Every method is a **delegation and nothing else** — no arithmetic, no filtering, no
   * ordering. That is deliberate: a port that quietly reorders a playlist or drops an entry is a
   * second implementation of the DAO, and a second implementation is free to disagree about the
   * exact thing the DAO was written to get right.
   */
  private phaseStore(scope: ReturnType<typeof createScanWorkerScope>, userId: string): PhaseStore {
    return {
      findByPaths: async (libraryId, paths) => await (await scope.get(Tokens.SongMatchDAO)()).findByPaths(libraryId, paths),
      findByAlbumTitle: async (libraryId, pairs) => await (await scope.get(Tokens.SongMatchDAO)()).findByAlbumTitle(libraryId, pairs),

      grantedLibraryIds: async (id) => {
        const granted = await scope.get(Tokens.LibraryService).listForUser(id);
        return new Set(granted.map((row: { readonly id: string }) => row.id));
      },

      songsByIds: async (ids) => await (await scope.get(Tokens.SongDAO)()).listIdsAcrossLibraries(ids),
      findPlaylistById: async (id) => await (await scope.get(Tokens.PlaylistDAO)()).findById(id),

      createPlaylistWithId: async (input) => {
        await (await scope.get(Tokens.PlaylistDAO)()).createWithId(input);
      },
      replacePlaylistEntries: async (playlistId, songIds, totalDuration) => {
        // The DAO returns the entry count; the allowance is spent on **statements**, and the
        // header recompute is one of them, so the reported figure is the count plus that one.
        const written = await (await scope.get(Tokens.PlaylistDAO)()).replaceEntries(playlistId, songIds, totalDuration);
        return { written: written + 1 };
      },

      upsertStar: async (input) => {
        await (await scope.get(Tokens.AnnotationDAO)()).star(input.userId, input.itemId, input.itemType, input.starredAt);
        return { written: 1 };
      },
      upsertRating: async (input) => {
        await (await scope.get(Tokens.AnnotationDAO)()).setRating(input.userId, input.itemId, input.itemType, input.rating);
        return { written: 1 };
      },
      upsertBookmark: async (input) => {
        await (await scope.get(Tokens.AnnotationDAO)()).createBookmark(userId, input.songId, input.positionMs, input.comment);
        return { written: 1 };
      },
      savePlayQueue: async (input) => {
        await (await scope.get(Tokens.AnnotationDAO)()).savePlayQueue({ ...input, changed: input.changed });
        return { written: input.songIds.length + 2 };
      },
      setPlayCounts: async (input) => {
        // Absolute, never additive — see `PlayCountDAO.setPlayCounts`. An import re-run would
        // otherwise inflate every count, and unlike a playlist there is no observable difference
        // between "played twice" and "imported twice".
        const written = await (await scope.get(Tokens.PlayCountDAO)()).setPlayCounts(userId, input.counts);
        return { written };
      },
    };
  }

  private allowPrivateHosts(): boolean {
    const config = createScanWorkerScope(this.env).get(Tokens.AppConfig);
    return config.getAllowPrivateWebdavHosts() ?? config.isBypassAllowed();
  }

  /**
   * Merge one phase's outcome into the stored report, replacing any line with the same name.
   *
   * Replacing rather than appending is what makes a retried step idempotent: the same phase name
   * is rewritten with the newer outcome, so a retried step cannot list the same unresolved item
   * twice — and a duplicate reads as a second, different problem, which is exactly what an
   * operator triaging a 400-entry list cannot afford to be unsure about.
   */
  private async recordPhase(runId: string, outcome: PhaseReport, finished = true): Promise<void> {
    const scope = createScanWorkerScope(this.env);
    const runs = await scope.get(Tokens.ImportRunDAO)();
    const run = await runs.findById(runId);
    if (run === null) return;
    const existing = parseReport(await runs.readReport(runId));
    const phases = (existing?.phases ?? []).filter((entry) => entry.phase !== outcome.phase);
    phases.push(outcome);
    await runs.writeReport(
      runId,
      serializeReport(
        buildReport({
          runId,
          sourceName: existing?.sourceName ?? '',
          targetUsername: existing?.targetUsername ?? '',
          phases,
          finished,
        }),
      ),
    );
  }

  /**
   * Hand the play-count walk to its Durable Object.
   *
   * Outside a `step.do`, deliberately. `step.do` exists so work is **not** repeated when an
   * instance restarts, and this is a side effect whose whole purpose is to happen once and then
   * continue on its own alarm chain: a step that "completed" but whose object was never started
   * would be cached and never re-run, and the walk would silently never happen. The worker's name
   * **is** the run id, so calling this twice reaches the same object rather than starting a
   * second walk over the same albums.
   *
   * `false` when no binding is configured — tests and local dev — so the run can report the walk
   * as unavailable rather than as started.
   */
  private async startPlayCountWorker(runId: string): Promise<boolean> {
    const namespace = (this.env as unknown as { IMPORT_DO?: DurableObjectNamespace }).IMPORT_DO;
    if (namespace === undefined) return false;
    const stub = namespace.getByName(runId) as unknown as { start(): Promise<unknown> };
    await stub.start();
    const scope = createScanWorkerScope(this.env);
    await (await scope.get(Tokens.ImportRunDAO)()).update(runId, { playCountWorker: runId });
    return true;
  }

  /**
   * Close the run — **unless** a play-count walk is still going.
   *
   * An operator told "imported" with half the play counts walking has no way to know, and the
   * Durable Object is the only thing that can finish them. So the run stays `running` and names
   * the worker, and the worker's own completion settles it.
   */
  private async settle(runId: string, walkOutstanding: boolean): Promise<void> {
    const scope = createScanWorkerScope(this.env);
    const runs = await scope.get(Tokens.ImportRunDAO)();
    const run = await runs.findById(runId);
    if (run === null) return;
    if (walkOutstanding) {
      await runs.update(runId, { status: 'running', lastError: null });
      return;
    }
    const existing = parseReport(await runs.readReport(runId));
    await runs.writeReport(
      runId,
      serializeReport(
        buildReport({
          runId,
          sourceName: existing?.sourceName ?? '',
          targetUsername: existing?.targetUsername ?? '',
          phases: existing?.phases ?? [],
          finished: true,
        }),
      ),
    );
    await runs.update(runId, { status: 'completed', lastError: null, finishedAt: Math.floor(Date.now() / 1000) });
  }
}

export { LibraryImportWorkflow, STEP_RETRIES, STEP_TIMEOUT };
export type { ImportWorkflowPayload,  };
export {type RequestScopeEnv} from '@edge-sonic/backend-services/composition';