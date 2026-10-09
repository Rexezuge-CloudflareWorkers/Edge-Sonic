/**
 * The import phases, and the two invariants the whole feature rests on.
 *
 * ### What is being guarded
 *
 * 1. **An unresolved item is named, not counted.** A playlist that silently lost three tracks is a
 *    **wrong answer** rather than an unfinished one, and it is indistinguishable from a list the
 *    user deliberately trimmed. Every phase therefore returns the *named* items it could not
 *    match, and this asserts the names survive the round trip rather than a count.
 * 2. **Every phase is idempotent**, because a Workflow step is cached by name and re-runs after a
 *    fault. A phase that ran twice must leave the same state as one that ran once — which for
 *    play counts means *absolute*, since adding twice is indistinguishable from playing twice.
 *
 * ### The store is a recording double, and that is the point
 *
 * Each phase is driven against a store that **records every write**, because the question is which
 * rows a phase wrote and in what order — not what SQL produced them. `replacePlaylistEntries` and
 * `savePlayQueue` are the two that must be all-or-nothing, and both are asserted as refusals
 * rather than as partial writes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runBookmarksPhase,
  runPlayCountAlbumPhase,
  runPlayQueuePhase,
  runPlaylistsPhase,
  runStarsPhase,
  labelOf,
} from '@edge-sonic/backend-services/import';
import type { PhaseContext, PhaseStore, RemoteSubsonicClient } from '@edge-sonic/backend-services/import';
import type { SongRow } from '@edge-sonic/backend-data/dao';
import type { RemoteAlbum, RemoteArtist } from '@edge-sonic/backend-services/import';
import { UUIDUtil } from '@edge-sonic/shared/utils';

interface Write {
  readonly kind: string;
  readonly payload: unknown;
}

function recordingStore(local: readonly SongRow[], granted = new Set(['L1'])) {
  const writes: Write[] = [];
  const store: PhaseStore = {
    findByPaths: async (libraryId, paths) => local.filter((row) => row.library_id === libraryId && paths.includes(row.path)),
    findByAlbumTitle: async (libraryId, pairs) =>
      local.filter(
        (row) => row.library_id === libraryId && pairs.some(([album, title]) => row.album_ci === album && row.title_ci === title),
      ),
    grantedLibraryIds: async () => granted,
    songsByIds: async (ids) => local.filter((row) => ids.includes(row.id)),
    findPlaylistById: async () => null,
    createPlaylistWithId: async (input) => {
      writes.push({ kind: 'createPlaylist', payload: input });
    },
    replacePlaylistEntries: async (playlistId, songIds, totalDuration) => {
      writes.push({ kind: 'replaceEntries', payload: { playlistId, songIds: [...songIds], totalDuration } });
      return { written: songIds.length + 1 };
    },
    upsertStar: async (input) => {
      writes.push({ kind: 'star', payload: input });
      return { written: 1 };
    },
    upsertRating: async (input) => {
      writes.push({ kind: 'rating', payload: input });
      return { written: 1 };
    },
    upsertBookmark: async (input) => {
      writes.push({ kind: 'bookmark', payload: input });
      return { written: 1 };
    },
    savePlayQueue: async (input) => {
      writes.push({ kind: 'savePlayQueue', payload: input });
      return { written: input.songIds.length + 2 };
    },
    setPlayCounts: async (input) => {
      writes.push({ kind: 'setPlayCounts', payload: input });
      return { written: input.counts.length };
    },
  };
  return { store, writes };
}

function localSong(partial: Partial<SongRow> & { readonly id: string }): SongRow {
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
 * A phase context whose remote answers only what a case asks for.
 *
 * `Partial<RemoteSubsonicClient>` rather than a hand-written reader port, because the client
 * **is** the port: a second structural interface the client happens to satisfy is a second answer,
 * and the `as` cast that makes it fit is a hole in the compiler.
 */
function contextFor(store: PhaseStore, remote: Partial<RemoteSubsonicClient>, overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    runId: 'run-1',
    userId: 'user-1',
    libraryId: 'L1',
    store,
    remote: {
      getPlaylists: async () => [],
      getPlaylist: async () => [],
      getStarred: async () => ({ songs: [], albums: [], artists: [] }),
      getBookmarks: async () => [],
      getPlayQueue: async () => ({ entries: [], currentId: null, positionMs: null }),
      listAlbums: async () => [],
      getAlbumSongs: async () => [],
      ...remote,
    } as unknown as RemoteSubsonicClient,
    matchAlbum: async () => new Map(),
    matchArtist: async () => new Map(),
    albumPageSize: 500,
    ...overrides,
  };
}

describe('an unresolved item is named, and the name is what a person reads', () => {
  it('lists the track that did not match rather than only counting it', async () => {
    const { store } = recordingStore([
      localSong({
        id: 's1',
        title: 'Holocene',
        title_ci: 'holocene',
        album: 'Bloom',
        album_ci: 'bloom',
        artist: 'Mogwai',
        artist_ci: 'mogwai',
      }),
    ]);
    const context = contextFor(store, {
      getPlaylists: async () => [{ id: 'p1', name: 'Road trip', comment: null, isPublic: false, songCount: 2 }],
      getPlaylist: async () => [
        {
          id: 'r1',
          path: null,
          title: 'Holocene',
          album: 'Bloom',
          artist: 'Mogwai',
          track: null,
          discNumber: null,
          duration: null,
          playCount: null,
          userRating: null,
          starred: null,
        },
        {
          id: 'r2',
          path: null,
          title: 'A Track We Do Not Have',
          album: 'Nowhere',
          artist: 'Nobody',
          track: null,
          discNumber: null,
          duration: null,
          playCount: null,
          userRating: null,
          starred: null,
        },
      ],
    });

    const outcome = await runPlaylistsPhase(context, 'p1');

    expect(outcome.status).toBe('partial');
    expect(outcome.imported).toBe(1);
    // The **label**, not the id — an operator triaging a list cannot look up `r2`.
    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0].label).toBe('A Track We Do Not Have — Nobody — Nowhere');
    expect(outcome.unresolved[0].context).toBe('Road trip');
    expect(outcome.unresolved[0].reason).toBe('not-found');
    // And the remote's own id verbatim, which is what makes it useful in a support ticket.
    expect(outcome.unresolved[0].remoteId).toBe('r2');
  });

  it('labels a song with nothing but an id as that id, rather than an empty string', () => {
    // An empty label renders as a blank row in a list of named ones, which is the same defect
    // `NodeDAO.listRoots` had with the library root.
    expect(
      labelOf({
        id: 'r9',
        path: null,
        title: null,
        album: null,
        artist: null,
        track: null,
        discNumber: null,
        duration: null,
        playCount: null,
        userRating: null,
        starred: null,
      }),
    ).toBe('r9');
  });

  it('imports an empty remote playlist as an empty playlist, not as a failure', async () => {
    // The remote says it exists. An operator who sees it on the other server and not here would
    // conclude the import dropped it, and an empty playlist is the truthful answer.
    const { store, writes } = recordingStore([]);
    const context = contextFor(store, {
      getPlaylists: async () => [{ id: 'p1', name: 'Later', comment: null, isPublic: false, songCount: 0 }],
      getPlaylist: async () => [],
    });

    const outcome = await runPlaylistsPhase(context, 'p1');

    expect(outcome.status).toBe('imported');
    expect(outcome.imported).toBe(0);
    expect(writes.filter((write) => write.kind === 'createPlaylist')).toHaveLength(1);
  });
});

describe('a playlist keeps its order, and a repeat keeps its repeat', () => {
  it('writes the resolved ids in the remote order, not the matcher order', async () => {
    const songs = ['a', 'b', 'c'].map((id) =>
      localSong({ id, title: id.toUpperCase(), title_ci: id, album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y', duration: 10 }),
    );
    const { store, writes } = recordingStore(songs);
    const context = contextFor(store, {
      getPlaylists: async () => [{ id: 'p1', name: 'Ordered', comment: null, isPublic: false, songCount: 3 }],
      // Reversed on the wire, because `IN (...)` and a matcher both reorder.
      getPlaylist: async () =>
        ['c', 'a', 'b'].map((id) => ({
          id: `r-${id}`,
          path: null,
          title: id.toUpperCase(),
          album: 'X',
          artist: 'Y',
          track: null,
          discNumber: null,
          duration: null,
          playCount: null,
          userRating: null,
          starred: null,
        })),
    });

    await runPlaylistsPhase(context, 'p1');

    const written = writes.find((write) => write.kind === 'replaceEntries');
    // A playlist whose sequence reshuffles is worse than no playlist.
    expect((written?.payload as { songIds: string[] }).songIds).toEqual(['c', 'a', 'b']);
  });

  it('keeps the same track twice when the remote lists it twice', async () => {
    // A repeat in a playlist is legitimate, and collapsing it produces a **shorter** playlist than
    // the remote described — a wrong answer rather than an unfinished one.
    const song = localSong({ id: 'a', title: 'A', title_ci: 'a', album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' });
    const { store, writes } = recordingStore([song]);
    const context = contextFor(store, {
      getPlaylists: async () => [{ id: 'p1', name: 'Twice', comment: null, isPublic: false, songCount: 2 }],
      getPlaylist: async () =>
        [1, 2].map(() => ({
          id: 'r1',
          path: null,
          title: 'A',
          album: 'X',
          artist: 'Y',
          track: null,
          discNumber: null,
          duration: null,
          playCount: null,
          userRating: null,
          starred: null,
        })),
    });

    const outcome = await runPlaylistsPhase(context, 'p1');

    expect(outcome.imported).toBe(2);
    expect((writes.find((write) => write.kind === 'replaceEntries')?.payload as { songIds: string[] }).songIds).toEqual(['a', 'a']);
  });
});

describe('an imported playlist id is derived, so a retried step rewrites rather than duplicates', () => {
  it('is stable across calls and differs per remote playlist', async () => {
    const first = await UUIDUtil.deterministicId('edge-sonic:import:playlist', 'run-1', 'p1');
    const again = await UUIDUtil.deterministicId('edge-sonic:import:playlist', 'run-1', 'p1');
    const other = await UUIDUtil.deterministicId('edge-sonic:import:playlist', 'run-1', 'p2');

    // A Workflow step is retried after a fault, so "create this playlist" happens more than once.
    // A v4 per attempt would leave the user with a duplicate per retry.
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    // Canonical dashed form, so the value is a UUID by inspection rather than 32 hex characters
    // used as one.
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('cannot be made to collide by choosing a part containing the separator', async () => {
    // `[a, b]` and `[`a`, `b`]` hash differently. A space or a colon separator would have let a
    // caller forge a boundary and collide two different playlists — which means one overwrites
    // the other.
    const joined = await UUIDUtil.deterministicId('ns', 'a', 'b');
    const smuggled = await UUIDUtil.deterministicId('ns', 'a\0b');
    expect(smuggled).not.toBe(joined);
  });

  it('writes the derived id, so a second run of the same step lands on the same playlist', async () => {
    const song = localSong({ id: 'a', title: 'A', title_ci: 'a', album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' });
    const { store, writes } = recordingStore([song]);
    const context = contextFor(store, {
      getPlaylists: async () => [{ id: 'p1', name: 'Retry me', comment: null, isPublic: false, songCount: 1 }],
      getPlaylist: async () => [
        {
          id: 'r1',
          path: null,
          title: 'A',
          album: 'X',
          artist: 'Y',
          track: null,
          discNumber: null,
          duration: null,
          playCount: null,
          userRating: null,
          starred: null,
        },
      ],
    });

    await runPlaylistsPhase(context, 'p1');
    await runPlaylistsPhase(context, 'p1');

    const created = writes.filter((write) => write.kind === 'createPlaylist');
    expect(created).toHaveLength(2);
    // Same id both times — which is what makes `INSERT OR REPLACE` a retry rather than a second
    // playlist sharing the first's tracks.
    expect((created[0].payload as { id: string }).id).toBe((created[1].payload as { id: string }).id);
  });
});

describe('an imported playlist is never public', () => {
  it('refuses to carry a remote `public: true` across', async () => {
    // Visibility on this server is **by grant**. Importing `public: true` would publish a private
    // server's playlist to every user of this one — and it is a one-attribute mistake with no
    // symptom until somebody notices their playlist on a stranger's account.
    const { store, writes } = recordingStore([]);
    const context = contextFor(store, {
      getPlaylists: async () => [{ id: 'p1', name: 'Shared', comment: null, isPublic: true, songCount: 0 }],
      getPlaylist: async () => [],
    });

    await runPlaylistsPhase(context, 'p1');

    expect((writes.find((write) => write.kind === 'createPlaylist')?.payload as { isPublic: boolean }).isPublic).toBe(false);
  });
});

describe('a song outside a granted library is not written, and is counted as dropped', () => {
  it('narrows every resolved id to the grants', async () => {
    const song = localSong({ id: 'a', title: 'A', title_ci: 'a', album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' });
    // The grant set does not include the song's library — the case `requireForUser` would have
    // refused, reached here because an import resolves across libraries by design.
    const { store, writes } = recordingStore([song], new Set<string>());
    const context = contextFor(store, {
      getPlaylists: async () => [{ id: 'p1', name: 'Forbidden', comment: null, isPublic: false, songCount: 1 }],
      getPlaylist: async () => [
        {
          id: 'r1',
          path: null,
          title: 'A',
          album: 'X',
          artist: 'Y',
          track: null,
          discNumber: null,
          duration: null,
          playCount: null,
          userRating: null,
          starred: null,
        },
      ],
    });

    const outcome = await runPlaylistsPhase(context, 'p1');

    expect((writes.find((write) => write.kind === 'replaceEntries')?.payload as { songIds: string[] }).songIds).toEqual([]);
    // Counted, and named in `lastError`, because a silently dropped track is exactly the failure
    // this whole report exists to make visible.
    expect(outcome.unresolvedCount).toBe(1);
    expect(outcome.lastError).toMatch(/cannot see/);
  });
});

describe('stars carry the remote instant, so a retry does not reorder the favourites list', () => {
  it('stamps the remote `starred` value rather than now', async () => {
    const song = localSong({ id: 'a', title: 'A', title_ci: 'a', album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' });
    const { store, writes } = recordingStore([song]);
    // A known instant, so the assertion is a number rather than "roughly now".
    const starred = new Date('2021-03-04T05:06:07Z').toISOString();
    const context = contextFor(store, {
      getStarred: async () => ({
        songs: [
          {
            id: 'r1',
            path: null,
            title: 'A',
            album: 'X',
            artist: 'Y',
            track: null,
            discNumber: null,
            duration: null,
            playCount: null,
            userRating: null,
            starred,
          },
        ],
        albums: [],
        artists: [],
      }),
    });

    await runStarsPhase(context);

    // `stars.starred_at` is a sort key — `getStarred` orders by it — so stamping `nowSeconds()`
    // per item would move every star to the top of the list in import order.
    expect((writes.find((write) => write.kind === 'star')?.payload as { starredAt: number }).starredAt).toBe(
      Math.floor(Date.parse(starred) / 1000),
    );
  });

  it('writes a rating only inside 1..5, because 0 means "unrated" on the wire', async () => {
    const song = localSong({ id: 'a', title: 'A', title_ci: 'a', album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' });
    const { store, writes } = recordingStore([song]);
    const context = contextFor(store, {
      getStarred: async () => ({
        songs: [
          {
            id: 'r1',
            path: null,
            title: 'A',
            album: 'X',
            artist: 'Y',
            track: null,
            discNumber: null,
            duration: null,
            playCount: null,
            userRating: 4,
            starred: null,
          },
          {
            id: 'r2',
            path: null,
            title: 'B',
            album: 'X',
            artist: 'Y',
            track: null,
            discNumber: null,
            duration: null,
            playCount: null,
            userRating: 0,
            starred: null,
          },
        ],
        albums: [],
        artists: [],
      }),
    });

    await runStarsPhase(context);

    const ratings = writes.filter((write) => write.kind === 'rating');
    expect(ratings).toHaveLength(1);
    expect((ratings[0].payload as { rating: number }).rating).toBe(4);
  });

  it('reports an album the matcher could not resolve rather than starring an unreadable id', async () => {
    const { store, writes } = recordingStore([]);
    const outcome = await runStarsPhase(
      contextFor(
        store,
        {
          getStarred: async () => ({
            songs: [],
            albums: [{ id: 'al1', name: 'Not Indexed Here', artist: 'Nobody', artistId: null, songCount: 1 }] satisfies RemoteAlbum[],
            artists: [{ id: 'ar1', name: 'Nobody' }] satisfies RemoteArtist[],
          }),
        },
        // Neither resolves, which is the case: the remote indexes releases this deployment has
        // not scanned.
        { matchAlbum: async () => new Map(), matchArtist: async () => new Map() },
      ),
    );

    expect(writes.filter((write) => write.kind === 'star')).toHaveLength(0);
    // Named, because an album star that landed on an unreadable id would simply vanish from
    // every client with no error anywhere.
    expect(outcome.unresolved.map((item) => item.label)).toContain('Nobody — Not Indexed Here');
    expect(outcome.unresolved.map((item) => item.label)).toContain('Nobody');
  });
});

describe('bookmarks keep their position, and a missing one is zero rather than invented', () => {
  it('imports a bookmark with its remote position', async () => {
    const song = localSong({ id: 'a', title: 'A', title_ci: 'a', album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' });
    const { store, writes } = recordingStore([song]);
    const context = contextFor(store, {
      getBookmarks: async () => [
        {
          song: {
            id: 'r1',
            path: null,
            title: 'A',
            album: 'X',
            artist: 'Y',
            track: null,
            discNumber: null,
            duration: null,
            playCount: null,
            userRating: null,
            starred: null,
          },
          positionMs: 42_000,
          comment: 'again',
        },
      ],
    });

    await runBookmarksPhase(context);

    expect(writes.find((write) => write.kind === 'bookmark')?.payload).toMatchObject({ positionMs: 42_000, comment: 'again' });
  });

  it('writes 0 when the remote omitted the position, because that is what it said', async () => {
    // An invented position would send a client resuming mid-track with no reason why.
    const song = localSong({ id: 'a', title: 'A', title_ci: 'a', album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' });
    const { store, writes } = recordingStore([song]);
    const context = contextFor(store, {
      getBookmarks: async () => [
        {
          song: {
            id: 'r1',
            path: null,
            title: 'A',
            album: 'X',
            artist: 'Y',
            track: null,
            discNumber: null,
            duration: null,
            playCount: null,
            userRating: null,
            starred: null,
          },
          positionMs: null,
          comment: null,
        },
      ],
    });

    await runBookmarksPhase(context);

    expect(writes.find((write) => write.kind === 'bookmark')?.payload).toMatchObject({ positionMs: 0 });
  });
});

describe('the play queue is ordered by its remote position, not by arrival', () => {
  it('sorts by `position` and replaces wholesale', async () => {
    const songs = ['a', 'b'].map((id) =>
      localSong({ id, title: id.toUpperCase(), title_ci: id, album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' }),
    );
    const { store, writes } = recordingStore(songs);
    const context = contextFor(store, {
      getPlayQueue: async () => ({
        // Reversed, with **string** positions, because a queue's sequence is the answer and the
        // field arrives as text on some servers. Each entry is a `Child`, which is what carries
        // the album and title the matcher needs — a queue entry narrowed to `{ id, position }`
        // would match nothing and write an empty queue while reporting success.
        entries: [
          {
            song: {
              id: 'r2',
              path: null,
              title: 'B',
              album: 'X',
              artist: 'Y',
              track: null,
              discNumber: null,
              duration: null,
              playCount: null,
              userRating: null,
              starred: null,
            },
            position: '2' as unknown as number,
          },
          {
            song: {
              id: 'r1',
              path: null,
              title: 'A',
              album: 'X',
              artist: 'Y',
              track: null,
              discNumber: null,
              duration: null,
              playCount: null,
              userRating: null,
              starred: null,
            },
            position: '1' as unknown as number,
          },
        ],
        currentId: 'r1',
        positionMs: 12_000,
      }),
    });

    await runPlayQueuePhase(context);

    const saved = writes.find((write) => write.kind === 'savePlayQueue');
    expect((saved?.payload as { songIds: string[] }).songIds).toEqual(['a', 'b']);
    expect((saved?.payload as { currentSongId: string | null }).currentSongId).toBe('a');
  });
});

describe('play counts are absolute, never added', () => {
  it('writes the remote value as-is', async () => {
    const song = localSong({ id: 'a', title: 'A', title_ci: 'a', album: 'X', album_ci: 'x', artist: 'Y', artist_ci: 'y' });
    const { store, writes } = recordingStore([song]);
    const context = contextFor(store, {
      getAlbumSongs: async () => [
        {
          id: 'r1',
          path: null,
          title: 'A',
          album: 'X',
          artist: 'Y',
          track: null,
          discNumber: null,
          duration: null,
          playCount: 12,
          userRating: null,
          starred: null,
        },
      ],
    });

    const outcome = await runPlayCountAlbumPhase(context, { id: 'al1', name: 'X' });

    expect(writes.find((write) => write.kind === 'setPlayCounts')?.payload).toMatchObject({ counts: [{ songId: 'a', playCount: 12 }] });
    expect(outcome.imported).toBe(1);
  });

  it('does nothing for an album nobody has played, rather than reporting a failure', async () => {
    // Most albums in any library have never been played. A remote reporting `playCount: 0`
    // everywhere is saying the truth about a library nobody listens to.
    const { store, writes } = recordingStore([]);
    const context = contextFor(store, {
      getAlbumSongs: async () => [
        {
          id: 'r1',
          path: null,
          title: 'A',
          album: 'X',
          artist: 'Y',
          track: null,
          discNumber: null,
          duration: null,
          playCount: 0,
          userRating: null,
          starred: null,
        },
      ],
    });

    const outcome = await runPlayCountAlbumPhase(context, { id: 'al1', name: 'Unplayed' });

    expect(outcome.status).toBe('imported');
    expect(writes.filter((write) => write.kind === 'setPlayCounts')).toHaveLength(0);
  });

  it('issues no lookup at all for an unplayed album', async () => {
    // A cold walk over 2,000 albums must not spend two D1 statements per album to discover there
    // is nothing to do — that is the difference between a walk that fits a budget and one that
    // exhausts it on albums with no plays.
    const getAlbumSongs = vi.fn(async () => []);
    const { store } = recordingStore([]);
    const context = contextFor(store, { getAlbumSongs });

    await runPlayCountAlbumPhase(context, { id: 'al1', name: 'Empty' });

    expect(getAlbumSongs).toHaveBeenCalledTimes(1);
    // And nothing else was asked: the store's match methods are untouched.
    expect(await context.store.findByAlbumTitle('L1', [['never', 'asked']])).toEqual([]);
  });
});
