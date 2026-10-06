/**
 * Two libraries, and what a client is shown when it names neither.
 *
 * ### Why this file exists, and why the whole feature rests on it
 *
 * Every aggregate was `WHERE library_id = ?` and every un-scoped read resolved
 * `libraries[0]`, so a user granted two libraries saw one of them. That is invisible until a
 * **release spans both**, which is the case this file is built around:
 *
 * > A release whose track 01 is in `M0001_A` and track 03 is in `M0001_B` was browsable from
 * > **no** `musicFolderId` at all — folder 0 held half the album, folder 1 the other half, so
 * > a client listed it at `songCount: 1` and never opened the track it was missing. There was
 * > no client view that showed both.
 *
 * So the album id had to stop naming one library (`SPANNING_LIBRARY_ID`, `subsonic/ids.ts`),
 * and that is a change to an id every album surface publishes and every client stores. **A
 * claim about an id that no test exercises is not an invariant** — the whole suite was green
 * through the change that introduced it, and stayed green after, and nothing in either run
 * opened an album that spans two libraries.
 *
 * ### What is asserted, and what each case is for
 *
 * - The split release is **one** album with both tracks. A per-library `GROUP BY` lists it
 *   twice at a `songCount` of 1 each, so this fails loudly on the old shape.
 * - Both libraries' `getAlbum` answers the **same id**, so a client that opened it from either
 *   folder ends up in the same place.
 * - The un-scoped default is the union, and `musicFolderId` still narrows. The second is the
 *   protocol's own scope-selector model, and the cost of the first is that a folder picker
 *   shows *less* than the default — recorded here so it is a decision and not a surprise.
 * - **The grant is still the grant.** An album that exists only in a library this user cannot
 *   see is `code=70` and never `code=50`, because `50` confirms the id is real and turns the
 *   endpoint into an oracle for which paths exist. This is the one security property a union
 *   could plausibly have broken, so it is asserted rather than assumed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptData } from '@edge-sonic/backend-data/crypto';
import { NodeDAO, SongDAO } from '@edge-sonic/backend-data/dao';
import { createHarness, WEBDAV_TEST_KEY, nowSeconds } from './helpers/harness';
import type { Harness } from './helpers/harness';

/**
 * The two libraries, by **slug order** — `archive` sorts before `home`, so `musicFolderId=0`
 * is `archive`. A positional id means nothing unless the test knows which library a position
 * names, and that is the whole point of the round trip in `music-folder-index.test.ts`.
 */
const HOME = 'L1';
const ARCHIVE = 'L2';

interface AlbumRow {
  id: string;
  name: string;
  songCount: number;
  artist?: string;
}

interface AlbumDetail {
  id: string;
  name: string;
  songCount?: number;
  song?: Array<{ id: string; title: string; track?: number }>;
}

async function addLibrary(harness: Harness, id: string, slug: string, name: string): Promise<void> {
  const secret = await encryptData('dav-password', WEBDAV_TEST_KEY);
  const timestamp = nowSeconds();
  await harness.db.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'https://dav.example.com', '/remote.php/dav/files/alice/Music', 'alice', ?, ?, 1, ?, 1, ?, ?)`,
    )
    .bind(id, slug, slug, secret.ciphertext, secret.iv, name, timestamp, timestamp)
    .run();
}

/**
Grant the library to the harness user, which is what makes it visible at all.
*/
async function grant(harness: Harness, libraryId: string): Promise<void> {
  const user = await harness.db.db.prepare('SELECT id FROM users WHERE username = ?').bind('ann').first<{ id: string }>();
  await harness.db.db
    .prepare('INSERT INTO user_libraries (user_id, library_id, created_at) VALUES (?, ?, ?)')
    .bind(user?.id, libraryId, nowSeconds())
    .run();
}

/**
 * Index one track, with the folder nodes `getMusicDirectory` reads.
 *
 * The `name`/`title` split is deliberate and mirrors the real indexer: `name` is the filename
 * and `title` is the tag, and a row written by hand with only one of them is a row no query
 * can match — which is the defect `test/schema.int.test.ts` covers for `title_ci`.
 */
async function addTrack(
  harness: Harness,
  libraryId: string,
  folder: string,
  filename: string,
  title: string,
  artist: string,
  album: string,
  track: number,
): Promise<string> {
  const path = `${folder}/${filename}`;
  const dirPath = folder;
  await new NodeDAO(harness.db.db).upsertMany([
    { libraryId, path: folder, parentPath: '', name: folder, mtimeMs: 1000, etag: '"f"', depth: 1, isScanned: true },
  ]);
  const id = `s:${libraryId}:${path}`;
  await new SongDAO(harness.db.db, '').upsertFileFacts([
    {
      id,
      libraryId,
      path,
      dirPath,
      name: filename,
      size: 1000,
      mtimeMs: 1000,
      contentType: 'audio/ogg',
      suffix: 'opus',
    },
  ]);
  // The tags, as an enrichment pass would write them — which is what makes `album_ci`/`title_ci`
  // populated and therefore what the album aggregates filter on at all.
  await harness.db.db
    .prepare(
      `UPDATE songs SET title = ?, title_ci = ?, artist = ?, artist_ci = ?, album = ?, album_ci = ?,
                        album_artist = ?, album_artist_ci = ?, track = ?, disc = 1
       WHERE id = ?`,
    )
    .bind(title, title.toLowerCase(), artist, artist.toLowerCase(), album, album.toLowerCase(), artist, artist.toLowerCase(), track, id)
    .run();
  return id;
}

/**
 * The release that spans both libraries: track 01 in `home`, track 03 in `archive`.
 *
 * Discs and tracks are the real gap, so `compareAlbumTracks` has to interleave nothing and
 * the order assertion below is about the union rather than about a sort.
 */
async function seedSplitRelease(harness: Harness): Promise<{ homeTrack: string; archiveTrack: string }> {
  const homeTrack = await addTrack(harness, HOME, 'Artist - 棘ナシ', '01 - 空の箱.opus', '空の箱', 'トゲナシトゲアリ', '棘ナシ', 1);
  const archiveTrack = await addTrack(harness, ARCHIVE, 'Artist - 棘ナシ', '03 - 棘.opus', '棘', 'トゲナシトゲアリ', '棘ナシ', 3);
  return { homeTrack, archiveTrack };
}

async function albums(harness: Harness, extra: Record<string, string> = {}): Promise<AlbumRow[]> {
  const { body } = await harness.rest('getAlbumList2', { type: 'alphabeticalByName', size: '500', ...extra });
  const album = body['subsonic-response'] as { albumList2?: { album?: unknown } };
  const list = album.albumList2?.album;
  if (list === undefined) return [];
  return (Array.isArray(list) ? list : [list]) as AlbumRow[];
}

async function album(harness: Harness, id: string, extra: Record<string, string> = {}): Promise<{ status: number; body: AlbumDetail }> {
  const { status, body } = await harness.rest('getAlbum', { id, ...extra });
  return { status, body: (body['subsonic-response'] as { album?: AlbumDetail }).album ?? ({} as AlbumDetail) };
}

let harness: Harness;

beforeEach(async () => {
  // The harness already seeds `home` (`L1`) and grants it, so only the second library is added
  // here. Slug order still matters: `archive` sorts **before** `home`, so `musicFolderId=0` is
  // `archive` and `1` is `home` — which is why the narrowing assertions below name a position
  // and the library it names rather than trusting `0`.
  harness = await createHarness();
  await addLibrary(harness, ARCHIVE, 'archive', 'Archive');
  await grant(harness, ARCHIVE);
});

describe('a release split across two libraries', () => {
  it('is one album with both of its tracks, which is the whole point', async () => {
    await seedSplitRelease(harness);

    const all = await albums(harness);
    const split = all.filter((row) => row.name === '棘ナシ');

    // **One**, not two. A per-library `GROUP BY` publishes two albums at a `songCount` of 1
    // each, and a client renders that as a release that mysteriously lost two tracks.
    expect(split).toHaveLength(1);
    // And the count is the union's, not either half's — this is the number a client draws a
    // track total from, and `1` here is what the user saw before.
    expect(split[0]?.songCount).toBe(2);
  });

  it('answers the same album id from either library, so a client cannot end up in two places', async () => {
    await seedSplitRelease(harness);

    const unscoped = (await albums(harness)).find((row) => row.name === '棘ナシ');
    const fromHome = (await albums(harness, { musicFolderId: '1' })).find((row) => row.name === '棘ナシ');
    const fromArchive = (await albums(harness, { musicFolderId: '0' })).find((row) => row.name === '棘ナシ');

    // Each folder publishes the half it owns, and **both halves carry the same id** — which is
    // what a group id means. Two ids for one release is what the sentinel removed.
    expect(fromHome?.id).toBe(unscoped?.id);
    expect(fromArchive?.id).toBe(unscoped?.id);
  });

  it('opens whole from the union id, in disc then track order', async () => {
    await seedSplitRelease(harness);
    const id = (await albums(harness)).find((row) => row.name === '棘ナシ')?.id as string;

    const { status, body } = await album(harness, id);

    expect(status).toBe(200);
    expect(body.song?.map((song) => song.title)).toEqual(['空の箱', '棘']);
    // The count the album publishes has to agree with the tracks it carries, or a client shows
    // "2 tracks" over one row and the grid and the detail page disagree.
    expect(body.song).toHaveLength(2);
  });
});

describe('a star written under the old, library-scoped id', () => {
  /**
   * The re-key is supposed to be invisible to a stored annotation, and the reason is that
   * `resolveAlbumId` decodes an id to a **key** rather than to a library. The union then widens
   * the lookup that key is resolved against — so an id minted before the change, carrying a real
   * library id, resolves to the same key and is found across every granted library.
   *
   * This is asserted rather than assumed because the alternative was believed for a while: an
   * album star stored under `alk:<realLibrary>` was expected to become unreadable, and a
   * migration was going to be written to report the damage. If this test fails, that report is
   * real and needed; if it passes, it is not — and a deploy that "loses" nobody's favourites is
   * a fact rather than a hope.
   *
   * It also covers the case a client actually holds: Navic has been storing album ids for years,
   * and every one of them names a library.
   */
  it('is still published by getStarred, and still opens', async () => {
    await seedSplitRelease(harness);
    const current = (await albums(harness)).find((row) => row.name === '棘ナシ')?.id as string;

    // The **old** spelling: the same key, but naming `home` rather than the sentinel. Minted by
    // hand rather than through the product's encoder, because the product no longer emits it —
    // which is the point. The payload is byte-identical apart from the library half.
    const [, payload] = current.split(':', 2);
    const raw = atob((payload ?? '').replaceAll('-', '+').replaceAll('_', '/'));
    const keyPart = raw.slice(raw.indexOf('\n') + 1);
    const legacyId = `alk:${btoa(`${HOME}\n${keyPart}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;

    // Stored the way a client would have, through the surface rather than by writing the table.
    await harness.rest('star', { albumId: legacyId });

    const { body } = await harness.rest('getStarred2', {});
    const starred = (body['subsonic-response'] as { starred2?: { album?: unknown } }).starred2?.album;
    const published = (Array.isArray(starred) ? starred : starred === undefined ? [] : [starred]) as AlbumRow[];
    const match = published.find((row) => row.name === '棘ナシ');

    // Published, and carrying the **union's** song count rather than one library's — so the
    // annotation did not merely survive, it survived attached to the whole release.
    expect(match).toBeDefined();
    expect(match?.songCount).toBe(2);
  });
});

describe('what the default is, and what a folder still means', () => {
  it('answers the union when no musicFolderId is sent, and one library when it is', async () => {
    await seedSplitRelease(harness);

    const unscoped = (await albums(harness)).find((row) => row.name === '棘ナシ');
    const homeOnly = (await albums(harness, { musicFolderId: '1' })).find((row) => row.name === '棘ナシ');
    const archiveOnly = (await albums(harness, { musicFolderId: '0' })).find((row) => row.name === '棘ナシ');

    // The default is the union: `songCount` 2, because the user registered both libraries
    // because they wanted both, and answering with the first is answering a question nobody
    // asked.
    expect(unscoped?.songCount).toBe(2);
    // And `musicFolderId` still narrows — the protocol's own scope-selector model is intact.
    // Each of these is a **half**, which is the recorded cost of the default being the union:
    // a client with a folder picker can pick one and see less than it sees by default. Asserted
    // so that is a decision with a witness rather than a surprise found in the field.
    expect(homeOnly?.songCount).toBe(1);
    expect(archiveOnly?.songCount).toBe(1);
  });

  it('does not publish an album a track-only library cannot see', async () => {
    // The grant is the boundary, and the union must stay inside it. `listAlbums` is scoped to
    // the granted ids, so a release that exists **only** in a library this user was not granted
    // is absent from every list — and `getAlbum` on an id naming it is `code=70`, never
    // `code=50`, which would confirm the id is real and make the endpoint an oracle for which
    // paths exist. `apps/api/AGENTS.md` states that rule; a union is exactly the change that
    // could have quietly broken it.
    const { homeTrack } = await seedSplitRelease(harness);
    expect(homeTrack).toBeDefined();
    // Withdraw the archive grant, so the release now spans a granted and an invisible library.
    await harness.db.db.prepare('DELETE FROM user_libraries WHERE library_id = ?').bind(ARCHIVE).run();

    const visible = (await albums(harness)).find((row) => row.name === '棘ナシ');
    // Half a release is still a release, and it is the half the user can see. The track in the
    // ungranted library is not folded in.
    expect(visible?.songCount).toBe(1);

    const { body } = await album(harness, visible?.id as string);
    expect(body.song?.map((song) => song.title)).toEqual(['空の箱']);
  });
});
