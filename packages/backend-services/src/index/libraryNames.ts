/**
 * The vocabulary of a music library: what counts as a track, and what a path says.
 *
 * ### Why these are here rather than in `TreeService`
 *
 * Because the scan needed all of them and `TreeService` was the wrong place to reach for them.
 * `scanFolder.ts` imports `basename`, `isAudioFile` and `suffixOf` from this module already — which
 * is a **folder walk depending on a browse module** for three string helpers, and it is what pushed
 * that file to the god-file limit once its budget's own accounting landed in it.
 *
 * `TreeService` and `scanFolder` are two callers of one set of definitions, so the definitions
 * belong beside neither. And they are not arbitrary: the suffix set is what decides whether a
 * WebDAV entry reaches the index at all, and `cover.jpg` versus `folder.png` is a difference a music
 * library user makes deliberately — Picard and beets pick which, and this module probes in the order
 * they are declared.
 *
 * The remaining two — `parentOf` and `depthOf` — are here for the same reason and are load-bearing
 * in one specific way: `depthOf` is what `nodes.depth` is, and a row whose `depth` disagrees with
 * its `path` is one the frontier orders wrongly. `listFrontier` sorts by `depth ASC`, so an
 * off-by-one here reorders the whole walk rather than corrupting one row.
 */

/**
 * File suffixes the indexer treats as playable audio.
 *
 * `mp4` and `m4a` are both present because a `.mp4` container holding audio is what a phone records
 * and what some rippers emit; the container is not the question, the suffix is.
 */
const AUDIO_SUFFIXES: ReadonlySet<string> = new Set([
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

/**
 * Cover art filenames probed in an album folder, in preference order.
 *
 * An **order**, not a set. Album folders routinely contain both a `folder.png` and a `cover.jpg`,
 * and the user picked which; probing in this order is the whole claim, and a set would make it
 * arbitrary.
 */
const COVER_NAMES: readonly string[] = ['cover', 'folder', 'front', 'album', 'albumart', 'thumb'];

/**
 * Whether this entry name is an audio track the indexer will hold.
 *
 * `lastIndexOf` and not `split`, so a name containing a dot in the stem — `Mr. Bungle.flac` — is
 * judged on its real extension. A folder named `mp3` is *not* a track: `dot <= 0` rejects a name
 * with no dot, and an empty suffix is rejected by the set lookup.
 */
function isAudioFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? false : AUDIO_SUFFIXES.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The lowercase extension, or `''` when there is none.
 *
 * Lowercased because `isAudioFile` is, so `SONG.FLAC` and `song.flac` cannot take different paths
 * through the index — a comparison that is case-sensitive on one side and not the other is how a
 * library ends up with some of its tracks indexed and some merely browsable.
 */
function suffixOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * The parent path, or `''` for a top-level entry.
 *
 * `''` is a real parent here rather than a sentinel: it is the library root, and `nodes.parent_path`
 * stores it as such, so a top-level folder and the root agree rather than disagreeing about a value
 * that means "up".
 */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * Segments in a path, which is what `nodes.depth` counts.
 *
 * Zero for the library root, so `depth` orders the walk shallowest-first and a root is the only row
 * at zero. See the module header for why an off-by-one here is a walk-ordering defect rather than a
 * cosmetic one.
 */
function depthOf(path: string): number {
  return path.length === 0 ? 0 : path.split('/').length;
}

/**
 * The last segment of a path.
 *
 * Not `split('/').pop()`, which allocates an array for every entry of every listing. On a cold scan
 * of a 5,000-track library that is called 5,000 times per folder walk, against a 10 ms CPU limit.
 */
function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export {
  AUDIO_SUFFIXES,
  COVER_NAMES,
  isAudioFile,
  suffixOf,
  parentOf,
  depthOf,
  basename,
};