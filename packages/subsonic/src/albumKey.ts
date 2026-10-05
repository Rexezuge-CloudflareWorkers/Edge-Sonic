/**
 * What an album **is**, in one place.
 *
 * ### The question, and why it is a configuration
 *
 * "Which tracks are this album" has no single right answer for a WebDAV library, because the
 * two facts a library could group by routinely disagree. A folder is how the files are *stored*;
 * an album tag is how the *release* is identified. When a library keeps one folder per release
 * they agree, and when it does not they do not.
 *
 * The disagreement is not hypothetical. Measured against a live library: 113 tracks in 80 album
 * folders carrying only 71 distinct `ALBUM` values, because nine releases were split across
 * folders — one of them across six. Grouping on the folder published `Ex-Otogibanashi` twice,
 * `MementoMori (メメントモリ)` six times, and split a two-disc release in half.
 *
 * So this is an operator decision, exposed as one variable, and it is the same decision the
 * reference server exposes as `PID.Album` — "You can group albums by musicbrainz_albumid,
 * discogs_release_id, folder, or any other tag you want." A modelling decision with no right
 * answer is a setting; it is only a defect when it is made invisibly on the operator's behalf.
 *
 * | Value | An album is | Fits |
 * | --- | --- | --- |
 * | `folder` | one directory | a library that keeps a folder per release |
 * | `album` | one `ALBUM` tag (the default) | a library whose folders split a release, or whose folders are per-artist |
 * | `album_artist` | one (`ALBUMARTIST`, `ALBUM`) pair | properly tagged libraries; see the caveat below |
 *
 * ### `album_artist` and a missing album artist
 *
 * A **missing album artist is a value, not a wildcard**. Rows with `album_artist IS NULL` group
 * together under `(NULL, album)` rather than being distributed across the album artists of their
 * neighbours, because the alternative — treating absent as "matches anything" — merges every
 * untagged row into every tagged album that shares its name.
 *
 * Two consequences worth stating, because both look like the knob doing nothing:
 *
 * - For a library with **no `ALBUMARTIST` tag anywhere**, `album_artist` and `album` are the same
 *   grouping. That is the correct answer rather than a degenerate one — the reference server
 *   splits such a library too, for the same reason — but it is a fact about the data, not about
 *   the setting.
 * - On a library laid out **per artist**, `album_artist` reproduces the split even with the tag
 *   absent, because `upsertFileFacts` derives `album_artist` from the folder and the folder is
 *   named after the performer. So this mode fixes a properly tagged compilation and nothing else.
 *   `test/schema.int.test.ts` holds one fixture for each.
 *
 * ### `X` and `X (derived)`, and whether they are one album
 *
 * A row the scan has not range-read carries the path-derived name with `DERIVED_MARKER`
 * appended, and a row that has carries the real tag. Whether those are **one** release or two
 * is `DERIVED_MARKER`'s configured answer, and the default is empty — so they are one, and a
 * half-enriched library shows a release once rather than twice. It is a setting for the same
 * reason `ALBUM_GROUP_BY` is: the two facts can be told apart by the operator and not by the
 * protocol.
 *
 * With a non-empty marker they are deliberately **not** merged. An unmerged pair shows one
 * release twice on a partially-enriched library, while merging them means the marker — the only
 * visible record that a name is a guess — decides nothing, and a guess published as a release
 * name is the failure `pathConvention` exists to keep visible. So the two are not "merged by
 * default" either: the default merges them because an empty marker means the operator declined to
 * mark them, and a marked deployment gets the honest duplicate. `ALBUM_GROUP_BY` does not change
 * this, and no stripping helper is exported, so the next reader does not "fix" it into a second
 * grouping.
 *
 * The provenance that decided the marker no longer travels in the name — a configured string read
 * back with `LIKE` is either a match-all or a wildcard, so it lives in `songs.grouping_source`
 * instead. Nothing here reads that column, and nothing needs to: the grouping key is the stored
 * value either way.
 *
 * ### Why the key is a function and not a column
 *
 * The key is computed, in three places, from a row: in TypeScript to group the rows a statement
 * returned, in SQL to choose which keys are on the page, and in the id so a client can come back.
 * Those three must be one decision, so they are one module and {@link albumKeySpec} returns the
 * key string, the bound values and the row-fetch predicate **together** — a caller cannot take the
 * string and re-derive the predicate, because there is no second derivation to reach for.
 *
 * How an album's **id** carries that key is `albumId.ts`, and the two are split because they fail
 * differently: this file's output is never untrusted, and the id's is parsed out of a string a
 * client sent.
 */

/**
 * How an album's membership is decided. One string per grouping, and the string is what
 * `ALBUM_GROUP_BY` holds — so an operator setting it and a test asserting it are reading the same
 * value, not two vocabularies that have to be kept in step.
 */
const AlbumGrouping = {
  /**
  One directory is one album.
  */
  Folder: 'folder',
  /**
  One `ALBUM` tag is one album. The default.
  */
  Album: 'album',
  /**
  One (`ALBUMARTIST`, `ALBUM`) pair is one album, a missing album artist being one value.
  */
  AlbumArtist: 'album_artist',
} as const;

type AlbumGroupingValue = (typeof AlbumGrouping)[keyof typeof AlbumGrouping];

const ALBUM_GROUPINGS: readonly string[] = Object.values(AlbumGrouping);

/**
 * Whether a configured value names a grouping. The `validate()` gate: an unrecognised value is a
 * **refusal**, not a fallback, because a fallback would group a library by something the operator
 * did not ask for and nothing would say so.
 */
function isAlbumGrouping(value: string): value is AlbumGroupingValue {
  return ALBUM_GROUPINGS.includes(value);
}

/**
 * The subset of a `songs` row that decides album membership.
 *
 * Structural rather than imported, because this module is layer 0 and `SongRow` is layer 2's. A
 * `SongRow` is assignable to it, so no caller converts and no caller can pass something missing a
 * column the key is derived from — which would be a key computed over `undefined` and a group
 * nobody can query.
 */
interface AlbumKeyRow {
  readonly dir_path: string;
  readonly album: string | null;
  readonly album_ci: string | null;
  readonly album_artist: string | null;
  readonly album_artist_ci: string | null;
}

/**
 * One grouping, in the three forms it has to take.
 *
 * - `string` — what TypeScript groups by and what the id encodes.
 * - `values` — what a row fetch binds, in order.
 * - `predicate` — the SQL that matches those values, one `?` per entry.
 *
 * `predicate` is stated rather than derived, and that is the whole point: it is the only part a
 * caller could get subtly wrong without failing. `COALESCE(album_artist_ci, '')` would return
 * **exactly the same rows** as `album_artist_ci IS ?` for every value the key can hold, and would
 * silently stop using `idx_songs_album`, turning a page of albums into a scan of the library's
 * rows. A wrong predicate and a right one are indistinguishable from the result, so the predicate
 * is not computed at each call site — it is carried beside the key, where a change to one is a
 * change to the other.
 */
interface AlbumKeySpec {
  readonly string: string;
  readonly values: readonly unknown[];
  readonly predicate: string;
}

/**
 * The tag-derived name a key is built from, or `null` when the row has none.
 *
 * `_ci`, not the display column, and that is a decision rather than an optimisation. `album` and
 * `album_ci` are lowercased twins, so grouping on the display column makes `X` and `x` two
 * albums; grouping on the twin makes them one, which is what a case-insensitive index
 * (`idx_songs_album`) and a case-insensitive sort (`alphabeticalByName` orders by
 * `MIN(album_ci)`) already assume. The display name is then read off a row's `album`, so the
 * spelling a client sees is the one the tag held rather than the one the key normalised to.
 *
 * Empty is treated as absent rather than as a name, because the aggregates already exclude it
 * (`album_ci IS NOT NULL AND album_ci <> ''`) and a group under `''` is a blank row at the top of
 * an album list — the defect `NodeDAO.listRoots` had with the library root.
 */
function albumNameOf(row: AlbumKeyRow): string | null {
  const ci = row.album_ci;
  if (ci === null || ci === '') return null;
  return ci;
}

function albumArtistOf(row: AlbumKeyRow): string | null {
  const ci = row.album_artist_ci;
  if (ci === null || ci === '') return null;
  return ci;
}

/**
 * The key for one row, under one grouping.
 *
 * ### A row with no album tag falls back to its directory
 *
 * Under `album` and `album_artist` a row whose `album` is NULL or empty has no tag to group by,
 * and the alternatives are both wrong: dropping it drops the track out of `search3` and out of
 * `getAlbum`'s answer for it, and grouping it under the empty name puts a blank row at the top of
 * every album list. Its directory is the one identity it certainly has, so that is the key — and
 * it means such a track is **absent from the album lists** (they filter on `album_ci`) while still
 * resolving through `getAlbum` and still carrying an `albumId` on its song, which is what lets a
 * client drill from a track it found by search.
 *
 * ### Three shapes, one per grouping
 *
 * `folder:<dir>`, `album:<album>` and `aa:<artist>:<album>` — the last without the artist half
 * when the tag is absent, which is a *different key string* rather than an absent segment. A
 * trailing `:` would be ambiguous with an album name containing one, so the segment count carries
 * the distinction.
 */
function albumKeySpec(row: AlbumKeyRow, grouping: AlbumGroupingValue): AlbumKeySpec {
  const albumCi = albumNameOf(row);
  if (grouping === AlbumGrouping.Folder || albumCi === null) {
    return { string: `folder:${row.dir_path}`, values: [row.dir_path], predicate: 'dir_path IS ?' };
  }
  if (grouping === AlbumGrouping.Album) {
    return { string: `album:${albumCi}`, values: [albumCi], predicate: 'album_ci = ?' };
  }
  const artistCi = albumArtistOf(row);
  if (artistCi === null) {
    return { string: `aa:${albumCi}`, values: [null, albumCi], predicate: '(album_artist_ci IS ? AND album_ci = ?)' };
  }
  return { string: `aa:${artistCi}:${albumCi}`, values: [artistCi, albumCi], predicate: '(album_artist_ci IS ? AND album_ci = ?)' };
}

/**
 * The fetch half of a key, from the key alone.
 *
 * The counterpart to {@link albumKeySpec}: that derives a key *from a row*, this derives the bound
 * values *from a key*, and `getAlbum`, the starred paths and the search expansion all need the
 * second because they start from an id and hold no row yet. Both go through the same `predicate`
 * strings, so a key that resolves to rows resolves them the same way whichever direction it was
 * asked in.
 *
 * **Total**, and it throws rather than returning `null` — which is the right place for that
 * boundary. Untrusted input is validated by `decodeAlbumKey` in `albumId.ts`, which knows the
 * payload's shape and returns `null` for anything else; by the time a key string exists it is one
 * this module wrote, so a key it cannot parse is a programming error rather than a bad request. A
 * nullable parse here would push a `null` check into four call sites for a case none can reach,
 * and one of them would eventually skip the key — a page silently omitting an album, which is the
 * failure mode the album DAO exists to prevent.
 */
function specFromKey(key: string): AlbumKeySpec {
  const parsed = trySpecFromKey(key);
  if (parsed === null) throw new Error(`Not an album key: ${JSON.stringify(key)}`);
  return parsed;
}

/**
 * The parsing half of {@link specFromKey}, for the one caller that has to survive a bad key:
 * `decodeAlbumKey`. Not exported, because a `null` return is only meaningful next to the validator
 * that produces the key, and exporting it would invite the four checks above.
 */
function trySpecFromKey(key: string): AlbumKeySpec | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const tag = key.slice(0, separator);
  const rest = key.slice(separator + 1);
  if (tag === 'folder') {
    if (rest === '') return null;
    return { string: key, values: [rest], predicate: 'dir_path IS ?' };
  }
  if (tag === 'album') {
    if (rest === '') return null;
    return { string: key, values: [rest], predicate: 'album_ci = ?' };
  }
  if (tag !== 'aa') return null;
  // The album name is the half that may hold a `:`, so it is the half after the **first** one:
  // `Ex-Otogibanashi: deluxe` is a legal album title and must survive a round trip.
  const cut = rest.indexOf(':');
  const artist = cut === -1 ? null : rest.slice(0, cut);
  const album = cut === -1 ? rest : rest.slice(cut + 1);
  if (album === '') return null;
  return { string: key, values: [artist, album], predicate: '(album_artist_ci IS ? AND album_ci = ?)' };
}

export { AlbumGrouping, isAlbumGrouping, albumKeySpec, specFromKey, albumNameOf, ALBUM_GROUPINGS };
export type { AlbumGroupingValue, AlbumKeyRow, AlbumKeySpec };