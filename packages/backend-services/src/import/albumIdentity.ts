/**
 * Translating a **remote** album or artist id into a local one.
 *
 * ### Why this cannot be a name comparison done inline
 *
 * A remote album id is opaque — a Navidrome hash, an Airsonic number — and a local one is
 * `alk:base64url(<grouping key>)`. The only bridge is the album's **identity**, which this
 * server already owns in exactly one place: `subsonic/albumKey.ts`.
 *
 * So a remote `(albumArtist, album)` pair is run through the **same** `albumKeySpec` that mints
 * a local id, and the key it produces is both what the id encodes and what the existence check
 * is issued against. Two implementations of "what is an album" would be free to disagree —
 * over a separator, over whether a missing album artist is a value or a wildcard — and a
 * disagreement between two album identities is invisible until a client groups a library
 * wrongly. This is the invariant `packages/backend-data/AGENTS.md` states as structural: **the
 * SQL group and the TypeScript group are one function of the same columns.**
 *
 * ### Existence is checked, because an id nothing can read is not a star
 *
 * A key can be computed for an album this library does not have — the remote indexes a release
 * this deployment has not scanned yet. A star stored against that id is a row **no client can
 * ever read**: `getAlbum` resolves it to nothing, `getStarred` expands it through the same path
 * and drops it, and the operator watches their favourite disappear with no error anywhere. So
 * an album that is not present is reported as unresolved rather than stored.
 *
 * ### `_ci` compares, and `artist` on an album means the **album** artist
 *
 * Names compare case-insensitively, through the `_ci` twins, because `X` and `x` are one album
 * to a client that sorts them adjacently and two albums to a library that stores them apart. A
 * remote `AlbumID3.artist` is the *album* artist, so it maps to `album_artist` and not to
 * `artist` — a compilation is grouped by its performer and not by whoever sang on each track,
 * and using `artist` here would fail to match every compilation in the library.
 *
 * A remote with **no** album artist is a `(null, album)` group rather than a wildcard, because a
 * wildcard merges every untagged album sharing a name into every tagged one — the defect
 * `albumKey.ts` documents and `test/schema.int.test.ts` asserts with `EXPLAIN QUERY PLAN`.
 */
import { albumKeySpec, artistIdOf, encodeAlbumKey, AlbumGrouping, SPANNING_LIBRARY_ID } from '@edge-sonic/subsonic';
import type { AlbumGroupingValue } from '@edge-sonic/subsonic';
import { libraryIds } from '@edge-sonic/backend-data/dao';
import type { LibraryScope } from '@edge-sonic/backend-data/dao';

/**
What the matchers need from the data layer. Kept structural so a test answers only this.
*/
interface AlbumMatchStore {
  findPresentAlbumKeys(libraryId: LibraryScope, keys: readonly string[], grouping: AlbumGroupingValue): Promise<Set<string>>;
  findPresentArtists(libraryId: LibraryScope, names: readonly string[]): Promise<Map<string, string>>;
}

/**
Lowercase a tag for comparison, or `null` when absent.
*/
function ci(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}

/**
 * The grouping key a remote `(albumArtist, album)` pair would have, under `grouping`.
 *
 * `null` when the remote named no album: a key built from a null half matches every album that
 * has the other — a wildcard where a value was required, and the way a star lands on an album
 * nobody starred.
 */
function albumKeyFor(albumArtist: string | null, album: string | null, grouping: AlbumGroupingValue): string | null {
  const albumCi = ci(album);
  if (albumCi === null) return null;
  const artistCi = ci(albumArtist);
  // `albumKeySpec` is written against a *row*, so the pair is assembled in that shape rather
  // than re-deriving the key here — the whole point is that this module has no second answer.
  return albumKeySpec({ dir_path: '', album: albumCi, album_ci: albumCi, album_artist: artistCi, album_artist_ci: artistCi }, grouping).string;
}

/**
 * Whether a configured grouping names a grouping, defaulting to the product's own.
 *
 * `AppConfiguration.validate()` already **refuses** an unrecognised `ALBUM_GROUP_BY` at boot,
 * so the fallback is unreachable in a configured deployment. It exists so this module can be
 * called from a test with no environment at all, and it defaults to `album` rather than to
 * `folder` because that is the shipped default — a wrong fallback would silently group an
 * imported album differently from every album already on the server.
 */
function resolveGrouping(value: string | undefined): AlbumGroupingValue {
  return value === AlbumGrouping.Folder || value === AlbumGrouping.Album || value === AlbumGrouping.AlbumArtist ? value : AlbumGrouping.Album;
}

/**
 * Remote album id → local album id, for the ones this library actually holds.
 *
 * Returned as a map so the caller's **own** order is irrelevant: the lookup is a `SELECT`, and
 * `IN (...)` returns rows in index-scan order, so a report built from a returned array would
 * attribute albums to the wrong remote ids.
 */
async function matchRemoteAlbums(
  store: AlbumMatchStore,
  libraryId: LibraryScope,
  grouping: AlbumGroupingValue,
  albums: ReadonlyArray<{ readonly id: string; readonly name: string | null; readonly artist: string | null }>,
): Promise<Map<string, string>> {
  const byRemoteId = new Map<string, string>();
  const keyByRemoteId = new Map<string, string>();
  for (const album of albums) {
    const key = albumKeyFor(album.artist, album.name, grouping);
    if (key === null) continue;
    keyByRemoteId.set(album.id, key);
  }
  if (keyByRemoteId.size === 0) return byRemoteId;

  const present = await store.findPresentAlbumKeys(libraryId, [...new Set(keyByRemoteId.values())], grouping);
  for (const [remoteId, key] of keyByRemoteId) {
    // Minted through the product's own encoder rather than `encodeId` directly, so an imported
    // album star lands on the **same id** `getAlbumList2` publishes. A second minting site is a
    // second id for one album, and a star on an id nothing resolves is a star no client can see.
    if (present.has(key)) byRemoteId.set(remoteId, encodeAlbumKey(spanningLibraryIdFor(libraryId, grouping), key));
  }
  return byRemoteId;
}

/**
 * Remote artist id → local artist id.
 *
 * The id is minted from the **local display spelling**, not from the remote's name and not from
 * the `_ci` twin: `encodeId(IdKind.Artist, …)` takes what `getArtists` publishes
 * (`mappers.ts` mints from `group.name`), so an id built from anything else is one this server
 * never emits and `getArtist` answers `code=70` for a star the import reported as written.
 */
async function matchRemoteArtists(
  store: AlbumMatchStore,
  libraryId: LibraryScope,
  artists: ReadonlyArray<{ readonly id: string; readonly name: string | null }>,
): Promise<Map<string, string>> {
  const byRemoteId = new Map<string, string>();
  const ciByRemoteId = new Map<string, string>();
  for (const artist of artists) {
    const artistCi = ci(artist.name);
    if (artistCi === null) continue;
    ciByRemoteId.set(artist.id, artistCi);
  }
  if (ciByRemoteId.size === 0) return byRemoteId;

  const present = await store.findPresentArtists(libraryId, [...new Set(ciByRemoteId.values())]);
  for (const [remoteId, artistCi] of ciByRemoteId) {
    const display = present.get(artistCi);
    if (display !== undefined) byRemoteId.set(remoteId, artistIdOf(display));
  }
  return byRemoteId;
}

/**
 * The library half an imported album id carries, which is the **sentinel** for a tag grouping —
 * the same rule `albumIdOf` applies, because an imported star has to land on the exact id this
 * server publishes and a second minting site is a second id for one album.
 *
 * `folder` is the exception and takes the first library of the scope: under that grouping an
 * album *is* a directory, so there is no id that spans sources, and a scope of one is the only
 * shape representable. A star written under the wrong one would be reported by nothing, so the
 * narrowing is stated here rather than left to the reader.
 */
function spanningLibraryIdFor(scope: LibraryScope, grouping: AlbumGroupingValue): string {
  return grouping === 'folder' ? (libraryIds(scope)[0] ?? SPANNING_LIBRARY_ID) : SPANNING_LIBRARY_ID;
}

export { ci, albumKeyFor, resolveGrouping, matchRemoteAlbums, matchRemoteArtists, spanningLibraryIdFor };
export type { AlbumMatchStore };