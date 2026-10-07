/**
 * One Durable Object per library for the **request-path** media work: tag parsing and artwork.
 *
 * ### Why this is a second class rather than three more methods on `ScanWorker`
 *
 * **Because a Durable Object has one input gate, and the two workloads have opposite latency
 * profiles.** A `ScanWorker` alarm invocation walks the origin — up to `SCAN_CHUNK_FOLDERS`
 * folders inside `SCAN_CHUNK_DEADLINE_MS` (20 s) — and holds the object for that whole chunk.
 * Every RPC to *that same object* queues behind it. So with enrichment and artwork living
 * beside the loop, a `getSong` or a `getCoverArt` arriving mid-scan waited for the chunk
 * before it started, and `coverArt` is handed `streamTimeoutMs` (30 s): a scan in flight could
 * spend two thirds of an artwork request's budget before the request began.
 *
 * The template already carries this argument for `IMPORT_DO` — *"a Durable Object's lifecycle is
 * its alarm's"* — and it applies here with more force, because the collision is not two
 * `deleteAlarm` calls racing but **background work blocking a user-facing request**.
 *
 * ### What this object therefore does not have
 *
 * **No alarm, no `libraryId`, no pause, no frontier, and no storage of any kind.** That is not
 * an omission to be tidied up later — it is the property the split exists to establish. A
 * background scheduler and a request-path CPU offload share nothing but a library id, and the
 * one thing they must not share is a serialized event loop.
 *
 * ### So this class has **no constructor body at all**
 *
 * There is no state to load and no `blockConcurrencyWhile` to hold the gate for. `ScanWorker`
 * needs one because a pause and the day's row count have to survive an eviction; nothing here
 * does, which is what makes losing this object's memory free.
 *
 * ### The library row is resolved per call, not held
 *
 * A field would carry a library's **decrypted-able** credential material through storage the
 * platform does not encrypt for us, and the row changes whenever an operator edits the origin —
 * a held one would send the next request with the previous host. It is one indexed read, on a
 * path that is about to do ranged reads against that origin anyway.
 */
import { DurableObject } from 'cloudflare:workers';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { embeddedAlbumArt } from '@edge-sonic/backend-services/index';
import type { ArtSource, ResolvedArt } from '@edge-sonic/backend-services/index';
import type { AudioTags } from '@edge-sonic/media-tags';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import { createScanWorkerScope } from './ScanWorkerFactory';

/**
 * Facts about one file, for the path that enriches without a row in hand.
 *
 * Four fields and no more, and it is a declared shape rather than a `SongRow`: the scan holds
 * no row when it calls this, and a fabricated row is a copy of the schema that rots silently
 * the moment a column is added.
 */
interface EnrichFactsInput {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

class MediaWorker extends DurableObject<Cloudflare.Env> {
  private scope(): ReturnType<typeof createScanWorkerScope> {
    return createScanWorkerScope(this.env);
  }

  /**
   * The library this call is about, or an error naming it.
   *
   * One indexed statement rather than the whole table: this runs on all three RPCs, and
   * `getSong` and `getCoverArt` are hot paths. It used to be `listAll().find(...)` here and in
   * `ScanWorker` — a full `SELECT * FROM libraries` carrying every row's `password_ciphertext`
   * and `password_iv` to answer a lookup by primary key. `LibraryDAO.findById` always existed;
   * `LibraryService` now exposes it.
   *
   * A throw rather than `null` because there is no caller that wants to render "unknown
   * library" as an ordinary answer: `getSong` and `getCoverArt` have already resolved the
   * library through the grant check, so reaching this with an id that is not registered means
   * the two disagree — which is a fault, and a silent `null` would turn it into a blank cover
   * or an unenriched track.
   */
  private async libraryFor(libraryId: string): Promise<LibraryRow> {
    const library = await this.scope().get(Tokens.LibraryService).findById(libraryId);
    if (library === null) throw new Error(`Unknown library "${libraryId}".`);
    return library;
  }

  /**
   * Enrich one track by id: the `getSong` hot path, run in a DO isolate so the prefix/tail
   * range reads and the container parse do not spend the fetch isolate's subrequest budget or
   * CPU.
   *
   * The row is re-read after the write rather than patched in memory, because the enrichment
   * writes duration, bitrate and tags to D1 and the in-memory row still holds the pre-enrichment
   * zeros — the same reason `getSong`'s in-fetch path re-reads.
   */
  public async enrichSong(libraryId: string, songId: string): Promise<SongRow | null> {
    const library = await this.libraryFor(libraryId);
    const scope = this.scope();
    const songs = await scope.get(Tokens.SongDAO)();
    const song = await songs.findById(songId);
    if (!song) return null;
    await scope.get(Tokens.EnrichmentService).enrich(library, song);
    return (await songs.findById(songId)) ?? song;
  }

  /**
   * Enrich from file facts without a row in hand.
   *
   * Projects the outcome to its tags rather than carrying it over the wire: an RPC whose reason
   * to exist is "enrich this track" has no caller that needs the row count. The scan — the one
   * caller that does — reaches `EnrichmentService` in-process through the composition root,
   * where `rowsWritten` is preserved. A second shape for the same operation across a boundary
   * only one caller uses is a second answer waiting for a second caller.
   */
  public async enrichFacts(libraryId: string, facts: EnrichFactsInput): Promise<AudioTags | null> {
    const library = await this.libraryFor(libraryId);
    const scope = this.scope();
    return (await scope.get(Tokens.EnrichmentService).enrichFacts(library, facts)).tags;
  }

  /**
   * Artwork for an album directory: the `getCoverArt` hot path, run in a DO isolate so the
   * up-to-two ranged reads per probed track and the picture parse do not spend the fetch
   * isolate's budget.
   *
   * `timeoutMs` is the caller's `streamTimeoutMs` rather than this object's clock, because the
   * deadline that matters is the one the HTTP client is holding.
   */
  public async coverArt(
    libraryId: string,
    dirPath: string,
    candidates: readonly ArtSource[],
    timeoutMs: number,
  ): Promise<ResolvedArt | null> {
    const library = await this.libraryFor(libraryId);
    const scope = this.scope();
    return await embeddedAlbumArt(
      library,
      dirPath,
      candidates,
      {
        clientFor: (row) => scope.get(Tokens.LibraryService).clientFor(row, () => scope.get(Tokens.SubrequestMeter).charge(1, 'fetch')),
        cache: scope.get(Tokens.KvCache),
      },
      timeoutMs,
    );
  }
}

export { MediaWorker };
export type { EnrichFactsInput };