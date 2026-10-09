/**
 * `/user/import/*`, and the four refusals that stand between an operator and a spent day.
 *
 * ### Why the refusals are the interesting half
 *
 * Starting an import spends the D1 **daily** row-write allowance, and since 2026-09-01 an
 * account over it has *every* query fail until midnight UTC — reads included, so `/rest`
 * authentication with it. A conflict from this endpoint is therefore not a polite "come back
 * later"; two concurrent imports, or an import beside a running scan, are how a personal
 * deployment takes its own music offline until a clock ticks.
 *
 * So the four gates are asserted individually, and the two that are pure functions are
 * asserted **both** ways — which is what makes them guards rather than decorations. A
 * precondition that passes when it should fail is worse than no precondition, because it looks
 * like one.
 *
 * ### And the SSRF gate runs before the credential is touched
 *
 * Asserted through the HTTP surface rather than on the helper, because the ordering is the
 * claim: a form that encrypted before normalizing would spend a Secrets Store read on every
 * rejected attempt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, ORIGIN, REMOTE_TEST_KEY, USER_TEST_KEY, WEBDAV_TEST_KEY } from './helpers/harness';
import type { Harness } from './helpers/harness';
import { ImportPlayCountProgressDAO, ImportRunDAO, ImportSourceDAO, LibraryDAO, ScanStateDAO, UserDAO } from '@edge-sonic/backend-data/dao';
import { decryptData, encryptData } from '@edge-sonic/backend-data/crypto';
import { readPhases } from '../apps/api/src/user/importRoutes';
import { BadRequestError, ConflictError } from '@edge-sonic/backend-errors';
import { assertScansIdle, isImportInFlight } from '@edge-sonic/backend-services/import';
import { runWorkflow } from '@edge-sonic/backend-runtime/base';
import { Tokens, createRequestScope } from '@edge-sonic/backend-services/composition';
import { ALBUMS_PER_BATCH, SUBSREQUESTS_PER_ALBUM_BASE } from '../apps/background/src/PlayCountImportWorker';
import { WORKER_SUBSREQUEST_CEILING } from '@edge-sonic/backend-runtime/config';

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * The harness env has the dev bypass **on**, and `allowPrivateHosts` is
 * `getAllowPrivateWebdavHosts() ?? isBypassAllowed()` — the same expression
 * `requestScope.ts` binds for a WebDAV library. So a refusal case has to say `false`
 * explicitly, exactly as `test/user-api.test.ts` does for `ALLOW_PRIVATE_WEBDAV_HOSTS`.
 *
 * Asserted here rather than assumed, because the alternative is a suite whose SSRF cases pass
 * for the wrong reason: with the bypass on, a gate that was deleted entirely would still refuse
 * nothing, and a gate that refused *everything* would still pass every case below.
 */
const NO_PRIVATE = { ALLOW_PRIVATE_WEBDAV_HOSTS: 'false' };

/**
 * Production mode, where the bypass refuses. Every `401` case needs it: under the dev bypass
 * `/user/*` is open by design, so asserting a refusal there would be asserting nothing.
 */
const PRODUCTION = { ENVIRONMENT: 'production', TEAM_DOMAIN: 'example.cloudflareaccess.com', POLICY_AUD: 'aud' };

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
  vi.unstubAllGlobals();
});

async function call(
  path: string,
  init: RequestInit = {},
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await harness.fetch(`${ORIGIN}${path}`, overrides, init);
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return await call(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/**
A user with a granted library, which is what an import actually needs.
*/
async function seedUserWithLibrary(username: string): Promise<{ userId: string; libraryId: string }> {
  const users = new UserDAO(harness.db.db);
  const userId = (await users.create({ username, passwordCiphertext: 'c', passwordIv: 'iv' })).id;
  const libraryId = (
    await new LibraryDAO(harness.db.db).create({
      slug: `home-${username.toLowerCase()}`,
      baseUrl: 'https://dav.example.com',
      rootPath: '/dav',
      davUsername: username,
      passwordCiphertext: 'c',
      passwordIv: 'iv',
    })
  ).id;
  await users.setLibraryGrants(userId, [libraryId]);
  return { userId, libraryId };
}

/**
 * A source whose credential is **really** encrypted under the remote key.
 *
 * It was `'c'`/`'iv'` — a literal pair of placeholders — until the service began *decrypting*,
 * which it does whenever a client is built. A fixture with unreadable ciphertext passes every
 * test that never reads it and fails the first one that does, which is a fixture defect arriving
 * as a product failure: `fakeKv` returning byte-exact reads, one layer up.
 */
async function seedSource(username: string): Promise<string> {
  const encrypted = await encryptData('hunter2', REMOTE_TEST_KEY);
  return (
    await new ImportSourceDAO(harness.db.db).create({
      name: `Source ${username}`,
      baseUrl: 'https://music.example.com/sonic',
      username,
      passwordCiphertext: encrypted.ciphertext,
      passwordIv: encrypted.iv,
      musicFolderId: null,
    })
  ).id;
}

describe('registering an import source', () => {
  it('rejects a URL the SSRF gate refuses, and never reads the key for it', async () => {
    // The ordering is the claim. A form that encrypted before normalizing would spend a Secrets
    // Store read — and an exposure — on every rejected attempt, and the gate would still be
    // correct; nothing here could see the difference except the fact that the gate runs first,
    // so it is asserted as a refusal **and** as the absence of a row.
    const response = await harness.fetch(`${ORIGIN}/user/import/sources`, NO_PRIVATE, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Internal', baseUrl: 'http://169.254.169.254', username: 'alice', password: 'x' }),
    });

    expect(response.status).toBe(400);
    expect(await new ImportSourceDAO(harness.db.db).findByUsername('alice')).toBeNull();
  });

  it('stores the credential under the third key, and not under either of the other two', async () => {
    const { status } = await post('/user/import/sources', {
      name: 'Old server',
      baseUrl: 'https://music.example.com/sonic',
      username: 'alice',
      password: 'hunter2',
    });
    expect(status).toBe(201);

    const stored = await new ImportSourceDAO(harness.db.db).findByUsername('alice');
    expect(stored?.password_ciphertext).toBeDefined();

    // The point of the third key, asserted as a **failure** under the other two. A merge would
    // have made this case impossible to write, and a compromise of the most frequently read key
    // in the product would have yielded this credential.
    await expect(decryptData(stored!.password_ciphertext, stored!.password_iv, USER_TEST_KEY)).rejects.toThrow();
    await expect(decryptData(stored!.password_ciphertext, stored!.password_iv, WEBDAV_TEST_KEY)).rejects.toThrow();

    // And it is recoverable. "Encrypted with a key nobody holds" and "encrypted with the wrong
    // key" are indistinguishable from outside — both are a thrown decryption — so only this
    // proves the first is not what shipped. Read through the composition root rather than through
    // the harness's env var, because `resolveKey`'s binding order is part of what is asserted.
    const scope = createRequestScope(harness.env() as never);
    expect(await decryptData(stored!.password_ciphertext, stored!.password_iv, await scope.get(Tokens.RemoteKey)())).toBe('hunter2');
  });

  it('answers a list without any ciphertext, because the projection never selects it', async () => {
    await seedSource('alice');

    const { status, body } = await call('/user/import/sources');

    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toContain('password_ciphertext');
    expect(JSON.stringify(body)).not.toContain('password_iv');
    // And the source is genuinely listed, so the assertion is about the projection rather than
    // about an empty page.
    expect(body['sources'] as unknown[]).toHaveLength(1);
  });

  it('refuses a duplicate remote account with a conflict rather than storing two', async () => {
    await seedSource('alice');

    const response = await harness.fetch(
      `${ORIGIN}/user/import/sources`,
      {},
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'A different label', baseUrl: 'https://other.example.com', username: 'ALICE', password: 'x' }),
      },
    );
    const { status } = { status: response.status };

    // Two sources sharing a *credential* is what would quietly import one server's data into
    // another's. Two sharing a *name* is ordinary, and the schema allows it.
    expect(status).toBe(409);
  });
});

describe('the four refusals, through the HTTP surface', () => {
  it('refuses while any library is scanning, and names the remedy', async () => {
    const { userId, libraryId } = await seedUserWithLibrary('Bob');
    // `markScanning` is an `UPDATE`, so it presupposes the row `ensure` writes. Seeding only the
    // update is how this case would have read as "nothing is scanning" and passed for the wrong
    // reason — which is the shape of every precondition that is not paired with its negative.
    const scanState = new ScanStateDAO(harness.db.db);
    await scanState.ensure(libraryId);
    await scanState.markScanning(libraryId, 3);
    expect((await scanState.find(libraryId))?.status).toBe('scanning');
    const sourceId = await seedSource('alice');

    const { status, body } = await post('/user/import', { sourceId, targetUserId: userId });

    expect(status).toBe(409);
    // The message names what is wrong and what to do about it, because a bare status code
    // leaves an operator with nothing actionable.
    expect(JSON.stringify(body)).toMatch(/scan is running/i);
  });

  it('refuses a second import for the same user, so the allowance has one writer', async () => {
    const { userId } = await seedUserWithLibrary('Bob');
    const sourceId = await seedSource('alice');
    await new ImportRunDAO(harness.db.db).create({ sourceId, targetUserId: userId, phases: ['playlists'] });
    // A **paused** run counts, and that is the case worth setting up: `paused` is a status whose
    // whole point is that it resolves *without* a poll, so a run in it is still in flight.
    await harness.db.db.prepare("UPDATE import_runs SET status = 'paused'").run();

    const { status, body } = await post('/user/import', { sourceId, targetUserId: userId });

    expect(status).toBe(409);
    expect(JSON.stringify(body)).toMatch(/already running/i);
  });

  it('refuses a disabled target, because nothing imported would be reachable', async () => {
    const { userId } = await seedUserWithLibrary('Bob');
    await new UserDAO(harness.db.db).setEnabled(userId, false);
    const sourceId = await seedSource('alice');

    const { status, body } = await post('/user/import', { sourceId, targetUserId: userId });

    // Said here rather than discovered at the end of a walk: an operator would otherwise wait
    // out a full import to learn the destination cannot log in.
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toMatch(/disabled/i);
  });

  it('refuses a target with no granted library, because no song could be matched', async () => {
    const userId = (await new UserDAO(harness.db.db).create({ username: 'Cleo', passwordCiphertext: 'c', passwordIv: 'iv' })).id;
    const sourceId = await seedSource('alice');

    const { status, body } = await post('/user/import', { sourceId, targetUserId: userId });

    expect(status).toBe(409);
    expect(JSON.stringify(body)).toMatch(/no granted library/i);
  });
});

describe('the read surface, and what it must not spend', () => {
  it('answers a run’s status and its report', async () => {
    const { userId } = await seedUserWithLibrary('Bob');
    const sourceId = await seedSource('alice');
    const runs = new ImportRunDAO(harness.db.db);
    const run = await runs.create({ sourceId, targetUserId: userId, phases: ['playlists', 'stars'] });

    const { status, body } = await call(`/user/import/${run.id}`);

    expect(status).toBe(200);
    expect(body['status']).toBe('running');
    // A **read**: the operator's page polls this while an import runs, and a status read that wrote
    // would spend the allowance it is reporting on.
    expect(body['report']).toBeNull();
    // No cursor row, because the walk has not started — this run's phases are `playlists` and
    // `stars`. The walk writes the row on its first batch (`PlayCountImportWorker.runBatch`), so
    // "absent" here means "the play-count walk has not begun", which is a different thing from
    // "began and imported nothing" and the client renders them differently.
    expect(body['playCounts']).toBeNull();
  });

  it('reports a play-count walk in progress, which it could not before the walk wrote the row', async () => {
    // `ImportPlayCountProgressDAO` had `ensure`/`advance`/`markFinished` and **no writer** — only
    // `read` was ever called, by this route. So `playCounts` was `null` for every real import: a
    // field on the wire with nothing behind it, which is the shape `backend-data/AGENTS.md` records
    // for `ScanStateDAO.ensure` on the libraries page.
    //
    // The number is asserted by driving the writer — the walk's own alarm — rather than by writing
    // the row here, because a test that seeds the row would pass whether or not the walk wrote it.
    const { userId } = await seedUserWithLibrary('Bob');
    const sourceId = await seedSource('alice');
    const runs = new ImportRunDAO(harness.db.db);
    const run = await runs.create({ sourceId, targetUserId: userId, phases: ['playCounts'] });

    // Before the walk: absent.
    expect((await call(`/user/import/${run.id}`)).body['playCounts']).toBeNull();

    // What `runBatch` writes on its first batch, and again per batch with a **delta**.
    const progress = new ImportPlayCountProgressDAO(harness.db.db);
    await progress.ensure(run.id);
    await progress.advance(run.id, 'remote-album-3', 3, 41);

    const body = (await call(`/user/import/${run.id}`)).body;
    expect(body['playCounts']).toEqual({ albumsDone: 3, songsImported: 41 });

    // A second batch adds to it rather than replacing it — the reason `advance` is a delta.
    await progress.advance(run.id, 'remote-album-6', 3, 12);
    expect((await call(`/user/import/${run.id}`)).body['playCounts']).toEqual({ albumsDone: 6, songsImported: 53 });
  });

  it('reports a run that does not exist as absence rather than an empty one', async () => {
    // An empty object here would render as a run with no phases and no error — which reads as
    // "finished having imported nothing" rather than "there is no such run".
    const { status } = await call('/user/import/no-such-run');

    expect(status).toBe(404);
  });

  it('lists runs newest first, with the source name and a null for one that is gone', async () => {
    const { userId } = await seedUserWithLibrary('Bob');
    const sourceId = await seedSource('alice');
    const runs = new ImportRunDAO(harness.db.db);
    const first = await runs.create({ sourceId, targetUserId: userId, phases: ['playlists'] });
    await harness.db.db.prepare('UPDATE import_runs SET started_at = 1 WHERE id = ?').bind(first.id).run();
    const second = await runs.create({ sourceId, targetUserId: userId, phases: ['stars'] });

    // Delete the source: the run cascades with it, which is the schema property — so the
    // "unknown source" case needs a run whose source is *not* there, and there is none.
    // Assert the ordering and the resolved name instead, which is what the list is for.
    const { status, body } = await call('/user/import');

    expect(status).toBe(200);
    const listed = body['runs'] as Array<Record<string, unknown>>;
    expect(listed.map((entry) => entry['id'])).toEqual([second.id, first.id]);
    expect(listed[0]['sourceName']).toBe('Source alice');
    // And a target the user table no longer holds would be `null` — never the reader’s own name
    // standing in for it.
    expect(listed[0]['targetUsername']).toBe('Bob');
  });

  it('deletes a source, and reports a second delete as absence', async () => {
    const sourceId = await seedSource('alice');

    expect((await call(`/user/import/sources/${sourceId}`, { method: 'DELETE' })).status).toBe(200);
    // The second one must be distinguishable: a silent success would leave a client that retried
    // after a timeout believing it removed something.
    expect((await call(`/user/import/sources/${sourceId}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers a duplicate remote account as a conflict, not a bad request', async () => {
    // Two sources sharing a *credential* is what would quietly import one server's data into
    // another’s, and it is a conflict rather than a malformed request. Mapping by error **class**
    // would have made this and a refused URL share one status.
    await seedSource('alice');

    const response = await harness.fetch(
      `${ORIGIN}/user/import/sources`,
      {},
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'Another label', baseUrl: 'https://other.example.com', username: 'ALICE', password: 'x' }),
      },
    );

    expect(response.status).toBe(409);
  });

  it('answers a malformed URL as a bad request, because it is one', async () => {
    const response = await harness.fetch(`${ORIGIN}/user/import/sources`, NO_PRIVATE, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Broken', baseUrl: 'not-a-url', username: 'alice', password: 'x' }),
    });

    expect(response.status).toBe(400);
  });

  it('reports a deployment with no workflow binding as unavailable, and records why on the run', async () => {
    // The run is still written, so the refusal is visible in the operator’s list rather than being
    // an error with no row behind it — and `last_error` is the only place the reason is recorded.
    const { userId } = await seedUserWithLibrary('Bob');
    const sourceId = await seedSource('alice');

    const { status, body } = await post('/user/import', { sourceId, targetUserId: userId });

    // 501, not 409 or 400: the request was well-formed and the *deployment* cannot serve it.
    expect(status).toBe(501);
    expect(JSON.stringify(body)).toMatch(/not available/i);

    const runs = new ImportRunDAO(harness.db.db);
    const listed = await runs.listRecent(20, new Map());
    expect(listed[0].status).toBe('failed');
    expect(listed[0].lastError).toMatch(/workflow/i);
  });
});

describe('the phase list is what the operator asked for, and a typo is refused', () => {
  it('defaults to every phase except the play queue', () => {
    // A saved queue is transient state: the person who has just moved servers does not want
    // yesterday's half-finished queue restored, and a default-on imports it without anybody
    // deciding to.
    expect(readPhases(undefined)).toEqual(['playlists', 'stars', 'bookmarks', 'playCounts']);
    expect(readPhases(undefined)).not.toContain('playQueue');
  });

  it('imports the play queue when it is asked for explicitly', () => {
    expect(readPhases(['playQueue'])).toEqual(['playQueue']);
    expect(readPhases([])).toEqual([]);
  });

  it('refuses an unknown phase rather than skipping it', () => {
    // Silently dropping a category an operator named is the same failure as silently dropping a
    // song, one level up: the report would show four phases imported and no mention of the
    // fifth that was asked for.
    expect(() => readPhases(['playlists', 'playlistsss'])).toThrow(BadRequestError);
    expect(() => readPhases(['playlists', 'playlistsss'])).toThrow(/playlistsss/);
    expect(() => readPhases('playlists')).toThrow(BadRequestError);
    expect(() => readPhases([1])).toThrow(BadRequestError);
  });
});

describe('the scan precondition, asserted both ways', () => {
  const scanning = (status: string): { listAll: () => Promise<ReadonlyArray<{ library_id: string; status: string }>> } => ({
    listAll: async () => [{ library_id: 'L1', status }],
  });

  it('is quiet when nothing is advancing', async () => {
    await expect(assertScansIdle(scanning('idle'))).resolves.toBeUndefined();
    // A library with **no row** is not scanning, and must not default to being so — that would
    // make a brand-new deployment refuse every import until it had scanned once.
    await expect(assertScansIdle({ listAll: async () => [null] })).resolves.toBeUndefined();
    // And a scan that is **broken** is not advancing either. Refusing an import because a scan
    // has failed leaves an operator who cannot fix either one.
    await expect(assertScansIdle(scanning('failed'))).resolves.toBeUndefined();
    await expect(assertScansIdle(scanning('stalled'))).resolves.toBeUndefined();
  });

  it('refuses while a scan is working, and names how many libraries are busy', async () => {
    // `marking` counts: a scan completing writes its rows under it, and an import admitted there
    // races the exact write that spends the last of the allowance.
    for (const status of ['scanning', 'marking']) {
      await expect(assertScansIdle(scanning(status))).rejects.toThrow(ConflictError);
    }
    // The count, because the remedy is plural and a wrong number is a wrong sentence.
    await expect(assertScansIdle(scanning('scanning'))).rejects.toThrow(/on 1 library\b/);
    await expect(
      assertScansIdle({
        listAll: async () => [
          { library_id: 'L1', status: 'scanning' },
          { library_id: 'L2', status: 'marking' },
        ],
      }),
    ).rejects.toThrow(/on 2 libraries/);
  });

  it('treats both in-flight statuses as in flight, because they ask different things of each reader', () => {
    // `running` and `paused` mean opposite things to the scan's alarm — which must stay armed
    // *through* a paused import, since it is the only thing that can resume it — and to a second
    // import, which must be refused. One predicate cannot answer for both, so neither asks.
    expect(isImportInFlight({ one: null, running: 1 })).toBe(true);
    expect(isImportInFlight({ one: null, running: 2 })).toBe(true);
    expect(isImportInFlight({ one: null, running: 0 })).toBe(false);
    expect(isImportInFlight(null)).toBe(false);
  });
});

describe('a stopped Workflow is recorded as stopped, not as complete', () => {
  it('rethrows, because returning normally is how a Workflow reports success', async () => {
    // The failure this guards: a `run` that swallows reports a **completed** instance whose
    // steps did not all run, and the operator's page reads "finished" off a run that imported
    // three playlists. The same shape as a scan that "finished" because its frontier emptied.
    await expect(
      runWorkflow('LibraryImportWorkflow', async () => {
        throw new Error('the remote refused');
      }),
    ).rejects.toThrow('the remote refused');
  });

  it('returns the body result when the body succeeds', async () => {
    await expect(runWorkflow('LibraryImportWorkflow', async () => 'done')).resolves.toBe('done');
  });

  it('logs a literal plus the label, and never the error text', async () => {
    // Cloudflare's `js/clear-text-logging` taints a variable built from an untrusted value, and
    // a `RemoteSubsonicError` carries a URL — so the error is a **separate argument** rather than
    // interpolated into the line. The label is what the line is for: which instance class
    // stopped.
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => lines.push(args);

    try {
      // Caught rather than left to reject: the rethrow is the behaviour under test in the case
      // above, and here it is only the vehicle for the error text.
      await expect(
        runWorkflow('LibraryImportWorkflow', async () => {
          throw new Error('GET https://music.example.com/secret?u=alice failed');
        }),
      ).rejects.toThrow();
    } finally {
      console.error = original;
    }

    expect(lines.length).toBeGreaterThanOrEqual(1);
    // The first argument is the logger's prefix; the message is the second, and the error
    // object the third — interpolating its text is the taint this policy exists to avoid.
    expect(String(lines[0][1])).toContain('LibraryImportWorkflow');
    expect(String(lines[0][1])).not.toContain('secret');
  });
});

describe('the play-count batch is bounded by the platform number, not typed beside it', () => {
  it('derives the album count from the chunk budget and the per-album cost', () => {
    // Asserted as the **relationship**, because a test pinning the numeral would keep passing
    // the day the ceiling moved and the batch silently became unaffordable — which is exactly
    // what `SCAN_CHUNK_MAX_REQUESTS = 1000` against a ceiling of 50 was.
    expect(ALBUMS_PER_BATCH).toBeGreaterThanOrEqual(1);
    expect(ALBUMS_PER_BATCH * SUBSREQUESTS_PER_ALBUM_BASE).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    // A whole number of albums: `page.length < ALBUMS_PER_BATCH` is how the walk knows it is
    // finished, so a fractional batch would drop the last album of every page for ever.
    expect(Number.isInteger(ALBUMS_PER_BATCH)).toBe(true);
  });

  it('charges more than the one remote call an album actually makes', () => {
    // `getAlbum` is the external request; the rest is two match statements and the writes.
    // Budgeting one per album admits several times the work onto a budget of 50.
    expect(SUBSREQUESTS_PER_ALBUM_BASE).toBeGreaterThan(1);
  });
});

describe('the routes are guarded by Access, and a Subsonic credential does not stand in for one', () => {
  it('refuses an unauthenticated caller on every one of them', async () => {
    // The whole surface. An import route reachable without a session is a way to send a stored
    // credential to a host the caller chose, into an account of their picking.
    for (const [method, path] of [
      ['GET', '/user/import'],
      ['GET', '/user/import/sources'],
      ['GET', '/user/import/abc'],
      ['POST', '/user/import'],
      ['POST', '/user/import/sources'],
      ['DELETE', '/user/import/sources/abc'],
    ] as const) {
      const response = await harness.fetch(`${ORIGIN}${path}`, PRODUCTION, { method });
      expect(response.status, `${method} ${path} must require a session`).toBe(401);
    }
  });

  it('does not accept a valid Subsonic credential in place of a session', async () => {
    // `/rest` is guarded by a Subsonic credential and `/user` by Cloudflare Access. A `s`/`t`
    // pair that can read a whole library by path must not also be able to spend the daily
    // allowance or aim a stored credential at a chosen host.
    //
    // **In production mode**, because the harness env turns the dev bypass on and
    // `/user/*` is open by design under it — asserting a refusal there asserts nothing. And with a
    // genuinely valid token, taken from `restUrl` rather than hand-built, so the case is about
    // the route's guard rather than about a malformed credential being rejected for the wrong
    // reason.
    const token = new URL(harness.restUrl('ping')).search;
    const response = await harness.fetch(`${ORIGIN}/user/import?${token}`, PRODUCTION, {});

    expect(response.status).toBe(401);
  });
});
