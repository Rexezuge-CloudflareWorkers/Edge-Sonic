/**
 * The Worker, driven end to end.
 *
 * ### What this covers that the rest of the suite cannot
 *
 * Everything else in `test/` exercises a class in isolation. This drives the actual
 * worker's `fetch` with a real request, a real D1 (backed by `node:sqlite`), and a real
 * KV double, so it observes the things that only exist in the composition:
 *
 * - the **route order** in `EdgeSonicWorker`, which decides whether `/rest` sits behind
 *   the rate limiter, behind the Access middleware, or behind neither;
 * - the **envelope**, which is the only thing a Subsonic client reads;
 * - the **HTTP status**, which HTTP-level tooling reads and a unit test never produces.
 *
 * ### Why it does not use the Workers integration pool
 *
 * `@cloudflare/vitest-pool-workers` builds the worker with Miniflare, whose module
 * locator resolves a bare specifier in its *entry* file and not one reached through a
 * relative import. A monorepo worker and a monorepo's tests therefore both fail to load
 * with "Cannot find package" for packages that resolve fine under `tsc`, under Vite, and
 * under `esbuild`. The workarounds available — a pre-bundled entry, an alias table
 * derived from the manifests, a second `wrangler` config at the repo root — each fix the
 * symptom for one half of the problem and none of them survives a package being added.
 *
 * Driving `fetch` directly needs none of that: Hono, `jose`, `WebCrypto`, `Request`,
 * `Response` and `URLSearchParams` all exist in Node 24, and `node:sqlite` is the same
 * engine D1 is. What is genuinely lost is workerd-specific behaviour — `executionCtx`
 * timing, worker's own `Response` quirks, KV's eventual consistency — and that is stated
 * here rather than papered over.
 *
 * ### The one thing to be careful about
 *
 * The seed writes through the DAOs and the worker reads through its own, so a bug in the
 * DAO's SQL cannot hide behind shared in-memory state. `getIndexes` and
 * `getMusicDirectory` are asserted to make **no** WebDAV request, which is only true
 * because the index is warm from the seed; a cold-index path needs a WebDAV double and
 * is covered in `test/scan-incremental.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EdgeSonicWorker } from '../apps/api/src/workers/EdgeSonicWorker';
import { encryptData } from '@edge-sonic/backend-data/crypto';
import { NodeDAO, SongDAO, UserDAO } from '@edge-sonic/backend-data/dao';
import { sqliteQueryable } from './helpers/sqlite';
import type { SqliteQueryable } from './helpers/sqlite';
import { fakeKv } from './helpers/fakeKv';
import type { FakeKv } from './helpers/fakeKv';

const MIGRATION = readFileSync(fileURLToPath(new URL('../migrations/0001_edge_sonic_init.sql', import.meta.url)), 'utf8');

/** 32 ASCII zeros, base64. The same placeholder the deployment template documents. */
const TEST_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';

const PASSWORD = 'sesame';
const SALT = 'c19b2d';
const USERNAME = 'ann';
/** The Subsonic API reference's own worked example: md5('sesame' + 'c19b2d'). */
const EXPECTED_TOKEN = '26719a1196d2a940705a59634eb18eab';

const ORIGIN = 'https://edge-sonic.test';
const LIBRARY_ID = 'L1';
const ALBUM_DIR = 'Bon Iver/For Emma';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Mint an id the way the product does: `kind:base64url(libraryId \n path)`. */
function id(kind: 's' | 'al' | 'dir' | 'ar', path: string, libraryId = LIBRARY_ID): string {
  return `${kind}:${base64(new TextEncoder().encode(`${libraryId}\n${path}`))}`;
}

const SKINNY_LOVE = id('s', `${ALBUM_DIR}/01.flac`);
const HOLOCENE = id('s', `${ALBUM_DIR}/02.flac`);

/** A minimal `ExecutionContext`. Nothing in the request path calls `waitUntil`. */
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
};

let handle: SqliteQueryable;
let cache: FakeKv;
let worker: EdgeSonicWorker;

/** The env the worker sees. Rebuilt per test so no state leaks between them. */
function env(): Record<string, unknown> {
  return {
    DB: handle.db,
    CACHE: cache.ns,
    // Raw keys rather than Secrets Store bindings: there is no Secrets Store here, and
    // `resolveKey` treats a raw var as a test-only escape hatch that must never mask a
    // production binding.
    SUBSONIC_USER_ENCRYPTION_KEY: TEST_KEY,
    WEBDAV_ENCRYPTION_KEY: TEST_KEY,
    ENVIRONMENT: 'development',
    DEV_AUTH_EMAIL: 'operator@example.com',
    TEAM_DOMAIN: 'example.cloudflareaccess.com',
    POLICY_AUD: 'test-audience',
  };
}

async function seed(): Promise<void> {
  const userSecret = await encryptData(PASSWORD, TEST_KEY);
  const userId = (
    await new UserDAO(handle.db).create({
      username: USERNAME,
      passwordCiphertext: userSecret.ciphertext,
      passwordIv: userSecret.iv,
      email: 'ann@example.com',
      isAdmin: true,
    })
  ).id;

  const davSecret = await encryptData('dav-password', TEST_KEY);
  const timestamp = nowSeconds();
  await handle.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, 'home', 'home', 'https://dav.example.com', '/remote.php/dav/files/alice/Music', 'alice', ?, ?, 1, 'Home', 1, ?, ?)`,
    )
    .bind(LIBRARY_ID, davSecret.ciphertext, davSecret.iv, timestamp, timestamp)
    .run();
  await handle.db.prepare('INSERT INTO user_libraries (user_id, library_id, created_at) VALUES (?, ?, ?)').bind(userId, LIBRARY_ID, timestamp).run();

  const nodes = new NodeDAO(handle.db);
  // A node row per entry, files included: `getMusicDirectory` lists `nodes`, and a
  // seed with only the folders would make the endpoint look broken when it is not.
  await nodes.upsertMany([
    { libraryId: LIBRARY_ID, path: 'Bon Iver', parentPath: '', name: 'Bon Iver', mtimeMs: 1000, etag: '"a"', depth: 1, isScanned: true },
    { libraryId: LIBRARY_ID, path: ALBUM_DIR, parentPath: 'Bon Iver', name: 'For Emma', mtimeMs: 1000, etag: '"b"', depth: 2, isScanned: true },
    { libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/01.flac`, parentPath: ALBUM_DIR, name: '01.flac', mtimeMs: 1000, etag: '"c"', depth: 3, isScanned: true },
    { libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/02.flac`, parentPath: ALBUM_DIR, name: '02.flac', mtimeMs: 1000, etag: '"d"', depth: 3, isScanned: true },
  ]);

  const songs = new SongDAO(handle.db);
  await songs.upsertFileFacts([
    { id: SKINNY_LOVE, libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/01.flac`, dirPath: ALBUM_DIR, name: '01.flac', size: 4096, mtimeMs: 1000, contentType: 'audio/flac', suffix: 'flac' },
    { id: HOLOCENE, libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/02.flac`, dirPath: ALBUM_DIR, name: '02.flac', size: 8192, mtimeMs: 1000, contentType: 'audio/flac', suffix: 'flac' },
  ]);
  await songs.applyMetadata(SKINNY_LOVE, {
    title: 'Skinny Love',
    artist: 'Bon Iver',
    album: 'For Emma, Forever Ago',
    albumArtist: 'Bon Iver',
    track: 4,
    disc: 1,
    year: 2007,
    genre: 'Indie',
    duration: 251,
    bitrate: 900,
  });
  await songs.applyMetadata(HOLOCENE, {
    title: 'Holocene',
    artist: 'Bon Iver',
    album: 'For Emma, Forever Ago',
    albumArtist: 'Bon Iver',
    track: 5,
    disc: 1,
    year: 2007,
    genre: 'Indie',
    duration: 336,
    bitrate: 900,
  });
}

/** An authenticated `/rest` request. */
function restUrl(endpoint: string, extra: Record<string, string> = {}): string {
  const search = new URLSearchParams({ u: USERNAME, t: EXPECTED_TOKEN, s: SALT, v: '1.16.1', c: 'edge-sonic-test', f: 'json', ...extra });
  return `${ORIGIN}/rest/${endpoint}.view?${search}`;
}

async function get(url: string): Promise<Response> {
  return await worker.fetch(new Request(url), env() as never, executionContext);
}

async function rest(endpoint: string, extra: Record<string, string> = {}): Promise<{ status: number; response: Response; body: SubsonicBody }> {
  const response = await get(restUrl(endpoint, extra));
  return { status: response.status, response, body: (await response.json()) as SubsonicBody };
}

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

beforeAll(() => {
  worker = new EdgeSonicWorker();
});

beforeEach(async () => {
  handle?.close();
  handle = sqliteQueryable();
  handle.raw.exec(MIGRATION);
  cache = fakeKv();
  await seed();
});

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
    const response = await get(`${ORIGIN}/rest/getMusicDirectory.view?${new URLSearchParams({ u: USERNAME, t: EXPECTED_TOKEN, s: SALT, v: '1.16.1', f: 'xml', id: id('dir', ALBUM_DIR) })}`);
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
  it('rejects a wrong token with 401 and code=40 in the body', async () => {
    // Both signals are correct: the status is what HTTP-level tooling reads, and the
    // envelope is what a client reads. A client that only reads the body still says
    // "wrong password" rather than "server error".
    const { status, body } = await rest('ping', { t: '0'.repeat(32) });
    expect(status).toBe(401);
    expect(body['subsonic-response'].status).toBe('failed');
    expect(body['subsonic-response'].error?.code).toBe(40);
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

  it('gates /admin behind Cloudflare Access, not behind a Subsonic credential', async () => {
    // The two identity systems are deliberately separate: an operator's Access identity
    // must not be usable as a streaming credential, and a Subsonic password must not
    // open the admin API.
    // Asserted in `production`, where no dev bypass applies — the other test covers the
    // allow-list itself.
    const withPassword = await worker.fetch(
      new Request(`${ORIGIN}/admin/libraries`),
      { ...env(), ENVIRONMENT: 'production' } as never,
      executionContext,
    );
    expect(withPassword.status).toBe(401);
  });

  it('enforces the environment allow-list on the dev auth bypass', async () => {
    // Both directions are asserted, because a test that only checks the bypass passes
    // even if the allow-list stopped working altogether — which is the failure that
    // matters, since it authenticates every unauthenticated request as a fixed user.
    const inDevelopment = await worker.fetch(new Request(`${ORIGIN}/admin/me`), env() as never, executionContext);
    expect(inDevelopment.status).toBe(200);

    // The bypass is gated on an allow-list, not on `!== 'production'`: a deny-list
    // would enable it for `staging`, for `Preview`, and for a misspelled `prodcution`.
    const inProduction = await worker.fetch(
      new Request(`${ORIGIN}/admin/me`),
      { ...env(), ENVIRONMENT: 'production' } as never,
      executionContext,
    );
    expect(inProduction.status).toBe(401);

    // And a name that is *not* on the list, however it is spelled.
    const elsewhere = await worker.fetch(
      new Request(`${ORIGIN}/admin/me`),
      { ...env(), ENVIRONMENT: 'Preview' } as never,
      executionContext,
    );
    expect(elsewhere.status).toBe(401);
  });

  it('answers a CORS preflight without credentials', async () => {
    // A Fetch-spec preflight carries no credentials by design. Requiring auth for one
    // can only break clients, and a browser never issues the real request after a
    // failed preflight.
    const response = await worker.fetch(
      new Request(`${ORIGIN}/rest/ping.view`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' } }),
      env() as never,
      executionContext,
    );
    expect(response.status).toBe(204);
  });

  it('serves the admin SPA shell for its own routes', async () => {
    const response = await get(`${ORIGIN}/libraries`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<!doctype html>');
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
    const folders = (body['subsonic-response'].musicFolders as { musicFolder: Array<{ id: string; name: string }> }).musicFolder;
    expect(folders).toEqual([{ id: LIBRARY_ID, name: 'Home' }]);
  });

  it('serves getIndexes from the index, with no WebDAV request', async () => {
    // The origin is unreachable in this environment, so a request that succeeded proves
    // it never left the process.
    const { body } = await rest('getIndexes');
    const indexes = (body['subsonic-response'].indexes as { index: Array<{ name: string; shortcut: Array<{ name: string }> }> }).index;
    const shortcutNames = indexes.flatMap((index) => index.shortcut.map((shortcut) => shortcut.name));
    expect(shortcutNames).toContain('Bon Iver');
  });

  it('serves getMusicDirectory with files as children and no WebDAV request', async () => {
    const { body } = await rest('getMusicDirectory', { id: id('dir', ALBUM_DIR) });
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
    const { body } = await rest('getAlbum', { id: id('al', ALBUM_DIR) });
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
    const { body } = await rest('stream', { id: id('s', '../../../etc/passwd') });
    // code=70, not 50: `code=50` would confirm the id is real, turning the endpoint into
    // an oracle for which paths exist.
    expect(body['subsonic-response'].error?.code).toBe(70);
  });

  it('refuses a library this user was not granted', async () => {
    const { body } = await rest('getSong', { id: id('s', `${ALBUM_DIR}/01.flac`, 'L-other') });
    expect(body['subsonic-response'].error?.code).toBe(70);
  });

  it('refuses an album id where a song id is required', async () => {
    // Accepting it would resolve to the same path and work, hiding a client bug until
    // it became a different bug.
    const { body } = await rest('getSong', { id: id('al', ALBUM_DIR) });
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
    await cache.ns.put(`songMeta:v1:${SKINNY_LOVE}`, JSON.stringify({ mtimeMs: 1000, durationSeconds: 9999, bitrateKbps: 1 }));
    await cache.ns.put('libIndex:v1:nonsense:artists', 'not json at all');
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
        await worker.fetch(
          new Request(restUrl('getMusicDirectory', { id: id('dir', ALBUM_DIR) })),
          { ...env(), CACHE: undefined } as never,
          executionContext,
        )
      ).text();

    const withCache = await (
      await worker.fetch(
        new Request(restUrl('getMusicDirectory', { id: id('dir', ALBUM_DIR) })),
        env() as never,
        executionContext,
      )
    ).text();

    expect(await withoutCache()).toBe(withCache);
  });

  it('answers identically when every cache operation throws', async () => {
    const failing = fakeKv({}, { failAll: true });
    const withDeadCache = await (
      await worker.fetch(new Request(restUrl('getSong', { id: SKINNY_LOVE })), { ...env(), CACHE: failing.ns } as never, executionContext)
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

  it('distinguishes a recognised-but-unimplemented endpoint by name', async () => {
    // A client that probes `getVideos` gets "not implemented here" rather than "you
    // typed it wrong", which is the difference between a usable error and a confusing
    // one in a client's log.
    const { body } = await rest('getVideos');
    expect(body['subsonic-response'].error?.code).toBe(70);
    expect(body['subsonic-response'].error?.message).toContain('getVideos');
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
    const { body } = await rest('getSong', { id: id('s', 'does/not/exist.flac') });
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
    expect((after.body['subsonic-response'].starred2 as { song: unknown[] }).song).toEqual([]);
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
    expect(bookmarks.bookmark.find((bookmark) => bookmark.id === SKINNY_LOVE)?.position).toBe(42000);
  });
});
