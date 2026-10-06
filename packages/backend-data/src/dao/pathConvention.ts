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
 * ### Three rules, and each one is a bug that shipped without them
 *
 * 1. **It never overwrites a real tag.** `COALESCE(column, derived)` in the same
 *    `ON CONFLICT` clause as the rest of the upsert, so a derived value can only ever
 *    fill a gap. An enrichment pass writes the true value, and nothing this module
 *    produces can take it back — which is what makes it safe to run on every index.
 * 2. **It is a fallback, and the marker is how a client can see that.** Appended to the
 *    name so the string is stable across scans — the same path always derives the same
 *    value, so a rescan rewrites nothing and the incrementality guarantee holds — and so
 *    a guess is not published as though it were a release name.
 * 3. **`title` is not marked**, unlike the grouping. The marker exists so a client can
 *    tell a *release name* from a folder name, and a title is not a release name: the
 *    `X (derived)` album and the tagged `X` are deliberately two albums, whereas the
 *    derived `Title` and the tagged `Title` are one track by any reading, and marking it
 *    would put two spellings of the same song into `search3`. This is why the marker is a
 *    parameter to {@link deriveFromPath} and not to {@link deriveTitleFromFileName}.
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
 * real. `track` and `year` are the same.
 *
 * ### And why `title` is derived here now, when it was not
 *
 * `title` was derived only at **read** time, in `apps/api`'s `mappers.ts`, into the HTTP
 * response — so `title_ci`'s only writer was `applyMetadata`, i.e. an enrichment read.
 * Every row the scan had not range-read therefore held `title = NULL` **and
 * `title_ci = NULL`**, and the absence is invisible per-track for the same reason the rest
 * of this file's absence was: the mapper's filename fallback *displays* a correct title,
 * so the row looks right everywhere it is read one row at a time.
 *
 * It is not right anywhere that reads in SQL. `search3` filters on `title_ci`, so a track
 * was unsearchable by its own title, and `SongMatchDAO.findByAlbumTitle` — how an import
 * resolves a foreign song id — matches on `(album_ci, title_ci)`, where a NULL `title_ci`
 * makes `album_ci = ? AND title_ci = NULL`, which matches no row at all. A measured import
 * reported **113 of 118** starred tracks `not-found` on a library where 102 of them were
 * present under exactly the name it displayed. The metadata fallback is a guess, and a
 * guess that cannot be expressed in the row it guesses *about* is not a fallback.
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
 *
 * ### Version 3 exists because `title` joined the derivation
 *
 * Version 2 derived `artist`/`album`/`album_artist` and not `title`, so a row the indexer
 * wrote held no title at all and the backfill had nothing to correct. Bumping is what
 * re-derives the 88 unenriched rows of the library this was measured on; without the bump
 * those rows would keep `title_ci = NULL` for ever and stay invisible to `search3` and to
 * every import, because the selection is on the stamp rather than on the value.
 */
const DERIVED_VERSION = 3;

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

/**
 * A leading track number and its separator: `01 - `, `01. `, `01_ `, `01) `.
 *
 * Three digits because that is the widest a track number is written in practice, and a
 * wider class would eat the leading digits of a title that is *only* digits — `2001` is a
 * film, and `2001 - ` would otherwise leave it looking like a track number.
 */
const TRACK_PREFIX = /^\d{1,3}\s*[-._)]\s*/;

/**
 * How many prefixes are stripped, and it is **two** rather than "until it stops".
 *
 * `02-03 - Koi Yuki.opus` is disc 2 track 3 written the way a multi-disc release numbers
 * itself, and one strip leaves `03 - Koi Yuki` — which is what five files on the library
 * this was measured on display, and which matches nothing: the remote publishes `Koi Yuki`.
 *
 * A bound rather than a loop to fixpoint because a loop keeps eating a title that is
 * itself numbered: `01 - 02 - Intro` is two prefixes, and `1 - 2 - 3 - 4` is a title. Two
 * is the widest the convention needs, and the loop cannot be trusted to notice the
 * difference — it cannot tell a second prefix from a title that begins with a number.
 */
const MAX_TRACK_PREFIXES = 2;

/**
 * The non-breaking space, U+00A0.
 *
 * Normalized because it is the **same glyph** with the same width, and a library that has
 * one is not a library whose titles differ from the tags: seven files on the measured
 * library carry `MAdEaR …`, `N'o …` and `(-火-)`, while every tag and every
 * remote publishes an ordinary space. Left alone it is a title no query can match, and it
 * is a difference no user can see — which is the worst of both.
 *
 * Normalized on **both** columns rather than on the `_ci` twin alone, because a `_ci` that
 * disagrees with its display value is the drift `SongDAO`'s upsert comment warns about: the
 * row displays one string and answers a different question about another.
 */
const NO_BREAK_SPACE = ' ';

/**
 * What a file's **name** says its title is, or the name itself when that says nothing.
 *
 * The filename, not the path — the directory is {@link deriveFromPath}'s input and this is
 * separate, because the two answer different questions and a track's title is the one thing
 * a WebDAV origin states unconditionally.
 *
 * ### Why this is here and not in the mapper
 *
 * It was in `apps/api`'s `mappers.ts`, applied to the response. That made it invisible to
 * every query: `search3` filters on `title_ci` and the import's `findByAlbumTitle` matches on
 * `(album_ci, title_ci)`, so a row this function "knew" the title of was a row nothing could
 * find. A display fallback that never reaches the row is a comment about a feature.
 *
 * ### The rules, in order
 *
 * 1. **Drop the suffix.** `name` is `basename(path)` and carries it; `suffix` is the column
 *    for it, so the string does not stop at one.
 * 2. **Strip up to {@link MAX_TRACK_PREFIXES} track prefixes.**
 * 3. **Normalize {@link NO_BREAK_SPACE} to a space**, and trim.
 *
 * An empty result falls back to the **name with its suffix**, which is a worse title and a
 * true one: `01.opus` derives to nothing, and `''` is the defect this package has twice
 * already declined to write.
 */
function deriveTitleFromFileName(name: string): string {
  // **The extension, and only when there is one.** The last dot alone is not enough: a stem
  // may contain a dot of its own — `01 - Mr. Lonely.opus` titles as `Mr. Lonely`, not `Mr` —
  // so the suffix is whatever follows the *final* dot **and the name must actually have
  // that suffix**. `Mr. Lonely` has no extension, and cutting it at its dot derives `Mr`.
  //
  // This is also what makes the function idempotent, which the "unchanged rescan costs zero
  // rows" guarantee needs: the second pass is handed `Mr. Lonely`, and a rule that cut at
  // any dot turned it into `Mr` and then into `Mr` for ever.
  const known = KNOWN_SUFFIXES.has(extensionOf(name));
  const stem = known ? name.slice(0, name.lastIndexOf('.')) : name;

  let title = stem;
  for (let stripped = 0; stripped < MAX_TRACK_PREFIXES; stripped += 1) {
    const next = title.replace(TRACK_PREFIX, '').trim();
    if (next === title) break;
    title = next;
  }

  const normalized = title.split(NO_BREAK_SPACE).join(' ').trim();
  return normalized.length > 0 ? normalized : name;
}

/**
 * The last dot's tail, or `''` when there is no dot.
 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * The containers this product indexes.
 *
 * A **closed** list rather than "cut at the last dot", and it is a **transcribed copy** of
 * the `AUDIO_SUFFIXES` that `libraryNames.ts` decides which files to index by. A copy, not
 * an import: `backend-data` is layer 0 and that module is layer 3 above it, and importing it
 * upward would invert the layering this package is below everything else to enforce.
 *
 * The copy is the risk, so it is bounded and asserted rather than assumed: a suffix in one
 * list and not the other costs a title a suffix, and the set below is pinned by
 * `test/schema.int.test.ts` against the same literals. Adding a container means adding it in
 * both places, which is the point — a silent divergence would be the defect.
 */
const KNOWN_SUFFIXES: ReadonlySet<string> = new Set([
  'mp3',
  'flac',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'mp4',
  'aac',
  'wav',
  'wma',
  'aiff',
  'aif',
  'ape',
  'wv',
  'mpc',
  'dsf',
  'dff',
  'alac',
]);

export { DERIVED_VERSION, deriveFromPath, deriveTitleFromFileName };
export type { DerivedNames };