/**
 * The artist grouping, and the `index` elements it publishes.
 *
 * ### Why this is its own module
 *
 * Because it is **artist** work, not song mapping, and `mappers.ts` is over the soft god-file limit.
 * `groupArtistRows` and `artistIndexGroups` are a pair — rows in, letter-bucketed `index` elements
 * out — and they are the shared half of two endpoints: `getArtists` and the artist section of
 * `getIndexes`. Neither owns them; both need them to agree.
 *
 * `artistNameOf` stays in `mappers.ts` because it is also what a **song** element publishes as its
 * `artist`, and one derivation for both is the point of it being a function.
 */
import { artistElement, artistIdOf, elList } from '@edge-sonic/subsonic';
import type { ElementNode } from '@edge-sonic/subsonic';
import type { SongRow } from '@edge-sonic/backend-data/dao';
import type { AlbumIdentity } from './albumIdentity';
import { artistNameOf, toIso } from './mappers';

/**
 * The sort letter for index grouping, shared by the tag view and the folder view.
 *
 * A leading article is kept in the display name and stripped only from the grouping letter, which is
 * what every client does with `ignoredArticles`. An empty or non-alphabetic first character sorts
 * under `#` rather than into the empty string, which would produce an unnamed group at the top of the
 * list.
 *
 * One function rather than one per endpoint, because two groupings that disagree on the letter put
 * the same artist under `A` in one browse and `#` in the other.
 */
function firstLetterOf(name: string): string {
  const trimmed = name.trim();
  const first = [...trimmed].at(0);
  if (first === undefined) return '#';
  const upper = first.toUpperCase();
  return /^[A-Z]$/.test(upper) ? upper : '#';
}

interface ArtistGroup {
  readonly name: string;
  readonly albums: Set<string>;
  readonly songs: number;
}

/**
 * Song rows → artist groups, sorted by grouping key.
 *
 * The same grouping feeds `getArtists` and the artist half of `getIndexes`, so it lives here rather
 * than in either endpoint: two copies are free to disagree about which name wins, and the
 * disagreement shows up as an artist under two spellings.
 *
 * A real tag wins over a path-derived name, so the first row carrying a tag names the group: a library
 * half-enriched groups under the true name rather than under a guess.
 *
 * @param identityOf **Per row.** An artist's `albums` is a **set of album keys**, and the key is the
 *   grouping's answer — `albumCount` is "how many distinct albums is this artist on", and under a tag
 *   grouping a compilation counts for every artist who contributed a track to it. That is the honest
 *   answer for a library with no `ALBUMARTIST`: the artist page shows the album in full, with the other
 *   artists' tracks on it, because a partial album is the one answer a client cannot render.
 *
 *   Per row because the key names **the row's own library** under `folder` grouping, and `rows` is
 *   the caller's whole granted scope — the same reason `songToModel` takes a resolver.
 */
function groupArtistRows(rows: readonly SongRow[], identityOf: (song: SongRow) => AlbumIdentity): ArtistGroup[] {
  const byName = new Map<string, { name: string; albums: Set<string>; songs: number }>();
  for (const row of rows) {
    const name = row.artist ?? artistNameOf(row);
    const key = name.toLowerCase();
    const albumKey = identityOf(row).keyOf(row);
    const existing = byName.get(key);
    if (existing) {
      existing.albums.add(albumKey);
      existing.songs += 1;
    } else {
      byName.set(key, { name: row.artist ?? name, albums: new Set([albumKey]), songs: 1 });
    }
  }
  return [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}

/**
 * Artist groups → the letter-bucketed `index` elements both browses publish.
 *
 * One construction, because the attribute set is the contract: `getArtists` and `getIndexes` publish
 * the same `id` for the same artist, or a client drilling from one into `getArtist` lands on
 * `code=70`. The `starred` decoration is the caller's — the folder view does not annotate — so it
 * arrives as a lookup rather than as a second construction.
 *
 * `starred` is an epoch **second** and is published through `toIso` like every other timestamp. It
 * used to be `{ starred: undefined }`, which is *not* a decorated flag that decorates nothing:
 * `undefined` is dropped by both serializers, so the attribute did not exist at all on either surface.
 * An artist star is reachable only through here, because `getStarred` deliberately does not expand one
 * into its albums.
 */
function artistIndexGroups(groups: readonly ArtistGroup[], starred: ReadonlyMap<string, number> = new Map()): ElementNode[] {
  const buckets = new Map<string, ElementNode[]>();
  for (const group of groups) {
    const id = artistIdOf(group.name);
    const letter = firstLetterOf(group.name);
    const starredAt = starred.get(id);
    const node = artistElement({
      id,
      name: group.name,
      albumCount: group.albums.size,
      // A client draws one image per artist row from `coverArt` via `getCoverArt`. Omitting it
      // leaves Navic and every other grid client with nothing to request, so the artist list renders
      // as empty tiles even when every album has art. The id itself is the cover id: `getCoverArt`
      // resolves it to the artist's representative album (sidecar first, then embedded tags).
      coverArt: id,
      ...(starredAt !== undefined && { starred: toIso(starredAt) }),
    });
    const existing = buckets.get(letter);
    if (existing) {
      existing.push(node);
    } else {
      buckets.set(letter, [node]);
    }
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([name, artists]) => elList('index', 'artist', { name }, artists));
}

export { artistIndexGroups, groupArtistRows };
export type { ArtistGroup };
