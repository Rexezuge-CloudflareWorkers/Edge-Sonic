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
import type { PhaseContext, PhaseReport } from '@edge-sonic/backend-services/import';
import type { PlayCountImportWorker } from './PlayCountImportWorker';
import { importPhaseStore } from './importPhaseStore';
import { createScanWorkerScope } from './ScanWorkerFactory';

/**
 * The play-count Durable Object's stub, typed by **the class itself**.
 *
 * The `scanStubs.ts` pattern, for the same reason it is used there: a hand-written signature is
 * free to disagree with the class, and it shipped disagreeing. `{ start(): Promise<unknown> }`
 * declared **no** parameter, so `stub.start()` typechecked while `PlayCountImportWorker.start`
 * read `request.runId` off the first argument — which arrives `undefined` over RPC, so the
 * object got no run id and no alarm and the walk never began. The class is the statement; a
 * signature beside it is a second claim, and nothing measured the two.
 */
type ImportStub = DurableObjectStub & PlayCountImportWorker;

/**
 * What the play-count half did, which is **three** answers and not two.
 *
 * `not-configured` and `failed` both mean "no walk is outstanding", and collapsing them into one
 * boolean is what left a run saying `running` with nothing scheduled to advance it: a `false` from
 * a start that *threw* is indistinguishable from a `false` from no binding, so the run settled
 * `completed` over a play-count phase that never started. Each kind maps to exactly one terminal
 * state in {@link LibraryImportWorkflow.settle}.
 */
type WalkOutcome = { readonly kind: 'not-configured' } | { readonly kind: 'outstanding' } | { readonly kind: 'failed'; readonly reason: string };

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

/**
 * What the operator is told when the play-count object cannot be started.
 *
 * A **literal**, for the reason `runWorkflow` logs one: the text reaches an operator's page
 * through `import_runs.last_error`, so it must say what is true about this repository and nothing
 * about a fault's own contents. What it does not do is hide the cause — the error is logged beside
 * it, and the literal names the phase, because "the import failed" is the one sentence that
 * leaves an operator with no next step.
 */
const WALK_START_FAILED = 'The play-count walk could not be started, so no play counts were read. The other phases in this report are unaffected.';

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
    let walk: WalkOutcome = { kind: 'not-configured' };
    if (phases.includes('playCounts')) {
      walk = await this.startPlayCountWorker(runId);
      if (walk.kind === 'failed') {
        // `failed`, and named — the walk never began, so there is nothing partial about it and
        // nothing an operator can wait for. The literal is the whole message: the run's
        // `last_error` is what the operator page renders, and the cause behind it is a fault in
        // this repository's own binding rather than anything about the remote.
        await this.recordPhase(runId, {
          phase: 'playCounts',
          status: 'failed',
          imported: 0,
          rowsWritten: 0,
          unresolvedCount: 0,
          unresolved: [],
          lastError: walk.reason,
        });
      } else if (walk.kind === 'outstanding') {
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

    // Outside the `catch` that produced `walk`, deliberately: a fault in *settling* still has to
    // reach the engine, because a `run` that returns normally reports success and the run row is
    // the only thing that would have said otherwise.
    await this.settle(runId, walk);
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
      store: importPhaseStore(scope, context.userId),
      // No cast: the client satisfies the phase's reader port structurally, and the cast that used
      // to be here was a hole in the compiler where a divergence would have gone unread.
      remote: opened.client,
      matchAlbum: (libraryId, albums) => scope.get(Tokens.MatchRemoteAlbums)(libraryId, albums),
      matchArtist: (libraryId, artists) => scope.get(Tokens.MatchRemoteArtists)(libraryId, artists),
      albumPageSize: 500,
    };
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
   * The **payload is the run id**, and it is not derivable inside the object: the name is a
   * routing decision, and nothing about a Durable Object turns its own name into an argument.
   * The first version called `stub.start()` with none, so `PlayCountImportWorker.start` read
   * `request.runId` off `undefined` — which threw *before* the `put` and before the alarm, so the
   * walk never ran, the instance was recorded errored, and the run stayed `running` with no error
   * for ever.
   *
   * ### A start that fails is recorded, not thrown
   *
   * `failed` rather than a rethrow, and it is the narrowest catch in the class. Letting the fault
   * escape is how the run above ended up `running` with nothing scheduled to advance it, visible
   * only in the Cloudflare dashboard — the wedge `runWorkflow` exists to prevent, arriving through
   * the one call it cannot see. The reason is a **literal**, with the error logged beside it: a
   * `RemoteSubsonicError` carries a URL, and this string is what the operator page renders.
   */
  private async startPlayCountWorker(runId: string): Promise<WalkOutcome> {
    const namespace = (this.env as unknown as { IMPORT_DO?: DurableObjectNamespace }).IMPORT_DO;
    if (namespace === undefined) return { kind: 'not-configured' };
    const stub = namespace.getByName(runId) as unknown as ImportStub;
    try {
      await stub.start({ runId });
    } catch (err: unknown) {
      console.error('[LibraryImportWorkflow] the play-count walk could not be started; the run is recorded as failed');
      console.error(err);
      return { kind: 'failed', reason: WALK_START_FAILED };
    }
    const scope = createScanWorkerScope(this.env);
    await (await scope.get(Tokens.ImportRunDAO)()).update(runId, { playCountWorker: runId });
    return { kind: 'outstanding' };
  }

  /**
   * Close the run — unless a play-count walk is still going.
   *
   * An operator told "imported" with half the play counts walking has no way to know, and the
   * Durable Object is the only thing that can finish them. So the run stays `running` and names
   * the worker, and the worker's own completion settles it.
   *
   * The three kinds are three answers because they ask the operator for three different things.
   * `outstanding` needs a poll. `failed` needs a look. `not-configured` needs nothing — there was
   * no walk to run — and settling it `completed` is the only honest reading, since a deployment
   * with no binding cannot fail an import the operator asked for.
   */
  private async settle(runId: string, walk: WalkOutcome): Promise<void> {
    const scope = createScanWorkerScope(this.env);
    const runs = await scope.get(Tokens.ImportRunDAO)();
    const run = await runs.findById(runId);
    if (run === null) return;
    if (walk.kind === 'outstanding') {
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
          // `finished: true` for a **failed** run too. It means nothing further will be written,
          // which is true of a terminal failure, and leaving it null would render a run that is
          // definitively over as one still in progress.
          finished: true,
        }),
      ),
    );
    if (walk.kind === 'failed') {
      await runs.update(runId, { status: 'failed', lastError: walk.reason, finishedAt: Math.floor(Date.now() / 1000) });
      return;
    }
    await runs.update(runId, { status: 'completed', lastError: null, finishedAt: Math.floor(Date.now() / 1000) });
  }
}

export { LibraryImportWorkflow, STEP_RETRIES, STEP_TIMEOUT, WALK_START_FAILED };
export type { ImportWorkflowPayload, ImportStub, WalkOutcome };
export { type RequestScopeEnv } from '@edge-sonic/backend-services/composition';
