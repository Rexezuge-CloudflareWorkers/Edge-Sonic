/**
 * `importPhaseStore` — the store the Workflow's phases write through.
 *
 * ### Why this is its own module rather than a method
 *
 * **Because it uses none of the class.** Every method delegates to the scope and nothing else, so
 * it holds no `this`, no credential and no state — a free function over a scope, extracted from
 * `LibraryImportWorkflow` when the walk-outcome change pushed that file past the 400-LOC gate.
 * The alternative was to trim the comments, and a comment that is the only record of why a
 * delegation is shaped that way is worth less than the extraction.
 *
 * ### Every method is a **delegation and nothing else**
 *
 * No arithmetic, no filtering, no ordering. That is deliberate: a port that quietly reorders a
 * playlist or drops an entry is a second implementation of the DAO, and a second implementation is
 * free to disagree about the exact thing the DAO was written to get right.
 *
 * ### It is a port, and `PlayCountImportWorker` holds a second one
 *
 * The Durable Object needs the same shape to walk a remote's albums, and stubs the four methods its
 * phase cannot reach — writing nothing and reporting `0`, because a stub that threw would turn a
 * future caller of the wrong phase into a failure nobody could have predicted. So the two are
 * deliberately **not** one factory: sharing it would mean the walk's unreachable methods reported
 * the same `0` for a different reason, and a reader could not tell which.
 */
import { Tokens } from '@edge-sonic/backend-services/composition';
import type { Token } from '@edge-sonic/backend-runtime';
import type { PhaseStore } from '@edge-sonic/backend-services/import';

/**
 * The minimal scope this module reads: `Container`'s `get`, and nothing else.
 *
 * Structural rather than `ReturnType<typeof createScanWorkerScope>` so the dependency is the one
 * method this store resolves tokens through, and a scope that grows a binding cannot change this
 * file's shape by accident. `Container` is the type the composition root returns, so this cannot
 * drift from it without a compile error at the call site.
 */
interface PhaseStoreScope {
  get<T>(token: Token<T>): T;
}

function importPhaseStore(scope: PhaseStoreScope, userId: string): PhaseStore {
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
      // The DAO returns the entry count; the allowance is spent on **statements**, and the header
      // recompute is one of them, so the reported figure is the count plus that one.
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

export { importPhaseStore };
export type { PhaseStoreScope };
