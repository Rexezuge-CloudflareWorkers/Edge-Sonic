import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, PASSWORD, SALT, USERNAME, EXPECTED_TOKEN, ORIGIN, subsonicId, ALBUM_DIR } from './helpers/harness';
import type { Harness } from './helpers/harness';
import { fakeKv } from './helpers/fakeKv';
import { READER_VERSION } from '@edge-sonic/media-tags';
import { SPA_HTML } from '../apps/api/src/generated/spa-shell';
import { getRateLimitBucketCountForTests, resetRateLimitForTests } from '../apps/api/src/middleware/rateLimit';

let harness: Harness;

/**
A minimal `ExecutionContext`. Nothing in the request path calls `waitUntil`.
*/
const executionContext = {
  waitUntil: (): void => undefined,
  passThroughOnException: (): void => undefined,
  props: {} as Record<string, unknown>,
};

let env: (overrides?: Record<string, unknown>) => Record<string, unknown>;
let restUrl: (endpoint: string, extra?: Record<string, string>) => string;
let get: (url: string, overrides?: Record<string, unknown>, init?: RequestInit) => Promise<Response>;
let rest: (endpoint: string, extra?: Record<string, string>) => Promise<{ status: number; response: Response; body: SubsonicBody }>;

interface SubsonicBody {
  'subsonic-response': {
    status: string;
    version: string;
    type: string;
    openSubsonic: boolean;
    error?: { code: number; message: string };
    [key: string]: unknown;
  };
}

beforeEach(async () => {
  // The rate limiter's buckets are module-level state that outlives a request, so a
  // bucket opened by one test would otherwise be counted by the next one's assertion.
  resetRateLimitForTests();
  harness?.close();
  harness = await createHarness();
  env = harness.env;
  restUrl = harness.restUrl;
  get = harness.fetch;
  rest = harness.rest;
});

/**
The seeded ids, kept in local names so the assertions read as music rather than as base64.
*/
const SKINNY_LOVE = subsonicId('s', `${ALBUM_DIR}/01.flac`);
const HOLOCENE = subsonicId('s', `${ALBUM_DIR}/02.flac`);

describe('the Subsonic envelope', () => {
  it('answers ping with an empty ok envelope', async () => {
    const { status, response, body } = await rest('ping');
    expect(status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body['subsonic-response']).toMatchObject({ status: 'ok', version: '1.16.1', type: 'edge-sonic', openSubsonic: true });
    // Some clients treat any child element on `ping` as a protocol violation, so the
    // exact key set is asserted: adding a field here is a deliberate decision, not a
    // side effect of adding one somewhere else.
    expect(Object.keys(body['subsonic-response']).sort()).toEqual(['openSubsonic', 'serverVersion', 'status', 'type', 'version']);
  });

  it('honours f=xml and escapes untrusted values', async () => {
    const response = await get(`${ORIGIN}/rest/getMusicDirectory.view?${new URLSearchParams({ u: USERNAME, t: EXPECTED_TOKEN, s: SALT, v: '1.16.1', f: 'xml', id: subsonicId('dir', ALBUM_DIR) })}`);
    expect(response.headers.get('content-type')).toContain('text/xml');
    const xml = await response.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    // The artist name is a filename, so it is attacker-controlled through a directory
    // listing and must not be able to close an element.
    expect(xml).toContain('artist="Bon Iver"');
    expect(xml).not.toMatch(/<script/i);
  });

  it('never marks a response cacheable', async () => {
    // Responses are per-user; a shared cache must never serve one user's library to
    // another.
    const { response } = await rest('ping');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('authentication', () => {
  it('rejects a wrong token with code=40, over HTTP 200', async () => {
    // 200 with a failed envelope, which is what every real Subsonic server sends and what
    // a client actually parses. It was 401, on the argument that HTTP-level tooling can
    // only see a failed authentication through the status — and that cost a real client
    // the one thing it needs: `fin` calls `.error_for_status()` before parsing anything,
    // so a wrong password arrived as a bare `401 Unauthorized` with no message and no
    // code, on a server whose every other answer was correct. The envelope is the
    // contract; the status is not part of it.
    const { status, body } = await rest('ping', { t: '0'.repeat(32) });
    expect(status).toBe(200);
    expect(body['subsonic-response'].status).toBe('failed');
    expect(body['subsonic-response'].error?.code).toBe(40);
    // And the message survives, because that is what the user is shown.
    expect(typeof body['subsonic-response'].error?.message).toBe('string');
  });

  it('answers every protocol error with 200, whatever the code', async () => {
    // The general rule, walked rather than spot-checked: a non-2xx on this surface is a
    // client bug, not information. `code=40` used to be the exception, and an exception
    // here is a client that cannot read half its errors.
    const failures = await Promise.all([
      rest('ping', { t: '0'.repeat(32) }),
      rest('ping', { u: 'nobody' }),
      rest('noSuchEndpoint'),
      rest('getSong', { id: 'not-a-real-id' }),
      rest('getCoverArt'),
      rest('getAlbum', { id: 'al:0-bm90LWEtcmVhbC1pZA==' }),
    ]);
    for (const { status, body } of failures) {
      expect(status).toBe(200);
      expect(body['subsonic-response'].status).toBe('failed');
      expect(typeof body['subsonic-response'].error?.code).toBe('number');
    }
  });

  it('reports an unknown user as code=40, not as a distinct code', async () => {
    // Distinguishing "no such user" from "wrong password" turns `ping` into an
    // account-existence oracle.
    const { body } = await rest('ping', { u: 'nobody' });
    expect(body['subsonic-response'].error?.code).toBe(40);
  });

  it('accepts the legacy cleartext password', async () => {
    // The spec allows `p` instead of `t`+`s`, and some clients still send it.
    const response = await get(
      `${ORIGIN}/rest/ping.view?${new URLSearchParams({ u: USERNAME, p: PASSWORD, v: '1.16.1', f: 'json' })}`,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as SubsonicBody)['subsonic-response'].status).toBe('ok');
  });

  it('does not accept a token computed with an empty salt', async () => {
    // `t` with no `s` is not a valid credential. Computing `md5(password + "")` would
    // accept a token the attacker chose by supplying an empty salt, and the protocol
    // gives no reason to honour it.
    const { body } = await rest('ping', { s: '' });
    expect(body['subsonic-response'].error?.code).toBe(40);
  });

  it('requires `u` and names it', async () => {
    const response = await get(`${ORIGIN}/rest/ping.view?f=json`);
    // HTTP 200: a client parsing this surface cannot interpret anything else, and a
    // 400 with a correct body is shown to the user as "server error".
    expect(response.status).toBe(200);
    const body = (await response.json()) as SubsonicBody;
    expect(body['subsonic-response'].error?.code).toBe(10);
    expect(body['subsonic-response'].error?.message).toContain('u');
  });

  it('throttles repeated failures and then refuses', async () => {
    // D1-backed and fail-closed, so this is the one control that must not degrade when
    // the cache is having an incident.
    let last: SubsonicBody | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      last = (await (await get(restUrl('ping', { t: '0'.repeat(32) }))).json()) as SubsonicBody;
    }
    // The limit is 10 by default; past it the answer stops being `code=40`, because a
    // caller must not be able to keep guessing by learning "wrong password" forever.
    expect(last!['subsonic-response'].error?.code).toBe(0);
  });
});

describe('route order', () => {
  it('serves /health without a credential', async () => {
    // A liveness probe must never need a Subsonic password.
    const response = await get(`${ORIGIN}/health`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { apiVersion: string }).apiVersion).toBe('1.16.1');
  });

  it('gates /user behind Cloudflare Access, not behind a Subsonic credential', async () => {
    // The two identity systems are deliberately separate: an operator's Access identity
    // must not be usable as a streaming credential, and a Subsonic password must not
    // open the user API.
    // Asserted in `production`, where no dev bypass applies — the other test covers the
    // allow-list itself.
    const withPassword = await harness.worker.fetch(
      new Request(`${ORIGIN}/user/libraries`),
      { ...env(), ENVIRONMENT: 'production' } as never,
      executionContext,
    );
    expect(withPassword.status).toBe(401);
  });

  it('enforces the environment allow-list on the dev auth bypass', async () => {
    // Both directions are asserted, because a test that only checks the bypass passes
    // even if the allow-list stopped working altogether — which is the failure that
    // matters, since it authenticates every unauthenticated request as a fixed user.
    const inDevelopment = await harness.worker.fetch(new Request(`${ORIGIN}/user/me`), env() as never, executionContext);
    expect(inDevelopment.status).toBe(200);

    // The bypass is gated on an allow-list, not on `!== 'production'`: a deny-list
    // would enable it for `staging`, for `Preview`, and for a misspelled `prodcution`.
    const inProduction = await harness.worker.fetch(
      new Request(`${ORIGIN}/user/me`),
      { ...env(), ENVIRONMENT: 'production' } as never,
      executionContext,
    );
    expect(inProduction.status).toBe(401);

    // And a name that is *not* on the list, however it is spelled.
    const elsewhere = await harness.worker.fetch(
      new Request(`${ORIGIN}/user/me`),
      { ...env(), ENVIRONMENT: 'Preview' } as never,
      executionContext,
    );
    expect(elsewhere.status).toBe(401);
  });

  it('keys the user rate limit on the resolved identity, not on the client address', async () => {
    // The route order in `EdgeSonicWorker` puts `registerUserRateLimits` *after*
    // `userAuthentication`, and this is what that buys. The previous order registered
    // the limits first, while a comment claimed the opposite ("before auth, so they can
    // key on the resolved identity") — so every bucket silently fell back to `ip:…`.
    //
    // Two requests from one address, as two different operators. The user budget is
    // 60/min and cannot be exhausted cheaply here, so this asserts the *identity* is
    // what the bucket records: two different identities from one address each get their
    // own key, which is only true if `AuthenticatedUserEmailAddress` was set before the limiter ran.
    const first = await harness.worker.fetch(
      new Request(`${ORIGIN}/user/me`, { headers: { 'cf-connecting-ip': '203.0.113.50' } }),
      { ...env(), DEV_AUTH_EMAIL: 'ann@example.com' } as never,
      executionContext,
    );
    const second = await harness.worker.fetch(
      new Request(`${ORIGIN}/user/me`, { headers: { 'cf-connecting-ip': '203.0.113.50' } }),
      { ...env(), DEV_AUTH_EMAIL: 'bob@example.com' } as never,
      executionContext,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Two identities, so two buckets, so two tracked keys — not one shared by the
    // address they happened to share.
    const bob = ((await second.json()) as { email: string }).email;
    expect(bob).toBe('bob@example.com');
    expect(getRateLimitBucketCountForTests()).toBeGreaterThanOrEqual(2);
  });

  it('serves an unauthenticated /user path in the Exception dialect, not the Subsonic one', async () => {
    // Two dialects, and the split is by surface. A client parsing `/rest` has no way to
    // interpret the user shape, and an SPA has no way to interpret the protocol
    // envelope — so `onError` and `notFound` both choose by path. This also covers the
    // 401 from the auth middleware, which is the most common way an operator's browser
    // first meets this surface.
    const response = await harness.worker.fetch(
      new Request(`${ORIGIN}/user/libraries`),
      { ...env(), ENVIRONMENT: 'production' } as never,
      executionContext,
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { Exception: { Type: string; Message: string } };
    // One key, so a client needs a single decoder for the whole user surface.
    expect(Object.keys(body)).toEqual(['Exception']);
    expect(body.Exception.Type).toBe('Unauthorized');
  });

  it('answers a CORS preflight without credentials', async () => {
    // A Fetch-spec preflight carries no credentials by design. Requiring auth for one
    // can only break clients, and a browser never issues the real request after a
    // failed preflight.
    const response = await harness.worker.fetch(
      new Request(`${ORIGIN}/rest/ping.view`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' } }),
      env() as never,
      executionContext,
    );
    expect(response.status).toBe(204);
  });

  it('serves the operator SPA shell for its own routes', async () => {
    // Compares against the imported shell constant instead of a hardcoded marker:
    // `spa-shell.ts` is gitignored and generated, so CI runs against the empty
    // postinstall stub while a local checkout may hold a built shell. What this
    // locks is the ROUTE TABLE (shell vs 404 vs API envelope), not the build
    // artifact body — `scripts/verify-spa-shell.mjs` owns the artifact.
    const response = await get(`${ORIGIN}/libraries`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe(SPA_HTML);
  });

  it('does not return HTML for an API path', async () => {
    // A client that mistypes a URL must get a parseable envelope, not a page.
    const { response } = await rest('notAnEndpoint');
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('browsing', () => {
  it('lists only the libraries this user was granted', async () => {
    const { body } = await rest('getMusicFolders');
    const folders = (body['subsonic-response'].musicFolders as { musicFolder: Array<{ id: number; name: string }> }).musicFolder;
    // `id` is the position in the list, not the library's own key: the schema types it
    // as an `integer`, and it is what every `musicFolderId` refers to.
    expect(folders).toEqual([{ id: 0, name: 'Home' }]);
  });

  it('serves getIndexes with folder shortcuts and tag-index artists, with no WebDAV request', async () => {
    // The origin is unreachable in this environment, so a request that succeeded proves
    // it never left the process.
    //
    // The shape is the schema's, not a choice: `shortcut` is a direct child of
    // `indexes`, and each `index` group holds `artist` children. It shipped with the
    // folders nested as `shortcut` children *inside* the letter groups, which no
    // client reads — `index.artist` came back absent and the whole alphabetical
    // browse was empty on a client that works everywhere else — and the assertion
    // below was written from that code rather than from the schema, so it agreed.
    const { body } = await rest('getIndexes');
    const indexes = body['subsonic-response'].indexes as {
      shortcut: Array<{ id: string; name: string }>;
      index: Array<{ name: string; artist: Array<{ id: string; name: string }> }>;
    };
    expect(indexes.shortcut.map((shortcut) => shortcut.name)).toContain('Bon Iver');
    const artists = indexes.index.flatMap((group) => group.artist);
    expect(artists.map((artist) => artist.name)).toContain('Bon Iver');

    // And the round trip, which is the point of publishing the id: an artist read
    // from `getIndexes` drills into `getArtist` instead of answering `code=70`.
    const bonIver = artists.find((artist) => artist.name === 'Bon Iver')!;
    const drilled = await rest('getArtist', { id: bonIver.id });
    expect((drilled.body['subsonic-response'].artist as { name: string }).name).toBe('Bon Iver');
  });

  it('serves getMusicDirectory with files as children and no WebDAV request', async () => {
    const { body } = await rest('getMusicDirectory', { id: subsonicId('dir', ALBUM_DIR) });
    const directory = body['subsonic-response'].directory as { name: string; child: Array<{ title: string; isDir: boolean; duration: number }> };
    expect(directory.name).toBe('For Emma');
    const skinnyLove = directory.child.find((child) => child.title === 'Skinny Love');
    expect(skinnyLove?.isDir).toBe(false);
    // Enriched duration, straight from the D1 row.
    expect(skinnyLove?.duration).toBe(251);
  });

  it('serves getSong with the enriched metadata', async () => {
    const { body } = await rest('getSong', { id: SKINNY_LOVE });
    expect(body['subsonic-response'].song).toMatchObject({
      id: SKINNY_LOVE,
      title: 'Skinny Love',
      album: 'For Emma, Forever Ago',
      artist: 'Bon Iver',
      duration: 251,
      bitRate: 900,
      suffix: 'flac',
      contentType: 'audio/flac',
    });
  });

  it('derives the album id from the directory, so it survives a rename', async () => {
    const { body } = await rest('getAlbum', { id: subsonicId('al', ALBUM_DIR) });
    const album = body['subsonic-response'].album as { songCount: number; duration: number };
    expect(album.songCount).toBe(2);
    expect(album.duration).toBe(587);
  });

  it('groups artists from the index', async () => {
    const { body } = await rest('getArtists');
    const artists = (body['subsonic-response'].artists as { index: Array<{ artist: Array<{ name: string; albumCount: number }> }> }).index;
    expect(artists.flatMap((group) => group.artist.map((artist) => artist.name))).toContain('Bon Iver');
  });

  it('finds a track by search', async () => {
    const { body } = await rest('search3', { query: 'skinny' });
    const result = body['subsonic-response'].searchResult3 as { song: Array<{ title: string }> };
    expect(result.song.map((song) => song.title)).toContain('Skinny Love');
  });
});

describe('ids are unforgeable in effect', () => {
  it('refuses a path that escapes the library root', async () => {
    const { body } = await rest('stream', { id: subsonicId('s', '../../../etc/passwd') });
    // code=70, not 50: `code=50` would confirm the id is real, turning the endpoint into
    // an oracle for which paths exist.
    expect(body['subsonic-response'].error?.code).toBe(70);
  });

  it('refuses a library this user was not granted', async () => {
    const { body } = await rest('getSong', { id: subsonicId('s', `${ALBUM_DIR}/01.flac`, 'L-other') });
    expect(body['subsonic-response'].error?.code).toBe(70);
  });

  it('refuses an album id where a song id is required', async () => {
    // Accepting it would resolve to the same path and work, hiding a client bug until
    // it became a different bug.
    const { body } = await rest('getSong', { id: subsonicId('al', ALBUM_DIR) });
    expect(body['subsonic-response'].error?.code).toBe(70);
  });
});

describe('the cache is never load-bearing', () => {
  it('answers getSong identically with a poisoned and a corrupt cache entry', async () => {
    // The same requirement as `test/kv-outage.test.ts`, at the HTTP level: a value a
    // client could not have written must not change the response. Byte equality, not
    // "looks right".
    const cold = await (await get(restUrl('getSong', { id: SKINNY_LOVE }))).text();

    // A wrong value under the right key, and a genuinely corrupt one. Both must degrade
    // to a recompute from D1.
    //
    // The poisoned entry carries the **current** `readerVersion` and the row's real
    // `mtime_ms`, so it is a cache entry a real deployment would consider valid: every
    // check `enrich` makes passes and only the value is wrong. An entry that fails an
    // earlier check would be ignored for that reason, and would prove less.
    await harness.cache.ns.put(
      `songMeta:v1:${SKINNY_LOVE}`,
      JSON.stringify({ mtimeMs: 1000, readerVersion: READER_VERSION, durationSeconds: 9999, bitrateKbps: 1, sampleRate: 44_100, channels: 2, container: 'flac' }),
    );
    await harness.cache.ns.put('songMeta:v1:nonsense:artists', 'not json at all');
    const poisoned = await (await get(restUrl('getSong', { id: SKINNY_LOVE }))).text();

    expect(poisoned).toBe(cold);
    expect(poisoned).toContain('"duration":251');
    expect(poisoned).not.toContain('9999');
  });

  it('answers identically with no cache binding at all', async () => {
    // `KvCache(null)` must not be a separate code path from a failing binding — it is
    // constructed in the composition root whenever `env.CACHE` is absent.
    const withoutCache = async (): Promise<string> =>
      await (
        await harness.worker.fetch(
          new Request(restUrl('getMusicDirectory', { id: subsonicId('dir', ALBUM_DIR) })),
          { ...env(), CACHE: undefined } as never,
          executionContext,
        )
      ).text();

    const withCache = await (
      await harness.worker.fetch(
        new Request(restUrl('getMusicDirectory', { id: subsonicId('dir', ALBUM_DIR) })),
        env() as never,
        executionContext,
      )
    ).text();

    expect(await withoutCache()).toBe(withCache);
  });

  it('answers identically when every cache operation throws', async () => {
    const failing = fakeKv({}, { failAll: true });
    const withDeadCache = await (
      await harness.worker.fetch(new Request(restUrl('getSong', { id: SKINNY_LOVE })), { ...env(), CACHE: failing.ns } as never, executionContext)
    ).text();
    const healthy = await (await get(restUrl('getSong', { id: SKINNY_LOVE }))).text();

    expect(withDeadCache).toBe(healthy);
  });
});

describe('the error surface', () => {
  it('answers an unknown endpoint in the envelope, not as a 404 page', async () => {
    const { status, body } = await rest('notAnEndpoint');
    expect(status).toBe(200);
    expect(body['subsonic-response'].error?.code).toBe(70);
  });

  it('answers a retired endpoint with a status a client can stop retrying', async () => {
    // `getVideos` is `gone`: HTTP 410 and a plain-text body, not a Subsonic envelope. A
    // `code=70` envelope is a *protocol* answer to "give me this", which invites the client
    // to report a server error; 410 says the endpoint is retired and there is nothing to
    // retry. Navidrome draws the same line.
    //
    // The trade is stated rather than hidden: five endpoints now answer outside the envelope,
    // and a client that parses only the envelope degrades to "could not read the response"
    // on those. It is bounded to endpoints no client calls in a loop.
    const response = await harness.fetch(harness.restUrl('getVideos'));
    expect(response.status).toBe(410);
    expect(response.headers.get('content-type')).toContain('text/plain');
  });

  it('answers an endpoint that exists with an empty wrapper, not a failure', async () => {
    // `getLyrics` was `code=70`. A client calls it on every track and `code=70` reads as
    // "the server failed" where the truth is "this instrumental has no lyrics". The wrapper
    // is present and empty, so "nothing to report" stays distinguishable from "not
    // implemented" — which is the whole reason the absent-endpoint table has four answers.
    const { status, body } = await rest('getLyrics', { id: subsonicId('s', 'a/track.flac') });
    expect(status).toBe(200);
    expect(body['subsonic-response'].error).toBeUndefined();
    expect(body['subsonic-response'].lyrics).toEqual({});
  });

  it('refuses a client version it cannot serve, with the code that says which side is old', async () => {
    const newer = await rest('ping', { v: '1.20.0' });
    // 30, not 20: the *server* is the old one here. Swapping them sends the user to
    // upgrade the wrong program.
    expect(newer.body['subsonic-response'].error?.code).toBe(30);
  });

  it('accepts an older client in the same major', async () => {
    // `1.9.0 < 1.16.1` is false as a string comparison, so a naive version check would
    // reject every client older than 1.10.
    const { status, body } = await rest('ping', { v: '1.9.0' });
    expect(status).toBe(200);
    expect(body['subsonic-response'].status).toBe('ok');
  });

  it('never leaks a database error message into a response', async () => {
    // A schema or constraint error carries table and column names. The cause is logged;
    // the client gets a generic message.
    const { body } = await rest('getSong', { id: subsonicId('s', 'does/not/exist.flac') });
    const message = body['subsonic-response'].error?.message.toLowerCase() ?? '';
    expect(message).not.toContain('select');
    expect(message).not.toContain('songs');
  });
});

describe('user state', () => {
  it('stars a track and then reports it as starred', async () => {
    await rest('star', { id: SKINNY_LOVE });
    const { body } = await rest('getStarred2');
    const starred = body['subsonic-response'].starred2 as { song: Array<{ id: string; starred: string }> };
    expect(starred.song.find((song) => song.id === SKINNY_LOVE)?.starred).toBeTruthy();

    await rest('unstar', { id: SKINNY_LOVE });
    const after = await rest('getStarred2');
    // The wrapper is present and empty; the `song` key is **absent** rather than `[]`,
    // which is the shape the reference server answers and the shape every other empty
    // list takes. Asserted on the absence of the key, so it cannot be satisfied by an
    // endpoint that stopped reporting the list at all.
    expect(after.body['subsonic-response'].starred2).toEqual({});
  });

  it('round-trips a playlist in order', async () => {
    await rest('createPlaylist', { name: 'Morning', songId: `${HOLOCENE},${SKINNY_LOVE}` });
    const list = await rest('getPlaylists');
    const playlists = (list.body['subsonic-response'].playlists as { playlist: Array<{ id: string; name: string }> }).playlist;
    expect(playlists.map((playlist) => playlist.name)).toContain('Morning');

    const detail = await rest('getPlaylist', { id: playlists.find((playlist) => playlist.name === 'Morning')!.id });
    const songs = (detail.body['subsonic-response'].playlist as { entry: Array<{ id: string }> }).entry;
    // The client's order is the playlist's order, which is the whole point of a
    // playlist and the reason the DAO filters the caller's list rather than the
    // `IN (...)` result.
    expect(songs.map((song) => song.id)).toEqual([HOLOCENE, SKINNY_LOVE]);
  });

  it('counts a scrobble as a play', async () => {
    await rest('scrobble', { id: SKINNY_LOVE, submission: 'true' });
    const { body } = await rest('getSong', { id: SKINNY_LOVE });
    expect((body['subsonic-response'].song as { playCount: number }).playCount).toBe(1);
  });

  it('bookmarks a track and reads it back', async () => {
    await rest('createBookmark', { id: SKINNY_LOVE, position: '42000' });
    const { body } = await rest('getBookmarks');
    const bookmarks = body['subsonic-response'].bookmarks as { bookmark: Array<{ id: string; position: number }> };
    expect(bookmarks.bookmark.find((bookmark) => bookmark.id === SKINNY_LOVE)?.position).toBe(42_000);
  });
});
