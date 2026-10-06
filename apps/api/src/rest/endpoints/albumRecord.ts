/**
 * What an album **record** is, and how one is reached from an id.
 *
 * ### Why this is separate from the endpoints that render it
 *
 * Because it is one construction with four callers — `getAlbum`, `getArtist`, `getAlbumList2` and
 * `search3` — and it had already diverged between two of them. `getAlbum`'s copy omitted
 * `created` while every list emitted it, which a client declaring
 * `@SerialName("created") val createdAt: Instant` with no default fails on for **every** album.
 * The protocol types `created` as optional, so the omission was legal and the breakage was
 * invisible from here: a correct-looking response one strict client cannot read at all.
 *
 * It is separate from `structured.ts` rather than merely a function in it because the record and
 * the *resolution* of an id to it are the same decision at two ends: the id has to resolve to
 * whole rows, and the record is built only from whole rows. Keeping them in one file makes it
 * visible that `getAlbum` cannot skip a step the lists do not.
 */
import { artistIdOf, decodeId, encodeId, ErrorCode, IdKind, resolveAlbumId, SubsonicError } from '@edge-sonic/subsonic';
import type { Album } from '@edge-sonic/subsonic';
import type { LibraryRow, LibraryScope, SongRow } from '@edge-sonic/backend-data/dao';
import { librariesForId } from './libraries';
import { TreeService } from '@edge-sonic/backend-services/index';
import type { RestContext } from '../context';
import { albumNameOf, artistNameOf, toIso } from '../mappers';
import type { AnnotationLookup } from '../mappers';
import { compareAlbumTracks } from '../albumIdentity';
import type { AlbumIdentity } from '../albumIdentity';

/**
 * The album's `artist`, and whether a client can drill it.
 *
 * ### Three rules, and the third is the one that is not obvious
 *
 * 1. **The album artist, when the group has one.** That field's whole job is to name who owns a
 *    release, and it is the same on every track of one by definition — so it is the answer
 *    rather than a preference.
 * 2. **The single contributing artist, when it does not.** One performer on every track is an
 *    album by them whatever the tags say, and the id resolves: `getArtist` filters on `artist`,
 *    so a name taken from the data is a name `getArtist` can find.
 * 3. **`Various Artists`, and no `artistId`, when there are several.** There is no name in the
 *    library to point at, and a synthesized one is worse than none: `artistId` is a link, and a
 *    link that answers `code=70` is a client tapping an album's artist and being told the album
 *    does not exist. So the label is published — `artist` is **required** by the schema, so it
 *    cannot be omitted — and the id is left off, which the schema permits.
 *
 * `Various Artists` rather than a join of the contributors (`A, B, C`) for the same reason: a
 * joined string resolves to no artist either, so it buys readability at the price of the same
 * dead link, in a name this server invented in both halves.
 *
 * Deterministic by construction: the rows arrive in protocol order, so the first non-null album
 * artist and the contributor set are functions of the group's contents rather than of a `Set`'s
 * iteration order.
 */
const VARIOUS_ARTISTS = 'Various Artists';

function albumArtistOf(songs: readonly SongRow[]): { name: string; drillable: boolean } {
  const tagged = songs.find((song) => song.album_artist !== null && song.album_artist !== '');
  if (tagged?.album_artist) return { name: tagged.album_artist, drillable: true };
  const contributors = new Set<string>();
  for (const song of songs) contributors.add(song.artist ?? artistNameOf(song));
  if (contributors.size === 1) return { name: [...contributors][0], drillable: true };
  return { name: VARIOUS_ARTISTS, drillable: false };
}

/**
 * The album record, from its songs.
 *
 * **One function, because it is one album.** `getAlbum` and every album *list*
 * (`getArtist`, `getAlbumList2`, `search2`/`search3`) publish the same `id`, the same
 * name and the same `created`, read from the same first track. They were two literals,
 * and they had already diverged: `getAlbum`'s copy omitted `created` while the lists
 * emitted it.
 *
 * That is not cosmetic. A client whose `Album` model is
 * `@SerialName("created") val createdAt: Instant` — non-nullable, no default — throws
 * `MissingFieldException` on **every** `getAlbum`, for every album, because the key is
 * absent. The protocol types `created` as optional, so the omission was legal and the
 * breakage was invisible from here: a correct-looking response that one strict client
 * cannot read at all.
 *
 * `songs` must be the album's **complete** rows in protocol order, and every caller arranges
 * that now: `getArtist` completes each group, `search2`/`search3` complete each group, and the
 * album lists come from `listAlbums`, which fetches whole groups. A partial group reports a
 * different `songCount`, `duration` and `artist` here than in the list the album was reached
 * from — which is the "the same album, built once" invariant arriving through the *rows* rather
 * than through the literal.
 *
 * @param songs The album's tracks, already ordered by `compareAlbumTracks` — the first one
 * supplies the album-level fields, and it is also what `getAlbum` publishes as track 1.
 * @param identity The request's album identity: the id minted here, and the folder-shaped ids
 * a star may have been stored under.
 */
function albumModel(songs: readonly SongRow[], library: LibraryRow, identity: AlbumIdentity, annotations: AnnotationLookup): Album {
  const first = songs[0];
  const id = identity.idOf(first) ?? '';
  const artist = albumArtistOf(songs);
  // Every id this album has ever been published under: the current one, then the
  // folder-shaped one each of its rows would have had. A star is stored under the id the album
  // had *when the user starred it*, and an album whose identity moved from a folder to a tag is
  // published under a new id while the `stars` row still holds the old one. Checking only the
  // current id reports a correctly-stored star by nothing at all — the `starred: undefined`
  // finding one layer up, where a field was dropped by both serializers because the lookup held
  // nothing.
  const legacy = songs.map((song) => identity.legacyFolderIdOf(song));
  const starredAt = annotationFor(annotations.stars, [id, ...legacy]);
  const rating = annotationFor(annotations.ratings, [id, ...legacy]);
  return {
    id,
    name: albumNameOf(first),
    artist: artist.name,
    // Absent when the name is synthesized — `albumArtistOf`, rule 3. Not dropped
    // unconditionally: an album whose artist really is one name stays drillable, and the key
    // set `getAlbum` and `getArtist` publish has to match for both.
    ...(artist.drillable && { artistId: artistIdOf(artist.name) }),
    songCount: songs.length,
    duration: songs.reduce((total, song) => total + song.duration, 0),
    // **The first row that has one, not `songs[0]`.** `year` and `genre` are the two columns
    // `pathConvention` deliberately never derives, so a row the scan has not range-read holds
    // NULL for both. That was invisible while a derived `X (derived)` and a tagged `X` were
    // two albums — the tagged half published a year and the derived half published none, and
    // nobody compared them. With `DERIVED_MARKER` empty they are one album, the group's first
    // track is often the unenriched one, and `first.year` reports no year for a release every
    // other track has one for. So the merge introduced the bug and this is its fix.
    //
    // Deterministic rather than merely better: `songs` arrives in `compareAlbumTracks` order, so
    // the answer is a function of the album rather than of which row the statement returned
    // first. A disagreement between `getAlbum` and `getAlbumList2` about `year` is the
    // "the same album, built once" invariant arriving through the sort rather than the literal.
    year: firstWith(songs, (song) => song.year) ?? undefined,
    genre: firstWith(songs, (song) => song.genre) ?? undefined,
    coverArt: id,
    created: toIso(first.created_at),
    ...(starredAt !== undefined && { starred: toIso(first.mtime_ms) }),
    ...(rating !== undefined && { userRating: rating }),
  };
}

/**
 * The first track carrying a value a derivation never supplies.
 *
 * `null` and `undefined` both count as absent, because the columns are nullable and a DAO
 * projecting them over a partial row can hand back either. The predicate runs on the value and
 * not on a column name, so adding a third such column is one argument here rather than a fourth
 * `find` — and the album-level fields it feeds are read together on purpose.
 */
function firstWith<T>(songs: readonly SongRow[], read: (song: SongRow) => T | null): T | undefined {
  for (const song of songs) {
    const value = read(song);
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/**
 * The value stored under the first of `ids` that has one.
 *
 * Two annotations to answer over one set of ids is the shape of the problem and of the answer.
 * A helper rather than two inline `.has(...)`/`.get(...)` pairs because the pairs are what
 * diverge: `has` without `get` publishes `starred` with no timestamp, and both serializers drop
 * an absent field — so a correct star is reported by nothing.
 */
function annotationFor(lookup: ReadonlyMap<string, number>, ids: readonly string[]): number | undefined {
  for (const id of ids) {
    const value = lookup.get(id);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The library an album id names, with the caller's grant checked.
 *
 * Separate from resolving the album, because the grant check must come **first**: an id for a
 * library the caller cannot see is `code=70` and not `code=50`, or the endpoint becomes an
 * oracle for which paths exist. See `apps/api/AGENTS.md`.
 */
async function libraryForAlbumId(context: RestContext, id: string): Promise<{ library: LibraryRow; scope: LibraryScope }> {
  let libraryId: string;
  let path: string | null;
  try {
    const decoded = decodeId(id);
    libraryId = decoded.libraryId;
    // `assertPath` guards a *directory*. A key payload is base64url segments and never a path,
    // so the guard belongs on the folder branch only — running it on a key would be a check
    // against the wrong thing, and skipping it on a folder would leave a traversal reachable.
    path = decoded.kind === IdKind.Album ? decoded.path : null;
  } catch {
    throw new SubsonicError(ErrorCode.NotFound, 'Album not found.');
  }
  // A **tag** album id carries the sentinel and resolves across every granted library, so a
  // release whose tracks are split between two of them opens whole. A **folder** id (`al:`)
  // names a directory, which is per-source by nature, so it stays with one library — and the
  // grant check below is what keeps an id for a library the caller cannot see at `code=70`
  // rather than `code=50`, which would make the endpoint an oracle for which paths exist.
  const libraries = await librariesForId(context, libraryId);
  const library = libraries[0];
  if (path !== null) TreeService.assertPath(path);
  return { library, scope: libraries.map((row) => row.id) };
}

/**
 * The grouping key an album id names, or `null` when it names nothing.
 *
 * The directory form is resolved to its rows and then to *their* key rather than returned as
 * `folder:<dir>`, because under a tag grouping a directory is part of an album rather than one,
 * and the part a pre-existing star names is not the album the lists publish.
 */
async function resolveAlbumKey(context: RestContext, id: string, library: LibraryRow): Promise<string | null> {
  return await resolveAlbumId(id, context.albumsFor(library).grouping, async (dirPath) => await context.songs.listByAlbumDir(library.id, dirPath));
}

/**
 * Group songs into album **models**, in the order the albums first appear in `rows`.
 *
 * **The key is the request's album key** — a directory under `folder`, a tag under `album` and
 * `album_artist`. It used to be `dir_path` with no configuration, on the argument that a starred
 * album resolves back to its songs through it; that argument holds for a library whose folders
 * are releases and not at all for one whose folders are per-artist, and a star written under the
 * folder form is still recognised either way (see `albumModel`).
 *
 * ### No sort here, and that is load-bearing
 *
 * This used to end in `.sort(([a], [b]) => a.localeCompare(b))` over the group keys, which
 * re-sorted the list by **directory path** after the database had ordered it by whatever
 * the caller asked for. `getAlbumList2?type=alphabeticalByName` therefore returned
 * albums ordered by their folder — and since the folders here are named
 * `Artist - Album`, that is an order no client could have predicted and none requested.
 *
 * The order now belongs to whoever chose it: `listAlbums` sorts in SQL and this preserves
 * what it hands over, and a caller with no opinion (`getArtist`, `search`) gets first
 * appearance, which is the order its own query produced. Ordering is a decision about the
 * *list*, and a grouping has no opinion about it.
 *
 * ### Models, not elements
 *
 * (Continued in `structured.ts`, where the two wrappers are.)
 *
 * It returns `Album` values rather than protocol nodes because the two album list
 * endpoints publish **different element types** — `getAlbumList` answers with `Child`,
 * `getAlbumList2` with `AlbumID3` — and only the builder knows which is which. A grouping
 * that returned elements would have to choose, and the choice would be wrong for one of
 * them: it chose `AlbumID3` for both, which put `title` and `isDir` on every album in
 * `getAlbumList2` where the schema declares neither.
 *
 * So the split is made by the caller, which knows its own wrapper, and the grouping stays
 * the one place that decides what an album *is*.
 */
function groupAlbumsOf(rows: readonly SongRow[], library: LibraryRow, identity: AlbumIdentity, annotations: AnnotationLookup): Album[] {
  const groups = new Map<string, SongRow[]>();
  for (const row of rows) {
    const key = identity.keyOf(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  return [...groups].map(([, songs]) => {
    // `compareAlbumTracks` rather than a comparator written here. It was written here *and*
    // in `getAlbum`, and the two disagreed — this one had `disc`, that one did not — which is
    // what made a two-disc album's `created`, `year` and `genre` depend on which endpoint a
    // client asked.
    const ordered = [...songs].sort(compareAlbumTracks);
    return albumModel(ordered, library, identity, annotations);
  });
}
export { albumModel, albumArtistOf, groupAlbumsOf, libraryForAlbumId, resolveAlbumKey, VARIOUS_ARTISTS };
