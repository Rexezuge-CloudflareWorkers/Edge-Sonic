/**
 * One Durable Object per library: the scan loop and the heavy tag-picture CPU.
 *
 * Facade (Git `RepoWorker` pattern): routing + composition only. The folder walk
 * lives in `ScanService`, tag parsing in `EnrichmentService`/`media-tags`, picture
 * extraction in `embeddedAlbumArt` — this class only decides *where* they run and
 * chains the alarm that advances the scan without a client polling.
 *
 * D1 stays authoritative; DO storage holds only the library id and the alarm.
 * KV stays a non-load-bearing cache. That is what makes a DO restart safe: the
 * frontier lives in D1, so a lost isolate resumes rather than restarts.
 */
import { DurableObject } from 'cloudflare:workers';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { embeddedAlbumArt, isAdvancing } from '@edge-sonic/backend-services/index';
import type { ArtSource, ChunkResult, ResolvedArt } from '@edge-sonic/backend-services/index';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import { createScanWorkerScope } from './ScanWorkerFactory';

/**
 * Milliseconds between alarm-driven chunks.
 *
 * Non-zero so a chunk's `waitUntil` work settles before the next alarm fires,
 * and small enough that a scan of many chunks finishes while an operator
 * watches. The chunk itself is still bounded by `ScanBudget`, so this is a
 * pacing delay, not a work bound.
 */
const SCAN_ALARM_DELAY_MS = 1000;

/**
 * The alarm the chain re-arms itself with after a fault it could not record.
 *
 * `SCAN_ALARM_DELAY_MS` and nothing else, and the reasoning is the point: a failure that
 * could not be written to `scan_state` has no `consecutive_failures` to bound it, so the
 * rate is what does the bounding. One attempt a second against a store that is refusing
 * writes is cheap, and it stops the instant the store recovers — which is the only moment
 * it should stop, because the alternative (`stalled`, and therefore no alarm) is a
 * permanent end to a scan over a transient fault.
 */
const RETRY_ARM_DELAY_MS = SCAN_ALARM_DELAY_MS;

interface EnrichFactsInput {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

class ScanWorker extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
  }

  private scope(): ReturnType<typeof createScanWorkerScope> {
    return createScanWorkerScope(this.env);
  }

  private async libraryFor(libraryId: string): Promise<LibraryRow | null> {
    const scope = this.scope();
    const libraries = await scope.get(Tokens.LibraryService).listAll();
    return libraries.find((candidate) => candidate.id === libraryId) ?? null;
  }

  private async armIfAdvancing(result: ChunkResult): Promise<void> {
    if (isAdvancing(result.status)) {
      await this.ctx.storage.setAlarm(Date.now() + SCAN_ALARM_DELAY_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /**
   * Seed the frontier and schedule the alarm chain.
   *
   * Stores the library id so `alarm()` knows what to advance after a restart.
   */
  public async startScan(libraryId: string): Promise<ChunkResult> {
    const library = await this.libraryFor(libraryId);
    if (library === null) throw new Error(`Unknown library "${libraryId}".`);
    // Unconditional, and it must be: `start` is what *seeds* the frontier and clears the
    // retry counter, so this is the one entry point that legitimately re-points the object
    // at a different library.
    await this.ctx.storage.put('libraryId', libraryId);
    const scope = this.scope();
    const result = await scope.get(Tokens.ScanService).start(library);
    await this.armIfAdvancing(result);
    return result;
  }

  /**
   * Read-only status. Never advances the scan — that is what the alarm is for.
   */
  public async getStatus(libraryId: string): Promise<ChunkResult> {
    const scope = this.scope();
    return await scope.get(Tokens.ScanService).status(libraryId);
  }

  /**
   * Advance one chunk, then re-arm the alarm while more work remains.
   *
   * The operator `POST .../scan/step` and `alarm()` share this: a manual step
   * is one chunk of the same loop, not a second implementation.
   */
  public async stepOnce(libraryId: string): Promise<ChunkResult> {
    const library = await this.libraryFor(libraryId);
    if (library === null) throw new Error(`Unknown library "${libraryId}".`);
    await this.rememberLibrary(libraryId);
    return await this.runChunk(library);
  }

  public override async alarm(): Promise<void> {
    // Wrapped whole, because an alarm handler that rejects is a permanent wedge.
    //
    // It used to have no handler at all. Cloudflare retries a throwing alarm a bounded
    // number of times and then drops it, and every one of those retries was a chance for
    // the *same* fault to throw again — so the chain ended with D1 still recording
    // `scanning` and nothing scheduled to advance it. `getStatus` reports
    // `scanning: true` for ever, and every client reads that as *keep polling*, so the
    // symptom is a scan that looks alive and never moves. Nothing reconciled the two
    // stores: the alarm lives in DO storage, the status in D1, and `getAlarm()` is
    // called from nowhere in this repository.
    //
    // So the handler cannot reject, and a failure is recorded rather than discarded —
    // `isAdvancing('failed')` is true, so `armIfAdvancing` keeps the chain armed and
    // `consecutive_failures` bounds it. That is the difference between a bounded retry
    // and an unbounded one, and the reason the catch is here rather than around
    // `ScanService.step` alone: this is the code that owns the alarm, so this is where
    // re-arming is decided.
    try {
      const libraryId = await this.ctx.storage.get<string>('libraryId');
      if (!libraryId) return;
      const library = await this.libraryFor(libraryId);
      if (library === null) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.runChunk(library);
    } catch (error) {
      console.error('[ScanWorker] alarm failed; the chain stays armed for a bounded retry', error);
      // Re-arm unconditionally, and after the same delay a normal chunk would use. The
      // chunk's own failure already records `last_error` and counts against the retry
      // budget; this arm exists so a fault *outside* `step` — storage, the library lookup —
      // cannot silently end the chain. `RETRY_ARM_DELAY_MS` bounds the rate here, because
      // the counter that bounds the retries does not exist on this path.
      await this.ctx.storage.setAlarm(Date.now() + RETRY_ARM_DELAY_MS);
    }
  }

  /**
   * One chunk of the walk, with the alarm re-armed from its result.
   *
   * `stepOnce` and `alarm` share this because they are one loop: a manual step is a
   * chunk of the same walk, not a second implementation of it, and having them diverge
   * is how the two started disagreeing about whether a chunk was `idle`.
   */
  private async runChunk(library: LibraryRow): Promise<ChunkResult> {
    const scope = this.scope();
    const result = await scope.get(Tokens.ScanService).step(library);
    await this.armIfAdvancing(result);
    return result;
  }

  /**
   * Persist the library this object scans, only when it has changed.
   *
   * `stepOnce` used to `put` it unconditionally on every call — one storage write per
   * operator step for a value that is almost always identical — while `alarm` correctly
   * read it. Reading first also removes a race: the write used to land between `alarm`'s
   * read and its `step`, so two interleaved entries could each proceed on the value they
   * happened to read.
   */
  private async rememberLibrary(libraryId: string): Promise<void> {
    const current = await this.ctx.storage.get<string>('libraryId');
    if (current !== libraryId) await this.ctx.storage.put('libraryId', libraryId);
  }

  /**
   * Enrich one track by id: the `getSong` hot path, run in the DO isolate so
   * the prefix/tail range reads and the container parse do not spend the
   * fetch isolate's subrequest budget or CPU.
   */
  public async enrichSong(libraryId: string, songId: string): Promise<SongRow | null> {
    const library = await this.libraryFor(libraryId);
    if (library === null) throw new Error(`Unknown library "${libraryId}".`);
    const scope = this.scope();
    const songs = await scope.get(Tokens.SongDAO)();
    const song = await songs.findById(songId);
    if (!song) return null;
    await scope.get(Tokens.EnrichmentService).enrich(library, song);
    return (await songs.findById(songId)) ?? song;
  }

  /**
   * Enrich from file facts without a row in hand. The scan calls this path
   * in-process already; this RPC exists for callers outside the DO that hold
   * facts rather than rows.
   */
  public async enrichFacts(libraryId: string, facts: EnrichFactsInput): Promise<AudioTags | null> {
    const library = await this.libraryFor(libraryId);
    if (library === null) throw new Error(`Unknown library "${libraryId}".`);
    const scope = this.scope();
    return await scope.get(Tokens.EnrichmentService).enrichFacts(library, facts);
  }

  /**
   * Artwork for an album directory: the `getCoverArt` hot path, run in the DO
   * isolate so the up-to-two ranged reads per probed track and the picture
   * parse do not spend the fetch isolate's budget.
   */
  public async coverArt(
    libraryId: string,
    dirPath: string,
    candidates: readonly ArtSource[],
    timeoutMs: number,
  ): Promise<ResolvedArt | null> {
    const library = await this.libraryFor(libraryId);
    if (library === null) throw new Error(`Unknown library "${libraryId}".`);
    const scope = this.scope();
    return await embeddedAlbumArt(
      library,
      dirPath,
      candidates,
      {
        clientFor: (row) => scope.get(Tokens.LibraryService).clientFor(row),
        cache: scope.get(Tokens.KvCache),
      },
      timeoutMs,
    );
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/status' && request.method === 'GET') {
      const libraryId = url.searchParams.get('libraryId');
      if (!libraryId) return new Response('Missing libraryId', { status: 400 });
      return Response.json(await this.getStatus(libraryId));
    }
    return new Response('Not Found', { status: 404 });
  }
}

export { ScanWorker, SCAN_ALARM_DELAY_MS };
export type { EnrichFactsInput };
