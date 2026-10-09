/**
 * The **pure** half of remote-id matching: how a tag is normalized, what key two names make,
 * and when a set of local rows is narrow enough to pick from.
 *
 * Split out of [`matchRemoteIds.ts`](./matchRemoteIds.ts) because the two halves fail
 * differently and are worth being able to read separately. Everything here is a function of its
 * arguments: no store, no `await`, no statement. Everything there is the orchestration that
 * spends statements — the batching that has to fit one invocation's subrequest ceiling, and the
 * ordering of two strategies by confidence.
 *
 * The separation is also what makes these rules testable without a double. The decisions that
 * are easiest to get wrong — an absent tag becoming a matchable key, a narrowing that empties a
 * set rather than separating it — are all here, and none of them needs a `MatchStore` to reach.
 */
import type { SongRow } from '@edge-sonic/backend-data/dao/rows';
import type { MatchCandidate } from './matchRemoteIds';

/**
 * Lowercase a tag for comparison, or `null` when absent.
 *
 * The empty string maps to `null` rather than to `''` deliberately. A remote song that publishes
 * no album must not share a bucket with every locally-unalbumed row: `''` is a value that can
 * match, `null` cannot. The whole point of this normalization is that "no album" and "the album
 * whose name is the empty string" are the same thing, and neither of them is a name.
 *
 * Trimmed as well as lowercased. `EnvParser` does not trim for us on the metadata path, and a
 * tag written as ` Abbey Road ` against a stored `abbey road` is a match a listener would
 * recognize and a string comparison would miss.
 */
function ci(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * The `(album, title)` key metadata matching uses, or `null` when either half is absent.
 *
 * `null` is the only answer for an untagged candidate, and it means "this item has no key to
 * be matched on" — not "match it against untagged rows". A test that treats it as the latter
 * would find a local library with no tags and report every remote song as matched.
 */
function metadataKeyOf(candidate: MatchCandidate): readonly [string, string] | null {
  const album = ci(candidate.album);
  const title = ci(candidate.title);
  if (album === null || title === null) return null;
  return [album, title];
}

/**
 * Narrow candidates by disc, then by track.
 *
 * A loop rather than recursion because there are only ever two narrowing keys: each is tried at
 * most once, and the recursive form re-entered the function to discover it had nothing left to
 * try. The order is disc then track because a disc is the coarser grouping — narrowing by track
 * first would throw away every candidate on another disc of the same album, and a track number
 * is unique *within* a disc, not within an album.
 *
 * Applied only when the remote published both a value and the candidates disagree on it. A
 * remote that omits `track` narrows nothing, and a remote that omits it while the local library
 * has it must not narrow to nothing — which is why the narrowing is skipped entirely rather than
 * applied against `null`.
 */
function narrow(candidates: readonly SongRow[], candidate: MatchCandidate): SongRow[] {
  let narrowed = candidates;

  if (narrowed.length > 1 && candidate.discNumber !== null) {
    const byDisc = narrowed.filter((row) => row.disc === candidate.discNumber);
    // Only narrow when it actually narrowed. A library with no disc tags has `disc = NULL` on
    // every row, and filtering for `1` would empty the set — turning a resolvable match into a
    // reported one, which is the failure this whole module is careful about.
    if (byDisc.length > 0 && byDisc.length < narrowed.length) narrowed = byDisc;
  }

  if (narrowed.length > 1 && candidate.track !== null) {
    const byTrack = narrowed.filter((row) => row.track === candidate.track);
    if (byTrack.length > 0 && byTrack.length < narrowed.length) narrowed = byTrack;
  }

  return [...narrowed];
}

export { ci, metadataKeyOf, narrow };
