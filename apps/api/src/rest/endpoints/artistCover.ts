/**
 * An artist's cover: the representative album's art.
 *
 * An artist id names a group, not a folder, so its cover spans several folders where an
 * album id names one. Order is sidecar album probes, then the artist directory, then
 * embedded tags — with a missing folder caught before it can mask the embedded picture.
 *
 * An artist with rows but no art anywhere answers the placeholder, like an album with
 * no art. An artist with no rows at all answers `code=70`, like `getArtist` does for
 * the same id.
 */
import { ErrorCode, SubsonicError } from '@edge-sonic/subsonic';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { artistNameOf } from '../mappers';
import type { PassthroughResponse } from './media';
import {
  ARTIST_COVER_PROBE_LIMIT,
  ARTIST_COVER_ROW_LIMIT,
  coverForTarget,
  findCoverIn,
  forwardCoverFile,
  representativeDir,
} from './coverArtShared';

async function artistCover(libraries: readonly LibraryRow[], artistName: string, context: RestContext): Promise<PassthroughResponse> {
  const library = libraries[0];
  const scope = libraries.map((row) => row.id);
  const wanted = artistName.toLowerCase();
  const rows = await context.songIndex.listArtists(scope, ARTIST_COVER_ROW_LIMIT, 0);
  // Same grouping as `getArtist`: a path-derived name still names the artist.
  const mine = rows.filter((row) => (row.artist ?? artistNameOf(row)).toLowerCase() === wanted);

  if (mine.length === 0) {
    // No indexed tracks: the artist folder is the only thing left that could answer.
    const slash = artistName.indexOf('/');
    const dir = slash === -1 ? artistName : artistName.slice(0, slash);
    try {
      const found = await findCoverIn(library, dir, context);
      if (found !== null) return await forwardCoverFile(library, found, context);
    } catch {
      throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');
    }
    throw new SubsonicError(ErrorCode.NotFound, 'Artist not found.');
  }

  // One probe per album directory, bounded. A missing directory is skipped, not fatal.
  const probed = new Set<string>();
  for (const row of mine) {
    if (probed.has(row.dir_path)) continue;
    if (probed.size >= ARTIST_COVER_PROBE_LIMIT) break;
    probed.add(row.dir_path);
    try {
      const found = await findCoverIn(library, row.dir_path, context);
      if (found !== null) return await forwardCoverFile(library, found, context);
    } catch {
      continue;
    }
  }

  // The artist directory, for libraries that keep `artist.jpg` beside the albums.
  // Missing is ordinary here, so it is swallowed — unlike the no-rows case above.
  const slash = artistName.indexOf('/');
  const artistDir = slash === -1 ? artistName : artistName.slice(0, slash);
  let artistFolder: string | null = null;
  try {
    artistFolder = await findCoverIn(library, artistDir, context);
  } catch {
    artistFolder = null;
  }
  if (artistFolder !== null) return await forwardCoverFile(library, artistFolder, context);

  // No sidecar anywhere: try the representative album's embedded tags before the placeholder.
  return await coverForTarget(library, { dirPath: representativeDir(mine), songs: mine }, null, context);
}

export { artistCover };
