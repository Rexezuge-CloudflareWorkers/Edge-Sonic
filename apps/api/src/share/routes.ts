/**
 * The public sharing surface: the landing page and the audio behind it.
 *
 * ### Why this is not part of `/rest`
 *
 * A share is a **capability**: the id in the URL is the credential, and the visitor has no
 * Subsonic account. The `/rest` dispatcher authenticates every request except a named
 * public set, so putting shares there would mean either a second auth path inside the
 * dispatcher or a capability check that every future endpoint has to remember to skip.
 * A separate surface keeps the rule visible: these two routes read a share, and nothing
 * else on this worker is reachable without credentials.
 *
 * ### Unknown, expired, malformed, deleted — one answer
 *
 * All four are the same `404`. Distinguishing "expired" from "does not exist" would confirm
 * that the id was real, which is exactly the thing an unguessable link must not reveal.
 * `ShareService.visit` performs the expiry check in the `UPDATE … RETURNING` that counts the
 * visit, so the null branch is the same branch for every cause.
 *
 * ### A visit is the landing page only
 *
 * `recordVisit` is called by the page and never by the stream. A player fetching ranges is
 * not opening the link, and counting those would turn `visitCount` into a play counter with
 * a different name. The stream uses `visible`, which does not write.
 */
import { Hono } from 'hono';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { SongRow } from '@edge-sonic/backend-data/dao';
import type { ShareView } from '@edge-sonic/backend-services/share';
import { BaseRoute } from '../endpoints/BaseRoute';
import type { UserContext } from '../endpoints/BaseRoute';
import { guessContentType } from '../rest/mappers';
import { passthrough } from '../rest/endpoints/media';

type App = Hono<{ Bindings: Cloudflare.Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

/**
The one response every failure on this surface gets.
*/
function notFound(): Response {
  return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * HTML-escape a value that came from a file, a tag, or the share's own description.
 *
 * Every field on this page is attacker-controlled through the library: a WebDAV filename is
 * whatever anyone with write access chose, and a share description is typed by a user. This
 * page is rendered on a public URL, so an unescaped `<script>` is a stored XSS on the
 * deployment's own origin. The five characters are the whole rule; there is no attribute
 * context here that needs a second one.
 */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function trackTitle(song: SongRow): string {
  return song.title ?? song.name;
}

function trackArtist(song: SongRow): string {
  return song.artist ?? song.album_artist ?? '';
}

/**
 * The landing page, as a document.
 *
 * Minimal by design: no script, no stylesheet, no image. The content is a list of links to
 * `/share/:id/stream?song=…`, which is enough for a browser, a feed reader, or the link
 * preview that fetches this page. The CSP applied to `/share/` is `default-src 'none'`, and
 * this markup needs nothing else.
 */
function renderSharePage(view: ShareView): string {
  const { share, songs } = view;
  const description = share.description === null ? '' : `<p>${escapeHtml(share.description)}</p>`;
  const entries =
    songs.length === 0
      ? '<p>This share has no playable tracks.</p>'
      : `<ol>${songs
          .map((song) => {
            const title = escapeHtml(trackTitle(song));
            const artist = escapeHtml(trackArtist(song));
            const label = artist.length > 0 ? `${title} — ${artist}` : title;
            return `<li><a href="/share/${encodeURIComponent(share.id)}/stream?song=${encodeURIComponent(song.id)}">${label}</a></li>`;
          })
          .join('')}</ol>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Shared music</title>
</head>
<body>
<h1>Shared music</h1>
${description}
${entries}
</body>
</html>`;
}

async function landingPage(c: UserContext): Promise<Response> {
  const id = c.req.param('id');
  const scope = BaseRoute.getScope(c);
  const view = id === undefined || id.length === 0 ? null : await scope.get(Tokens.ShareService).visit(id);
  if (view === null) return notFound();
  return new Response(renderSharePage(view), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * One track from a share, with `Range` forwarded verbatim.
 *
 * The grant is re-checked at read time inside `ShareService.visible`: the share's entries are
 * frozen, but the owner's permission to the library is not, so a revoked grant removes the
 * track rather than serving it. The song is picked from that already-filtered list, so an id
 * outside the share cannot be addressed by appending a query parameter.
 */
async function shareStream(c: UserContext): Promise<Response> {
  const id = c.req.param('id');
  const songId = new URL(c.req.url).searchParams.get('song');
  if (id === undefined || id.length === 0 || songId === null || songId.length === 0) return notFound();

  const scope = BaseRoute.getScope(c);
  const view = await scope.get(Tokens.ShareService).visible(id);
  if (view === null) return notFound();
  const song = view.songs.find((entry) => entry.id === songId);
  if (song === undefined) return notFound();

  TreeService.assertPath(song.path);
  const libraries = scope.get(Tokens.LibraryService);
  const library = await libraries.findById(song.library_id);
  if (library === null) return notFound();

  const client = await libraries.clientFor(library);
  const range = c.req.header('range');
  const upstream = await client.get(song.path, {
    ...(range !== undefined && range.length > 0 && { range }),
    timeoutMs: scope.get(Tokens.AppConfig).getStreamTimeoutMs(),
  });

  const response = passthrough(upstream);
  if (!response.headers.has('content-type')) {
    response.headers.set('content-type', song.content_type ?? guessContentType(song.suffix));
  }
  return response;
}

function registerShareRoutes(app: App): void {
  // `:id/stream` before `:id` is not about matching order — Hono matches whole segments —
  // but it keeps the two reads of one capability beside each other in the source.
  app.get('/share/:id/stream', shareStream);
  app.get('/share/:id', landingPage);
}

export { registerShareRoutes };
