/**
 * Shared cover-art primitives: the placeholder, the sidecar fetch, and the
 * embedded-tags probe.
 *
 * Split from `coverArt.ts` because that module passed the god-file guard only
 * until artist covers needed an embedded fallback too — one more branch put it
 * over 400 lines. The split is by caller: this holds what the album path and
 * the artist path both use, `coverArt.ts` holds the album/song/directory route,
 * and `artistCover.ts` holds the artist route.
 */
import { embeddedAlbumArt, TreeService } from '@edge-sonic/backend-services/index';
import type { ResolvedArt } from '@edge-sonic/backend-services/index';
import type { LibraryRow, SongRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';
import { compareAlbumTracks } from '../albumIdentity';
import type { PassthroughResponse } from './media';
import { passthrough } from './media';

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * A 1×1 transparent PNG, for "this album has no cover".
 *
 * A **valid** image on purpose. Every client has a placeholder path for "artwork did not
 * load", and that path is reached by a decodable image — so this is the answer that
 * renders as a blank tile rather than as a broken-image icon.
 */
const PLACEHOLDER_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
);

/**
 * How many song rows an artist cover request will consider.
 *
 * A bound because the artist page is `SELECT *` over every track by that artist — a page
 * size of 500 on an artist with 5,000 tracks is not a cover lookup, it is a table fetch.
 */
const ARTIST_COVER_ROW_LIMIT = 500;

/**
 * How many album directories one artist cover request will `PROPFIND`.
 *
 * Sampled, not exhaustive: a client draws one cover per artist row, so probing every
 * album of a 30-album artist is 30 subrequests per row drawn, against a
 * 50-external-subrequest ceiling for the whole invocation on the Free plan.
 */
const ARTIST_COVER_PROBE_LIMIT = 3;

/**
 * How many of an album's tracks the embedded-artwork path will read.
 *
 * Real libraries have albums where the picture is on some files and not others, so one
 * track is not enough, and a compilation with none of them is not worth more than three
 * ranged reads to discover.
 */
const ALBUM_ART_TRACK_LIMIT = 3;

/**
 * What an id resolves to for artwork purposes: the folder to probe, and the rows.
 *
 * One resolution for both halves rather than one for the sidecar and one for the embedded
 * picture, so a merged album spanning directories cannot answer differently depending on
 * which branch ran.
 */
interface AlbumTarget {
  readonly dirPath: string | null;
  readonly songs: readonly SongRow[];
}

/**
 * The 1×1 transparent PNG, as a response.
 */
function placeholderImage(): Response {
  return new Response(PLACEHOLDER_PNG, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
}

/**
 * Fetch a cover file from the origin and answer with its bytes.
 *
 * A failure answers with the placeholder rather than propagating: a cover endpoint
 * that answers JSON hands the client a body its image decoder cannot read, with no
 * diagnostic anywhere.
 */
async function forwardCoverFile(library: LibraryRow, folder: string, context: RestContext): Promise<PassthroughResponse> {
  const client = await context.libraries.clientFor(library);
  let upstream: Response;
  try {
    upstream = await client.get(folder, { timeoutMs: context.streamTimeoutMs });
  } catch {
    return { response: placeholderImage() };
  }
  if (!upstream.ok) return { response: placeholderImage() };

  const response = passthrough(upstream);
  const declared = response.headers.get('content-type');
  if (declared === null || declared === 'application/octet-stream') {
    const byExtension = IMAGE_CONTENT_TYPES[folder.slice(folder.lastIndexOf('.') + 1).toLowerCase()];
    if (byExtension) response.headers.set('content-type', byExtension);
  }
  response.headers.set('Cache-Control', 'public, max-age=86400');
  return { response };
}

/**
 * The folder a group's artwork is looked for in: the first track's, in protocol order.
 *
 * `compareAlbumTracks` is `getAlbum`'s own ordering, so the folder chosen is the folder of the
 * track a client calls track 1. An unstable choice would write the KV entry under a key that
 * stops matching.
 */
function representativeDir(songs: readonly SongRow[]): string | null {
  const first = [...songs].sort(compareAlbumTracks)[0];
  return first?.dir_path ?? null;
}

/**
 * Artwork from the album's own tracks.
 *
 * `null` is an ordinary answer, not a failure: no song rows, no picture on any probed track, or
 * an origin that could not be read.
 */
async function embeddedArtFor(target: AlbumTarget, library: LibraryRow, context: RestContext): Promise<ResolvedArt | null> {
  if (target.dirPath === null || target.songs.length === 0) return null;

  // Deterministic order, and it is load-bearing: the cache key is built from the
  // tracks probed, so an unstable order means the cache never hits.
  const candidates = [...target.songs]
    .sort(compareAlbumTracks)
    .slice(0, ALBUM_ART_TRACK_LIMIT)
    .map((song) => ({ id: song.id, path: song.path, size: song.size, mtimeMs: song.mtime_ms }));

  const stub = context.mediaStubFor(library.id);
  if (stub) {
    return await stub.coverArt(library.id, target.dirPath, candidates, context.streamTimeoutMs);
  }
  return await embeddedAlbumArt(library, target.dirPath, candidates, { clientFor: (row) => context.libraries.clientFor(row), cache: context.cache }, context.streamTimeoutMs);
}

/**
 * Sidecar probe, then embedded tags, then the placeholder.
 */
async function coverForSongs(library: LibraryRow, songs: readonly SongRow[], dirPath: string | null, context: RestContext): Promise<PassthroughResponse> {
  const folder = dirPath === null ? null : await findCoverIn(library, dirPath, context).catch(() => null);
  return await coverForTarget(library, { dirPath, songs }, folder, context);
}

async function coverForTarget(library: LibraryRow, target: AlbumTarget, folder: string | null, context: RestContext): Promise<PassthroughResponse> {
  if (folder !== null) {
    return await forwardCoverFile(library, folder, context);
  }

  const embedded = await embeddedArtFor(target, library, context);
  if (embedded !== null) {
    return {
      response: new Response(embedded.data.slice(), {
        status: 200,
        headers: { 'Content-Type': embedded.mimeType, 'Cache-Control': 'public, max-age=86400' },
      }),
    };
  }

  return { response: placeholderImage() };
}

async function findCoverIn(library: LibraryRow, dirPath: string, context: RestContext): Promise<string | null> {
  const { children } = await context.tree.children(library, dirPath);
  const cover = TreeService.findCover(children);
  return cover === null ? null : cover.path;
}

export {
  IMAGE_CONTENT_TYPES,
  ARTIST_COVER_ROW_LIMIT,
  ARTIST_COVER_PROBE_LIMIT,
  ALBUM_ART_TRACK_LIMIT,
  placeholderImage,
  forwardCoverFile,
  representativeDir,
  embeddedArtFor,
  coverForSongs,
  coverForTarget,
  findCoverIn,
};
export type { AlbumTarget };
