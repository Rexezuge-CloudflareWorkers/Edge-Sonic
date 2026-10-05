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
 * 2. **It is a fallback, and the marker is how a client can see that.** Appended to the
 *    name so the string is stable across scans — the same path always derives the same
 *    value, so a rescan rewrites nothing and the incrementality guarantee holds — and so
 *    a guess is not published as though it were a release name.
 *
 * ### Why deriving at index time was not enough on its own
 *
 * Every writer of these columns is gated on the file having *changed* — the root
 * `Depth: 0` probe, `isScanned: !changed`, `if (changed)` in `reconcileFolder`, and the
 * read-through `getMusicDirectory` path. So for an already-indexed library the
 * derivation never ran at all, and the aggregates stayed empty: 113 rows, every one
 * indexed before the deploy, every one with `album_ci` NULL. It was invisible per-track
 * because the song mapper falls back to the folder name for display, so `getRandomSongs`
 * returned rows that *looked* tagged while every SQL-filtered aggregate saw NULL.
 *
 * `songDerivation.ts` therefore runs the same function over rows the indexer will never
 * touch, selected on `derived_version` rather than on the value. Deriving in SQL was
 * rejected: it would be a second implementation of this module, free to disagree with
 * it, which is the "a double that shares a wrong assumption" failure in a place where
 * nothing would notice.
 *
 * ### What it deliberately does not derive
 *
 * `genre`. There is no path convention for it that is not a guess, and a guessed
 * genre is worse than an absent one — it is offered to the user as though it were
 * real. `track` and `year` are the same. `title` is derived elsewhere, from the
 * filename, because that one is unambiguous and the convention is universal.
 */

/**
 * Which version of this convention wrote a row's grouping.
 *
 * ### Bump this whenever the derivation changes
 *
 * Because "the column is NULL" cannot express a *corrected* convention. Once an earlier
 * derivation has written a value, the columns are no longer NULL, so a later and better
 * `deriveFromPath` could never reach the rows the earlier one wrote. That is the
 * `reader_version` defect one layer down: a corrected **reader** could not re-read an
 * existing library, and without this a corrected **derivation** would not re-derive one.
 *
 * The backfill selects on this stamp rather than on the value, so bumping it re-derives
 * everything, and the `grouping_source` guard keeps a real tag winning over both.
 *
 * ### Version 2 exists because the marker became configuration
 *
 * Version 1 wrote `' (derived)'` and recognised its own guesses by reading that suffix
 * back out of the stored value. An operator cannot choose that string and still have the
 * recognition work — an empty marker matches everything and any other marker is a `LIKE`
 * pattern — so provenance moved to `songs.grouping_source` and the marker became purely
 * presentational. See `groupingSource.ts` for the measurements.
 *
 * The bump is what migrates an existing library: every row is re-selected once, a row the
 * column calls derived is rewritten with the configured marker, and a row holding a tag is
 * selected, declined, and stamped. Without it the deployment would run two conventions at
 * once and the aggregates would answer from whichever one happened to be nearer.
 */
const DERIVED_VERSION = 2;

/**
 * Whitespace, as the engine defines it.
 *
 * `\S` rather than a hand-copied list of code points, so the class stays one shared fact
 * and this module cannot drift from what `\s` meant — the same reason the DAOs run against
 * `node:sqlite` rather than against a double. It has no quantifier, so it is linear on the
 * one-character strings it is handed here.
 */
const NON_SPACE = /\S/;

/**
 * `-`, `–` (U+2013), `—` (U+2014).
 */
const HYPHEN = 0x2d;
const EN_DASH = 0x20_13;
const EM_DASH = 0x20_14;

/**
 * The separator in an `Artist - Album` folder name.
 *
 * A spaced en-dash or hyphen, and only the *first* one: an album titled
 * `Symphony No. 5 - 1949` must not be split into artist `Symphony No. 5` and album
 * `1949`. The first occurrence after a plausible artist name is the convention's,
 * because the artist part cannot itself contain the separator in this layout.
 *
 * **The index of the dash, not the regex's match index — and that is what makes the scan
 * below equivalent.** Both sides of the split are `.trim()`ed by the caller, so the *extent*
 * of either whitespace run cannot change the answer; `slice(0, dashIndex)` is
 * `slice(0, match.index)` after a trim. A regex would have had to consume the runs to find
 * them, which is the expensive part.
 *
 * **Which is also the DoS.** `/\s+[-–—]\s+/.exec(dirName)` is quadratic: one unbounded `\s+`
 * followed by a character that can fail is enough, because for each of the *n* start
 * positions inside a run of *n* spaces the engine retries every run length. 16 KB of folder
 * name costs ~280 ms and 100 KB costs ~11 s, against a 10 ms CPU limit on Workers Free. The
 * name reached this module from an untrusted `DAV:href` and is re-read on every upsert and on
 * every backfill poll, so one hostile `PROPFIND` is an invocation the runtime kills. `[gimsuy]`
 * cannot fix it — JavaScript has no possessive quantifier or atomic group — which is why the
 * fix is a scan and not a flag. `test/redos-linear-parsing.test.ts` asserts the equivalence
 * and bounds the worst case, because the two analysers this repository already runs both
 * miss this shape and a green lint was never evidence about it.
 *
 * Note the shape the adversarial input has to take: a run of spaces **followed by a
 * non-dash**. A run that ends in a dash matches on the first attempt and costs nothing, so
 * `' '.repeat(n) + '- Album'` is cheap and `' '.repeat(n) + 'a'` is not.
 */
function findAlbumSeparator(dirName: string): number {
  // The bounds keep `i - 1` and `i + 1` in range, so a separator cannot sit at either end
  // and no sentinel comparisons are needed. That is also the convention's own rule: `- Album`
  // has no artist and `Artist -` has no album.
  for (let i = 1; i + 1 < dirName.length; i++) {
    const code = dirName.charCodeAt(i);
    if (code !== HYPHEN && code !== EN_DASH && code !== EM_DASH) continue;
    // Whitespace on **both** sides is the convention; a dash with a non-space on either
    // side is just a dash in a word, which is most of them.
    if (NON_SPACE.test(dirName.charAt(i - 1)) || NON_SPACE.test(dirName.charAt(i + 1))) continue;
    return i;
  }
  return -1;
}

interface DerivedNames {
  readonly artist: string | null;
  readonly album: string | null;
}

/**
 * `Artist/Album` → both names. The ordinary layout.
 */
function fromNestedPath(dirPath: string, marker: string): DerivedNames {
  const slash = dirPath.lastIndexOf('/');
  if (slash <= 0) {
    // A track directly in an artist folder, or at the library root: there is no album.
    return { artist: dirPath.length > 0 ? mark(dirPath, marker) : null, album: null };
  }
  const album = dirPath.slice(slash + 1);
  const artist = dirPath.slice(0, slash);
  return { artist: artist.length > 0 ? mark(artist, marker) : null, album: album.length > 0 ? mark(album, marker) : null };
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
function fromFlatAlbumFolder(dirName: string, marker: string): DerivedNames {
  const separator = findAlbumSeparator(dirName);
  if (separator === -1) return { artist: null, album: dirName };
  const artist = dirName.slice(0, separator).trim();
  const album = dirName.slice(separator + 1).trim();
  // A separator at either end is a name that happens to contain a dash, not the
  // convention. `- Album` has no artist and `Artist -` has no album.
  if (artist.length === 0 || album.length === 0) return { artist: null, album: dirName };
  return { artist: mark(artist, marker), album: mark(album, marker) };
}

/**
 * What a file's path says about its artist and album, or `null` for both when the
 * path says nothing usable.
 *
 * `null` rather than an empty string, because the columns are nullable and a caller
 * writing `''` would produce a row that groups under a blank name — which is what
 * `getArtists` renders as an unlabelled entry at the top of the `#` group, the same
 * defect `NodeDAO.listRoots` had with the library root.
 *
 * ### `marker` is a parameter, and it is not defaulted
 *
 * Because the marker's emptiness is a **decision**: an empty marker is what makes a
 * derived `X` and a tagged `X` the same album rather than two releases that differ only
 * in a suffix, and that is `DERIVED_MARKER`'s configured answer rather than a fallback.
 * A default here would reintroduce the "a module constant that silently wins" hazard in
 * the one place where two spellings of the same question must never coexist.
 *
 * Read from configuration at the composition root and threaded down by constructor —
 * `backend-data` is layer 0 and cannot import the configuration layer.
 */
function deriveFromPath(dirPath: string, marker: string): DerivedNames {
  if (dirPath.length === 0) return { artist: null, album: null };

  const slash = dirPath.lastIndexOf('/');
  const dirName = slash === -1 ? dirPath : dirPath.slice(slash + 1);
  // Depth 1: the folder is a top-level `Artist - Album` or a bare album name. Depth 2
  // and deeper: the folder is an album inside an artist folder, and splitting the leaf
  // on a dash would turn `Artist - 2009 Remaster` into an artist called `Artist`.
  const derived = slash === -1 ? fromFlatAlbumFolder(dirName, marker) : fromNestedPath(dirPath, marker);
  if (derived.artist === null && derived.album === null) return derived;
  return derived;
}

function mark(name: string, marker: string): string {
  return `${name}${marker}`;
}

export { DERIVED_VERSION, deriveFromPath };
export type { DerivedNames };