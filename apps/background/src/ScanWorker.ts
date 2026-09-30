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
    await this.ctx.storage.put('libraryId', libraryId);
    const scope = this.scope();
    const result = await scope.get(Tokens.ScanService).step(library);
    await this.armIfAdvancing(result);
    return result;
  }

  public override async alarm(): Promise<void> {
    const libraryId = await this.ctx.storage.get<string>('libraryId');
    if (!libraryId) return;
    const library = await this.libraryFor(libraryId);
    if (library === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const scope = this.scope();
    const result = await scope.get(Tokens.ScanService).step(library);
    await this.armIfAdvancing(result);
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
