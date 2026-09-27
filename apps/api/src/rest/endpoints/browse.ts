/**
 * File-structure browsing: `getIndexes` and `getMusicDirectory`.
 *
 * These are the only two endpoints that need **no index at all** — one `PROPFIND
 * Depth: 1` per level answers them — and that is why a library is browsable the
 * instant it is registered, before any scan has run.
 *
 * They are also the *fallback* for every other browsing endpoint. A client that
 * cannot find an album because the index is stale can still walk to it, so the
 * folder view is the safety net for the tag view rather than a legacy path.
 */
import { childElement, decodeId, el, elList, encodeId, ErrorCode, IdKind, SubsonicError, successResponse } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow, NodeRow } from '@edge-sonic/backend-data/dao';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import { toIso, songToChild } from '../mappers';

type EnvelopeResponse = ReturnType<typeof successResponse>;

function respond(context: RestContext, payload: ElementNode | null): EnvelopeResponse {
  return successResponse(payload, { format: context.format, jsonpCallback: context.jsonpCallback });
}

function libraryName(library: LibraryRow): string {
  const name = library.display_name?.trim();
  return name && name.length > 0 ? name : library.slug;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function isPlayable(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && /\.(mp3|flac|ogg|oga|opus|m4a|mp4|aac|wav|wma|aiff|aif|ape|wv|mpc|dsf|dff)$/i.test(name);
}

/**
 * Resolve a `musicFolderId`, or pick the caller's only library.
 *
 * A caller that sent no id and has exactly one library gets that library; a caller
 * with several and no id gets the first by slug, which is deterministic. Refusing
 * the ambiguous case would break every client that omits the id, and the
 * alternative — guessing — is not a security problem because the result is still
 * filtered to libraries this user was granted.
 */
async function resolveLibrary(context: RestContext, requested: string | undefined): Promise<LibraryRow> {
  const libraries = await context.libraries.listForUser(context.user.id);
  if (libraries.length === 0) {
    throw new SubsonicError(ErrorCode.NotFound, 'No library has been granted to this user.');
  }
  if (requested === undefined || requested.length === 0) return libraries[0]!;
  // Authorization happens inside `requireForUser`, so an id for a library this user
  // cannot see is reported as "not found" rather than "forbidden" — the latter
  // would confirm the library exists.
  return await context.libraries.requireForUser(context.user.id, requested);
}

/**
 * The sort letter for `getIndexes` grouping.
 *
 * A leading article is kept in the display name and stripped only from the
 * grouping letter, which is what every client does with `ignoredArticles`. An
 * empty or non-alphabetic first character sorts under `#` rather than into the
 * empty string, which would produce an unnamed group at the top of the list.
 */
function firstLetterOf(name: string): string {
  const trimmed = name.trim();
  const first = [...trimmed][0];
  if (first === undefined) return '#';
  const upper = first.toUpperCase();
  return /^[A-Z]$/.test(upper) ? upper : '#';
}

function buildIndexes(roots: readonly NodeRow[], library: LibraryRow, lastModified: number): ElementNode {
  const buckets = new Map<string, NodeRow[]>();
  for (const node of roots) {
    const letter = firstLetterOf(node.name);
    const existing = buckets.get(letter);
    if (existing) {
      existing.push(node);
    } else {
      buckets.set(letter, [node]);
    }
  }

  return elList(
    'indexes',
    'index',
    { lastModified, ignoredArticles: 'The El La Los Las Le Les' },
    [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([letter, nodes]) =>
        elList(
          'index',
          'shortcut',
          { name: letter },
          nodes.map((node) => el('shortcut', { id: encodeId(IdKind.Directory, library.id, node.path), name: node.name })),
        ),
      ),
  );
}

/**
 * `getIndexes` — the top level, grouped by first letter.
 *
 * The protocol's `index`/`shortcut` shape is a client-side convenience for jumping
 * to a letter, and it is derived from the same node rows the directory view uses,
 * so the two can never disagree about what exists.
 *
 * `ifModifiedSince` is answered: a client polling on resume gets an **empty**
 * `indexes` element when nothing changed, which is how this protocol says "304"
 * inside a 200.
 */
async function getIndexes(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  context.libraries.assertReachable(library);

  const roots = await context.tree.roots(library);
  const ifModifiedSince = context.params.int('ifModifiedSince', 0);
  const newest = roots.reduce((max, node) => Math.max(max, node.mtime_ms ?? 0), 0);
  if (ifModifiedSince > 0 && newest <= ifModifiedSince) {
    return respond(context, el('indexes', { lastModified: newest, ignoredArticles: 'The El La Los Las Le Les' }));
  }
  return respond(context, buildIndexes(roots, library, newest));
}

/**
 * `getMusicDirectory` — one folder's children.
 *
 * `id` is a `dir:` ID, so resolving it to a path is a base64 decode and not a
 * lookup. The folder is then read from D1 and only `PROPFIND`ed live if the index
 * has never seen it (read-through materialization).
 *
 * Files appear exactly once, as rich song children. The node rows supply the
 * subdirectory entries and the ordering; the `songs` rows supply duration, genre,
 * and track number for the playable ones.
 */
async function getMusicDirectory(context: RestContext): Promise<EnvelopeResponse> {
  const id = context.params.require('id');
  const decoded = decodeId(id, IdKind.Directory);
  TreeService.assertPath(decoded.path);

  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  context.libraries.assertReachable(library);

  const { folder, children } = await context.tree.children(library, decoded.path);
  const path = folder.path;
  const selfId = encodeId(IdKind.Directory, library.id, path);
  const songs = await context.songs.listByDirectory(library.id, path);

  const byPath = new Map(songs.map((song) => [song.path, song]));
  const childNodes: ElementNode[] = children.map((node) => {
    const song = byPath.get(node.path);
    if (song) {
      // The indexed row wins: it carries duration, genre, and track number, which
      // the node row does not have.
      return childElement(songToChild(song, library, selfId));
    }
    const isDirectory = !isPlayable(node.name);
    return childElement({
      id: encodeId(isDirectory ? IdKind.Directory : IdKind.Song, library.id, node.path),
      parent: selfId,
      isDir: isDirectory,
      title: node.name,
      duration: 0,
      bitRate: 0,
      created: toIso(node.created_at),
    });
  });

  const parentId =
    path.length === 0 ? '' : encodeId(IdKind.Directory, library.id, path.slice(0, path.lastIndexOf('/')).replace(/\/$/, ''));

  return respond(
    context,
    elList(
      'directory',
      'child',
      { id: selfId, parent: parentId, name: path === '' ? libraryName(library) : baseName(path) },
      childNodes,
    ),
  );
}

const browseEndpoints = { getIndexes, getMusicDirectory };

export { browseEndpoints, getIndexes, getMusicDirectory, resolveLibrary, firstLetterOf, isPlayable };
