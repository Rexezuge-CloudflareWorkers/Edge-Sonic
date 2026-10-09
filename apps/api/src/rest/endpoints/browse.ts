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
import { childElement, decodeId, deriveShortSongId, el, elList, encodeId, ErrorCode, IdKind, SubsonicError } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow, NodeRow } from '@edge-sonic/backend-data/dao';
import { basename, parentOf, TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import { respond } from '../respond';
import type { EnvelopeResponse } from '../respond';
import { IGNORED_ARTICLES, toIso, songToChild } from '../mappers';
import { artistIndexGroups, groupArtistRows } from '../artistIndex';
import { libraryName, resolveLibrary } from './libraries';

function isPlayable(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && /\.(?:mp3|flac|ogg|oga|opus|m4a|mp4|aac|wav|wma|aiff|aif|ape|wv|mpc|dsf|dff)$/i.test(name);
}

function buildIndexes(roots: readonly NodeRow[], library: LibraryRow, artists: readonly ElementNode[], lastModified: number): ElementNode {
  // `shortcut` is a direct child of `indexes`, and `index` groups hold `artist`
  // children — that placement is the schema's, not a choice. An `index` holding
  // `shortcut` children is a shape no client reads: `index.artist` comes back
  // absent, and the whole alphabetical browse is empty on a client that works
  // everywhere else. It shipped that way, with the suite asserting the wrong
  // shape, because the assertion was written from the code rather than the schema.
  const shortcuts = roots.map((node) => el('shortcut', { id: encodeId(IdKind.Directory, library.id, node.path), name: node.name }));
  return elList('indexes', ['shortcut', 'index'], { lastModified, ignoredArticles: IGNORED_ARTICLES }, [...shortcuts, ...artists]);
}

/**
 * `getIndexes` — the top level: folder shortcuts, plus the tag-index artists
 * grouped by first letter.
 *
 * Two sources, because they answer different questions. The shortcuts are the
 * library's top-level folders, readable before any scan has run — one `PROPFIND
 * Depth: 1` answers them, which is what makes a library browsable the instant it
 * is registered. The artists come from the song index, so they are the same
 * artists `getArtists` publishes, with the same ids: a client drilling from here
 * into `getArtist` lands on the same rows. Before the first scan that half is
 * empty, and the folders are still all there — the folder view is the safety net
 * for the tag view rather than a legacy path.
 *
 * `ifModifiedSince` is answered: a client polling on resume gets an **empty**
 * `indexes` element when nothing changed, which is how this protocol says "304"
 * inside a 200. Empty still carries both list keys, so the shape a client decodes
 * does not change with the data.
 */
async function getIndexes(context: RestContext): Promise<EnvelopeResponse> {
  const library = await resolveLibrary(context, context.params.get('musicFolderId'));
  context.libraries.assertReachable(library);

  const roots = await context.tree.roots(library);
  const ifModifiedSince = context.params.int('ifModifiedSince', 0);
  const newest = roots.reduce((max, node) => Math.max(max, node.mtime_ms ?? 0), 0);
  if (ifModifiedSince > 0 && newest <= ifModifiedSince) {
    return respond(context, elList('indexes', ['shortcut', 'index'], { lastModified: newest, ignoredArticles: IGNORED_ARTICLES }, []));
  }
  const rows = await context.songIndex.listArtists(library.id, 5000, 0);
  // One library here, so a single identity — `getIndexes` browses one origin. The per-row form
  // is used anyway so this and `getArtists` cannot disagree about what an album key is.
  const identity = context.albumsFor(library);
  return respond(context, buildIndexes(roots, library, artistIndexGroups(groupArtistRows(rows, () => identity)), newest));
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
  // `code=70` for an absent id, not `code=10`. The id is the selector and there is no other
  // way to ask for no directory, so "no id" and "a directory that is not there" are the same
  // request — see `requireMediaId` in `./structured` for where that line is drawn and why.
  const id = context.params.get('id');
  if (id === undefined || id.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'Directory not found.');
  const decoded = decodeId(id, IdKind.Directory);
  TreeService.assertPath(decoded.path);

  const library = await context.libraries.requireForUser(context.user.id, decoded.libraryId);
  context.libraries.assertReachable(library);

  const { folder, children } = await context.tree.children(library, decoded.path);
  const path = folder.path;
  const selfId = encodeId(IdKind.Directory, library.id, path);
  const songs = await context.songs.listByDirectory(library.id, path);

  const byPath = new Map(songs.map((song) => [song.path, song]));
  const identity = context.albumsFor(library);
  const childNodes: ElementNode[] = children.map((node) => {
    const song = byPath.get(node.path);
    if (song) {
      // The indexed row wins: it carries duration, genre, and track number, which
      // the node row does not have.
      return childElement(songToChild(song, selfId, () => identity));
    }
    const isDirectory = !isPlayable(node.name);
    return childElement({
      // A playable file with no indexed row — browsable before the scan reaches it. It gets a
      // **derived short** song id, not `encodeId(IdKind.Song, …)`: a reversible song id grows with
      // the path, and a client filing a download under one hits `ENAMETOOLONG` past 255 bytes with
      // no server-side error. That is the defect `subsonic/songId.ts` exists for, and minting the
      // long form here was the one place still doing it.
      id: isDirectory ? encodeId(IdKind.Directory, library.id, node.path) : deriveShortSongId(library.id, node.path),
      parent: selfId,
      isDir: isDirectory,
      title: node.name,
      duration: 0,
      bitRate: 0,
      created: toIso(node.created_at),
    });
  });

  // `parentOf`, not `slice(0, lastIndexOf('/'))`: a top-level folder's path holds no
  // separator at all, so `lastIndexOf` answered `-1` and `'Blur'.slice(0, -1)` is `'Blu'`
  // — an id naming a directory that does not exist. `getIndexes` publishes exactly these
  // folder shortcuts, so a client walking *up* from a root folder issued a live `PROPFIND`
  // for `Blu` and got a `404`.
  //
  // **And the library root is `''`, not an id for it**, which is the second half. `decodeId`
  // runs `normalizeRelativePath` over the payload and that refuses an empty path, so **no id can
  // name the library root** — `getMusicDirectory` on one answers `code=70` whatever it encodes.
  // Publishing one would be a link that is dead on arrival, which is worse than publishing none:
  // `apps/api/AGENTS.md` says so about the album id, and it holds here for the same reason. So
  // "up from the top folder" is the same answer the root directory gives for itself — the empty
  // string — and a client reads that as the top of the tree, which is what it is.
  const parentPath = parentOf(path);
  const parentId = parentPath.length === 0 ? '' : encodeId(IdKind.Directory, library.id, parentPath);

  return respond(
    context,
    elList('directory', 'child', { id: selfId, parent: parentId, name: path === '' ? libraryName(library) : basename(path) }, childNodes),
  );
}

const browseEndpoints = { getIndexes, getMusicDirectory };

// `resolveLibrary` and `libraryName` moved to `./libraries`, which owns the folder list
// that `getUser` and `getMusicFolders` both publish. Not re-exported: every importer was
// repointed, so a second path to the same function would be one more place to change.
// `firstLetterOf` moved to `../mappers` for the same reason: the tag view and the folder
// view group by the same letter, or one browse disagrees with the other.
export { browseEndpoints };
