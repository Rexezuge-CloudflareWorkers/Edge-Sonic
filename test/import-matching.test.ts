/**
 * Matching a foreign song id to a local one.
 *
 * ### What is being guarded here
 *
 * Three failures, all of which produce a **wrong answer** rather than an error:
 *
 * 1. **An ambiguous match resolved anyway.** Two local songs sharing an album and title — a live
 *    cut beside the studio one, a compilation, an `.flac` beside its `.mp3` — would have a star
 *    written onto whichever row the query returned first, and no client could tell.
 * 2. **A path that does not resolve being read as "not found"** rather than falling through to a
 *    metadata guess. A remote's path is relative to *its* music folder and ours to ours, so two
 *    servers on the same bucket from different roots disagree on the prefix while agreeing
 *    completely on the file.
 * 3. **The album key being a second convention.** A remote `(albumArtist, album)` pair has to be
 *    run through the *same* `albumKeySpec` that mints this server's album ids, or a star lands on
 *    an id `getAlbum` cannot resolve — which no client can see, because the row exists.
 *
 * ### The store is a double, and it is the right kind
 *
 * It answers from in-memory rows rather than SQLite, because what is under test is the
 * **decision** — which strategy fired, whether ambiguity was caught — and not the SQL. The SQL
 * runs against real SQLite in `test/schema.int.test.ts` with `EXPLAIN QUERY PLAN`, because a
 * wrong predicate and a right one return identical rows and only the plan tells them apart.
 */
import { describe, expect, it, vi } from 'vitest';
import { albumKeyFor, matchRemoteAlbums, matchRemoteArtists, matchRemoteSongs, resolveGrouping } from '@edge-sonic/backend-services/import';
import type { AlbumMatchStore, MatchStore } from '@edge-sonic/backend-services/import';
import type { SongRow } from '@edge-sonic/backend-data/dao';
import { albumKeySpec, decodeId, IdKind } from '@edge-sonic/subsonic';
import { SubrequestBudgetExhaustedError } from '@edge-sonic/backend-errors';
import { SongMatchDAO } from '@edge-sonic/backend-data/dao';
import { SubrequestCounter } from '@edge-sonic/shared';
import { sqliteQueryable, execScript } from './helpers/sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

/**
One local song, with every field the row type requires so a double is not a second schema.
*/
function song(partial: Partial<SongRow> & { readonly id: string }): SongRow {
  return {
    library_id: 'L1',
    path: `A/${partial.id}.flac`,
    dir_path: 'A',
    name: `${partial.id}.flac`,
    name_ci: `${partial.id}.flac`,
    size: 1,
    mtime_ms: 1,
    content_type: 'audio/flac',
    suffix: 'flac',
    title: null,
    title_ci: null,
    artist: null,
    artist_ci: null,
    album: null,
    album_ci: null,
    album_artist: null,
    album_artist_ci: null,
    track: null,
    disc: null,
    year: null,
    genre: null,
    genre_ci: null,
    duration: 300,
    bitrate: 0,
    sample_rate: null,
    channels: null,
    enriched_at: null,
    reader_version: 1,
    derived_version: 1,
    grouping_source: null,
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

/**
A store answering from a fixed list, with call recording for the assertions that need it.
*/
function storeAnswering(rows: readonly SongRow[]): MatchStore & { findByPaths: ReturnType<typeof vi.fn>; findByAlbumTitle: ReturnType<typeof vi.fn> } {
  return {
    findByPaths: vi.fn(async () => [...rows]),
    findByAlbumTitle: vi.fn(async () => [...rows]),
  };
}

const STACKS = { remoteId: 'r1', path: null, artist: 'Bon Iver', album: 'For Emma', title: 're: Stacks', discNumber: null, track: null };

/**
 * A local song carrying the **same** `(album_ci, title_ci)` as {@link STACKS}.
 *
 * Written as a helper rather than spelled out per test because the double must carry the `_ci`
 * twins, not the display names: the matcher keys its lookup on the twins, so a double holding
 * only `album: 'For Emma'` returns rows the matcher files under `null null` and every case reads
 * as "not found" — which is a green suite for a broken matcher.
 */
function localStacks(partial: Partial<SongRow> & { readonly id: string }): SongRow {
  return song({
    album: 'For Emma',
    album_ci: 'for emma',
    album_artist: 'Bon Iver',
    album_artist_ci: 'bon iver',
    artist: 'Bon Iver',
    artist_ci: 'bon iver',
    title: 're: Stacks',
    title_ci: 're: stacks',
    ...partial,
  });
}

describe('an ambiguous match is refused, not resolved', () => {
  it('refuses when two local songs share the key and nothing narrows them', async () => {
    const store = storeAnswering([localStacks({ id: 's1' }), localStacks({ id: 's2' })]);

    const [outcome] = await matchRemoteSongs(store, 'L1', [STACKS]);

    expect(outcome.songId).toBeNull();
    // `ambiguous`, not `not-found`, because they want different things done about them: this one
    // needs the operator to say which track was meant, the other needs a rescan. Collapsing them
    // would send somebody to index a library that already holds the album.
    expect(outcome.reason).toBe('ambiguous');
  });

  it('resolves when the remote published a disc number and only one candidate carries it', async () => {
    const store = storeAnswering([localStacks({ id: 's1', disc: 1 }), localStacks({ id: 's2', disc: 2 })]);

    const [outcome] = await matchRemoteSongs(store, 'L1', [{ ...STACKS, discNumber: 1 }]);

    // Narrowed to one row, so it resolves. A matcher that refused on first sight would report
    // every two-disc album in the library as unresolvable.
    expect(outcome.songId).toBe('s1');
    expect(outcome.strategy).toBe('metadata');
  });

  it('does not narrow to nothing when the local library has no disc tags at all', async () => {
    // Both rows have `disc = NULL`, so filtering for `1` would empty the set — turning a
    // resolvable match into a reported one. That is the over-correction this asserts against, and
    // it is the direction a matcher drifts when "refuse when ambiguous" is added.
    const store = storeAnswering([localStacks({ id: 's1' }), localStacks({ id: 's2' })]);

    const [outcome] = await matchRemoteSongs(store, 'L1', [{ ...STACKS, discNumber: 1 }]);

    expect(outcome.songId).toBeNull();
    expect(outcome.reason).toBe('ambiguous');
  });

  it('narrows by track number when the remote published one and discs did not separate them', async () => {
    const store = storeAnswering([localStacks({ id: 's1', track: 1 }), localStacks({ id: 's2', track: 2 })]);

    const [outcome] = await matchRemoteSongs(store, 'L1', [{ ...STACKS, track: 2 }]);

    expect(outcome.songId).toBe('s2');
  });
});

describe('two remote songs sharing an album and title are two answers', () => {
  /**
   * A compilation crediting one title to two artists, or two cuts of one song.
   *
   * The measured case is a real one: an album carried two local rows called `Étoile`, and
   * the import reported **both** remote copies as `not-found` while the rows sat in the
   * library under exactly that name.
   */
  const ETOILE = 'MementoMori (メメントモリ)';

  function etoile(partial: Partial<SongRow> & { readonly id: string }): SongRow {
    return song({
      album: ETOILE,
      album_ci: ETOILE.toLowerCase(),
      album_artist: '霜月はるか',
      album_artist_ci: '霜月はるか',
      title: 'Étoile',
      title_ci: 'étoile',
      ...partial,
    });
  }

  it('reports both as ambiguous rather than dropping one', async () => {
    // The defect: the candidates were keyed `Map<string, MatchCandidate>` on the composite, so
    // the second `set` **overwrote** the first. The overwritten candidate never entered the
    // lookup, and the catch-all at the end labelled it `not-found` — a verdict for an item the
    // matcher never searched. `not-found` sends an operator to re-index a library that already
    // holds the album.
    const store = storeAnswering([etoile({ id: 'local-1' }), etoile({ id: 'local-2' })]);
    const first = { remoteId: 'r1', path: null, artist: '霜月はるか', album: ETOILE, title: 'Étoile', discNumber: null, track: null };
    const second = { ...first, remoteId: 'r2' };

    const outcomes = await matchRemoteSongs(store, 'L1', [first, second]);

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.reason).toBe('ambiguous');
      expect(outcome.songId).toBeNull();
    }
  });

  it('separates them by track number, which is the pair the key cannot tell apart', async () => {
    // The reason every candidate in a bucket is resolved rather than the bucket resolved once
    // and the outcome copied: `narrow` reads each candidate's **own** `discNumber`/`track`, so
    // two candidates sharing an `(album, title)` are exactly the pair it can separate.
    const store = storeAnswering([etoile({ id: 'local-1', track: 1 }), etoile({ id: 'local-2', track: 5 })]);
    const first = { remoteId: 'r1', path: null, artist: '霜月はるか', album: ETOILE, title: 'Étoile', discNumber: null, track: 1 };
    const second = { ...first, remoteId: 'r2', track: 5 };

    const outcomes = await matchRemoteSongs(store, 'L1', [first, second]);

    // Each resolved to its own track. A single shared outcome would have written both stars
    // onto one row — the wrong answer this module exists to refuse.
    expect(outcomes.map((outcome) => outcome.songId)).toEqual(['local-1', 'local-2']);
    expect(outcomes.every((outcome) => outcome.strategy === 'metadata')).toBe(true);
  });

  it('asks the question once, because a shared key shares a query', async () => {
    // The batching guarantee, asserted because the fix could have spent one statement per
    // candidate: 113 unmatched tracks is 3 statements at `PAIRS_PER_STATEMENT`, and a
    // duplicate-heavy library would quietly multiply that.
    const store = storeAnswering([etoile({ id: 'local-1' })]);
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      remoteId: `r${index}`,
      path: null,
      artist: '霜月はるか',
      album: ETOILE,
      title: 'Étoile',
      discNumber: null,
      track: null,
    }));

    await matchRemoteSongs(store, 'L1', candidates);

    expect(store.findByAlbumTitle).toHaveBeenCalledTimes(1);
  });
});

describe('the path strategy is tried first, and reported honestly', () => {
  it('prefers the path, skips the metadata lookup, and says it matched by path', async () => {
    const store = storeAnswering([song({ id: 'by-path', path: 'A/x.flac' })]);

    const [outcome] = await matchRemoteSongs(store, 'L1', [{ ...STACKS, path: 'A/x.flac' }]);

    expect(outcome.songId).toBe('by-path');
    // `path`, not `metadata`. Reporting the weaker strategy for a stronger match would tell an
    // operator the match is a guess when it is exact.
    expect(outcome.strategy).toBe('path');
    // The metadata lookup is **skipped**, not merely out-ranked: a 500-song playlist would
    // otherwise double its statement count for no possible gain.
    expect(store.findByAlbumTitle).not.toHaveBeenCalled();
  });

  it('falls through to metadata when the remote path names a different prefix', async () => {
    // Two servers pointed at the same bucket from different roots disagree on the prefix while
    // agreeing on the file, which is the ordinary case for a migrated library.
    const store = storeAnswering([localStacks({ id: 'local-1', path: 'Bon Iver/For Emma/re: Stacks.flac' })]);

    const [outcome] = await matchRemoteSongs(store, 'L1', [{ ...STACKS, path: 'music/Bon Iver/For Emma/re: Stacks.flac' }]);

    expect(outcome.songId).toBe('local-1');
    // `metadata` — a guess, and labelled as one.
    expect(outcome.strategy).toBe('metadata');
  });

  it('reports a song with neither a path nor an album/title pair as unresolvable', async () => {
    const store = storeAnswering([]);

    const [outcome] = await matchRemoteSongs(store, 'L1', [{ remoteId: 'r1', path: null, artist: null, album: null, title: null, discNumber: null, track: null }]);

    // A key built from a null half would match every row carrying the other, so the matcher
    // refuses rather than treating an absent tag as a wildcard.
    expect(outcome.songId).toBeNull();
    expect(outcome.reason).toBe('not-found');
  });

  it('de-duplicates repeated remote ids, because a playlist repeats its tracks', async () => {
    const store = storeAnswering([localStacks({ id: 'one' })]);

    const outcomes = await matchRemoteSongs(store, 'L1', Array.from({ length: 40 }, () => STACKS));

    expect(outcomes).toHaveLength(40);
    // One lookup per **distinct** id, not one per occurrence: a 40-track playlist drawn from a
    // 10-track album would be four times the work otherwise.
    expect(store.findByPaths).toHaveBeenCalledTimes(1);
  });

  it('keeps the caller order, because a shuffled report is worse than no report', async () => {
    const store = storeAnswering([]);

    const outcomes = await matchRemoteSongs(store, 'L1', [
      { ...STACKS, remoteId: 'a' },
      { ...STACKS, remoteId: 'b' },
      { ...STACKS, remoteId: 'c' },
    ]);

    // `IN (...)` returns rows in index-scan order, so the matcher's own result order is not the
    // caller's unless it is re-established.
    expect(outcomes.map((outcome) => outcome.remoteId)).toEqual(['a', 'b', 'c']);
  });
});

describe('a remote album key is the same key this server publishes', () => {
  const allPresent: AlbumMatchStore = {
    findPresentAlbumKeys: async (_libraryId, keys) => new Set(keys),
    findPresentArtists: async () => new Map(),
  };

  it('produces the album grouping key rather than a second convention', () => {
    expect(albumKeyFor('Bon Iver', 'For Emma', 'album')).toBe(
      albumKeySpec({ dir_path: '', album: 'for emma', album_ci: 'for emma', album_artist: 'bon iver', album_artist_ci: 'bon iver' }, 'album').string,
    );
  });

  it('round-trips through the id this server publishes', async () => {
    const mapped = await matchRemoteAlbums(allPresent, 'L1', 'album', [{ id: 'r1', name: 'For Emma', artist: 'Bon Iver' }]);
    const localId = mapped.get('r1');

    expect(localId).toBeDefined();
    // Decoding back to the key is the round trip that proves the two halves agree — the invariant
    // `packages/backend-data/AGENTS.md` states as structural.
    expect(decodeId(localId as string, IdKind.AlbumKey).path).toBe(albumKeyFor('Bon Iver', 'For Emma', 'album'));
  });

  it('reports an album this library does not hold rather than storing an unreadable star', async () => {
    // The release has not been indexed here. An id minted anyway would be a row **no client can
    // read**: `getAlbum` resolves it to nothing and `getStarred` drops it, so the favourite
    // disappears with no error anywhere.
    const absent: AlbumMatchStore = { findPresentAlbumKeys: async () => new Set(), findPresentArtists: async () => new Map() };

    expect((await matchRemoteAlbums(absent, 'L1', 'album', [{ id: 'r1', name: 'Not Here', artist: 'Nobody' }])).size).toBe(0);
  });

  it('treats a remote with no album artist as its own group, not a wildcard', () => {
    const withArtist = albumKeyFor('Bon Iver', 'Compilation', 'album_artist');
    const without = albumKeyFor(null, 'Compilation', 'album_artist');

    // Different keys. Treating the absent artist as "matches anything" would fold every untagged
    // album named `Compilation` into every tagged one.
    expect(without).not.toBe(withArtist);
    expect(without).toBe('aa:compilation');
  });

  it('refuses an album the remote did not name', () => {
    expect(albumKeyFor('Bon Iver', null, 'album')).toBeNull();
    expect(albumKeyFor('Bon Iver', ' '.repeat(3), 'album')).toBeNull();
  });

  it('defaults an unrecognised grouping to `album`, the shipped default', () => {
    // `validate()` already refuses an unknown `ALBUM_GROUP_BY` at boot, so this is unreachable in
    // a configured deployment. It exists so a test with no environment can call it, and it
    // defaults to the shipped value rather than to `folder` — a wrong default would group an
    // imported album differently from every album already indexed.
    expect(resolveGrouping(undefined)).toBe('album');
    expect(resolveGrouping('nonsense')).toBe('album');
    expect(resolveGrouping('folder')).toBe('folder');
  });
});

describe('a remote artist id is minted from the local display spelling', () => {
  it('uses the stored spelling, so getArtist can resolve the star', async () => {
    const store: AlbumMatchStore = {
      findPresentAlbumKeys: async () => new Set(),
      // The `_ci` twin is lowercase; the id must carry the **display** column, because
      // `mappers.ts` mints artist ids from `group.name` and an id built from anything else is
      // one this server never publishes.
      findPresentArtists: async () => new Map([['bon iver', 'Bon Iver']]),
    };

    const mapped = await matchRemoteArtists(store, 'L1', [{ id: 'r1', name: 'bon iver' }]);

    expect(decodeId(mapped.get('r1') as string, IdKind.Artist).path).toBe('Bon Iver');
  });

  it('reports an artist this library does not hold', async () => {
    const store: AlbumMatchStore = { findPresentAlbumKeys: async () => new Set(), findPresentArtists: async () => new Map() };

    expect((await matchRemoteArtists(store, 'L1', [{ id: 'r1', name: 'Nobody' }])).size).toBe(0);
  });
});

describe('the match DAO against real SQLite', () => {
  function seeded(): ReturnType<typeof sqliteQueryable> {
    const handle = sqliteQueryable();
    // The whole directory, sorted — the same rule `test/helpers/migrations.ts` exists to
    // enforce, applied here so a new migration cannot leave this suite on a schema the product
    // does not have.
    for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
      execScript(handle, readFileSync(`${MIGRATIONS}/${file}`, 'utf8'));
    }
    void handle.db
      .prepare(
        `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
         VALUES ('L1', 'home', 'home', 'https://dav.example.com', '/dav/music', 'ann', '', '', 1, 'Home', 1, 0, 0)`,
      )
      .run();
    return handle;
  }

  function insert(handle: ReturnType<typeof seeded>, row: { id: string; path: string; dirPath: string; album: string; title: string }): void {
    void handle.db
      .prepare(
        `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix,
                            artist, artist_ci, album, album_ci, album_artist, album_artist_ci, title, title_ci,
                            duration, bitrate, derived_version, created_at, updated_at)
         VALUES (?, 'L1', ?, ?, ?, ?, 1, 1, 'audio/flac', 'flac', 'A', 'a', ?, ?, 'A', 'a', ?, ?, 300, 0, 1, 0, 0)`,
      )
      .bind(row.id, row.path, row.dirPath, `${row.id}.flac`, `${row.id}.flac`, row.album, row.album.toLowerCase(), row.title, row.title.toLowerCase())
      .run();
  }

  it('matches a path exactly, and never case-insensitively', async () => {
    // A WebDAV origin on Linux is case-sensitive, so `Album/x.flac` and `album/x.flac` are two
    // files and a case-insensitive match would point a star at whichever came back first.
    const handle = seeded();
    insert(handle, { id: 's1', path: 'Album/Song.flac', dirPath: 'Album', album: 'B', title: 'Song' });
    const dao = new SongMatchDAO(handle.db);

    expect(await dao.findByPaths('L1', ['Album/Song.flac'])).toHaveLength(1);
    expect(await dao.findByPaths('L1', ['album/song.flac'])).toHaveLength(0);
    handle.close();
  });

  it('returns every row for a key, so ambiguity stays visible', async () => {
    // The caller's next question is "are there more than one?" — a lookup that picked one would
    // make an ambiguous match look resolved, which is the failure this DAO exists to surface.
    const handle = seeded();
    insert(handle, { id: 's1', path: 'A/one.flac', dirPath: 'A', album: 'B', title: 'One' });
    insert(handle, { id: 's2', path: 'B/two.flac', dirPath: 'B', album: 'B', title: 'Two' });
    const dao = new SongMatchDAO(handle.db);

    // Both rows share `album_ci = 'b'`, so this is the ambiguous-key case the DAO must return in
    // full rather than resolving to one row.
    expect(await dao.findByAlbumTitle('L1', [['b', 'one'], ['b', 'two']])).toHaveLength(2);
    handle.close();
  });

  it('refuses an id list larger than the remaining budget rather than resolving a subset', async () => {
    // The caller's list **is** the answer: a subset is a playlist that silently lost songs, which
    // is a wrong answer rather than an unfinished one.
    const handle = seeded();
    const dao = new SongMatchDAO(handle.db, new SubrequestCounter(2));

    await expect(dao.findByPaths('L1', Array.from({ length: 500 }, (_, index) => `A/${index}.flac`))).rejects.toBeInstanceOf(SubrequestBudgetExhaustedError);
    handle.close();
  });
});
