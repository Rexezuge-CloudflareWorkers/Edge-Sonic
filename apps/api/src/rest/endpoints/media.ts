/**
 * Media retrieval: `stream`, `download`, `getCoverArt`.
 *
 * ### No transcoding, and no pretending
 *
 * Edge-Sonic does not transcode. `format=mp3` and `maxBitRate=128` are **ignored**,
 * and the original bytes are streamed with the file's real `Content-Type`.
 *
 * That is a deliberate choice over the obvious alternative. Many clients send
 * `maxBitRate` unconditionally, so a server that honours it must transcode; a
 * server that does not must still answer. The failure mode to avoid is answering
 * with `Content-Type: audio/mpeg` and FLAC bytes: some players will "play" a file
 * that is not decodable as the declared type, which is worse than a large file.
 * A truthful passthrough plays; a lie does not.
 *
 * ### The body is never touched
 *
 * `stream` forwards the client's `Range` and returns the upstream `Response`
 * **unmodified** — no buffering, no re-chunking, no content rewriting. Seeking is
 * how every Subsonic client skips a track, and a `206` has to stay a `206` with its
 * `Content-Range` intact. This is the one endpoint where "don't be clever" is the
 * entire implementation.
 */
import { decodeId, encodeId, ErrorCode, IdKind, SubsonicError } from '@edge-sonic/subsonic';
import type { IdKindValue } from '@edge-sonic/subsonic';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import { guessContentType } from '../mappers';

type PassthroughResponse = { response: Response };

/**
Response headers forwarded from the origin. Everything else is dropped.
*/
const PASSTHROUGH_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'] as const;

/**
 * Rebuild a response with only the allowlisted headers.
 *
 * Rebuilding rather than mutating: a `Response` from `fetch` has immutable headers
 * in Workers, and mutating one throws. Hop-by-hop headers (`connection`,
 * `transfer-encoding`, `keep-alive`) and the origin's own CORS headers are dropped
 * so a cached or replayed response cannot re-introduce this server's CORS policy
 * from a different origin.
 */
function passthrough(upstream: Response): Response {
  const headers = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The origin's own `Content-Type` wins when it is a real media type; otherwise
  // the indexed suffix decides. See the module note on not lying.
  if (!headers.has('content-type') || headers.get('content-type') === 'application/octet-stream') {
    headers.delete('content-type');
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/**
 * Resolve a song id to its library, row, and path.
 *
 * The path comes from the **ID**, not from a `songs` row lookup — that is what
 * makes the ID scheme reversible and keeps the hot path off the database. The row is
 * still read, for two reasons that are not optional:
 *
 * 1. `Content-Type` and `Content-Length` come from the index rather than from
 *    trusting the origin's header for a file we never checked;
 * 2. the existence check is what makes a forged ID harmless. Without it, a crafted
 *    `s:<b64url(libA|any/path)>` would stream any readable path in that library.
 */
async function resolveSong(context: RestContext, expectedKind: IdKindValue) {
  const id = context.params.require('id');
  const decoded = decodeId(id, expectedKind);
  TreeService.assertPath(decoded.path);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  context.libraries.assertReachable(library);

  const song = await context.songs.findById(id);
  if (!song || song.path !== decoded.path) {
    // Either the id does not exist, or it names a path this library has not
    // indexed. Both are `code=70`.
    throw new SubsonicError(ErrorCode.NotFound, 'Media not found.');
  }
  return { id, decoded, library, song };
}

/**
 * `stream` — the audio, with `Range` support.
 *
 * The `Range` header is forwarded **verbatim**, including multi-range forms, because
 * re-deriving it would mean parsing a header whose whole purpose is to be passed
 * through. `estimateContentLength` is deliberately not set: with no transcoding
 * there is nothing to estimate, and a wrong value makes a player seek to the wrong
 * byte.
 */
async function stream(context: RestContext): Promise<PassthroughResponse> {
  const { decoded, library, song } = await resolveSong(context, IdKind.Song);
  const client = await context.libraries.clientFor(library);
  const range = context.params.get('range') ?? headerRange(context);

  const upstream = await client.get(decoded.path, {
    ...(range !== null && range.length > 0 && { range }),
    timeoutMs: context.streamTimeoutMs,
  });

  const response = passthrough(upstream);
  if (!response.headers.has('content-type')) {
    response.headers.set('content-type', song.content_type ?? guessContentType(song.suffix));
  }
  return { response };
}

/**
 * `download` — the same bytes, as an attachment.
 *
 * A separate endpoint because a client must be able to fetch a file *without*
 * seeking it, and because the `Content-Disposition` lets a browser save it under
 * its real name rather than the song id.
 */
async function download(context: RestContext): Promise<PassthroughResponse> {
  const { decoded, library, song } = await resolveSong(context, IdKind.Song);
  const client = await context.libraries.clientFor(library);
  const upstream = await client.get(decoded.path, { timeoutMs: context.streamTimeoutMs });

  const response = passthrough(upstream);
  if (!response.headers.has('content-type')) {
    response.headers.set('content-type', song.content_type ?? guessContentType(song.suffix));
  }
  // RFC 6266, and the escaping matters because the name is a **WebDAV filename**: it is
  // whatever anybody with write access to the library chose, and it reaches a browser.
  //
  // Three separate problems, three separate replacements:
  //
  // - `"` would break out of the quoted-string.
  // - CR and LF would split the header.
  // - `/` and `\\` would put a **path** in the filename. `a";b/../../evil.flac` is a
  //   legal WebDAV entry name, and quoting it does nothing: some browsers and download
  //   managers resolve the separators, so the file lands outside the download directory.
  //   The separators are replaced rather than the whole name rejected, because a
  //   directory that happens to contain a slash in a display name should still download.
  // eslint-disable-next-line no-control-regex -- the control characters ARE the check.
  const safeName = song.name.replaceAll(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_');
  response.headers.set('content-disposition', `attachment; filename="${safeName}"`);
  return { response };
}

/**
 * `getCoverArt` — an album, artist, or song's cover image.
 *
 * The id may be any of the three, so the folder is resolved first and the probe
 * order is fixed (`cover`, `folder`, `front`, …). A request for a song id resolves
 * to that song's *album* directory, which is why a client can pass whatever id it
 * happens to be holding.
 *
 * `size` is **ignored**. Resizing needs an image decoder, and this server has none;
 * sending the original is honest, and a client that asked for 300px can scale it.
 * Claiming to have resized while sending the original would just be a lie with more
 * steps.
 */
async function getCoverArt(context: RestContext): Promise<PassthroughResponse> {
  const id = context.params.require('id');
  // The prefix is not checked here: `getCoverArt` legitimately accepts a song, an
  // album, an artist, or a directory id, and all four resolve to a folder.
  const decoded = decodeId(id);
  TreeService.assertPath(decoded.path);
  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  context.libraries.assertReachable(library);

  const folder = await resolveCoverFolder(library, decoded.kind, decoded.path, context);
  if (folder === null) {
    // A missing cover is `404` with a tiny generated image rather than a Subsonic
    // error: every client has a placeholder path for "artwork did not load", and a
    // protocol envelope would be written into an `<img>` tag.
    return { response: new Response(PLACEHOLDER_PNG, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } }) };
  }

  const client = await context.libraries.clientFor(library);
  const upstream = await client.get(folder, { timeoutMs: context.streamTimeoutMs });
  const response = passthrough(upstream);
  // The origin's `Content-Type` for an image is reliable, but a WebDAV server that
  // reports `application/octet-stream` for a JPEG would make some clients refuse to
  // decode it. The extension is the better signal here.
  const declared = response.headers.get('content-type');
  if (declared === null || declared === 'application/octet-stream') {
    const byExtension = IMAGE_CONTENT_TYPES[folder.slice(folder.lastIndexOf('.') + 1).toLowerCase()];
    if (byExtension) response.headers.set('content-type', byExtension);
  }
  // Cover art is immutable per album revision, so it is the one media response that
  // is cacheable by a shared cache.
  response.headers.set('Cache-Control', 'public, max-age=86400');
  return { response };
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
A 1×1 transparent PNG, for "this album has no cover".
*/
const PLACEHOLDER_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
);

/**
The folder to look for a cover in, for any accepted id kind.
*/
async function resolveCoverFolder(library: LibraryRow, kind: IdKindValue, path: string, context: RestContext): Promise<string | null> {
  if (kind === IdKind.Song) {
    const song = await context.songs.findById(encodeId(IdKind.Song, library.id, path));
    return song ? (await findCoverIn(library, song.dir_path, context)) : null;
  }
  if (kind === IdKind.Album) return await findCoverIn(library, path, context);
  if (kind === IdKind.Directory) return await findCoverIn(library, path, context);
  if (kind === IdKind.Artist) {
    // An artist id carries the artist *name*, not a path, so the folder has to be
    // found. Albums are searched first, because that is where the cover lives, and
    // the artist directory is the fallback for a library that keeps one.
    const rows = await context.songIndex.listArtists(library.id, 500, 0);
    for (const row of rows) {
      if ((row.artist ?? row.album_artist ?? '').toLowerCase() !== path.toLowerCase()) continue;
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

/**
 * `Range` from the HTTP header, for the clients that send it there.
 *
 * The Subsonic protocol has **no** `range` parameter — clients set the header — so
 * this is the primary source, with the `range` query parameter accepted as a
 * fallback for the few clients that send it there. Either way the value is
 * forwarded untouched, because re-deriving it means parsing a header whose entire
 * purpose is to be passed through.
 */
function headerRange(context: RestContext): string | null {
  const fromQuery = context.params.get('range');
  if (fromQuery !== undefined && fromQuery.length > 0) return fromQuery;
  const fromHeader = context.request.headers.get('range');
  return fromHeader !== null && fromHeader.length > 0 ? fromHeader : null;
}

const mediaEndpoints = { stream, download, getCoverArt };

export { mediaEndpoints, stream, download, getCoverArt, passthrough, headerRange, PASSTHROUGH_HEADERS, PLACEHOLDER_PNG, IMAGE_CONTENT_TYPES };
