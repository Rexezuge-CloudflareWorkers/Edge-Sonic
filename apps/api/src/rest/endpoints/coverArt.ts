/**
 * `getCoverArt` — an album, artist or song's cover image.
 *
 * Split from `media.ts` because cover art is the one media endpoint that is not a
 * passthrough. `stream` and `download` forward bytes the origin already holds; this one
 * *finds* a picture that may not exist as a file at all, which is a different shape of
 * problem and a different set of ways to be wrong.
 *
 * ### A picture can be in two places, and the second one used to not exist
 *
 * A sidecar image next to the tracks, and a picture **inside** a track's tags. The first
 * is what `resolveCoverFolder` looks for, and it is still tried first so a library that
 * has both gets the sidecar — which is also the cheaper answer, because the sidecar is
 * resolved from D1 while the embedded path spends ranged reads on the origin.
 *
 * The second is the common case and used to be answered with a 1×1 transparent PNG.
 * Picard, beets, Metaflac, `ffmpeg` and every ripped disc embed the picture, and most
 * people never also drop a `cover.jpg` beside the tracks. So for such a library the name
 * lookup found nothing and the endpoint served `PLACEHOLDER_PNG`: a **valid** 70-byte
 * 1×1 transparent PNG, `200`, `image/png`. The client decoded an image, cached it, and
 * drew a transparent pixel — and because a transparent pixel and a network fault are the
 * same observation from outside, it presented as "no cover image can be loaded" rather
 * than as a failure, and no log line anywhere would have named it.
 *
 * `embeddedArtFor` reads the picture out of the album's own tracks.
 *
 * ### This endpoint never speaks the Subsonic envelope
 *
 * Everything else on `/rest` answers in the protocol envelope because a client parsing
 * that surface has no way to interpret anything else. **This one is consumed as an
 * image**, so the envelope is not a lesser dialect here — it is simply the wrong shape.
 * A `404` from the origin on the cover `GET` used to throw, be classified by
 * `toSubsonicError`, and come back as a masked `200 application/json`: the client handed
 * that to an image decoder, it failed, and the only evidence was a client-side log line.
 * So an unreachable cover is the placeholder, and there is no failure path here that
 * produces JSON.
 *
 * ### `size` is ignored
 *
 * Resizing needs an image decoder and this server has none. Sending the original is
 * honest, and a client that asked for 300px can scale it; claiming to have resized while
 * sending the original would be a lie with more steps. Embedded art makes the cost more
 * visible than a sidecar did — a 1 MB JPEG where a sidecar might be 50 KB — so the
 * extracted bytes are cached in KV under a 30-day TTL, which holds it to roughly one
 * origin read per album per client per month.
 */
import { decodeId, encodeId, IdKind } from '@edge-sonic/subsonic';
import type { IdKindValue } from '@edge-sonic/subsonic';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { embeddedAlbumArt, TreeService } from '@edge-sonic/backend-services/index';
import type { ResolvedArt } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
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
 * renders as a blank tile rather than as a broken-image icon. The trade is stated rather
 * than assumed: a client that caches it will not re-ask, so artwork appearing later is
 * invisible until it evicts. That is why the *extracted* bytes are cached under a key
 * that goes stale when the file does, while this stays a constant.
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
 * The probe limit below is what actually caps the outbound requests; this one only caps
 * the rows read to find candidate directories.
 */
const ARTIST_COVER_ROW_LIMIT = 500;

/**
 * How many album directories one artist cover request will `PROPFIND`.
 *
 * Sampled, not exhaustive, and the reason is arithmetic rather than taste: a client
 * draws one cover per album row, so probing every album of a 30-album artist is 30
 * subrequests per row drawn, against a 50-external-subrequest ceiling for the whole
 * invocation on the Free plan. Missing art renders the placeholder every client already
 * handles.
 */
const ARTIST_COVER_PROBE_LIMIT = 3;

/**
 * How many of an album's tracks the embedded-artwork path will read.
 *
 * The same shape as {@link ARTIST_COVER_PROBE_LIMIT} and for the same reason: real
 * libraries have albums where the picture is on some files and not others, so one track
 * is not enough, and a compilation with none of them is not worth more than three ranged
 * reads to discover.
 */
const ALBUM_ART_TRACK_LIMIT = 3;

async function getCoverArt(context: RestContext): Promise<PassthroughResponse> {
  const id = context.params.require('id');
  // The prefix is not checked here: `getCoverArt` legitimately accepts a song, an
  // album, an artist, or a directory id, and all four resolve to a folder.
  const decoded = decodeId(id);
  TreeService.assertPath(decoded.path);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  context.libraries.assertReachable(library);

  const folder = await resolveCoverFolder(library, decoded.kind, decoded.path, context);
  if (folder !== null) {
    return await forwardCoverFile(library, folder, context);
  }

  // No sidecar. Before falling back to the placeholder, try the album's own tags.
  const embedded = await embeddedArtFor(library, decoded.kind, decoded.path, context);
  if (embedded !== null) {
    return {
      // `slice()`, not the view itself: the bytes are usually a window onto a much larger
      // read buffer, and handing a `Response` a view would keep all of it alive for as
      // long as the client takes to download a cover.
      response: new Response(embedded.data.slice(), {
        status: 200,
        headers: { 'Content-Type': embedded.mimeType, 'Cache-Control': 'public, max-age=86400' },
      }),
    };
  }

  return { response: placeholderImage() };
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
 * A failure answers with the placeholder rather than propagating, and that is the whole
 * reason this function exists separately from the happy path. See the module note: a
 * cover endpoint that answers JSON is wrong in a way nothing reports.
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
  // The origin's `Content-Type` for an image is reliable, but a WebDAV server that reports
  // `application/octet-stream` for a JPEG would make some clients refuse to decode it.
  // The extension is the better signal here.
  const declared = response.headers.get('content-type');
  if (declared === null || declared === 'application/octet-stream') {
    const byExtension = IMAGE_CONTENT_TYPES[folder.slice(folder.lastIndexOf('.') + 1).toLowerCase()];
    if (byExtension) response.headers.set('content-type', byExtension);
  }
  // Cover art is immutable per album revision, so it is the one media response that is
  // cacheable by a shared cache.
  response.headers.set('Cache-Control', 'public, max-age=86400');
  return { response };
}

/**
 * Artwork from the album's own tracks, for any accepted id kind.
 *
 * Resolves the id to an album directory the way `resolveCoverFolder` does, then hands
 * that directory's tracks to the extractor. `null` is an ordinary answer, not a failure:
 * no song rows, no picture on any probed track, or an origin that could not be read.
 */
async function embeddedArtFor(library: LibraryRow, kind: IdKindValue, path: string, context: RestContext): Promise<ResolvedArt | null> {
  const dirPath = await albumDirFor(library, kind, path, context);
  if (dirPath === null) return null;

  const songs = await context.songs.listByAlbumDir(library.id, dirPath);
  if (songs.length === 0) return null;

  // **Deterministic order, and it is load-bearing.** The cache key is built from the
  // tracks this probes and the first one carrying a picture is the one that answers, so an
  // unstable order means the same album resolves to different bytes on different requests,
  // the cache never hits, and two clients can be shown different covers for one album.
  // Track number then name, matching `getAlbum`'s own ordering — so the picture comes from
  // the file a client would call track 1.
  const candidates = [...songs]
    .sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999) || a.name.localeCompare(b.name))
    .slice(0, ALBUM_ART_TRACK_LIMIT)
    .map((song) => ({ id: song.id, path: song.path, size: song.size, mtimeMs: song.mtime_ms }));

  // With the `SCAN` binding the picture parse runs in the library's DO isolate;
  // without it the direct extractor runs in-fetch, which is the path the suite
  // exercises.
  const stub = context.scanStubFor(library.id);
  if (stub) {
    return await stub.coverArt(library.id, dirPath, candidates, context.streamTimeoutMs);
  }
  return await embeddedAlbumArt(library, dirPath, candidates, { clientFor: (row) => context.libraries.clientFor(row), cache: context.cache }, context.streamTimeoutMs);
}

/**
 * The album directory an id refers to, for artwork purposes.
 *
 * Deliberately simpler than `resolveCoverFolder`: the artist case is not re-probed across
 * several album directories here, because that loop already spent up to three
 * `PROPFIND`s and this runs *after* it. A cover request is one a client makes per grid
 * cell, so the subrequest count is the number that has to stay small.
 */
async function albumDirFor(library: LibraryRow, kind: IdKindValue, path: string, context: RestContext): Promise<string | null> {
  if (kind === IdKind.Album || kind === IdKind.Directory) return path;
  if (kind === IdKind.Song) {
    const song = await context.songs.findById(encodeId(IdKind.Song, library.id, path));
    return song?.dir_path ?? null;
  }
  if (kind === IdKind.Artist) {
    // An artist id carries a name, not a path. The artist *directory* is the cheap guess
    // and it is right for the overwhelmingly common `Artist/Album` layout; when it holds
    // no tracks the answer is "no artwork", which the placeholder renders.
    const slash = path.indexOf('/');
    return slash === -1 ? path : path.slice(0, slash);
  }
  return null;
}

/**
 * The folder to look for a sidecar cover in, for any accepted id kind.
 */
async function resolveCoverFolder(library: LibraryRow, kind: IdKindValue, path: string, context: RestContext): Promise<string | null> {
  if (kind === IdKind.Song) {
    const song = await context.songs.findById(encodeId(IdKind.Song, library.id, path));
    return song ? await findCoverIn(library, song.dir_path, context) : null;
  }
  if (kind === IdKind.Album) return await findCoverIn(library, path, context);
  if (kind === IdKind.Directory) return await findCoverIn(library, path, context);
  if (kind === IdKind.Artist) {
    // An artist id carries the artist *name*, not a path, so the folder has to be found.
    // Albums are searched first, because that is where the cover lives, and the artist
    // directory is the fallback for a library that keeps one.
    const rows = await context.songIndex.listArtists(library.id, ARTIST_COVER_ROW_LIMIT, 0);

    // One probe per *album directory*, not per song row. The artist page returns every song
    // on it, so an artist with 300 tracks in 30 albums was 300 `findCoverIn` calls — each a
    // D1 read or a live `PROPFIND` — to look for one image. A `Set` over the directories
    // collapses that to at most 30, and the `take` bounds it at a handful so a compilation
    // cannot spend a whole budget of requests on a cover that is not there.
    //
    // The first album is not necessarily the one with art, so this is a *sample*, and the
    // directory fallback below covers the rest.
    const wanted = path.toLowerCase();
    const probed = new Set<string>();
    for (const row of rows) {
      if (((row.artist ?? row.album_artist ?? '').toLowerCase() !== wanted) || probed.has(row.dir_path)) continue;
      if (probed.size >= ARTIST_COVER_PROBE_LIMIT) break;
      probed.add(row.dir_path);
      const found = await findCoverIn(library, row.dir_path, context);
      if (found !== null) return found;
    }
    const slash = path.indexOf('/');
    return await findCoverIn(library, slash === -1 ? path : path.slice(0, slash), context);
  }
  return null;
}

async function findCoverIn(library: LibraryRow, dirPath: string, context: RestContext): Promise<string | null> {
  const { children } = await context.tree.children(library, dirPath);
  const cover = TreeService.findCover(children);
  return cover === null ? null : cover.path;
}

export { getCoverArt, PLACEHOLDER_PNG, IMAGE_CONTENT_TYPES, ARTIST_COVER_PROBE_LIMIT, ALBUM_ART_TRACK_LIMIT };
