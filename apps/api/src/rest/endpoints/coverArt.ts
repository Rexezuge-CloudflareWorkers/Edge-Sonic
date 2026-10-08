/**
 * `getCoverArt` — an album, artist or song's cover image.
 *
 * Split from `media.ts` because cover art is the one media endpoint that is not a
 * passthrough. `stream` and `download` forward bytes the origin already holds; this one
 * *finds* a picture that may not exist as a file at all.
 *
 * A sidecar image next to the tracks is tried first (cheaper: D1 plus one `GET`);
 * a picture **inside** the track's tags is second (the common Picard/beets/`ffmpeg`
 * layout). Without the second, an embedded-only library answered with a valid 1×1
 * transparent PNG the client cached and drew — "no cover image can be loaded" with
 * no log line naming it. `embeddedArtFor` (in `coverArtShared.ts`) reads it.
 *
 * This endpoint never speaks the Subsonic envelope: it is consumed as an image, so
 * an unreachable cover is the placeholder and no failure path here produces JSON.
 * `size` is ignored — no image decoder, so the original is sent honestly.
 */
import { decodeAlbumKey, decodeId, IdKind } from '@edge-sonic/subsonic';
import type { IdKindValue } from '@edge-sonic/subsonic';
import type { LibraryRow, LibraryScope } from '@edge-sonic/backend-data/dao';
import { librariesForId } from './libraries';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import type { PassthroughResponse } from './media';
import { artistCover } from './artistCover';
import type { AlbumTarget } from './coverArtShared';
import { coverForSongs, coverForTarget, findCoverIn, representativeDir } from './coverArtShared';

async function getCoverArt(context: RestContext): Promise<PassthroughResponse> {
  const id = context.params.require('id');
  // Song fast path, before any decode: a short song id carries no library or path to decode, so
  // resolving it is one indexed read and everything else here is for the directory-shaped kinds.
  const song = await context.songs.findBySongId(id);
  if (song) {
    const library = await context.libraries.requireForUser(context.user.id, song.library_id);
    context.libraries.assertReachable(library);
    return await coverForSongs(library, [song], song.dir_path, context);
  }
  const decoded = decodeId(id);
  // The path guard is on the path-shaped kinds only: an album-key payload is base64url
  // segments and is never used as a path.
  if (decoded.kind !== IdKind.AlbumKey) TreeService.assertPath(decoded.path);
  // `librariesForId`, not `requireForUser`: an album or artist id carries the sentinel.
  const libraries = await librariesForId(context, decoded.libraryId);
  const library = libraries[0];
  context.libraries.assertReachable(library);

  // An artist id names a group spanning several folders; the album path below resolves
  // one id to one folder.
  if (decoded.kind === IdKind.Artist) {
    return await artistCover(libraries, decoded.path, context);
  }

  // Resolved once and used by both branches, so the sidecar and embedded probes cannot
  // look at different albums of a merged release.
  const target = await albumTargetFor(library, libraries.map((row) => row.id), decoded.kind, decoded.path, context);
  const folder = await resolveCoverFolder(library, decoded.kind, decoded.path, target.dirPath, context);
  return await coverForTarget(library, target, folder, context);
}

/**
 * The album an id names, its rows and the folder its artwork is found in.
 *
 * `IdKind.AlbumKey` resolves through the grouping key; `IdKind.Album` is the legacy
 * folder form. Artist ids never reach here — see `artistCover`.
 */
async function albumTargetFor(library: LibraryRow, scope: LibraryScope, kind: IdKindValue, path: string, context: RestContext): Promise<AlbumTarget> {
  if (kind === IdKind.Song) {
    const song = await context.songs.findByPath(library.id, path);
    return { dirPath: song?.dir_path ?? null, songs: song === null ? [] : [song] };
  }
  if (kind === IdKind.AlbumKey) {
    const key = decodeAlbumKey(path);
    if (key === null) return { dirPath: null, songs: [] };
    const songs = await context.songIndex.listForAlbumKeys(scope, [key], context.albumsFor(library).grouping);
    return { dirPath: representativeDir(songs), songs };
  }
  if (kind === IdKind.Album) {
    const songs = await context.songs.listByAlbumDir(library.id, path);
    return { dirPath: path, songs };
  }
  if (kind === IdKind.Directory) {
    const songs = await context.songs.listByDirectory(library.id, path);
    return { dirPath: path, songs };
  }
  return { dirPath: null, songs: [] };
}

/**
 * The folder to look for a sidecar cover in, for any album, song or directory id.
 * Artist ids never reach here — see `artistCover`.
 */
async function resolveCoverFolder(
  library: LibraryRow,
  kind: IdKindValue,
  path: string,
  albumDir: string | null,
  context: RestContext,
): Promise<string | null> {
  if (kind === IdKind.Song) {
    const song = await context.songs.findByPath(library.id, path);
    return song ? await findCoverIn(library, song.dir_path, context) : null;
  }
  if (albumDir !== null) return await findCoverIn(library, albumDir, context);
  return null;
}

export { getCoverArt };
