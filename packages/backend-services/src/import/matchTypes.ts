/**
 * The shapes remote-id matching speaks in.
 *
 * Split out of [`matchRemoteIds.ts`](./matchRemoteIds.ts) because these are the module's
 * **contract** rather than its behaviour — what a candidate is, what a verdict is, and the store
 * port between them. They are read by the phase that consumes the verdicts, by the tests that
 * assert them, and by `matchKeys.ts`, and keeping them beside the orchestration meant every one
 * of those readers had to import a module whose first hundred lines were types.
 *
 * `MatchStore` is the port, and it exists so the batching can be reasoned about without D1: two
 * statements per page regardless of size, because a 500-song playlist is 500 single-row lookups
 * against a ceiling that permits 50 per invocation, so an unbatched version would be a guaranteed
 * failure on the very phase that matters most.
 */
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

export type { MatchCandidate, MatchOutcome, MatchStore, MatchStrategy };
