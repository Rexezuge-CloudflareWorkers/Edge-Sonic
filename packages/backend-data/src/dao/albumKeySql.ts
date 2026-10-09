/**
 * The album key's **SQL** face: how a grouping is written into a `GROUP BY`, and how many keys one
 * statement may bind.
 *
 * ### Why this is a module and not three statements in `songIndex.ts`
 *
 * Because it is the part of the album decision that touches D1, and D1's own rules are the ones
 * that can silently defeat it. Two of the three facts here are invisible in a result:
 *
 * - `album_artist` mode groups on `album_artist_ci` **directly**, so NULL is one group — a missing
 *   album artist is a value, not a wildcard. `COALESCE(album_artist_ci, '')` produces the *same
 *   rows* in the page and in the fetch, and is wrong twice: it cannot use
 *   `idx_songs_album (library_id, album_artist_ci, album_ci)` because there is a function on the
 *   column, and it conflates a genuinely empty tag with an absent one. `GROUP BY` keeps NULL and the
 *   row fetch keeps it too, by binding `null` and comparing with `IS`.
 * - The batch size is **derived** from the grouping rather than written down, because the halves are
 *   not the author's to count: `folder` and `album` bind one variable per group, `album_artist`
 *   binds two, and the constant that measures the failure — D1's 100 — is the one that was wrong
 *   before. 49 groups, not 50, and not the `999` SQLite's own default allows.
 *
 * ### Why `keyOf` rebuilds the key rather than returning a column
 *
 * So the page's membership and the caller's membership are one function of the same columns. The
 * TypeScript grouping reads `albumKeySpec(row, grouping)` and this reads the grouped row; written
 * separately they are free to disagree, and the symptom would be a page holding the wrong number of
 * albums with every individual album looking correct — the defect "one grouping, or two answers to
 * the same question" already records. `test/schema.int.test.ts` holds the fixture that can see it:
 * one directory holding two albums.
 *
 * ### Why the tiebreak is the key columns
 *
 * Because a page boundary needs a **total** order. `dir_path` was not one — a directory can hold two
 * album keys under a tag grouping — so two albums that tie on every `orderBy` term could come back
 * in either order and paging would return one twice or skip it. The key columns are unique per
 * group by construction, which is what makes appending them sufficient.
 */
import { bindChunkSize } from './sqlLimits';
import type { AlbumGroupingValue } from '@edge-sonic/subsonic';

/**
 * One row of the key page: the album's grouping key.
 *
 * **The key, not a directory** — because an album is whatever `ALBUM_GROUP_BY` says it is, and
 * `subsonic/albumKey.ts` is where that is decided. It was `dir_path AS key`, and the folder was
 * load-bearing in a way nothing recorded: `getAlbum`, the starred paths and the cover-art lookup all
 * resolved an album through `songs.dir_path`, so the id, the star table and the artwork key were one
 * identity. That identity is what a tag grouping breaks, deliberately, and the reason it can be
 * broken is that all four now read the key instead.
 *
 * `key_a`/`key_b` rather than named columns because the key's **shape** is the grouping's: one value
 * under `folder` and `album`, two under `album_artist`, and a page row that carried
 * `album_artist_ci` explicitly would have to be `null`-aware per grouping in the reader. The values
 * are positional and are bound in the order `specFromKey` produces them.
 */
interface AlbumKeyRowOut {
  readonly key_a: string | null;
  readonly key_b: string | null;
}

/**
 * Album groups per statement: one variable per key half, plus the `library_id`.
 */
function albumGroupsPerStatement(grouping: AlbumGroupingValue): number {
  return bindChunkSize(grouping === 'album_artist' ? 2 : 1);
}

/**
 * How one grouping is expressed in the key page's SQL.
 */
function albumKeyProjection(grouping: AlbumGroupingValue): {
  readonly select: string;
  readonly groupBy: string;
  readonly orderTiebreak: readonly string[];
  readonly keyOf: (row: AlbumKeyRowOut) => string;
} {
  if (grouping === 'folder') {
    return {
      select: 'dir_path AS key_a, NULL AS key_b',
      groupBy: 'dir_path',
      orderTiebreak: ['dir_path ASC'],
      keyOf: (row) => `folder:${row.key_a ?? ''}`,
    };
  }
  if (grouping === 'album') {
    return {
      select: 'NULL AS key_a, album_ci AS key_b',
      groupBy: 'album_ci',
      orderTiebreak: ['album_ci ASC'],
      keyOf: (row) => `album:${row.key_b ?? ''}`,
    };
  }
  return {
    select: 'album_artist_ci AS key_a, album_ci AS key_b',
    groupBy: 'album_artist_ci, album_ci',
    orderTiebreak: ['album_artist_ci ASC', 'album_ci ASC'],
    // The artist half is the **first** segment after the tag, because an album name may hold a `:`
    // and this is the half that cannot.
    keyOf: (row) => (row.key_a === null ? `aa:${row.key_b ?? ''}` : `aa:${row.key_a}:${row.key_b ?? ''}`),
  };
}

export { albumKeyProjection, albumGroupsPerStatement };
export type { AlbumKeyRowOut };
