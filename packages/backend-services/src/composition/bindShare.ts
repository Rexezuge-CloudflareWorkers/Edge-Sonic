/**
 * The sharing capability's composition.
 *
 * Own module so `requestScope.ts` gains one call rather than a block: the DAO thunk, the
 * service that reads it, and the two ports the service needs are one cohesive unit, and the
 * root is already at its god-file budget.
 *
 * The service takes **closures**, not a DAO instance — the DAO is bound as a thunk so a
 * request that never touches a share never constructs it, which is the same shape
 * `LibraryService` and `TreeService` take for the same reason.
 */
import type { Container } from '@rexezuge/runtime';
import type { D1Queryable } from '@rexezuge/d1';
import type { SubrequestCounter } from '@rexezuge/shared';
import { ShareDAO } from '@edge-sonic/backend-data/dao';
import { ShareService } from '../share/ShareService';
import { Tokens } from './tokens';

function bindShare(scope: Container, db: D1Queryable, subrequests: SubrequestCounter): void {
  scope.bindValue(Tokens.ShareDAO, async () => new ShareDAO(db, subrequests));

  const shares = async () => await scope.get(Tokens.ShareDAO)();

  scope.bindValue(
    Tokens.ShareService,
    new ShareService({
      shares: {
        findById: async (id) => (await shares()).findById(id),
        listForOwner: async (ownerUserId) => (await shares()).listForOwner(ownerUserId),
        listEntries: async (shareId) => (await shares()).listEntries(shareId),
        listEntrySongs: async (shareId) => (await shares()).listEntrySongs(shareId),
        listEntrySongsForOwner: async (ownerUserId) => (await shares()).listEntrySongsForOwner(ownerUserId),
        create: async (input) => (await shares()).create(input),
        replaceEntries: async (shareId, songIds) => (await shares()).replaceEntries(shareId, songIds),
        update: async (id, input) => (await shares()).update(id, input),
        delete: async (ownerUserId, id) => (await shares()).delete(ownerUserId, id),
        recordVisit: async (id, now) => (await shares()).recordVisit(id, now),
      },
      songs: {
        listIdsAcrossLibraries: async (ids) => (await scope.get(Tokens.SongDAO)()).listIdsAcrossLibraries(ids),
      },
      libraries: {
        listForUser: async (userId) => (await scope.get(Tokens.LibraryDAO)()).listForUser(userId),
      },
    }),
  );
}

export { bindShare };
