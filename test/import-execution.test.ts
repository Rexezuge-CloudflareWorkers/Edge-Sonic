/**
 * The two Workers that run an import, driven directly.
 *
 * ### Why these are testable without workerd
 *
 * Because `test/mocks/cloudflare-workers.ts` stores the `ctx` and `env` a `DurableObject` or
 * `WorkflowEntrypoint` is constructed with — so a test can construct the real class over a fake
 * context and call `alarm()` / `run()` itself. That is the whole reason the mock stores them
 * rather than exposing nothing: a `DurableObject` base that only knew about types would make
 * every DO class in `apps/background` untestable outside Miniflare, and the integration pool is
 * the wrong place for a unit of a batch loop.
 *
 * **And they had to be tested.** Between them these two files are the only place an import's
 * *scheduling* lives, and every defect the class is shaped around is a **silent wedge** rather
 * than an error: a walk that reports progress and makes none, an alarm that is consumed with
 * nothing left to advance it, a run marked complete while half its play counts are still walking.
 *
 * ### The fakes model the platform's two load-bearing facts
 *
 * - **`storage.setAlarm` is a *schedule*, not a call.** A fake that fired immediately would make
 *   every batch loop run to exhaustion, which is precisely the unbounded behaviour the batch is
 *   bounded to prevent. So the fake **records** the alarm and the test fires it — which is what
 *   lets a three-round chain be asserted as three rounds.
 * - **A Workflow `step.do` is cached by name.** A fake that always re-ran would model a Workflow
 *   that does not exist, and every idempotency assertion would pass for the wrong reason. So the
 *   fake caches, and the test drives a *second* pass to prove a cached step is not re-run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayCountImportWorker } from '../apps/background/src/PlayCountImportWorker';
import { LibraryImportWorkflow, WALK_START_FAILED } from '../apps/background/src/LibraryImportWorkflow';
import { NonRetryableError } from 'cloudflare:workflows';
import { ImportPlayCountProgressDAO, ImportRunDAO, ImportSourceDAO, LibraryDAO, PlayCountDAO, UserDAO } from '@edge-sonic/backend-data/dao';
import { DatabaseError, SubrequestBudgetExhaustedError } from '@edge-sonic/backend-errors';
import { MAX_CONSECUTIVE_FAILURES } from '@edge-sonic/backend-services/index';
import { encryptData } from '@edge-sonic/backend-data/crypto';
import { REMOTE_TEST_KEY } from './helpers/harness';
import { sqliteQueryable, execScript } from './helpers/sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IMPORT_PHASES } from '@edge-sonic/backend-services/import';
import { parseReport, serializeReport, buildReport, phase } from '@edge-sonic/backend-services/import';
import type { ImportPhase } from '@edge-sonic/backend-data/dao';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

/**
A `DurableObjectState`, in memory, with `setAlarm` as a **recorded schedule**.
*/
function fakeCtx() {
  const store = new Map<string, unknown>();
  const alarms: Array<number | null> = [];
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      setAlarm: async (at: number) => void alarms.push(at),
      deleteAlarm: async () => void alarms.push(null),
    },
    alarms,
    store,
    executionContext: { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} },
  };
}

/**
An env with a live SQLite handle and the three per-feature keys.
*/
function envFor(handle: ReturnType<typeof sqliteQueryable>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: handle.db,
    ENVIRONMENT: 'development',
    DEV_AUTH_EMAIL: 'operator@example.com',
    TEAM_DOMAIN: 'example.cloudflareaccess.com',
    POLICY_AUD: 'aud',
    SUBSONIC_USER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    WEBDAV_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    SUBSONIC_REMOTE_ENCRYPTION_KEY: REMOTE_TEST_KEY,
    ...overrides,
  };
}

let handle: ReturnType<typeof sqliteQueryable>;

function migrated(): ReturnType<typeof sqliteQueryable> {
  const opened = sqliteQueryable();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    execScript(opened, readFileSync(`${MIGRATIONS}/${file}`, 'utf8'));
  }
  return opened;
}

beforeEach(() => {
  handle = migrated();
});

/**
A run with a real source, a real user and a real library.
*/
async function seedRun(options: { sourceId?: string; userId?: string } = {}): Promise<{ runId: string; sourceId: string; userId: string }> {
  const users = new UserDAO(handle.db);
  const userId =
    options.userId ?? (await users.create({ username: `u${users.list.length}`, passwordCiphertext: 'c', passwordIv: 'iv' })).id;
  const libraryId = (
    await new LibraryDAO(handle.db).create({
      slug: `lib${options.sourceId ?? 'x'}`,
      baseUrl: 'https://dav.example.com',
      rootPath: '/dav',
      davUsername: 'ann',
      passwordCiphertext: 'c',
      passwordIv: 'iv',
    })
  ).id;
  await users.setLibraryGrants(userId, [libraryId]);

  const encrypted = await encryptData('hunter2', REMOTE_TEST_KEY);
  const sourceId =
    options.sourceId ??
    (
      await new ImportSourceDAO(handle.db).create({
        name: 'Old server',
        baseUrl: 'https://music.example.com/sonic',
        username: 'alice',
        passwordCiphertext: encrypted.ciphertext,
        passwordIv: encrypted.iv,
        musicFolderId: null,
      })
    ).id;

  const run = await new ImportRunDAO(handle.db).create({ sourceId, targetUserId: userId, phases: [...IMPORT_PHASES] });
  return { runId: run.id, sourceId, userId };
}

/**
 * A remote Subsonic server, as the client sees it.
 *
 * ### It serves a **page**, not one album per call
 *
 * The first version returned a single album per `getAlbumList2`, which quietly made the whole
 * batch bound untestable: `ALBUMS_PER_BATCH` is seven, a page of one is always short, so the walk
 * settled after one album and the re-arm branch never ran. The stub is a **double**, and a double
 * that models a shape the platform does not have hides the code that guards that shape — which
 * is this repository's rule about `fakeKv` and `fakeDav` arriving at a third fixture.
 *
 * `pageSize` is therefore the protocol's own 500 by default, and a test that wants a short page
 * says so explicitly.
 */
interface FakeAlbum {
  readonly id: string;
  /**
  The remote's own name for the album, which may differ from the first track's artist.
  */
  readonly name?: string;
  /**
  The remote's **album** artist, which is what an album id is matched on.
  */
  readonly artist?: string;
  readonly songs: ReadonlyArray<{ readonly id: string; readonly title: string; readonly album: string; readonly artist: string }>;
}

function remoteAlbums(albums: readonly FakeAlbum[]) {
  return {
    /**
    Every album, so the assertions can say what the walk should have reached.
    */
    all: albums,
    /**
    A page at `offset`, like `getAlbumList2?offset=&size=`.
    */
    page: (offset: number, size: number) =>
      albums.slice(offset, offset + size).map((album) => ({
        id: album.id,
        name: album.name ?? album.id,
        artist: album.artist ?? album.songs[0]?.artist ?? 'Unknown',
        artistId: null,
        songCount: album.songs.length,
      })),
    songsOf: (albumId: string) =>
      (albums.find((album) => album.id === albumId)?.songs ?? []).map((song) => ({
        id: song.id,
        path: null,
        title: song.title,
        album: song.album,
        artist: song.artist,
        track: 1,
        discNumber: 1,
        duration: 100,
        // A count worth importing — `> 0`, which is what `runPlayCountAlbumPhase` filters on, so an
        // album of zero-count tracks is the *unplayed* case and is asserted separately.
        playCount: 3,
        userRating: null,
        starred: null,
      })),
  };
}

/**
 * Stub the whole `fetch`, answering from `remote`.
 *
 * Both endpoints, and the `offset` parameter honoured — because a stub that ignored `offset` would
 * return the same first page for ever and the walk would never finish, or would finish after one
 * album while appearing to have walked the library.
 */
function stubFetch(remote: ReturnType<typeof remoteAlbums>, pageSize = 500) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown): Response => Response.json(body, { status: 200, headers: { 'content-type': 'application/json' } });

      if (/getAlbumList2/.test(url)) {
        const offset = Number.parseInt(new URL(url).searchParams.get('offset') ?? '0', 10);
        return json({ 'subsonic-response': { status: 'ok', albumList2: { album: remote.page(offset, pageSize) } } });
      }
      if (/getAlbum\b/.test(url)) {
        const id = new URL(url).searchParams.get('id') ?? '';
        return json({ 'subsonic-response': { status: 'ok', album: { song: remote.songsOf(id) } } });
      }
      return json({ 'subsonic-response': { status: 'ok' } });
    }),
  );
}

describe('PlayCountImportWorker', () => {
  it('records its run and arms an alarm, so the walk is scheduled rather than run inline', async () => {
    const { runId } = await seedRun();
    const ctx = fakeCtx();

    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });

    // A schedule, not an execution. A fake that fired immediately would make the batch bound
    // untestable by construction — which is exactly the thing the bound exists for.
    expect(ctx.alarms).toHaveLength(1);
    expect(ctx.store.get('runId')).toBe(runId);
    expect(await worker.status()).toMatchObject({ runId, albums: 0, finished: false });
  });

  it('reports progress from storage and never from D1, because D1 may be refusing writes', async () => {
    // The pause model `scanPause.ts` follows, and the reason is the same: an exhausted daily
    // allowance fails *every* query, so the answer to "what is happening" has to be readable
    // while D1 is refusing answers. A `status` that read the run row would answer during exactly
    // the outage it exists to explain.
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });

    const status = await worker.status();
    expect(status).toMatchObject({ runId, albums: 0, songs: 0, finished: false, lastError: null });
  });

  it('settles the run as failed, with a reason, when the source is no longer permitted', async () => {
    // ### The reachable refusal is the **policy**, not the row
    //
    // Deleting the source does not leave a run behind: `import_runs.source_id` is
    // `ON DELETE CASCADE`, so the run cascades with it. That is right — a report about rows that no
    // longer exist is a lie — and it means "the source is gone" reaches this branch as "the run is
    // gone too", which is the *next* test.
    //
    // What is genuinely reachable with a run still present is an operator **tightening**
    // `ALLOW_PRIVATE_WEBDAV_HOSTS` after the run started. The row is fine and the URL is fine; the
    // host is simply no longer allowed, so `clientFor` answers `null` and the walk must stop and
    // say why rather than carry on against a host the policy has refused.
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    // A private origin, registered while the policy permitted it.
    await handle.db.prepare('UPDATE import_sources SET base_url = ?').bind('http://10.1.2.3:4533').run();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle, { ALLOW_PRIVATE_WEBDAV_HOSTS: 'false' }) as never);
    await worker.start({ runId });

    await worker.alarm();

    const run = await new ImportRunDAO(handle.db).findById(runId);
    expect(run?.status).toBe('failed');
    // **Named**, not merely stopped: a run sitting `running` with nothing scheduled to advance it is
    // a wedge, and an operator cannot tell that from a walk in progress.
    expect(run?.last_error).toMatch(/source/i);
    // And the alarm is **disarmed** — nothing is scheduled to resume a finished walk, and leaving it
    // armed would wake the object once per period for ever to discover the same thing.
    expect(ctx.alarms.at(-1)).toBeNull();
  });

  it('cascades a run with its source, so a report never outlives the rows it describes', async () => {
    const { runId, sourceId } = await seedRun();
    await handle.db.prepare('DELETE FROM import_sources WHERE id = ?').bind(sourceId).run();

    expect(await new ImportRunDAO(handle.db).findById(runId)).toBeNull();
  });

  it('settles the run as failed, with a reason, when the run itself has gone', async () => {
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    await handle.db.prepare('DELETE FROM import_runs WHERE id = ?').bind(runId).run();

    await worker.alarm();

    expect((await worker.status()).lastError).toMatch(/run/i);
  });

  it('walks a batch, advances the cursor by a delta, and re-arms while albums remain', async () => {
    // Twenty albums — **more** than one batch of seven — so the re-arm branch runs and the cursor is
    // what carries the walk across alarms. A fixture of one page would settle after one album and
    // never reach the branch this is about.
    const remote = remoteAlbums(
      Array.from({ length: 20 }, (_, index) => ({
        id: `a${index}`,
        songs: [{ id: `s${index}`, title: `Track ${index}`, album: 'X', artist: 'Y' }],
      })),
    );
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    stubFetch(remote);

    await worker.alarm();
    const afterOne = await worker.status();
    // One alarm walked a **bounded** number of albums and stopped, rather than the whole library.
    expect(afterOne.albums).toBeGreaterThan(0);
    expect(afterOne.albums).toBeLessThan(remote.all.length);
    expect(afterOne.finished).toBe(false);
    // Re-armed, because work remains.
    expect(ctx.alarms.at(-1)).not.toBeNull();

    // The cursor moved, so the next alarm continues rather than restarting — and a restart would
    // *add* to counts already set, which for play counts means inflating every one of them.
    await worker.alarm();
    const afterTwo = await worker.status();
    expect(afterTwo.albums).toBeGreaterThanOrEqual(afterOne.albums);

    // Walk the rest to completion. Bounded to a number of rounds so a cursor that fails to advance
    // fails here rather than hanging.
    for (let round = 0; round < 10 && !(await worker.status()).finished; round += 1) {
      await worker.alarm();
    }
    const done = await worker.status();
    expect(done.finished).toBe(true);
    // Every album, exactly once — the assertion that makes the cursor's correctness observable.
    expect(done.albums).toBe(remote.all.length);
    expect((await new ImportRunDAO(handle.db).findById(runId))?.status).toBe('completed');
    vi.unstubAllGlobals();
  });

  it('skips an album nobody has played, without spending a match lookup on it', async () => {
    // Most albums in any library have never been played. A remote reporting `playCount: 0`
    // everywhere is saying the truth about a library nobody listens to, and a walk that treated it
    // as a fault would report every album as unresolvable.
    const remote = remoteAlbums([{ id: 'a0', songs: [{ id: 's0', title: 'Unheard', album: 'X', artist: 'Y' }] }]);
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    stubFetch(remote);
    // The remote says zero for every track.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const json = (body: unknown): Response => Response.json(body, { status: 200, headers: { 'content-type': 'application/json' } });
        if (/getAlbumList2/.test(url)) return json({ 'subsonic-response': { status: 'ok', albumList2: { album: remote.page(0, 500) } } });
        return json({
          'subsonic-response': { status: 'ok', album: { song: [{ id: 's0', title: 'Unheard', album: 'X', artist: 'Y', playCount: 0 }] } },
        });
      }),
    );

    await worker.alarm();

    const done = await worker.status();
    expect(done.finished).toBe(true);
    // The album was still **walked** — it is not skipped — and nothing was imported from it.
    expect(done.albums).toBe(1);
    expect(done.songs).toBe(0);
    vi.unstubAllGlobals();
  });

  it('records the fault and re-arms when the remote refuses, rather than letting the alarm die', async () => {
    // A throwing alarm is retried a bounded number of times by the platform and then **dropped**,
    // so a fault that escapes leaves the run saying `running` with nothing scheduled to advance
    // it. The catch here is what turns a fault into a bounded retry instead of a wedge.
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error');
      }),
    );

    await worker.alarm();

    // Armed **again** — the whole point — and the run still `running`, because it has not settled.
    expect(ctx.alarms).toHaveLength(2);
    expect(ctx.alarms.at(-1)).not.toBeNull();
    expect((await worker.status()).finished).toBe(false);
    expect((await new ImportRunDAO(handle.db).findById(runId))?.status).toBe('running');
    vi.unstubAllGlobals();
  });

  it('settles the run failed after consecutive batch faults, naming the fault', async () => {
    // The October 2026 loop: every alarm threw at `setPlayCounts`, the catch recorded a
    // generic message and re-armed in a second, and the run stayed `running` for ever. The
    // catch is now bounded by `MAX_CONSECUTIVE_FAILURES` and records the thrown message.
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error');
      }),
    );

    for (let round = 0; round < MAX_CONSECUTIVE_FAILURES; round += 1) {
      await worker.alarm();
    }

    const run = await new ImportRunDAO(handle.db).findById(runId);
    expect(run?.status).toBe('failed');
    // Named, not generic: the operator reads this, and "could not read the import source"
    // never named the budget refusal behind the loop.
    expect(run?.last_error).toMatch(/network error/);
    expect((await worker.status()).finished).toBe(true);
    expect(ctx.alarms.at(-1)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('backs off between retries rather than re-arming every second', async () => {
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error');
      }),
    );

    const before = Date.now();
    await worker.alarm();
    const firstDelay = (ctx.alarms.at(-1) as number) - before;
    await worker.alarm();
    const secondDelay = (ctx.alarms.at(-1) as number) - before;

    // Exponential: the second wait is longer than the first, and both are at least the
    // walk's one-second pacing rather than an immediate retry.
    expect(firstDelay).toBeGreaterThanOrEqual(1000);
    expect(secondDelay).toBeGreaterThan(firstDelay);
    vi.unstubAllGlobals();
  });

  it('sleeps to midnight UTC on a spent D1 allowance instead of looping', async () => {
    // Since 2026-09-01 an account over its daily row allowance has every query fail until
    // midnight UTC. Re-arming in a second re-runs the whole failure path ~86,400 times; the
    // scan learned this in `scanPause.ts`, and the walk paused the same way.
    const { runId } = await seedRun();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    const refusal = new DatabaseError(
      "Failed to importRuns.findById: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
      false,
    );
    const findByIdSpy = vi.spyOn(ImportRunDAO.prototype, 'findById').mockRejectedValue(refusal);

    await worker.alarm();
    expect(findByIdSpy).toHaveBeenCalled();
    findByIdSpy.mockRestore();

    const run = await new ImportRunDAO(handle.db).findById(runId);
    expect(run?.status).toBe('paused');
    expect((await worker.status()).finished).toBe(false);
    expect((await worker.status()).lastError).toMatch(/00:00 UTC/);
    // Armed for the reset, hours away — not a second from now.
    expect((ctx.alarms.at(-1) as number) - Date.now()).toBeGreaterThan(60_000);
    vi.unstubAllGlobals();
  });

  it('defers a budget-exhausted album to the next alarm instead of failing the batch', async () => {
    // `setPlayCounts` is `requireComplete`: an album whose counted tracks do not fit in what
    // remains of this alarm refuses. That refusal is about this alarm's remaining budget, so
    // the batch banks what it walked and retries the album on a fresh budget — rather than
    // throwing the cursor away and retrying the same offset for ever.
    const { runId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    await handle.db
      .prepare(
        `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, album, album_ci, title, title_ci, artist, artist_ci, duration, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'local-song-1',
        libraryId,
        'Music/AlbumX/Wanted.mp3',
        'Music/AlbumX',
        'Wanted.mp3',
        'wanted.mp3',
        'X',
        'x',
        'Wanted',
        'wanted',
        'Y',
        'y',
        100,
        1,
        1,
      )
      .run();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    const song = (id: string, title: string, playCount: number) => ({ id, title, album: 'X', artist: 'Y', playCount });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const json = (body: unknown): Response => Response.json(body, { status: 200, headers: { 'content-type': 'application/json' } });
        if (/getAlbumList2/.test(url)) {
          const offset = Number.parseInt(new URL(url).searchParams.get('offset') ?? '0', 10);
          const size = Number.parseInt(new URL(url).searchParams.get('size') ?? '500', 10);
          const albums = Array.from({ length: 8 }, (_, index) => ({
            id: `a${index}`,
            name: `Album ${index}`,
            artist: 'Y',
            artistId: null,
            songCount: 1,
          }));
          return json({ 'subsonic-response': { status: 'ok', albumList2: { album: albums.slice(offset, offset + size) } } });
        }
        if (/getAlbum\b/.test(url)) {
          const id = new URL(url).searchParams.get('id') ?? '';
          if (id === 'a2') return json({ 'subsonic-response': { status: 'ok', album: { song: [song('rs1', 'Wanted', 3)] } } });
          return json({ 'subsonic-response': { status: 'ok', album: { song: [song('quiet', 'Unheard', 0)] } } });
        }
        return json({ 'subsonic-response': { status: 'ok' } });
      }),
    );
    const setPlayCounts = vi
      .spyOn(PlayCountDAO.prototype, 'setPlayCounts')
      .mockRejectedValueOnce(
        new SubrequestBudgetExhaustedError(
          'Writing 10 rows for playCounts.setPlayCounts needs 10 subrequests and 5 remain in this invocation.',
        ),
      );

    await worker.alarm();

    // Two albums banked (a0, a1 unplayed), the refused album deferred: still running, re-armed,
    // and the cursor moved rather than wedged at zero.
    const afterOne = await worker.status();
    expect(afterOne.albums).toBe(2);
    expect(afterOne.finished).toBe(false);
    expect((await new ImportRunDAO(handle.db).findById(runId))?.status).toBe('running');
    expect(ctx.alarms.at(-1)).not.toBeNull();
    expect(setPlayCounts).toHaveBeenCalledTimes(1);

    // And the **operator's** cursor advances with it. The Durable Object's own storage is what the
    // worker reads; `import_play_count_progress` is what `GET /user/import/:id` reads, so the two can
    // disagree and an operator watching the page sees nothing move. The write was missing entirely
    // — `ImportPlayCountProgressDAO` had three writers and no caller — so this is the assertion that
    // says the walk publishes its progress.
    const published = await new ImportPlayCountProgressDAO(handle.db).read(runId);
    expect(published?.albums_done).toBe(2);

    // A fresh budget takes the deferred album.
    await worker.alarm();
    const afterTwo = await worker.status();
    expect(afterTwo.albums).toBeGreaterThan(afterOne.albums);
    setPlayCounts.mockRestore();
    vi.unstubAllGlobals();
  });

  it('settles failed, naming the album, when even the first album fits no alarm', async () => {
    // The deterministic half of the same refusal: the first album on a near-fresh budget
    // still does not fit, so no later alarm will have meaningfully more room and re-arming
    // would loop the same page for ever.
    const { runId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    await handle.db
      .prepare(
        `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, album, album_ci, title, title_ci, artist, artist_ci, duration, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'local-song-9',
        libraryId,
        'Music/X/Track 0.mp3',
        'Music/X',
        'Track 0.mp3',
        'track 0.mp3',
        'X',
        'x',
        'Track 0',
        'track 0',
        'Y',
        'y',
        100,
        1,
        1,
      )
      .run();
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId });
    stubFetch(remoteAlbums([{ id: 'a0', name: 'Huge Album', songs: [{ id: 's0', title: 'Track 0', album: 'X', artist: 'Y' }] }]));
    const setPlayCounts = vi
      .spyOn(PlayCountDAO.prototype, 'setPlayCounts')
      .mockRejectedValue(
        new SubrequestBudgetExhaustedError(
          'Writing 40 rows for playCounts.setPlayCounts needs 40 subrequests and 38 remain in this invocation.',
        ),
      );

    await worker.alarm();

    const run = await new ImportRunDAO(handle.db).findById(runId);
    expect(run?.status).toBe('failed');
    expect(run?.last_error).toMatch(/Huge Album/);
    expect((await worker.status()).finished).toBe(true);
    expect(ctx.alarms.at(-1)).toBeNull();
    setPlayCounts.mockRestore();
    vi.unstubAllGlobals();
  });

  it('does nothing at all without a run, rather than inventing one', async () => {
    // An alarm with nothing to walk is a *programming* error, and inventing a run would turn it
    // into a silent import from an unknown source.
    const ctx = fakeCtx();
    const worker = new PlayCountImportWorker(ctx as never, envFor(handle) as never);
    await worker.start({ runId: 'nonexistent' });

    await worker.alarm();

    // Disarmed rather than left armed: there is nothing to walk, so an armed alarm would wake the
    // object once per period for ever to discover the same thing. And no row was written — an
    // update against a run that does not exist is a no-op, which is why the assertion is about the
    // alarm rather than about a status.
    expect(ctx.alarms.at(-1)).toBeNull();
  });
});

/**
 * A Workflow `step`, with the one behaviour that matters: **cached by name**.
 *
 * Re-running a cached step is what the Workflow engine does not do, and modelling it wrongly makes
 * every idempotency assertion pass for the wrong reason — so the fake caches, and the tests drive
 * a second pass to prove a step is not repeated.
 */
function fakeStep() {
  const cache = new Map<string, unknown>();
  const calls: string[] = [];
  return {
    calls,
    cache,
    do: async (name: string, _config: unknown, body: () => Promise<unknown>): Promise<unknown> => {
      if (cache.has(name)) return cache.get(name);
      calls.push(name);
      const value = await body();
      cache.set(name, value);
      return value;
    },
  };
}

describe('LibraryImportWorkflow', () => {
  it('records each phase from the step’s own return value, not a placeholder', async () => {
    // The defect this guards: recording a hardcoded `imported` inside the step's caller means
    // the report says \"imported\" whatever the step decided, and the **named list of unresolved
    // items** — the one thing the feature exists for — never reaches the operator.
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    const step = fakeStep();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { 'subsonic-response': { status: 'ok', starred2: { song: [{ id: 'r1', title: 'Gone', album: 'Nowhere', artist: 'Nobody' }] } } },
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    const workflow = new LibraryImportWorkflow(fakeCtx().executionContext as never, envFor(handle) as never);
    await workflow.run(
      { payload: { runId, sourceId, userId, libraryIds: [libraryId], phases: ['stars'], playlistIds: [] } } as never,
      step as never,
    );

    const stored = parseReport(await new ImportRunDAO(handle.db).readReport(runId));
    const stars = stored?.phases.find((entry) => entry.phase === 'stars');
    // The phase ran and reported **partial**, because its one track matched nothing locally.
    expect(stars?.status).toBe('partial');
    // And the item is **named** — the label, not a count.
    expect(stars?.unresolved.map((item) => item.label)).toContain('Gone — Nobody — Nowhere');
    vi.unstubAllGlobals();
  });

  it('names one step per playlist, so a retry re-does one playlist rather than all of them', async () => {
    // A 30-playlist phase as a single step would re-fetch and re-write **all thirty** when the
    // twenty-ninth failed, spending the daily row allowance twice over for the first twenty-eight.
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    const step = fakeStep();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/getPlaylists/.test(url)) {
          return Response.json(
            {
              'subsonic-response': {
                status: 'ok',
                playlists: {
                  playlist: [
                    { id: 'p1', name: 'One' },
                    { id: 'p2', name: 'Two' },
                  ],
                },
              },
            },
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        return Response.json(
          { 'subsonic-response': { status: 'ok', playlist: { entry: [] } } },
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const workflow = new LibraryImportWorkflow(fakeCtx().executionContext as never, envFor(handle) as never);
    await workflow.run(
      {
        payload: {
          runId,
          sourceId,
          userId,
          // The **scope**, not one library: the phases resolve a foreign id against every
          // library the target user was granted, and a payload carrying a single id made the
          // second library's tracks unmatchable.
          libraryIds: [libraryId],
          phases: ['playlists'],
          // The ids are in the **payload**, read before the workflow started: a step name is a
          // cache key and has to be nameable before the first step runs.
          playlistIds: ['p1', 'p2'],
        },
      } as never,
      step as never,
    );

    expect(step.calls.filter((name) => name.startsWith('playlist '))).toEqual(['playlist p1', 'playlist p2']);
    vi.unstubAllGlobals();
  });

  it('does not re-run a cached step, so a retried instance cannot write the same playlist twice', async () => {
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    const step = fakeStep();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { 'subsonic-response': { status: 'ok', playlist: { entry: [] } } },
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const workflow = new LibraryImportWorkflow(fakeCtx().executionContext as never, envFor(handle) as never);
    const payload = {
      runId,
      sourceId,
      userId,
      libraryIds: [libraryId],
      phases: ['playlists' as ImportPhase],
      playlistIds: ['p1'],
    } as never;
    await workflow.run({ payload } as never, step as never);
    await workflow.run({ payload } as never, step as never);

    // One execution of the step across **two** passes of the instance. The derived playlist id is
    // the second half of the same guard; this is the half the platform provides.
    expect(step.calls.filter((name) => name.startsWith('playlist '))).toEqual(['playlist p1']);
    vi.unstubAllGlobals();
  });

  it('refuses to retry a step whose source has been deleted, rather than reading a gone row three more times', async () => {
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    await handle.db.prepare('DELETE FROM import_sources WHERE id = ?').bind(sourceId).run();

    const workflow = new LibraryImportWorkflow(fakeCtx().executionContext as never, envFor(handle) as never);

    // `NonRetryableError`, so the engine records a **failed** instance rather than burning three
    // attempts on a row that will not come back — and rather than reporting success.
    await expect(
      workflow.run(
        { payload: { runId, sourceId, userId, libraryIds: [libraryId], phases: ['bookmarks'], playlistIds: [] } } as never,
        fakeStep() as never,
      ),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('leaves the run running while the play-count walk is outstanding, and does not claim success', async () => {
    // The failure this guards: `finish` marking the run `completed` because the workflow's own
    // steps ended, while the Durable Object is still walking albums. An operator told
    // \"imported\" with half the play counts missing has no way to know, and nothing would correct
    // them later.
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    const started: string[] = [];
    const received: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ 'subsonic-response': { status: 'ok' } }, { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const workflow = new LibraryImportWorkflow(
      fakeCtx().executionContext as never,
      {
        ...envFor(handle),
        // A DO namespace stub that records the `start`, which is the whole point of the step: it
        // must happen **once**, outside `step.do`, because a step that "completed" but whose object
        // was never started would be cached and never re-run.
        //
        // `start` reads `request.runId` rather than closing over `name`, because the double's job
        // is to be the class. The first version took no argument and returned `{ runId: name }`, so
        // it agreed with a caller that passed **nothing** — and `stub.start()` with no payload threw
        // `Cannot read properties of undefined (reading 'runId')` on a real Durable Object, before
        // the `put` and before the alarm. A double that shares the caller's assumption is not a
        // guard on the call; it is a second copy of the bug.
        IMPORT_DO: {
          getByName: (name: string) => {
            started.push(name);
            return {
              start: async (request: { readonly runId: string }) => {
                // Throws exactly as `PlayCountImportWorker.start` does when the payload is absent.
                received.push(request.runId);
                return { runId: request.runId };
              },
            };
          },
        },
      } as never,
    );

    await workflow.run(
      { payload: { runId, sourceId, userId, libraryIds: [libraryId], phases: ['playCounts'], playlistIds: [] } } as never,
      fakeStep() as never,
    );

    const runs = new ImportRunDAO(handle.db);
    const run = await runs.findById(runId);
    expect(run?.status).toBe('running');
    expect(run?.finished_at).toBeNull();
    // The walk named, so the operator can see what is outstanding.
    const stored = parseReport(await runs.readReport(runId));
    expect(stored?.phases.find((entry) => entry.phase === 'playCounts')?.status).toBe('partial');
    expect(stored?.finishedAt).toBeNull();
    // And the object's name **is** the run, so a retried call reaches the same object rather than
    // starting a second walk over the same albums.
    expect(started).toEqual([runId]);
    // **And the payload carries it**, because a name is a routing decision and nothing turns a
    // Durable Object's name into an argument. This is the assertion the first version could not
    // have made: its double never read the request.
    expect(received).toEqual([runId]);
    expect(run?.play_count_worker).toBe(runId);
    vi.unstubAllGlobals();
  });

  it('settles the run failed, naming the walk, when the play-count object cannot be started', async () => {
    // The failure this guards: `start` throwing out of `startPlayCountWorker`, so `settle` never
    // ran and the run stayed `running` with `last_error` **null** for ever, with nothing scheduled
    // to advance it. The Workflow instance was recorded errored in the Cloudflare dashboard and the
    // operator's own page said the import was still going. That is the wedge `runWorkflow` exists
    // to prevent, arriving through the one call it cannot see.
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { 'subsonic-response': { status: 'ok', starred2: {} } },
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const workflow = new LibraryImportWorkflow(
      fakeCtx().executionContext as never,
      {
        ...envFor(handle),
        // The DO refuses the start. The other phases still ran, and their report lines must survive.
        IMPORT_DO: {
          getByName: () => ({
            start: async () => {
              throw new Error('Durable Object storage is unavailable.');
            },
          }),
        },
      } as never,
    );

    await workflow.run(
      { payload: { runId, sourceId, userId, libraryIds: [libraryId], phases: ['stars', 'playCounts'], playlistIds: [] } } as never,
      fakeStep() as never,
    );

    const runs = new ImportRunDAO(handle.db);
    const run = await runs.findById(runId);
    // **Terminal**, not `running`. A run with nothing scheduled to advance it is the defect.
    expect(run?.status).toBe('failed');
    expect(run?.finished_at).toBeTypeOf('number');
    // And it names the phase, rather than leaving the operator to work out which of five is
    // missing. The literal — not the thrown error's text, which carries whatever the runtime put
    // in it — because this is what the operator page renders.
    expect(run?.last_error).toBe(WALK_START_FAILED);
    expect(run?.last_error).toContain('play-count');
    expect(run?.play_count_worker).toBeNull();

    const stored = parseReport(await runs.readReport(runId));
    // The walk named `failed`, not `partial` and not `imported`: `partial` promises numbers are
    // still arriving, and nothing is arriving.
    expect(stored?.phases.find((entry) => entry.phase === 'playCounts')?.status).toBe('failed');
    // A terminal run is finished. `finishedAt: null` here would render a run that is definitively
    // over as one still in progress.
    expect(stored?.finishedAt).toBeTypeOf('number');
    // **The phases that did work are still in the report.** Four of five succeeding is not a
    // reason to discard them, and the operator's next step is re-running the counts alone.
    expect(stored?.phases.find((entry) => entry.phase === 'stars')?.status).toBe('imported');
    vi.unstubAllGlobals();
  });

  it('reports a completed run when no walk is outstanding', async () => {
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ 'subsonic-response': { status: 'ok' } }, { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const workflow = new LibraryImportWorkflow(fakeCtx().executionContext as never, envFor(handle) as never);
    await workflow.run(
      { payload: { runId, sourceId, userId, libraryIds: [libraryId], phases: ['bookmarks'], playlistIds: [] } } as never,
      fakeStep() as never,
    );

    const runs = new ImportRunDAO(handle.db);
    expect((await runs.findById(runId))?.status).toBe('completed');
    expect(parseReport(await runs.readReport(runId))?.finishedAt).toBeTypeOf('number');
    vi.unstubAllGlobals();
  });

  it('skips a phase the operator did not ask for, entirely', async () => {
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    const step = fakeStep();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ 'subsonic-response': { status: 'ok' } }, { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const workflow = new LibraryImportWorkflow(fakeCtx().executionContext as never, envFor(handle) as never);
    await workflow.run(
      { payload: { runId, sourceId, userId, libraryIds: [libraryId], phases: [], playlistIds: [] } } as never,
      step as never,
    );

    // **No steps at all**. A phase the operator left out is skipped, not run-and-found-empty —
    // so the report cannot show a category they did not ask for as imported.
    expect(step.calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('replaces a phase line by name rather than appending, so a retried phase cannot double it', async () => {
    // Recording happens **outside** `step.do` and is keyed by phase name. That is what makes it
    // idempotent; appending would list every unresolved item once per attempt, and a duplicate reads
    // as a second, different problem.
    const { runId, sourceId, userId } = await seedRun();
    const libraryId = (await new LibraryDAO(handle.db).list())[0]?.id ?? '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { 'subsonic-response': { status: 'ok', starred2: {} } },
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const runs = new ImportRunDAO(handle.db);
    // Seed a report that already carries a `stars` line, as a previous attempt would have.
    await runs.writeReport(
      runId,
      serializeReport(
        buildReport({
          runId,
          sourceName: 'Old server',
          targetUsername: 'ann',
          finished: false,
          phases: [
            phase({
              phase: 'stars',
              status: 'partial',
              unresolvedCount: 1,
              unresolved: [{ category: 'star', context: 'starred', remoteId: 'r1', label: 'Gone', reason: 'not-found' }],
            }),
          ],
        }),
      ),
    );

    const workflow = new LibraryImportWorkflow(fakeCtx().executionContext as never, envFor(handle) as never);
    await workflow.run(
      { payload: { runId, sourceId, userId, libraryIds: [libraryId], phases: ['stars'], playlistIds: [] } } as never,
      fakeStep() as never,
    );

    const stored = parseReport(await runs.readReport(runId));
    // **One** line named `stars`, not two.
    expect(stored?.phases.filter((entry) => entry.phase === 'stars')).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe('the phase vocabulary is one list, and both callers read it', () => {
  it('is exported once, from the feature, not restated per consumer', () => {
    // The route validates an operator's `phases` against this exact list and the workflow switches
    // on the same names. Two lists would be two vocabularies, and a phase the route accepts but the
    // workflow ignores is a category that reports success having imported nothing.
    expect(IMPORT_PHASES).toEqual(['playlists', 'stars', 'bookmarks', 'playQueue', 'playCounts']);
    expect(new Set(IMPORT_PHASES).size).toBe(IMPORT_PHASES.length);
  });
});
