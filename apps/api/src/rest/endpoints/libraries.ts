/**
 * Music folders: the list a `musicFolderId` indexes into, and the two surfaces that
 * publish it.
 *
 * ### One list, two publishers, one order
 *
 * `getUser` and `getMusicFolders` both answer "which libraries may this user see, and
 * what is each one called", and the protocol makes them the *same* list: a
 * `musicFolderId` in any other request is an index into the `folder` list on `user`
 * and into `getMusicFolders`. So a folder id is a **position**, and the position only
 * means something relative to one agreed order.
 *
 * That order is `userLibraries` below, and it is the only way this surface obtains the
 * list. Two callers each fetching `listForUser` and mapping it themselves is how the
 * two surfaces start disagreeing — which is exactly what happened: `getUser` published
 * positions and `getMusicFolders` published library ids, so the id a client read from
 * one was rejected by the other, and the comment on `user` claiming the list was the
 * index into described a contract nothing tested.
 */
import { musicFolderElement, SPANNING_LIBRARY_ID, userFolderElements, ErrorCode, SubsonicError } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { RestContext } from '../context';

/**
 * The libraries `userId` may see, in the one order a published folder id is a position
 * in.
 *
 * Deterministic (`ORDER BY slug_ci`) and stable for a given grant set. It changes when
 * a library is renamed or granted, which repoints a stored `musicFolderId` — so it is
 * the *list* a client re-reads, never a list it caches, and every publisher below
 * derives its ids from this call rather than from a library row.
 */
async function userLibraries(context: RestContext, userId: string): Promise<LibraryRow[]> {
  return await context.libraries.listForUser(userId);
}

/**
Display name, falling back to the slug.
*/
function libraryName(library: LibraryRow): string {
  const name = library.display_name?.trim();
  return name && name.length > 0 ? name : library.slug;
}

/**
 * The `folder` children of a `user` element — the positions, as bare integers.
 *
 * Counted from the same list, in the same order, as `musicFolderElementsFor`, because
 * the two are the same list published twice. Returns `[]` for a user with no grants,
 * which the endpoint then carries as an empty array rather than an absent key.
 */
async function userFolderElementsFor(context: RestContext, userId: string): Promise<ElementNode[]> {
  return userFolderElements((await userLibraries(context, userId)).length);
}

/**
 * The `musicFolders` wrapper's children — the same positions, each with its name.
 *
 * `id` is the position in the same list, not the library identifier: the schema types
 * it as an `integer`, and a client modelling it as anything wider cannot decode a
 * library's `TEXT` key. The name is what a client actually reads; the id only has to
 * agree with `userFolderElementsFor`.
 */
async function musicFolderElementsFor(context: RestContext, userId: string): Promise<ElementNode[]> {
  const libraries = await userLibraries(context, userId);
  return libraries.map((library, index) => musicFolderElement({ id: index, name: libraryName(library) }));
}

/**
 * A position, and only in its canonical spelling.
 *
 * `01`, `-1` and `1 ` are not positions, and accepting them would make a library whose
 * identifier happens to be `"01"` unreachable through the id that resolves it.
 */
const CANONICAL_POSITION = /^(?:0|[1-9]\d*)$/;

/**
 * Resolve a `musicFolderId`, or pick the caller's only library.
 *
 * A caller that sent no id and has exactly one library gets that library; a caller with
 * several and no id gets the first, which is deterministic. Refusing the ambiguous case
 * would break every client that omits the id, and the alternative — guessing — is not a
 * security problem because the result is still filtered to libraries this user was
 * granted.
 *
 * Two spellings resolve, in this order:
 *
 * 1. **A position** in `userLibraries`, which is what both publishers emit. Resolving
 *    one needs no further authorization check because the list is already this user's
 *    grants — an out-of-range position is not a library anyone can reach.
 * 2. **A library identifier**, which is what this surface published before it published
 *    positions. A client holding one keeps working, and it is still authorized:
 *    `requireForUser` reports a library the caller cannot see and one that does not
 *    exist identically, so this is not an oracle. Only consulted when the value is not a
 *    position *in range*, so nothing that resolved before stops resolving.
 */
async function resolveLibrary(context: RestContext, requested: string | undefined): Promise<LibraryRow> {
  return (await resolveLibraries(context, requested))[0];
}

/**
 * The libraries a request reads, which is **every** one the caller was granted unless it
 * named a folder.
 *
 * ### Why the default is the union
 *
 * A user with two libraries is not a user with two libraries *and* a preference between them —
 * they registered both because they wanted both in their library, and a server that answers the
 * un-scoped request with only the first is answering a question nobody asked. The measured case:
 * a release whose track 01 lives in one library and track 03 in the other was browsable from
 * **no** `musicFolderId` at all, because folder 0 held half the album and folder 1 the other
 * half, so a client that showed the album listed it at a `songCount` of 1 and never opened the
 * track it was missing.
 *
 * So the default is the union and `musicFolderId` remains the way to narrow. That keeps the
 * protocol's own model intact — `musicFolderId` is a **scope selector**, and a client that sends
 * one still gets exactly the library it asked for.
 *
 * ### And what it costs, stated rather than hidden
 *
 * `getMusicFolders` still publishes the individual libraries, so a client with a folder picker
 * can still choose one and will then see *less* than the default. That is the price of the
 * default being the union, and the alternative — a synthetic "All" entry — would shift every
 * published `musicFolderId` position, which the stored ones depend on. `folder` grouping is
 * **not** unioned, because under it an album *is* a directory and directories are per-source.
 */
async function resolveLibraries(context: RestContext, requested: string | undefined): Promise<LibraryRow[]> {
  const libraries = await userLibraries(context, context.user.id);
  if (libraries.length === 0) {
    throw new SubsonicError(ErrorCode.NotFound, 'No library has been granted to this user.');
  }
  if (requested === undefined || requested.length === 0) return libraries;
  if (CANONICAL_POSITION.test(requested)) {
    const position = Number(requested);
    if (position < libraries.length) return [libraries[position]];
  }
  return [await context.libraries.requireForUser(context.user.id, requested)];
}

/**
 * The library a **row** belongs to, for minting an id over it.
 *
 * ### Why the mappers take a resolver rather than a library
 *
 * `resolveLibraries` answers **every** granted library when no `musicFolderId` is sent, so a list
 * endpoint's rows can come from N of them — and under `ALBUM_GROUP_BY=folder` the library is *part*
 * of the album id (`albumIdOf`, `subsonic/albumId.ts`). Minting every id against `libraries[0]`
 * therefore published a link that decoded to the wrong library and answered `code=70`.
 *
 * The tag groupings hide it: they carry the sentinel and ignore the library half. So the defect was
 * invisible under the default and only appeared on a per-performer library, which is what
 * `ALBUM_GROUP_BY=folder` exists for.
 *
 * `songToModel`, `songToChild`, `albumModel` and `groupArtistRows` all take
 * `(song) => AlbumIdentity` now, which is what makes "the id was minted against a different library
 * than the row's" unrepresentable instead of merely fixed. They used to take a `LibraryRow` beside
 * the identity **and never read it**, so nothing about the two could be checked.
 */

/**
 * The libraries a **decoded id** may reach, and the only way an endpoint turns an id into a
 * scope.
 *
 * ### Two answers, because an id names a group or a file
 *
 * - A **song** or **directory** id carries a real library, because `path` only means something
 *   inside one: the same relative path in two libraries is two files, and resolving it against
 *   the union would let a client read a track from a library it never named. So those answer one
 *   library, and `requireForUser` is the authorization — a library the caller cannot see is
 *   still `code=70`, never `50`, because `50` would confirm the id is real.
 * - An **album** or **artist** id carries {@link SPANNING_LIBRARY_ID}, because it names a group
 *   and a group is what two libraries share. Those answer **every** library the caller was
 *   granted, so a release whose tracks live in two of them opens whole.
 *
 * The union is still grant-scoped, so the oracle rule holds on the union branch too: a key that
 * exists only in a library the caller cannot see resolves to nothing, because the lookup is
 * restricted to the granted set rather than widened to everything and filtered afterwards.
 *
 * A forged id cannot reach the union branch as an oracle — the sentinel is a fixed constant, so
 * it says "all granted libraries" and nothing about which ones exist.
 */
async function librariesForId(context: RestContext, libraryId: string): Promise<LibraryRow[]> {
  if (libraryId === SPANNING_LIBRARY_ID) {
    const libraries = await userLibraries(context, context.user.id);
    if (libraries.length === 0) throw new SubsonicError(ErrorCode.NotFound, 'No library has been granted to this user.');
    return libraries;
  }
  return [await context.libraries.requireForUser(context.user.id, libraryId)];
}

export { userLibraries, libraryName, userFolderElementsFor, musicFolderElementsFor, resolveLibrary, resolveLibraries, librariesForId };
