/**
 * The import feature's wiring, out of `requestScope.ts`.
 *
 * ### Why this is its own module
 *
 * Because `requestScope.ts` is over the god-file limit, and for the same reason `bindIndexDrop.ts`
 * and `bindScanDriver.ts` exist: the answer to a file that has outgrown its shape is to move the
 * block that does not belong, not to shorten the reasoning in the blocks that do.
 *
 * ### And because two docstrings here had been detached from their code
 *
 * The album/artist matchers carried a paragraph explaining why they are bound here rather than in
 * the import feature, and the remote-instance service carried another — and both sat **above** the
 * bindings they described rather than beside them, so a reader arriving at the code found the
 * reasoning first and the statement second, with nothing connecting them. Two orphans is the shape
 * this repository keeps getting wrong: a claim placed where nothing measures whether it still
 * applies. Each is now attached to the call it is about.
 */
import type { Container } from '@edge-sonic/backend-runtime/di';
import type { LibraryScope } from '@edge-sonic/backend-data/dao';
import type { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import type { SubrequestMeter } from '@edge-sonic/shared';
import { matchRemoteAlbums, matchRemoteArtists, resolveGrouping } from '../import/albumIdentity';
import { ImportSourceService } from '../import/sourceService';
import { Tokens } from './tokens';

/**
 * Bind the import's three services: the stored remote source, and the two id matchers.
 *
 * `subrequests` is passed rather than reached for, because the remote client charges it and two
 * counters would be two numbers that disagree.
 */
function bindImport(scope: Container, config: AppConfiguration, subrequests: SubrequestMeter): void {
  scope.bindValue(
    Tokens.ImportSourceService,
    new ImportSourceService({
      sources: () =>
        scope
          .get(Tokens.ImportSourceDAO)()
          .then(async (dao) => await dao),
      resolveKey: scope.get(Tokens.RemoteKey),
      /**
       * The **same expression** `LibraryService` is built with, deliberately rather than by
       * extraction: a WebDAV library and a remote Subsonic server are different things that happen
       * to share one operator-supplied-host policy, and two copies of the policy would be two
       * answers to whether a private origin may be used.
       */
      allowPrivateHosts: (): boolean => config.getAllowPrivateWebdavHosts() ?? config.isBypassAllowed(),
      /**
       * Charges the **same** meter the DAOs write to, passed as a function rather than the counter
       * itself — so this module holds no counter of its own. Two counters would be two numbers that
       * disagree, which is the defect the whole budget mechanism was rebuilt to remove.
       */
      onRequest: () => subrequests.charge(1, 'fetch'),
    }),
  );

  /**
   * The two album/artist matchers, bound once and shared by every caller.
   *
   * They are wired here rather than inside the import feature because they are a function of the
   * **grouping configuration** — `ALBUM_GROUP_BY` decides which key an album has — and the
   * configuration is read once per scope. A matcher built per call site would be free to read a
   * different grouping from the id `getAlbum` mints, and a star on an album id nothing resolves is
   * invisible to every client.
   *
   * `libraryId` is threaded through rather than read from a scope-level field because an import
   * resolves against **one** library at a time: the song phase runs once per library so a song id
   * can never be matched against the wrong grant, and the album and artist phases follow it.
   */
  const albumGrouping = resolveGrouping(config.getAlbumGroupBy());
  scope.bindValue(
    Tokens.MatchRemoteAlbums,
    async (libraryId: LibraryScope, albums: ReadonlyArray<{ id: string; name: string | null; artist: string | null }>) =>
      await matchRemoteAlbums(await scope.get(Tokens.SongMatchDAO)(), libraryId, albumGrouping, albums),
  );
  scope.bindValue(
    Tokens.MatchRemoteArtists,
    async (libraryId: LibraryScope, artists: ReadonlyArray<{ id: string; name: string | null }>) =>
      await matchRemoteArtists(await scope.get(Tokens.SongMatchDAO)(), libraryId, artists),
  );
}

export { bindImport };
