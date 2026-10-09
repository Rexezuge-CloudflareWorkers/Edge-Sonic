/**
 * Turning a remote song id into a local one.
 *
 * ### Two strategies, in order, and why path is first
 *
 * **Path, then metadata.** Path is exact — it is a file's identity in a library — and
 * metadata is a guess. So path is tried first and the guess is a fallback.
 *
 * The order is worth stating because it is *backwards from the intuition*. The same product
 * on both sides sounds like it would make ids comparable, and it makes them less comparable:
 * Edge-Sonic ids are `kind:base64url(libraryId \n path)`, so they are reversible and this
 * importer can read a remote Edge-Sonic `s:` id's path directly — **and this server does
 * not publish `Child.path` at all**, on purpose (`builders.ts`: it "leaks the storage
 * layout of someone's WebDAV bucket"). So the exact strategy is available against Navidrome
 * and unavailable against another Edge-Sonic, and the fallback is what carries a
 * same-product migration.
 *
 * ### An unresolved id is reported, never substituted
 *
 * Every unmatched item is returned to the caller by name. A playlist that silently lost
 * three tracks is a **wrong answer** rather than an unfinished one, and nothing downstream
 * could tell it from a playlist the user had deliberately shortened.
 *
 * ### An ambiguous match is NOT resolved
 *
 * Two local songs can share an artist, album and title: a compilation with two discs, a
 * live recording beside the studio cut, a library that holds both a `.flac` and a `.mp3` of
 * the same album. Choosing one is a coin flip that writes a star onto the wrong track, and
 * the operator has no way to find out. So a fallback key matching **more than one** local
 * row resolves to nothing and is reported as ambiguous — which is recoverable information,
 * where a wrong match is not.
 *
 * The one refinement: `discNumber` and `track`, when the remote publishes them, narrow the
 * candidates. So "same album, same title" is refined before it is called ambiguous, rather
 * than being treated as hopeless on first sight.
 */
import { bindChunkSize } from '@edge-sonic/backend-data/dao';
import { chunkArray } from '@edge-sonic/backend-data/dao';
import type { LibraryScope, SongRow } from '@edge-sonic/backend-data/dao';
import { metadataKeyOf, narrow } from './matchKeys';
import type { MatchCandidate, MatchOutcome, MatchStore } from './matchTypes';

/**
Pairs per statement: two bound variables each, plus the `library_id`.
*/
const PAIRS_PER_STATEMENT = bindChunkSize(2);

/**
 * The composite-key separator: a literal NUL.
 *
 * It has to be a byte the **data cannot contain**, because this key is a concatenation of two
 * independent tag values. A space would not do it — `(album: "a b", title: "c")` and `(album: "a",
 * title: "b c")` produce the identical composite, so two different songs would share a bucket and
 * `narrow` would be asked to separate them on disc and track alone. That is the same shape of defect
 * `subsonic/albumId.ts` records for `al:`/`alk:` colliding, where the fix was a structurally
 * disambiguated encoding rather than a delimiter the data could contain. `normalizeRelativePath`
 * refuses control characters in paths, so no title this server derives can hold one.
 *
 * **Written as an escape, and that is the second half of why.** The literal byte was written
 * directly into the template string, which makes the file **binary**: `rg` silently refuses to
 * search it, `git diff` renders it invisibly, and most editors show nothing where the delimiter
 * should be. Two files in this repository were in that state. Every other NUL in the codebase is
 * written as `'\0'` — this constant is the third one, and the only reason it exists.
 */
const NUL = '\0';

/**
The unresolved verdict, in the one place it is built, so its call sites cannot drift.
*/
function notFound(remoteId: string): MatchOutcome {
  return { remoteId, songId: null, strategy: null, reason: 'not-found' };
}

/**
 * The composite map key for a metadata match.
 *
 * A function because both halves of the lookup build this string — the candidate side and the
 * row side — and the two must agree byte for byte or every candidate reads as `not-found`
 * against rows that are present. Written out twice it is a separator that can differ.
 */
function compositeKeyOf([album, title]: readonly [string, string]): string {
  return `${album}${NUL}${title}`;
}

/**
 * Group the unresolved candidates by the `(album, title)` key metadata matching uses.
 *
 * **Bucketed, not keyed to one candidate**, because two remote songs can share an
 * `(album, title)` pair — a compilation crediting one title twice, two cuts of a song. This
 * was a `Map<string, MatchCandidate>` whose second `set` **overwrote the first**: the
 * overwritten candidate never entered the lookup, was therefore never searched, and was then
 * labelled `not-found` by the catch-all. A verdict for an item this function never looked
 * up, which is the one failure the module exists to prevent — and it is measured, not
 * theoretical: an import reported both copies of one track as `not-found` while the row was
 * indexed under exactly that name.
 *
 * A candidate with no metadata key is absent from the map rather than bucketed under a null:
 * it has nothing to be matched on, and the catch-all is what reports it.
 */
function bucketByMetadataKey(candidates: readonly MatchCandidate[]): Map<string, MatchCandidate[]> {
  const pairs = new Map<string, MatchCandidate[]>();
  for (const candidate of candidates) {
    const key = metadataKeyOf(candidate);
    if (key === null) continue;
    const composite = compositeKeyOf(key);
    const bucket = pairs.get(composite);
    if (bucket) bucket.push(candidate);
    else pairs.set(composite, [candidate]);
  }
  return pairs;
}

/**
 * One statement per {@link PAIRS_PER_STATEMENT} distinct keys, and the local rows each key
 * matched, bucketed the same way the candidates were.
 *
 * One representative per key drives the statement, so the batch is unchanged: two candidates
 * sharing a key share a query, and asking twice spends a statement to re-ask the same question.
 */
async function fetchRowsByKey(
  store: MatchStore,
  libraryId: LibraryScope,
  pairs: Map<string, MatchCandidate[]>,
): Promise<Map<string, SongRow[]>> {
  const representatives = [...pairs.values()].map((bucket) => bucket[0]);
  const rowsByKey = new Map<string, SongRow[]>();
  for (const chunk of chunkArray(representatives, PAIRS_PER_STATEMENT)) {
    const rows = await store.findByAlbumTitle(
      libraryId,
      chunk.map((candidate) => metadataKeyOf(candidate)).filter((key): key is readonly [string, string] => key !== null),
    );
    for (const row of rows) {
      // A row with a NULL `album_ci` or `title_ci` is **skipped**, not bucketed under the
      // string `"null"`. `metadataKeyOf` refuses a candidate with either half missing, so every
      // real key is built from two present values — which means a NULL-bearing row was being
      // filed under a key no candidate can produce, except when the other half really was the
      // text `null`: a track titled "null" matched an unenriched row with `title_ci IS NULL`
      // purely because a null had been interpolated into a template literal.
      //
      // Skipping is also the rule the rest of this module already states — an unenriched row
      // carries no name to match on — so the fix removes an accident rather than adding a
      // policy. `title_ci` in particular is populated by path derivation precisely so that a
      // row the enrichment read never reached can still match.
      if (row.album_ci === null || row.title_ci === null) continue;
      const composite = compositeKeyOf([row.album_ci, row.title_ci]);
      const bucket = rowsByKey.get(composite);
      if (bucket) bucket.push(row);
      else rowsByKey.set(composite, [row]);
    }
  }
  return rowsByKey;
}

/**
 * Record one verdict per candidate sharing a key.
 *
 * **Every** candidate in a bucket, not just its representative. The representative chose the
 * query; it does not get to answer for its twin, because `narrow` reads the candidate's own
 * `discNumber`/`track` and two candidates sharing an `(album, title)` are exactly the pair
 * that can be told apart by those. Resolving the bucket once and copying the outcome would also
 * report `ambiguous` for a pair the narrowing separates, which is the recoverable information
 * this module exists to preserve.
 */
function resolveBucket(outcomes: Map<string, MatchOutcome>, bucket: readonly MatchCandidate[], rows: readonly SongRow[]): void {
  for (const candidate of bucket) {
    const narrowed = narrow(rows, candidate);
    if (narrowed.length === 1) {
      outcomes.set(candidate.remoteId, { remoteId: candidate.remoteId, songId: narrowed[0].id, strategy: 'metadata', reason: null });
    } else if (narrowed.length > 1) {
      outcomes.set(candidate.remoteId, { remoteId: candidate.remoteId, songId: null, strategy: null, reason: 'ambiguous' });
    } else {
      outcomes.set(candidate.remoteId, notFound(candidate.remoteId));
    }
  }
}

/**
 * Strategy two: the metadata key, which is a guess and is reported as one.
 */
async function matchByMetadata(
  store: MatchStore,
  libraryId: LibraryScope,
  outcomes: Map<string, MatchOutcome>,
  unresolved: readonly MatchCandidate[],
): Promise<void> {
  const pairs = bucketByMetadataKey(unresolved);
  const rowsByKey = await fetchRowsByKey(store, libraryId, pairs);
  for (const [composite, bucket] of pairs) {
    resolveBucket(outcomes, bucket, rowsByKey.get(composite) ?? []);
  }

  // Anything with no metadata key and no path never entered either loop.
  for (const candidate of unresolved) {
    if (!outcomes.has(candidate.remoteId)) {
      outcomes.set(candidate.remoteId, notFound(candidate.remoteId));
    }
  }
}

/**
 * Strategy one: the path, which is exact.
 *
 * Returns the candidates the path did **not** resolve rather than the ones it did. That
 * direction is deliberate: every later step is about the leftovers, so returning the leftovers
 * means the caller reads one list instead of comparing two.
 */
async function matchByPath(
  store: MatchStore,
  libraryId: LibraryScope,
  outcomes: Map<string, MatchOutcome>,
  pending: readonly MatchCandidate[],
): Promise<MatchCandidate[]> {
  const unresolved: MatchCandidate[] = [];
  const withPath = pending.filter((candidate) => candidate.path !== null && candidate.path.length > 0);
  const byPath = await store.findByPaths(
    libraryId,
    withPath.map((candidate) => candidate.path as string),
  );
  const pathIndex = new Map<string, SongRow>();
  for (const row of byPath) pathIndex.set(row.path, row);

  for (const candidate of pending) {
    if (candidate.path === null) {
      unresolved.push(candidate);
      continue;
    }
    const row = pathIndex.get(candidate.path);
    if (row) {
      outcomes.set(candidate.remoteId, { remoteId: candidate.remoteId, songId: row.id, strategy: 'path', reason: null });
    } else {
      // A path that does not resolve falls through to metadata rather than being reported
      // immediately: the remote's path is relative to *its* music folder and ours to ours,
      // so two servers pointed at the same bucket from different roots will disagree on the
      // prefix while agreeing completely on the file.
      unresolved.push(candidate);
    }
  }
  return unresolved;
}

/**
 * Resolve a page of remote songs to local ids.
 *
 * One page rather than one song, because the alternative is a statement per song against the
 * same ceiling that makes the batching in `songIdLookup.ts` load-bearing. Two statements per
 * page regardless of size: the path lookup and the metadata lookup.
 *
 * Three steps and one projection, in the order their confidence decreases — path, then
 * metadata, then the catch-all — and each is a named function so the order is readable rather
 * than inferred from the shape of one long body.
 */
async function matchRemoteSongs(
  store: MatchStore,
  libraryId: LibraryScope,
  candidates: readonly MatchCandidate[],
): Promise<MatchOutcome[]> {
  const outcomes = new Map<string, MatchOutcome>();

  // Deduplicated because a 40-track playlist drawn from a 10-track album repeats every id
  // forty times, and one lookup per *occurrence* is one lookup per play in the worst case.
  const unique = new Map<string, MatchCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.remoteId)) unique.set(candidate.remoteId, candidate);
  }
  const pending = [...unique.values()];

  const unresolved = await matchByPath(store, libraryId, outcomes, pending);
  await matchByMetadata(store, libraryId, outcomes, unresolved);

  /**
   * One outcome per **occurrence**, not per distinct id.
   *
   * The lookups are de-duplicated — a 40-track playlist drawn from a 10-track album repeats every
   * id four times, and one lookup per occurrence is one lookup per play in the worst case — but the
   * *result* is not. A playlist legitimately lists the same track twice, and returning one outcome
   * for two entries would drop the repeat and produce a **shorter playlist** than the remote
   * described: a wrong answer rather than an unfinished one, and indistinguishable from a list the
   * user deliberately trimmed.
   */
  return candidates.map((candidate) => outcomes.get(candidate.remoteId) ?? notFound(candidate.remoteId));
}

export { matchRemoteSongs };
// Re-exported so the published surface of this module is unchanged by the split. A caller
// importing `metadataKeyOf` from here keeps working, and `test/import-matching.test.ts` keeps
// asserting against the same path it did.
export { ci, metadataKeyOf, narrow } from './matchKeys';
// Re-exported so the published surface is unchanged by the split.
export type { MatchCandidate, MatchOutcome, MatchStore, MatchStrategy } from './matchTypes';
