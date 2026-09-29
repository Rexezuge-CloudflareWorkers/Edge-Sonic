/**
 * Deriving `artist` and `album` from where a file sits.
 *
 * ### Why this exists, and why it is not an optimization
 *
 * `getArtists`, `getAlbumList2`, `getGenres` and `search3` all filter and group in
 * SQL, on `artist_ci` / `album_ci` / `genre_ci`. A row with those columns NULL is
 * invisible to every one of them — not "shown with a blank artist", *absent*. And
 * those columns are only ever written by a tag read, which costs one ranged WebDAV
 * request per track and is bounded twice over: a chunk spends its subrequest ceiling
 * mostly on `PROPFIND`s, and a track past the per-folder cap keeps `enriched_at =
 * NULL` until somebody opens it individually.
 *
 * So for a library of any size, most rows are unenriched for a long time, and the
 * whole tag-organized half of the protocol answers `[]`. It shipped: a client
 * authenticated against a library of 80 albums and saw empty artists, albums, genres
 * and search, while `getRandomSongs` — which does not group — returned rows with
 * `duration: 0` and no artist.
 *
 * The WebDAV path *already* carries the answer. `Artist/Album/01 Track.flac` names
 * both, and so does the very common `Artist - Album/01 Track.flac`. Writing it at
 * index time means the aggregates are answerable from the first scan, and a real tag
 * read only ever *refines* what the path already said.
 *
 * ### Two rules, and each one is a bug that shipped without them
 *
 * 1. **It never overwrites a real tag.** `COALESCE(column, derived)` in the same
 *    `ON CONFLICT` clause as the rest of the upsert, so a derived value can only ever
 *    fill a gap. An enrichment pass writes the true value, and nothing this module
 *    produces can take it back — which is what makes it safe to run on every index.
 * 2. **It is a fallback, not a guess dressed as a tag.** `derived` is prefixed onto
 *    the artist name so a client can tell a derived grouping from a tagged one, and
 *    so the string is stable across scans: the same path always derives the same
 *    value, so a rescan rewrites nothing and the incrementality guarantee holds.
 *
 * ### What it deliberately does not derive
 *
 * `genre`. There is no path convention for it that is not a guess, and a guessed
 * genre is worse than an absent one — it is offered to the user as though it were
 * real. `track` and `year` are the same. `title` is derived elsewhere, from the
 * filename, because that one is unambiguous and the convention is universal.
 */

/**
 * The marker distinguishing a path-derived grouping from a tagged one.
 *
 * Part of the stored value rather than a separate column, so the aggregates need no
 * join and no extra predicate to answer "is this real or derived?".
 */
const DERIVED_MARKER = ' (derived)';

/**
 * The separator in an `Artist - Album` folder name.
 *
 * A spaced en-dash or hyphen, and only the *first* one: an album titled
 * `Symphony No. 5 - 1949` must not be split into artist `Symphony No. 5` and album
 * `1949`. The first occurrence after a plausible artist name is the convention's,
 * because the artist part cannot itself contain the separator in this layout.
 */
const ALBUM_SEPARATOR = /\s+[-–—]\s+/;

interface DerivedNames {
  readonly artist: string | null;
  readonly album: string | null;
}

/**
 * `Artist/Album` → both names. The ordinary layout.
 */
function fromNestedPath(dirPath: string): DerivedNames {
  const slash = dirPath.lastIndexOf('/');
  if (slash <= 0) {
    // A track directly in an artist folder, or at the library root: there is no album.
    return { artist: dirPath.length > 0 ? mark(dirPath) : null, album: null };
  }
  const album = dirPath.slice(slash + 1);
  const artist = dirPath.slice(0, slash);
  return { artist: artist.length > 0 ? mark(artist) : null, album: album.length > 0 ? album : null };
}

/**
 * `Artist - Album` at the library root → both names.
 *
 * The layout this product's own live library uses: a flat folder per album, named
 * `Artist - Album`, with the tracks inside it. Without this branch every such album
 * would group under an artist literally named `Artist - Album`, which is the shape a
 * user sees when the album list is browsable and the artist list is not — the exact
 * split this module exists to remove.
 */
function fromFlatAlbumFolder(dirName: string): DerivedNames {
  const match = ALBUM_SEPARATOR.exec(dirName);
  if (match === null) return { artist: null, album: dirName };
  const artist = dirName.slice(0, match.index).trim();
  const album = dirName.slice(match.index + match[0].length).trim();
  // A separator at either end is a name that happens to contain a dash, not the
  // convention. `- Album` has no artist and `Artist -` has no album.
  if (artist.length === 0 || album.length === 0) return { artist: null, album: dirName };
  return { artist: mark(artist), album };
}

/**
 * What a file's path says about its artist and album, or `null` for both when the
 * path says nothing usable.
 *
 * `null` rather than an empty string, because the columns are nullable and a caller
 * writing `''` would produce a row that groups under a blank name — which is what
 * `getArtists` renders as an unlabelled entry at the top of the `#` group, the same
 * defect `NodeDAO.listRoots` had with the library root.
 */
function deriveFromPath(dirPath: string): DerivedNames {
  if (dirPath.length === 0) return { artist: null, album: null };

  const slash = dirPath.lastIndexOf('/');
  const dirName = slash === -1 ? dirPath : dirPath.slice(slash + 1);
  // Depth 1: the folder is a top-level `Artist - Album` or a bare album name. Depth 2
  // and deeper: the folder is an album inside an artist folder, and splitting the leaf
  // on a dash would turn `Artist - 2009 Remaster` into an artist called `Artist`.
  const derived = slash === -1 ? fromFlatAlbumFolder(dirName) : fromNestedPath(dirPath);
  if (derived.artist === null && derived.album === null) return derived;
  return derived;
}

function mark(name: string): string {
  return `${name}${DERIVED_MARKER}`;
}

export { DERIVED_MARKER, deriveFromPath };
export type { DerivedNames };
