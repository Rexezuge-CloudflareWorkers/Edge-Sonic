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

/**
How a local row was found, so the operator report can say which strategy worked.
*/
type MatchStrategy = 'path' | 'metadata' | null;

/**
One remote song, reduced to what matching needs.
*/
interface MatchCandidate {
  readonly remoteId: string;
  readonly path: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly title: string | null;
  readonly discNumber: number | null;
  readonly track: number | null;
}

/**
The outcome for one remote id, whether it resolved or not.
*/
interface MatchOutcome {
  readonly remoteId: string;
  /**
  The local song id, or `null` when nothing resolved.
  */
  readonly songId: string | null;
  readonly strategy: MatchStrategy;
  /**
   * Why it did not resolve, or `null` when it did.
   *
   * `'ambiguous'` is kept distinct from `'not-found'` because they are different problems
   * with different remedies: a track that is absent needs re-tagging or a rescan, and one
   * that matched two candidates needs the operator to say which they meant.
   */
  readonly reason: 'not-found' | 'ambiguous' | null;
}

/**
What the store has to answer, so a test can supply only this.
*/
interface MatchStore {
  /**
   * Rows whose `path` is one of these, within one library.
   *
   * **Exact and case-sensitive**, and that is not a simplification: a WebDAV origin on Linux
   * is case-sensitive, so `Album/track.flac` and `album/track.flac` are two files and
   * lowercasing would merge them into one match.
   */
  findByPaths(libraryId: LibraryScope, paths: readonly string[]): Promise<SongRow[]>;
  /**
   * Rows whose `(album_ci, title_ci)` is one of these pairs, within one library.
   *
   * One statement per chunk derived from `bindChunkSize`, and **not** one per candidate: a
   * 500-song playlist is 500 single-row lookups against a ceiling that permits 50 per
   * invocation, so an unbatched version would be a guaranteed failure on the very phase that
   * matters most.
   */
  findByAlbumTitle(libraryId: LibraryScope, pairs: ReadonlyArray<readonly [string, string]>): Promise<SongRow[]>;
}

/**
 * Lowercase a tag for comparison, or `null` when absent.
 *
 * Absent rather than `''` deliberately: `''` is a value that would match every other
 * untagged row, and a group under the empty name is the same defect `NodeDAO.listRoots` had
 * with the library root — a blank entry at the top of a list that should not have one.
 */
function ci(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toLowerCase();
}

/**
 * The metadata key for one remote song.
 *
 * `null` when either half is missing, because a key built from a null half matches every row
 * that has the other — a wildcard where a value was required.
 */
function metadataKeyOf(candidate: MatchCandidate): readonly [string, string] | null {
  const album = ci(candidate.album);
  const title = ci(candidate.title);
  if (album === null || title === null) return null;
  return [album, title];
}

/**
 * Narrow candidates by disc and track.
 *
 * Applied only when the remote published both a value and the candidates disagree on it.
 * A remote that omits `track` narrows nothing, and a remote that omits it while the local
 * library has it must not narrow to nothing — which is why the narrowing is skipped
 * entirely rather than applied against `null`.
 */
function narrow(candidates: readonly SongRow[], candidate: MatchCandidate): SongRow[] {
  if (candidates.length <= 1) return [...candidates];

  if (candidate.discNumber !== null) {
    const byDisc = candidates.filter((row) => row.disc === candidate.discNumber);
    // Only narrow when it actually narrowed. A library with no disc tags has `disc = NULL`
    // on every row, and filtering for `1` would empty the set — turning a resolvable match
    // into a reported one, which is the failure this whole module is careful about.
    if (byDisc.length > 0) return byDisc;
  }

  if (candidate.track !== null) {
    const byTrack = candidates.filter((row) => row.track === candidate.track);
    if (byTrack.length > 0) return byTrack;
  }

  return [...candidates];
}

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
 * Resolve a page of remote songs to local ids.
 *
 * One page rather than one song, because the alternative is a statement per song against the
 * same ceiling that makes the batching in `songIdLookup.ts` load-bearing. Two statements per
 * page regardless of size: the path lookup and the metadata lookup.
 */
async function matchRemoteSongs(
  store: MatchStore,
  libraryId: LibraryScope,
  candidates: readonly MatchCandidate[],
): Promise<MatchOutcome[]> {
  const outcomes = new Map<string, MatchOutcome>();
  const unresolved: MatchCandidate[] = [];

  // Deduplicated because a 40-track playlist drawn from a 10-track album repeats every id
  // forty times, and one lookup per *occurrence* is one lookup per play in the worst case.
  const unique = new Map<string, MatchCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.remoteId)) unique.set(candidate.remoteId, candidate);
  }
  const pending = [...unique.values()];

  // --- Strategy one: the path, which is exact. ---
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

  // --- Strategy two: the metadata key, which is a guess and is reported as one. ---
  //
  // **Bucketed, not keyed to one candidate**, because two remote songs can share an
  // `(album, title)` pair — a compilation crediting one title twice, two cuts of a song.
  // This was a `Map<string, MatchCandidate>` whose second `set` **overwrote the first**:
  // the overwritten candidate never entered `pendingByKey`, was therefore never looked
  // up, and was then labelled `not-found` by the catch-all below. A verdict for an item
  // this function never searched, which is the one failure the module exists to
  // prevent — and it is measured, not theoretical: an import reported both copies of one
  // track as `not-found` while the row was indexed under exactly that name.
  //
  // One representative per key still drives the statement, so the batch is unchanged: two
  // candidates sharing a key share a query, and asking twice spends a statement to
  // re-ask the same question.
  const pairs = new Map<string, MatchCandidate[]>();
  for (const candidate of unresolved) {
    const key = metadataKeyOf(candidate);
    if (key === null) continue;
    const composite = `${key[0]}${NUL}${key[1]}`;
    const bucket = pairs.get(composite);
    if (bucket) bucket.push(candidate);
    else pairs.set(composite, [candidate]);
  }

  const pendingByKey = [...pairs.values()].map((bucket) => bucket[0]);
  const rowsByKey = new Map<string, SongRow[]>();
  for (const chunk of chunkArray(pendingByKey, PAIRS_PER_STATEMENT)) {
    const rows = await store.findByAlbumTitle(libraryId, chunk.map(metadataKeyOf).filter((key): key is readonly [string, string] => key !== null));
    for (const row of rows) {
      const key = `${row.album_ci}${NUL}${row.title_ci}`;
      const bucket = rowsByKey.get(key);
      if (bucket) bucket.push(row);
      else rowsByKey.set(key, [row]);
    }
  }

  // **Every** candidate in a bucket, not just its representative. The representative chose
  // the query; it does not get to answer for its twin, because `narrow` reads the
  // candidate's own `discNumber`/`track` and two candidates sharing an `(album, title)`
  // are exactly the pair that can be told apart by those. Resolving the bucket once and
  // copying the outcome would also report `ambiguous` for a pair the narrowing separates,
  // which is the recoverable information this module exists to preserve.
  for (const [composite, bucket] of pairs) {
    const candidates = rowsByKey.get(composite) ?? [];
    for (const candidate of bucket) {
      const rows = narrow(candidates, candidate);
      if (rows.length === 1) {
        outcomes.set(candidate.remoteId, { remoteId: candidate.remoteId, songId: rows[0].id, strategy: 'metadata', reason: null });
      } else if (rows.length > 1) {
        outcomes.set(candidate.remoteId, { remoteId: candidate.remoteId, songId: null, strategy: null, reason: 'ambiguous' });
      } else {
        outcomes.set(candidate.remoteId, { remoteId: candidate.remoteId, songId: null, strategy: null, reason: 'not-found' });
      }
    }
  }

  // Anything with no metadata key and no path never entered either loop.
  for (const candidate of unresolved) {
    if (!outcomes.has(candidate.remoteId)) {
      outcomes.set(candidate.remoteId, { remoteId: candidate.remoteId, songId: null, strategy: null, reason: 'not-found' });
    }
  }

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
return candidates.map((candidate) => outcomes.get(candidate.remoteId) ?? { remoteId: candidate.remoteId, songId: null, strategy: null, reason: 'not-found' as const });
}

export { matchRemoteSongs, metadataKeyOf, narrow, ci };
export type { MatchCandidate, MatchOutcome, MatchStore, MatchStrategy };