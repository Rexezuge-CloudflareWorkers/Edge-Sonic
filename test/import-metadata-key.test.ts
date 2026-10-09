import { describe, expect, it } from 'vitest';
import { matchRemoteSongs } from '@edge-sonic/backend-services/import/matchRemoteIds';
import type { MatchCandidate, MatchStore, MatchOutcome } from '@edge-sonic/backend-services/import/matchRemoteIds';
import type { LibraryScope, SongRow } from '@edge-sonic/backend-data/dao';

/**
 * The metadata fallback's bucket key, and what a `NULL` column does to it.
 *
 * `test/import-matching.test.ts` covers the matching decisions. This covers the one thing that
 * decision rests on and that no decision-level test can catch: that the candidate side and the
 * row side of the bucket key are built the same way, and that neither files a missing name
 * under the text `"null"`.
 *
 * The defect this pins was real and is the shape this repository keeps finding. The row side
 * read `compositeKeyOf([row.album_ci, row.title_ci])` where both columns are `string | null`,
 * and interpolating a null yields the four characters `null`. So a row that had never been
 * enriched — `title_ci IS NULL` — sat in the bucket spelled `album\0null`, and a remote song
 * whose title was literally the word "null" found it there and matched. Every other title read
 * as `not-found` against a row that was present under exactly the name the mapper was
 * displaying to the user throughout, which is the same measured 113-of-118 shape the guide
 * records for a missing `title_ci`.
 */

/**
A `LibraryScope` is one library id or a list of them — a string, not an object.
*/
const LIBRARY: LibraryScope = 'lib-1';

function row(overrides: Partial<SongRow> & { id: string; path: string }): SongRow {
  return {
    album_ci: null,
    title_ci: null,
    disc: null,
    track: null,
    ...overrides,
  } as SongRow;
}

/**
A store that answers the path lookup with nothing and the metadata lookup with `rows`.
*/
function storeReturning(rows: readonly SongRow[]): MatchStore {
  return {
    findByPaths: async () => [],
    findByAlbumTitle: async () => [...rows],
  };
}

function candidate(overrides: Partial<MatchCandidate> & { remoteId: string }): MatchCandidate {
  return {
    path: null,
    album: null,
    title: null,
    discNumber: null,
    track: null,
    ...overrides,
  } as MatchCandidate;
}

const byRemoteId = (outcomes: readonly MatchOutcome[]): Map<string, MatchOutcome> => new Map(outcomes.map((o) => [o.remoteId, o]));

describe('the metadata bucket key', () => {
  it('matches a row whose both columns are present', async () => {
    const outcomes = await matchRemoteSongs(
      storeReturning([row({ id: 's1', path: 'a.flac', album_ci: 'abbey road', title_ci: 'come together' })]),
      LIBRARY,
      [candidate({ remoteId: 'r1', album: 'Abbey Road', title: 'Come Together' })],
    );

    expect(byRemoteId(outcomes).get('r1')).toEqual({ remoteId: 'r1', songId: 's1', strategy: 'metadata', reason: null });
  });

  it('reports not-found for an unenriched row rather than matching on the text "null"', async () => {
    // The defect. `title_ci IS NULL` used to become the bucket `album\0null`, and a remote
    // title of "null" found it. Nothing else in the file could see this: the row is present,
    // the query is correct, and every other title read as absent.
    const outcomes = await matchRemoteSongs(
      storeReturning([row({ id: 's1', path: 'a.flac', album_ci: 'album', title_ci: null })]),
      LIBRARY,
      [candidate({ remoteId: 'r1', album: 'Album', title: 'null' })],
    );

    expect(byRemoteId(outcomes).get('r1')).toEqual({ remoteId: 'r1', songId: null, strategy: null, reason: 'not-found' });
  });

  it('reports not-found when the album column is the missing one', async () => {
    const outcomes = await matchRemoteSongs(
      storeReturning([row({ id: 's1', path: 'a.flac', album_ci: null, title_ci: 'come together' })]),
      LIBRARY,
      [candidate({ remoteId: 'r1', album: 'null', title: 'Come Together' })],
    );

    expect(byRemoteId(outcomes).get('r1')).toEqual({ remoteId: 'r1', songId: null, strategy: null, reason: 'not-found' });
  });

  it('still matches a fully present row whose name really is "null"', async () => {
    // The other half of the same case, and the reason the fix skips NULL-bearing rows rather
    // than banning the word: a track genuinely titled "null" must still resolve.
    const outcomes = await matchRemoteSongs(
      storeReturning([row({ id: 's1', path: 'a.flac', album_ci: 'album', title_ci: 'null' })]),
      LIBRARY,
      [candidate({ remoteId: 'r1', album: 'Album', title: 'null' })],
    );

    expect(byRemoteId(outcomes).get('r1')).toEqual({ remoteId: 'r1', songId: 's1', strategy: 'metadata', reason: null });
  });

  it('builds the candidate and row keys identically, so a separator cannot differ between them', async () => {
    // An album named "A" and a title of "B\0C" must not collide with an album named "A\0B"
    // and a title of "C". The NUL separator exists to prevent exactly that, and the only way
    // it holds is if both sides use one builder.
    const outcomes = await matchRemoteSongs(storeReturning([row({ id: 's1', path: 'a.flac', album_ci: 'a', title_ci: 'b' })]), LIBRARY, [
      candidate({ remoteId: 'r1', album: 'A', title: 'B' }),
    ]);

    expect(byRemoteId(outcomes).get('r1')?.songId).toBe('s1');
  });

  it('does not let a blank album or title become a matchable key', async () => {
    // `ci` maps an empty string to `null` precisely so an absent tag is absent. Without that,
    // an untagged remote song would share the bucket of every untagged local row.
    const outcomes = await matchRemoteSongs(storeReturning([row({ id: 's1', path: 'a.flac', album_ci: '', title_ci: '' })]), LIBRARY, [
      candidate({ remoteId: 'r1', album: '', title: '' }),
    ]);

    expect(byRemoteId(outcomes).get('r1')?.reason).toBe('not-found');
  });
});
