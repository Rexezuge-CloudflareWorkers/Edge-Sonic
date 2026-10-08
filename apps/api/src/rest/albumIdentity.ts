/**
 * The album identity for one request, and the one order an album's tracks are published in.
 *
 * ### Why this is its own module rather than three functions in `mappers.ts`
 *
 * Because it is **one decision** in three forms — the grouping, the key it produces, and the
 * protocol order of the rows inside a group — and all three have to move together. They were
 * written out separately and had already diverged: `groupAlbums` sorted an album's tracks by
 * `disc, track, name` while `getAlbum` and `getCoverArt`'s artwork probe sorted by `track, name`,
 * and the two wrong copies matched each other, so a two-disc album came back with its discs
 * interleaved and nothing anywhere reported an error:
 *
 * ```
 * Silent Siren Selection, one directory, no configuration involved
 *   disc=1 trk=2  Stella☆
 *   disc=2 trk=3  Koi Yuki      <- disc 2, between two disc-1 tracks
 *   disc=2 trk=6  KAKUMEI
 *   disc=1 trk=8  I x U
 *   disc=2 trk=14 Cherry Bomb
 * ```
 *
 * Every field in that response is right and the order is wrong, which is why it presented as
 * nothing at all.
 *
 * ### Why the grouping is a parameter and never a module constant
 *
 * A module-level value is resolved at import time, which in a Worker is before `env` exists — so
 * `ALBUM_GROUP_BY` would be the default in every deployed instance while passing validation and
 * reading as configured. That is the `LOG_LEVEL` defect: a setting that cannot be seen to have any
 * effect. It arrives as an argument and is carried on {@link AlbumIdentity}.
 *
 * Why an object rather than the bare string, when `library` is already threaded everywhere: because
 * the things a caller needs — the key, the id, the folder an album's artwork is found in — are
 * three questions about one decision, and passing the string would mean each call site answering
 * them from `subsonic/albumKey.ts` on its own. That is the shape of the defect this repository has
 * already recorded for album ids: two literals for one field that had already diverged.
 */
import { albumIdOf, albumKeySpec } from '@edge-sonic/subsonic';
import type { AlbumGroupingValue } from '@edge-sonic/subsonic';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';

/**
 * What an album is, for one request against one library.
 */
interface AlbumIdentity {
  readonly grouping: AlbumGroupingValue;
  /**
   * The key a row belongs to. What `groupAlbums` groups by, and what the DAO's key page holds.
   */
  keyOf: (song: SongRow) => string;
  /**
   * The protocol id for a row's album, or `undefined` for a row with no album to point at.
   */
  idOf: (song: SongRow) => string | undefined;
  /**
   * The id a **folder-shaped** album id would have had, for a row.
   *
   * Only the annotation lookups need it, and only because it is how a star written under a
   * previous grouping is still recognised: the stored id is the directory form, so a star on what
   * is now a merged album would be reported by nothing at all.
   */
  legacyFolderIdOf: (song: SongRow) => string;
}

/**
 * Build the album identity for a request.
 *
 * A factory rather than a bare object so the three functions cannot be built by three callers that
 * each remembered half of it — and so the folder-shaped id is derived from the same
 * `albumIdOf(…, 'folder')` call as every other id, rather than from `encodeId(Album, dir_path)`
 * written out again.
 */
function albumIdentity(grouping: AlbumGroupingValue, libraryId: string): AlbumIdentity {
  return {
    grouping,
    keyOf: (song) => albumKeySpec(song, grouping).string,
    idOf: (song) => albumIdOf(song, libraryId, grouping),
    legacyFolderIdOf: (song) => albumIdOf(song, libraryId, 'folder') ?? '',
  };
}

/**
 * One identity **per library**, for a read that spans several of them.
 *
 * ### Why the identity has to follow the row and not the request
 *
 * `resolveLibraries` answers every library the caller was granted when no `musicFolderId`
 * was sent, so a list endpoint reads the union. The album id it then published was minted from
 * `libraries[0]` — and under `ALBUM_GROUP_BY=folder` that library is **part of the id**
 * (`albumIdOf`, `subsonic/albumId.ts`). So a release whose folder lives in the second library
 * was published as `al:<firstLibrary>:<secondLibraryDir>`, and `getAlbum` decoded it, queried
 * the first library for the second's directory, found nothing and answered `code=70`: a link
 * that is dead on arrival.
 *
 * The tag groupings hide the same defect, because they carry the sentinel and ignore the
 * library half — which is exactly why it survived. What is wrong is not the value but the
 * shape: one request holds rows from N libraries and one identity cannot name all N.
 *
 * So the id is derived from **the row's own `library_id`**, and this is the lookup that does
 * it. `fallback` is the identity a caller already built, used for a row whose library is not
 * in `libraries` — which cannot happen for a grant-scoped read, and is named rather than
 * thrown so a mapper stays a total function over rows.
 */
function identityPerLibrary(
  grouping: AlbumGroupingValue,
  libraries: readonly LibraryRow[],
  fallback: AlbumIdentity,
): (song: SongRow) => AlbumIdentity {
  const byLibraryId = new Map(libraries.map((library) => [library.id, albumIdentity(grouping, library.id)]));
  return (song) => byLibraryId.get(song.library_id) ?? fallback;
}

/**
 * The one comparator for "an album's tracks, in the order a client sees them".
 *
 * **Disc, then track, then name** — and `disc` was the term two of the three copies were missing.
 * A client renders disc separators against `discNumber`, so an interleaved answer draws disc 1,
 * then disc 2, then disc 1 again.
 *
 * The tiebreak is `name`, not `name_ci`, because this order is what a client reads and the row
 * published as track 1 has to be the row a client calls track 1. The one place it cannot hold — the
 * album row fetch's `ORDER BY`, which only has to make an album's rows contiguous before the
 * caller re-sorts them — is asserted against this in `test/schema.int.test.ts`, on a fixture whose
 * names differ only by case, which is the input that tells the two apart.
 */
function compareAlbumTracks(a: SongRow, b: SongRow): number {
  return (a.disc ?? 9999) - (b.disc ?? 9999) || (a.track ?? 9999) - (b.track ?? 9999) || a.name.localeCompare(b.name);
}

export { albumIdentity, identityPerLibrary, compareAlbumTracks };
export type { AlbumIdentity };