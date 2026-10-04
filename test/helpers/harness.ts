/**
 * A running `EdgeSonicWorker` over a real D1, with a fake origin.
 *
 * ### What this is for
 *
 * The unit tests exercise a class; this exercises the **composition**: route order, the
 * envelope, HTTP status, and the DAOs' SQL, all through the worker's own `fetch`. It is
 * what catches a mistake in wiring that every isolated test passes.
 *
 * ### Why it does not use the Workers integration pool
 *
 * `@cloudflare/vitest-pool-workers` builds the worker with Miniflare, whose module
 * locator resolves a bare specifier in its *entry* file and not one reached through a
 * relative import. A monorepo worker and a monorepo's tests therefore both fail to load
 * with "Cannot find package" for packages that resolve under `tsc`, under Vite, and
 * under `esbuild`. The available workarounds — a pre-bundled entry, an alias table
 * derived from the manifests, a second `wrangler` config at the root — each fix one half
 * of the problem, and none survive a package being added.
 *
 * Driving `fetch` directly needs none of that: Hono, `jose`, `WebCrypto`, `Request`,
 * `Response` and `URLSearchParams` all exist in Node 24, and `node:sqlite` is the engine
 * D1 *is*. What is genuinely lost is workerd-specific behaviour — `executionCtx` timing,
 * worker's own `Response` quirks, KV eventual consistency — and that is stated here
 * rather than papered over.
 */
import { encryptData } from '@edge-sonic/backend-data/crypto';
import { NodeDAO, SongDAO, UserDAO } from '@edge-sonic/backend-data/dao';
import { READER_VERSION } from '@edge-sonic/media-tags';
import { EdgeSonicWorker } from '../../apps/api/src/workers/EdgeSonicWorker';
import { sqliteQueryable } from './sqlite';
import { fakeKv } from './fakeKv';
import { fakeDav } from './fakeDav';
import { migrationSql } from './migrations';
import type { SqliteQueryable } from './sqlite';
import type { FakeKv, FakeKvOptions } from './fakeKv';
import type { DavEntry, FakeDav } from './fakeDav';

/**
 * The whole schema, every migration, in Wrangler's order.
 *
 * This used to read `0001_edge_sonic_init.sql` by name, which is a schema no real
 * database has: `0002` adds `songs.reader_version`, and the harness's own `upsertFileFacts`
 * names that column — so every seeded song raised `no such column: songs.reader_version`
 * the moment the column moved to its own migration. Reading the directory is what keeps
 * the double modelling the platform; see `helpers/migrations.ts`.
 */
export const MIGRATION = migrationSql();

/**
32 ASCII zeros, base64. The same placeholder the deployment template documents.
*/
export const TEST_KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';

export const ORIGIN = 'https://edge-sonic.test';
export const LIBRARY_ID = 'L1';
export const ALBUM_DIR = 'Bon Iver/For Emma';
export const PASSWORD = 'sesame';
export const SALT = 'c19b2d';
export const USERNAME = 'ann';
/**
The Subsonic API reference's own worked example: md5('sesame' + 'c19b2d').
*/
export const EXPECTED_TOKEN = '26719a1196d2a940705a59634eb18eab';

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
Mint an id the way the product does: `kind:base64url(libraryId \n path)`.
*/
export function subsonicId(kind: 's' | 'al' | 'alk' | 'ar' | 'dir' | 'vid' | 'mf' | 'dira', path: string, libraryId = LIBRARY_ID): string {
  return `${kind}:${base64(new TextEncoder().encode(`${libraryId}\n${path}`))}`;
}

/**
A minimal `ExecutionContext`. Nothing in the request path calls `waitUntil`.
*/
export const executionContext = {
  waitUntil: (): void => undefined,
  passThroughOnException: (): void => undefined,
  // Required by the runtime type even though nothing reads it. Leaving it out made this
  // double structurally unlike the platform object every `app.fetch` call requires, so
  // a test could not pass one to a Hono app without a cast.
  props: {} as Record<string, unknown>,
};

export interface SubsonicBody {
  'subsonic-response': {
    status: string;
    version: string;
    type: string;
    openSubsonic: boolean;
    error?: { code: number; message: string };
    [key: string]: unknown;
  };
}

export interface Harness {
  /**
  A fresh worker. Stateless, so one is enough, but a fresh one proves it.
  */
  worker: EdgeSonicWorker;
  /**
  The live database. Call `close()` when the test is done.
  */
  db: SqliteQueryable;
  cache: FakeKv;
  /**
  The WebDAV origin double, for tests that need one.
  */
  dav: FakeDav;
  /**
  The env the worker sees, with `CACHE` healthy.
  */
  env(overrides?: Record<string, unknown>): Record<string, unknown>;
  /**
  An authenticated `/rest` URL.
  */
  restUrl(endpoint: string, extra?: Record<string, string>): string;
  fetch(url: string, overrides?: Record<string, unknown>, init?: RequestInit): Promise<Response>;
  /**
  An authenticated `/rest` call, parsed.
  */
  rest(endpoint: string, extra?: Record<string, string>): Promise<{ status: number; response: Response; body: SubsonicBody }>;
  /**
  The ids of the seeded fixture, for readability in assertions.
  */
  ids: { skinnyLove: string; holocene: string; album: string; directory: string; artist: string };
  close(): void;
}

/**
 * A one-album library: two tracks, node rows for every entry, and the metadata a client
 * renders.
 *
 * The **file** node rows matter as much as the song rows: `getMusicDirectory` lists
 * `nodes`, so a seed with only the folders makes a correct endpoint look broken.
 */
/**
 * @param kv Options for the cache double. Present because a double that settles
 *   instantly cannot observe an **abandoned** promise — see `FakeKvOptions.deferPuts`,
 *   which exists because the artwork cache was written without `await` and the suite could
 *   not see it.
 */
export async function createHarness(tree?: Record<string, DavEntry[]>, kv: FakeKvOptions = {}): Promise<Harness> {
  const db = sqliteQueryable();
  db.raw.exec(MIGRATION);
  const cache = fakeKv({}, kv);
  const dav = fakeDav(tree ?? {});

  const userSecret = await encryptData(PASSWORD, TEST_KEY);
  const userId = (
    await new UserDAO(db.db).create({
      username: USERNAME,
      passwordCiphertext: userSecret.ciphertext,
      passwordIv: userSecret.iv,
      email: 'ann@example.com',
      isAdmin: true,
    })
  ).id;

  const davSecret = await encryptData('dav-password', TEST_KEY);
  const timestamp = nowSeconds();
  await db.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, 'home', 'home', 'https://dav.example.com', '/remote.php/dav/files/alice/Music', 'alice', ?, ?, 1, 'Home', 1, ?, ?)`,
    )
    .bind(LIBRARY_ID, davSecret.ciphertext, davSecret.iv, timestamp, timestamp)
    .run();
  await db.db.prepare('INSERT INTO user_libraries (user_id, library_id, created_at) VALUES (?, ?, ?)').bind(userId, LIBRARY_ID, timestamp).run();

  const ids = {
    skinnyLove: subsonicId('s', `${ALBUM_DIR}/01.flac`),
    holocene: subsonicId('s', `${ALBUM_DIR}/02.flac`),
    album: subsonicId('al', ALBUM_DIR),
    directory: subsonicId('dir', ALBUM_DIR),
    artist: subsonicId('ar', 'Bon Iver'),
  };

  const nodes = new NodeDAO(db.db);
  await nodes.upsertMany([
    { libraryId: LIBRARY_ID, path: 'Bon Iver', parentPath: '', name: 'Bon Iver', mtimeMs: 1000, etag: '"a"', depth: 1, isScanned: true },
    { libraryId: LIBRARY_ID, path: ALBUM_DIR, parentPath: 'Bon Iver', name: 'For Emma', mtimeMs: 1000, etag: '"b"', depth: 2, isScanned: true },
    { libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/01.flac`, parentPath: ALBUM_DIR, name: '01.flac', mtimeMs: 1000, etag: '"c"', depth: 3, isScanned: true },
    { libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/02.flac`, parentPath: ALBUM_DIR, name: '02.flac', mtimeMs: 1000, etag: '"d"', depth: 3, isScanned: true },
    { libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/cover.jpg`, parentPath: ALBUM_DIR, name: 'cover.jpg', mtimeMs: 1000, etag: '"e"', depth: 3, isScanned: true },
  ]);

  const songs = new SongDAO(db.db);
  await songs.upsertFileFacts([
    { id: ids.skinnyLove, libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/01.flac`, dirPath: ALBUM_DIR, name: '01.flac', size: 4096, mtimeMs: 1000, contentType: 'audio/flac', suffix: 'flac' },
    { id: ids.holocene, libraryId: LIBRARY_ID, path: `${ALBUM_DIR}/02.flac`, dirPath: ALBUM_DIR, name: '02.flac', size: 8192, mtimeMs: 1000, contentType: 'audio/flac', suffix: 'flac' },
  ]);
  // These two rows claim to be *enriched*, so they have to say which reader enriched
  // them. Seeding `duration` and `bitrate` without a `readerVersion` says "these came
  // from some reader, possibly not the one running", and the service then correctly
  // treats the row as stale and re-reads the file — which this harness's `fakeDav` body
  // cannot answer, so every enriched-metadata assertion went to 0. A double that does not
  // model the product's own staleness rule hides a real guard.
  await songs.applyMetadata(ids.skinnyLove, {
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
    readerVersion: READER_VERSION,
  });
  await songs.applyMetadata(ids.holocene, {
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
    readerVersion: READER_VERSION,
  });

  const worker = new EdgeSonicWorker();

  const env = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    DB: db.db,
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
    ...overrides,
  });

  const restUrl = (endpoint: string, extra: Record<string, string> = {}): string =>
    `${ORIGIN}/rest/${endpoint}.view?${new URLSearchParams({ u: USERNAME, t: EXPECTED_TOKEN, s: SALT, v: '1.16.1', c: 'edge-sonic-test', f: 'json', ...extra })}`;

  const doFetch = async (url: string, overrides: Record<string, unknown> = {}, init: RequestInit = {}): Promise<Response> =>
    await worker.fetch(new Request(url, init), env(overrides) as never, executionContext);

  return {
    worker,
    db,
    cache,
    dav,
    env,
    restUrl,
    fetch: doFetch,
    async rest(endpoint, extra = {}) {
      const response = await doFetch(restUrl(endpoint, extra));
      return { status: response.status, response, body: (await response.json()) as SubsonicBody };
    },
    ids,
    close: () => db.close(),
  };
}
