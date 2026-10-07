/**
 * The library-wide enrichment's wiring, out of `requestScope.ts`.
 *
 * ### Why this is its own module
 *
 * Because `requestScope.ts` is over the god-file limit, and for the same reason
 * `bindIndexDrop.ts`, `bindImport.ts` and `bindScanDriver.ts` exist: the answer to a file
 * that has outgrown its shape is to move the block that does not belong, not to shorten
 * the reasoning in the blocks that do.
 *
 * What moves here is the **wiring** for one feature. The decisions stay where they are
 * reachable: which tracks still owe a read is `SongEnrichmentDAO`'s, what one bounded
 * chunk costs is `LibraryEnrichmentService`'s, and which strategy a deployment gets is
 * `apps/api`'s.
 */
import type { Container } from '@edge-sonic/backend-runtime/di';
import type { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import { ENRICH_TRACKS_PER_CHUNK } from '@edge-sonic/backend-runtime/config';
import { READER_VERSION } from '@edge-sonic/media-tags';
import { SongEnrichmentDAO } from '@edge-sonic/backend-data/dao';
import type { D1Queryable } from '@edge-sonic/backend-data/utils';
import type { SubrequestCounter } from '@edge-sonic/shared';
import { LibraryEnrichmentService } from '../index/libraryEnrichment';
import { InProcessEnrichDriver } from '../library/EnrichDriver';
import type { EnrichDriver } from '../library/EnrichDriver';
import { Tokens } from './tokens';

/**
 * Bind the enrichment selection DAO and the service over it, defaulting the driver.
 *
 * `db` and `subrequests` are passed rather than reached for, for the reason every other
 * binding in this root does: a DAO without the scope's meter still works and nothing
 * counts its writes. `supplied` is the app's decision — it is the only place that can see
 * whether an `ENRICH` binding exists — and Layer 3 cannot construct the object-backed
 * strategy, so the default is the in-process one.
 */
function bindEnrichment(
  scope: Container,
  db: D1Queryable,
  subrequests: SubrequestCounter,
  config: AppConfiguration,
  supplied?: EnrichDriver,
): void {
  scope.bindValue(Tokens.SongEnrichmentDAO, async () => new SongEnrichmentDAO(db, subrequests));
  scope.bindValue(
    Tokens.LibraryEnrichmentService,
    new LibraryEnrichmentService({
      songs: {
        listNeedingEnrichment: async (libraryId, readerVersion, limit) =>
          (await scope.get(Tokens.SongEnrichmentDAO)()).listNeedingEnrichment(libraryId, readerVersion, limit),
        countNeedingEnrichment: async (libraryId, readerVersion) =>
          (await scope.get(Tokens.SongEnrichmentDAO)()).countNeedingEnrichment(libraryId, readerVersion),
      },
      scanState: {
        find: async (libraryId) => (await scope.get(Tokens.ScanStateDAO)()).find(libraryId),
      },
      subrequests,
      // The same per-track service the scan's per-folder enrichment and `getSong` use, so
      // the three entry points enrich identically. `onRequest` is the chunk's meter, for
      // the scan's reason: a range read inside the loop must count against the same budget
      // as the selection that found the track.
      enrichTrack: async (library, facts, onRequest) => {
        const outcome = await scope.get(Tokens.EnrichmentService).enrichFacts(library, facts, onRequest);
        return { rowsWritten: outcome.rowsWritten, billedRows: outcome.billedRows };
      },
      chunkMaxRequests: config.getScanChunkMaxRequests(),
      chunkDeadlineMs: config.getScanChunkDeadlineMs(),
      // Derived in `subrequests.ts` from the same ceiling the scan chunks against, so a
      // chunk that spends its whole page still fits it.
      tracksPerChunk: ENRICH_TRACKS_PER_CHUNK,
      readerVersion: READER_VERSION,
    }),
  );

  if (supplied !== undefined) {
    scope.bindValue(Tokens.EnrichDriver, supplied);
    return;
  }
  scope.bindValue(
    Tokens.EnrichDriver,
    new InProcessEnrichDriver(
      () => scope.get(Tokens.LibraryEnrichmentService),
      async (libraryId) => (await scope.get(Tokens.SongEnrichmentDAO)()).countNeedingEnrichment(libraryId, READER_VERSION),
    ),
  );
}

export { bindEnrichment };
