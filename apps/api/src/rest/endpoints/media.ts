/**
 * Media retrieval: `stream` and `download`.
 *
 * `getCoverArt` lives in `./coverArt` — it is the one media endpoint that is not a
 * passthrough, since it has to *find* a picture that may not exist as a file at all.
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
import { decodeId, ErrorCode, IdKind, SubsonicError } from '@edge-sonic/subsonic';
import type { IdKindValue } from '@edge-sonic/subsonic';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import { guessContentType } from '../mappers';
import { getCoverArt } from './coverArt';

type PassthroughResponse = { response: Response };

export type { PassthroughResponse };

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

export { mediaEndpoints, stream, download, passthrough };

export {getCoverArt} from './coverArt';