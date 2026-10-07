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
import { decodeAlbumKey, decodeId, IdKind } from '@edge-sonic/subsonic';
import type { IdKindValue } from '@edge-sonic/subsonic';
import type { LibraryRow, LibraryScope, SongRow } from '@edge-sonic/backend-data/dao';
import { librariesForId } from './libraries';
import { embeddedAlbumArt, TreeService } from '@edge-sonic/backend-services/index';
import type { ResolvedArt } from '@edge-sonic/backend-services/index';
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
  // Song fast path, before any decode: short ids carry no library or path to
  // decode, and legacy song ids for rotated rows no longer match their row's
  // id either. The row has both, so it resolves either form.
  const song = await context.songs.findBySongId(id);
  if (song) {
    const library = await context.libraries.requireForUser(context.user.id, song.library_id);
    context.libraries.assertReachable(library);
    return await coverForSongs(library, [song], song.dir_path, context);
  }
  // The prefix is not checked here: `getCoverArt` legitimately accepts a song, an album, an
  // artist, or a directory id, and all of them resolve to a folder.
  const decoded = decodeId(id);
  // **The path guard is on the path-shaped kinds only.** An album-key payload is base64url
  // segments and is never used as a path, so asserting it against `assertPath` would be a check
  // against the wrong thing — and skipping it for the folder kinds would leave a traversal
  // reachable through the directory branch.
  if (decoded.kind !== IdKind.AlbumKey) TreeService.assertPath(decoded.path);
  // `librariesForId`, not `requireForUser`: an album or artist id carries the sentinel, because
  // it names a group rather than one library, and asking for a library by that id would refuse
  // the cover of every album on a multi-library user. The union it returns is still only the
  // caller's grants, so the id names nothing invisible.
  const libraries = await librariesForId(context, decoded.libraryId);
  const library = libraries[0];
  context.libraries.assertReachable(library);

  // Resolved once and used by both branches, so the sidecar probe and the embedded probe
  // cannot be looking at different albums. See `AlbumTarget`.
  const target =
    decoded.kind === IdKind.Artist ? { dirPath: null, songs: [] } : await albumTargetFor(library, libraries.map((row) => row.id), decoded.kind, decoded.path, context);

  const folder = await resolveCoverFolder(library, decoded.kind, decoded.path, target.dirPath, context);
  return await coverForTarget(library, target, folder, context);
}

/**
 * Sidecar probe, then embedded tags, then the placeholder — the shared tail
 * for the song fast path above and the decoded album/artist/directory path.
 */
async function coverForSongs(library: LibraryRow, songs: readonly SongRow[], dirPath: string | null, context: RestContext): Promise<PassthroughResponse> {
  const folder = dirPath === null ? null : await findCoverIn(library, dirPath, context).catch(() => null);
  return await coverForTarget(library, { dirPath, songs }, folder, context);
}

async function coverForTarget(library: LibraryRow, target: AlbumTarget, folder: string | null, context: RestContext): Promise<PassthroughResponse> {
  if (folder !== null) {
    return await forwardCoverFile(library, folder, context);
  }

  // No sidecar. Before falling back to the placeholder, try the album's own tags.
  const embedded = await embeddedArtFor(target, library, context);
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
 * What an id resolves to for artwork purposes: the folder to probe, and the album's rows.
 *
 * One resolution for both halves rather than one for the sidecar and one for the embedded
 * picture, and the reason is a merged album. Under a tag grouping an album spans directories, so
 * resolving the folder and then re-reading *that folder's* rows would probe one disc of a
 * two-disc release and answer "no artwork" for an album whose second disc carries the picture.
 * The two answers have to come from the same set of rows or the endpoint contradicts itself
 * depending on which branch ran.
 */
interface AlbumTarget {
  readonly dirPath: string | null;
  readonly songs: readonly SongRow[];
}

/**
 * The album an id names, its rows and the folder its artwork is found in.
 *
 * `IdKind.AlbumKey` is the current form and resolves through the grouping key; `IdKind.Album` is
 * the folder form this server minted before an album's identity became configurable, and both
 * arrive in clients. A song id resolves through its own row, and an artist id through its
 * directory — see `resolveCoverFolder` for the artist case, which is not this function's problem.
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
    // A folder id names a directory, so that directory is the folder probed even when the
    // album now spans others — a pre-existing star points at this album, and the sidecar
    // beside the tracks it was starred from is the one the user saw.
    return { dirPath: path, songs };
  }
  if (kind === IdKind.Directory) {
    const songs = await context.songs.listByDirectory(library.id, path);
    return { dirPath: path, songs };
  }
  return { dirPath: null, songs: [] };
}

/**
 * The folder a group's artwork is looked for in: the first track's, in protocol order.
 *
 * A tag-grouped album spans directories and there is no answer right for all of them — a
 * release with `cover.jpg` beside disc 1 and embedded art on disc 2 has art in two places. One
 * folder is chosen, deterministically, and the alternative, probing each until one has art,
 * spends a `PROPFIND` or a ranged read per directory on a request a client makes **per grid
 * cell** — the arithmetic `ARTIST_COVER_PROBE_LIMIT` exists to bound one layer up.
 *
 * `compareAlbumTracks` is `getAlbum`'s own ordering, so the folder chosen is the folder of the
 * track a client calls track 1. An unstable choice would write the KV entry under a key that
 * stops matching: the cache never hits and two clients can be shown different covers for one
 * album.
 */
function representativeDir(songs: readonly SongRow[]): string | null {
  const first = [...songs].sort(compareAlbumTracks)[0];
  return first?.dir_path ?? null;
}

/**
 * Artwork from the album's own tracks, for any accepted id kind.
 *
 * `null` is an ordinary answer, not a failure: no song rows, no picture on any probed track, or
 * an origin that could not be read.
 */
async function embeddedArtFor(target: AlbumTarget, library: LibraryRow, context: RestContext): Promise<ResolvedArt | null> {
  if (target.dirPath === null || target.songs.length === 0) return null;

  // **Deterministic order, and it is load-bearing.** The cache key is built from the
  // tracks this probes and the first one carrying a picture is the one that answers, so an
  // unstable order means the same album resolves to different bytes on different requests, the
  // cache never hits, and two clients can be shown different covers for one album.
  // `compareAlbumTracks` — disc, then track, then name — is `getAlbum`'s own ordering, so the
  // picture comes from the file a client would call track 1. It used to be track and name with
  // no disc, which matched a `getAlbum` that also had no disc: both wrong together, and both
  // picked disc 2's first track out of a two-disc album.
  const candidates = [...target.songs]
    .sort(compareAlbumTracks)
    .slice(0, ALBUM_ART_TRACK_LIMIT)
    .map((song) => ({ id: song.id, path: song.path, size: song.size, mtimeMs: song.mtime_ms }));

  // Through the **media** object, not the scan's, and this endpoint is where that
  // matters most: it is the one request a client makes once per grid cell, it holds a
  // `streamTimeoutMs` of 30 s, and a Durable Object handles one event at a time. Resolving
  // the scan stub would spend up to `SCAN_CHUNK_DEADLINE_MS` of that budget waiting for
  // whatever chunk the library's scan happened to be running.
  const stub = context.mediaStubFor(library.id);
  if (stub) {
    return await stub.coverArt(library.id, target.dirPath, candidates, context.streamTimeoutMs);
  }
  return await embeddedAlbumArt(library, target.dirPath, candidates, { clientFor: (row) => context.libraries.clientFor(row), cache: context.cache }, context.streamTimeoutMs);
}

/**
 * The folder to look for a sidecar cover in, for any accepted id kind.
 *
 * `albumDir` is the folder {@link albumTargetFor} already resolved, passed in rather than
 * recomputed: this runs *after* the target is resolved, and a second resolution would spend the
 * same statement twice on a request a client makes per grid cell.
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
  // Every kind whose id resolves to a folder: an album key, a legacy album directory, and a
  // directory id. One branch rather than three, because the folder is the same answer for all
  // three and a folder id and an album id disagreeing here would be a bug with no symptom
  // until a cover failed to load.
  if (albumDir !== null) return await findCoverIn(library, albumDir, context);
  if (kind !== IdKind.Artist) return null;
  {
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
}

async function findCoverIn(library: LibraryRow, dirPath: string, context: RestContext): Promise<string | null> {
  const { children } = await context.tree.children(library, dirPath);
  const cover = TreeService.findCover(children);
  return cover === null ? null : cover.path;
}

export { getCoverArt };
