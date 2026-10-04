/**
 * The user API.
 *
 * This is the surface an operator uses to register a library and a user, so it holds the
 * two decisions with the widest blast radius in the product:
 *
 * 1. **A stored credential goes to a host the operator typed.** `baseUrl` is fetched
 *    with the library's own DAV password, so a private, loopback, or link-local address
 *    is a way to send a secret to somewhere the operator cannot see. The gate is
 *    asserted here through the HTTP surface, not just on the helper.
 * 2. **A new user's password is stored under the per-feature key**, so that revoking or
 *    rotating the user key does not also require re-entering the DAV password — and,
 *    more importantly, so the two are never interchangeable.
 *
 * Auth is the environment allow-list, so most of these run with the dev bypass active
 * and the bypass's *refusals* are covered in `test/user-auth.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, ORIGIN, TEST_KEY } from './helpers/harness';
import type { Harness } from './helpers/harness';
import { decryptData } from '@edge-sonic/backend-data/crypto';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

// The origin is a global, so a stub left installed by one test is the *next* test's
// origin — and a stale one answers from a closed database, which looks like a
// product bug rather than a leaked double.
afterEach(() => {
  vi.unstubAllGlobals();
  harness.close();
});

/**
 * One entry of `GET /user/libraries`, typed for the fields these tests assert.
 *
 * `Record<string, unknown>` was enough while the list carried only scalars, but `scan` is a
 * nested object and an `unknown`-valued property cannot be read through. Spelled out rather
 * than cast at the call site, so a wire change that drops `scan` is a **type** failure here
 * instead of an `any` that silences it.
 */
interface LibraryWire {
  id?: string;
  slug?: string;
  displayName?: string | null;
  davUsername?: string;
  isEnabled?: boolean;
  songCount?: number;
  /**
   * The scan state each library carries. `null` — not absent — for a library that has never
   * been scanned; a client that cannot tell the two renders an empty line where the diagnosis
   * belongs.
   */
  scan?: { status?: string; scanned?: number; lastError?: string | null } | null;
  [key: string]: unknown;
}

interface UserBody {
  libraries?: LibraryWire[];
  users?: Array<Record<string, unknown>>;
  /**
   * The one error dialect this surface emits. A direct validation failure, a thrown
   * service error, and a 429 from the rate limiter all produce this shape, so a client
   * needs one decoder rather than two.
   */
  Exception?: { Type: string; Message: string };
  /**
   * The probe's verdict. Declared here rather than reached for with a cast because the
   * whole point of the probe is that these three fields answer different questions:
   * `ok` is whether the origin was usable, `status` is what it said, and `error` is
   * what the operator should do.
   */
  ok?: boolean;
  status?: number | string | null;
  error?: string | null;
  lastError?: string | null;
  [key: string]: unknown;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function call(path: string, init: RequestInit = {}, env: Record<string, unknown> = {}): Promise<{ status: number; body: UserBody }> {
  const response = await harness.fetch(`${ORIGIN}${path}`, env, init);
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as UserBody) };
}

describe('libraries', () => {
  it('lists the registered libraries without any credential material', async () => {
    const { status, body } = await call('/user/libraries');

    expect(status).toBe(200);
    const library = body.libraries?.[0];
    expect(library).toMatchObject({ id: 'L1', slug: 'home', displayName: 'Home', davUsername: 'alice', isEnabled: true });
    // The DAV password is stored encrypted and must never leave the server. The
    // response is JSON, so the fields simply are not there.
    expect(JSON.stringify(body)).not.toContain('dav-password');
    expect(JSON.stringify(body)).not.toContain('passwordCiphertext');
    expect(JSON.stringify(body)).not.toContain('password_iv');
  });

  /**
   * The list carries what an operator needs to see whether a scan is working, and none of it
   * was there before: `songCount` was a literal `0` no client read, and there was no scan state
   * at all, so the page showed a scan only after the operator clicked Rescan and never updated.
   */
  it('reports the indexed track count, rather than a literal zero', async () => {
    // The harness seeds two tracks. `0` here is not "an empty library" — it is the value the
    // route used to hardcode, and a count that is a constant is not a count at all.
    const { body } = await call('/user/libraries');
    expect(body.libraries?.[0]).toHaveProperty('songCount', 2);
  });

  it('reports a library that has never been scanned as null, not as idle', async () => {
    // `idle` means "scanned, nothing to do". A library with no `scan_state` row has never
    // been pointed at the scanner at all, and it is the one row an operator has to act on —
    // so the two cannot share a value. Asserted as `null` rather than as an absent key
    // because a client that cannot tell "never scanned" from "field missing" renders an
    // empty line where the diagnosis belongs.
    const { body } = await call('/user/libraries');
    const library = body.libraries?.[0];
    expect(library).toHaveProperty('scan', null);
  });

  it('reports the persisted scan state once a scan has run', async () => {
    // The progress a client polls for: the status, the folders visited, and the reason if it
    // stopped. `total` is absent from this shape and that is deliberate — the server writes
    // `total_count` as 0 and never updates it, so a client rendering `scanned / total` would
    // show "12 of 0". `songCount` is the progress number, and it is the one `getScanStatus`
    // publishes as `count`.
    // Seeded rather than `UPDATE`d: the harness registers a library without scanning it, so
    // there is no row — which is the state the previous case asserts, and reusing it here
    // would make this test pass on a query that matched nothing.
    await harness.db.db
      .prepare(
        "INSERT INTO scan_state (library_id, status, scanned_count, total_count, index_version, consecutive_failures, updated_at) VALUES ('L1', 'scanning', 7, 0, 1, 0, 0)",
      )
      .run();

    const { body } = await call('/user/libraries');
    expect(body.libraries?.[0]?.scan).toEqual({ status: 'scanning', scanned: 7, lastError: null });
  });

  it('reports a stalled scan as stalled, not as a failure that reads as retrying', async () => {
    // `failed` and `stalled` are the **same** stored status, separated only by the retry
    // counter. Reporting the row's status verbatim would render a terminal scan as one that
    // is still being retried — and the operator's page would keep polling a scan that nothing
    // is going to advance. `MAX_CONSECUTIVE_FAILURES` is 3.
    await harness.db.db
      .prepare(
        "INSERT INTO scan_state (library_id, status, scanned_count, total_count, index_version, consecutive_failures, last_error, updated_at) VALUES ('L1', 'failed', 0, 0, 1, 3, 'the origin refused the connection', 0)",
      )
      .run();

    const { body } = await call('/user/libraries');
    const library = body.libraries?.[0];
    expect(library?.scan?.status).toBe('stalled');
    // And the reason travels with it. A diagnosis that exists in the database and never
    // reaches the screen is the same defect this surface already fixed twice.
    expect(library?.scan?.lastError).toBe('the origin refused the connection');
  });

  it('does not create a scan_state row just to report on one', async () => {
    // The paired guard for the `null` above. `ScanStateDAO.ensure` writes an `idle` row on
    // first sight, and a list call that used it would turn every `GET /user/libraries` for
    // every never-scanned library into a **write** — against the 5,000-rows/day allowance,
    // on the request an operator's page then polls. It would also destroy the `null` that
    // distinguishes "never scanned" from "scanned", because the row it wrote is exactly the
    // row whose absence carries that meaning.
    await harness.db.db.prepare('DELETE FROM scan_state').run();
    await call('/user/libraries');
    const { body } = await call('/user/libraries');
    expect(body.libraries?.[0]?.scan).toBeNull();
    const rows = await harness.db.db.prepare('SELECT COUNT(*) AS cnt FROM scan_state').first<{ cnt: number }>();
    expect(rows?.cnt).toBe(0);
  });

  it('registers a library, storing the password encrypted', async () => {
    const { status, body } = await call('/user/libraries', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: 'work',
        baseUrl: 'https://dav.example.org',
        rootPath: '/remote.php/dav/files/bob/Music',
        davUsername: 'bob',
        davPassword: 'hunter2',
        displayName: 'Work',
      }),
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ slug: 'work' });

    // The row holds ciphertext, and it decrypts back to what was typed. A plain value in
    // this column is the difference between "an operator can rotate the key" and
    // "the whole DAV credential set is in a database backup".
    const row = await harness.db.db
      .prepare('SELECT password_ciphertext, password_iv FROM libraries WHERE slug = ?')
      .bind('work')
      .first<{ password_ciphertext: string; password_iv: string }>();
    expect(row?.password_ciphertext).not.toContain('hunter2');
    expect(await decryptData(row!.password_ciphertext, row!.password_iv, TEST_KEY)).toBe('hunter2');
  });

  it('refuses a library URL pointing at a private or loopback address', async () => {
    // The server fetches `baseUrl` with the library's own credential, so an internal
    // address turns a registration form into a way to send that credential — and to
    // probe the network the worker can see and the operator cannot.
    //
    // Bare origins, because `baseUrl` stores an origin and a path is rejected earlier
    // for a different reason; mixing the two here would let a path rejection pass as if
    // the SSRF gate had worked.
    //
    // The flag is set explicitly rather than relying on the environment. Unset means
    // "allowed outside production" so a co-located dev server works, which is the
    // right default and the wrong thing to assert against — the production posture is
    // the explicit `false`, and that is what is under test.
    const refused = [
      'http://127.0.0.1',
      'https://localhost',
      'https://10.0.0.5',
      'https://192.168.1.1',
      // The cloud metadata endpoint: the classic "read the instance credentials" target.
      'https://169.254.169.254',
      'https://[::1]',
      'https://0.0.0.0',
    ];

    for (const baseUrl of refused) {
      const { status, body } = await call(
        '/user/libraries',
        { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ slug: 'x', baseUrl, davUsername: 'u', davPassword: 'p' }) },
        { ALLOW_PRIVATE_WEBDAV_HOSTS: 'false' },
      );
      expect(status, baseUrl).toBe(400);
      // The message names the way out, because an operator who hit this on a genuine
      // local server needs to know the escape hatch exists.
      expect(body.Exception?.Message, baseUrl).toContain('ALLOW_PRIVATE_WEBDAV_HOSTS');
    }
  });

  it('refuses plaintext http to a non-loopback host, so a credential never crosses the network in the clear', async () => {
    // A Basic credential is base64, not encryption. Allowing `http://dav.example.com`
    // would put every library password on the wire in recoverable form.
    const { status, body } = await call('/user/libraries', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: 'x', baseUrl: 'http://dav.example.com', davUsername: 'u', davPassword: 'p' }),
    });
    expect(status).toBe(400);
    expect(body.Exception?.Message).toMatch(/https/);
  });

  it('refuses a URL with an embedded credential, which would be stored and logged', async () => {
    const { status, body } = await call('/user/libraries', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: 'x', baseUrl: 'https://alice:hunter2@dav.example.com', davUsername: 'u', davPassword: 'p' }),
    });
    expect(status).toBe(400);
    expect(body.Exception?.Message).toMatch(/credential/i);
  });

  it('refuses a URL with a path, a query, or a fragment, because the root path is a separate field', async () => {
    for (const baseUrl of ['https://dav.example.com/remote.php/dav', 'https://dav.example.com?a=b', 'https://dav.example.com#x']) {
      const { status } = await call('/user/libraries', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug: 'x', baseUrl, davUsername: 'u', davPassword: 'p' }),
      });
      expect(status, baseUrl).toBe(400);
    }
  });

  it('refuses a non-http scheme, so a stored credential cannot be smuggled out', async () => {
    for (const baseUrl of ['file://', 'gopher://example.com', 'ftp://example.com']) {
      const { status } = await call('/user/libraries', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug: 'x', baseUrl, davUsername: 'u', davPassword: 'p' }),
      });
      expect(status, baseUrl).toBe(400);
    }
  });

  it('allows a private address only when the deployment opts in explicitly', async () => {
    // The opt-in exists for a co-located development server. It is one flag, it is
    // absent from the production template, and `AppConfiguration.validate()` warns
    // when it is live in production — see `test/enrichment-config.test.ts`.
    const { status } = await harness.fetch(
      `${ORIGIN}/user/libraries`,
      { ALLOW_PRIVATE_WEBDAV_HOSTS: 'true' },
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ slug: 'local', baseUrl: 'http://127.0.0.1:8080', davUsername: 'u', davPassword: 'p' }),
      },
    );
    expect(status).toBe(201);
  });

  it('names a missing field instead of storing a library that cannot work', async () => {
    const { status, body } = await call('/user/libraries', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: 'x', baseUrl: 'https://dav.example.org' }),
    });

    // A library row with no credential is a library that 401s on every scan. Failing at
    // registration is the only point where the operator is still watching.
    expect(status).toBe(400);
    expect(body.Exception?.Message).toMatch(/davUsername|davPassword/);
  });

  it('rejects a malformed body as a 400, not as a 500', async () => {
    const { status, body } = await call('/user/libraries', { method: 'POST', headers: JSON_HEADERS, body: '{not json' });
    expect(status).toBe(400);
    expect(body.Exception?.Type).toBe('BadRequest');
  });

  it('rejects an oversized body with 413, before parsing it', async () => {
    const { status, body } = await call('/user/libraries', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: 'x',
        baseUrl: 'https://dav.example.org',
        davUsername: 'u',
        davPassword: 'p',
        displayName: 'y'.repeat(3_000_000),
      }),
    });
    expect(status).toBe(413);
    expect(body.Exception?.Type).toBe('PayloadTooLarge');
  });

  it('refuses a duplicate slug rather than shadowing an existing library', async () => {
    const { status, body } = await call('/user/libraries', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: 'home', baseUrl: 'https://dav.example.org', davUsername: 'u', davPassword: 'p' }),
    });
    expect(status).toBe(409);
    expect(body.Exception?.Type).toBe('Conflict');
  });

  it('updates a library without disturbing the credential it already stores', async () => {
    const before = await harness.db.db
      .prepare('SELECT password_ciphertext FROM libraries WHERE id = ?')
      .bind('L1')
      .first<{ password_ciphertext: string }>();

    // A `PATCH` here is a full replace of the library's editable fields; the password
    // is the one field it does not take unless asked. Sending a partial body is a 400,
    // which is why the test sends all of them — a partial update that silently dropped
    // `davUsername` would break every scan for the library.
    const { status, body } = await call('/user/libraries/L1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: 'home',
        baseUrl: 'https://dav.example.com',
        rootPath: '/remote.php/dav/files/alice/Music',
        davUsername: 'alice',
        displayName: 'Home (moved)',
      }),
    });

    expect(status, JSON.stringify(body)).toBe(200);
    const after = await harness.db.db
      .prepare('SELECT password_ciphertext, display_name FROM libraries WHERE id = ?')
      .bind('L1')
      .first<{ password_ciphertext: string; display_name: string }>();
    expect(after?.display_name).toBe('Home (moved)');
    // A `PATCH` that re-encrypted from an absent password would silently destroy the
    // stored credential and break every scan for that library.
    expect(after?.password_ciphertext).toBe(before?.password_ciphertext);
  });

  it('deletes a library and its whole index, and leaves users alone', async () => {
    expect(await harness.db.db.prepare('SELECT COUNT(*) AS n FROM songs').first<{ n: number }>()).toEqual({ n: 2 });

    const { status } = await call('/user/libraries/L1', { method: 'DELETE' });
    expect(status).toBe(200);

    // The cascade is the schema's job, and it has to be complete: an orphaned `songs`
    // row is a track a client can still name, and the origin no longer has.
    expect(await harness.db.db.prepare('SELECT COUNT(*) AS n FROM songs').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await harness.db.db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()).toEqual({ n: 1 });
  });

  it('reports a probe result without failing the request when the origin is down', async () => {
    // A diagnostic endpoint that 500s is useless: the operator needs to be told "the
    // host is unreachable" and then fix the network.
    const { status, body } = await call('/user/libraries/L1/probe', { method: 'POST' });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    // Not `toHaveProperty('ok')`, which passes for `{}`. A body with no `error` is
    // exactly what the operator surface cannot render, so the field is asserted.
    expect(body.error).toBe('Library is unreachable.');
  });

  it('carries the origin’s status through, so the SPA can name the fault', async () => {
    // The probe is the only diagnostic in the product, and the whole point of the
    // `status` field is that a 401 and a 404 have different fixes. A deployment
    // fault — a rotated key, an unprovisioned secret — must not borrow the wording
    // of a dead host; that is asserted in `test/library-ssrf.test.ts`, and this
    // asserts the field survives the route, which is a separate seam.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const { status, body } = await call('/user/libraries/L1/probe', { method: 'POST' });
    // The harness tree has no entry for the library root, so the origin answers 404.
    expect(status).toBe(200);
    expect(body.status).toBe(404);
    expect(body.error).toMatch(/root path does not exist/i);
  });

  it('reports a failed scan with the reason the DAO persisted', async () => {
    // `scan_state.last_error` was written by `ScanStateDAO.fail` and read by nobody,
    // and `ChunkResult` had no field for it, so a failed scan told an operator
    // "failed" and nothing else. The reason is now on the wire.
    //
    // A harness with a root entry, because `start` distinguishes "the root is gone"
    // (a `404`, which completes the scan and clears the index) from "the origin is
    // unreachable". With the default empty tree the scan never starts, and the test
    // would be asserting on a library the product had already pruned.
    harness.close();
    const root = '/remote.php/dav/files/alice/Music';
    harness = await createHarness({ [root]: [{ path: root, collection: true, mtime: 1000 }] });

    // `start` only seeds the frontier. The chunk is advanced by `getScanStatus`,
    // which is the one caller of `ScanService.step` — the `/user` scan route is a
    // passive read, so advancing through it would assert that a poll never fails
    // anything.
    vi.stubGlobal('fetch', harness.dav.fetch);
    const started = await call('/user/libraries/L1/scan', { method: 'POST' });
    expect(started.body.status).toBe('scanning');

    vi.stubGlobal('fetch', (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await harness.rest('getScanStatus');

    const failed = await call('/user/libraries/L1/scan');
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.lastError).toBeTruthy();

    // The failure survives the request that caused it, which is the point: a poll
    // after the fact is the only place an operator can still read the reason.
    const after = await call('/user/libraries/L1/scan');
    expect(after.body.status).toBe('failed');
    expect(after.body.lastError).toBe(failed.body.lastError);
  });

  it('sends lastError as null on a healthy scan, not as an absent field', async () => {
    // "Absent" and "no error" are different answers. A client that cannot tell them
    // apart either renders an empty error line or treats a blank string as a fault.
    const { body } = await call('/user/libraries/L1/scan');
    expect(body).toHaveProperty('lastError');
    expect(body.lastError).toBeNull();
  });

  it('advances the scan from the operator surface, and says which bound stopped it', async () => {
    // The scan is client-driven, and `/rest/getScanStatus` was the only thing that
    // advanced it — so an operator clicking "Rescan" started a scan that only moved
    // if some *Subsonic client* happened to be polling. This route is the missing
    // half, and `stoppedBy` is only readable here, because the Subsonic envelope
    // carries just `scanning` and `count`.
    //
    // A tree with a root entry, because `start` reads a missing root as "the library
    // is gone", completes the scan and clears the index — the case the test above
    // leans on. With the default empty tree there would be nothing to advance.
    const root = '/remote.php/dav/files/alice/Music';
    harness.dav.setTree({
      [root]: [
        { path: root, collection: true, mtime: 1000 },
        { path: `${root}/Bon Iver`, collection: true, mtime: 2000 },
      ],
      [`${root}/Bon Iver`]: [{ path: `${root}/Bon Iver`, collection: true, mtime: 2000 }],
    });
    vi.stubGlobal('fetch', harness.dav.fetch);
    const started = await call('/user/libraries/L1/scan', { method: 'POST' });
    expect(started.body.status).toBe('scanning');

    const chunk = await call('/user/libraries/L1/scan/step', { method: 'POST' });

    expect(chunk.status).toBe(200);
    // It really advanced: the frontier moved, and the request reached the origin.
    expect(chunk.body.foldersVisited).toBeGreaterThan(0);
    expect(harness.dav.propfinds.length).toBeGreaterThan(0);
    // What the chunk spent, per kind, and the bound that ended it. `null` would mean
    // "nothing stopped it", which for a `scanning` result is never the case. The breakdown is
    // asserted rather than the total alone because a total cannot say whether the operator
    // should raise a budget or shrink a page.
    expect(chunk.body).toHaveProperty('stoppedBy');
    expect(chunk.body.subrequests).toMatchObject({ total: expect.any(Number) });
    expect((chunk.body.subrequests as { total: number }).total).toBeGreaterThan(0);
    expect((chunk.body.subrequests as { d1: number }).d1).toBeGreaterThan(0);
    expect(chunk.body.stoppedBy).toBe('frontier');
  });

  it('refuses to advance a scan for a library that does not exist', async () => {
    const { status, body } = await call('/user/libraries/nope/scan/step', { method: 'POST' });
    expect(status).toBe(404);
    expect(body.Exception?.Message).toContain('not found');
  });
});

describe('users', () => {
  it('creates a user whose password verifies immediately', async () => {
    const { status, body } = await call('/user/users', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: 'bob', password: 'opensesame', email: 'bob@example.com' }),
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ username: 'bob' });

    // The round trip that matters: the stored value must be the *user* key's output, so
    // rotating the DAV key does not log everyone out and vice versa.
    const row = await harness.db.db
      .prepare('SELECT password_ciphertext, password_iv FROM users WHERE username = ?')
      .bind('bob')
      .first<{ password_ciphertext: string; password_iv: string }>();
    expect(await decryptData(row!.password_ciphertext, row!.password_iv, TEST_KEY)).toBe('opensesame');
  });

  it('refuses a username that differs only in case', async () => {
    // Subsonic clients match usernames case-insensitively, so `Ann` and `ann` are one
    // user to a client and two rows to the database. The database has to agree with the
    // client, or the second registration silently shadows the first.
    const { status, body } = await call('/user/users', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: 'ANN', password: 'x' }),
    });
    expect(status).toBe(409);
    expect(body.Exception?.Message).toMatch(/already exists/i);
  });

  it('lists users without any credential material', async () => {
    const { body } = await call('/user/users');
    const serialized = JSON.stringify(body);
    expect(body.users?.[0]).toMatchObject({ username: 'ann', isAdmin: true });
    expect(serialized).not.toContain('sesame');
    expect(serialized).not.toContain('password');
  });

  it('disables a user, which is the revocation that matters', async () => {
    // There is no way to invalidate an already-issued token in the Subsonic protocol, so
    // disabling the row is the only lever an operator has. It has to actually stop
    // authentication.
    const { status } = await call(`/user/users/${await userId('ann')}/enabled?enabled=false`, { method: 'PATCH' });
    expect(status).toBe(200);

    const { body } = await harness.rest('ping');
    expect(body['subsonic-response'].error?.code).toBe(40);
  });

  it('re-enables a user', async () => {
    const id = await userId('ann');
    await call(`/user/users/${id}/enabled?enabled=false`, { method: 'PATCH' });
    await call(`/user/users/${id}/enabled?enabled=true`, { method: 'PATCH' });

    const { body } = await harness.rest('ping');
    expect(body['subsonic-response'].status).toBe('ok');
  });

  it('grants and revokes a library, changing what the user can see', async () => {
    const id = await userId('ann');

    const { status } = await call(`/user/users/${id}/libraries`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ libraryIds: [] }),
    });
    expect(status).toBe(200);

    // With no grant, the library is invisible — not an error, just an empty library. A
    // user with no grants must not be able to name a song id from before the grant was
    // removed.
    const { body } = await harness.rest('getMusicFolders');
    expect((body['subsonic-response'].musicFolders as { musicFolder: unknown[] } | undefined)?.musicFolder ?? []).toEqual([]);

    await call(`/user/users/${id}/libraries`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ libraryIds: ['L1'] }) });
    const restored = await harness.rest('getMusicFolders');
    expect((restored.body['subsonic-response'].musicFolders as { musicFolder: unknown[] }).musicFolder).toHaveLength(1);
  });

  it('rejects a grant for a library that does not exist', async () => {
    // A silently-ignored id is worse than a rejection: the operator believes access was
    // granted, and the user sees nothing.
    const id = await userId('ann');
    const { status, body } = await call(`/user/users/${id}/libraries`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ libraryIds: ['L-nope'] }),
    });
    expect(status).toBe(404);
    expect(body.Exception?.Type).toBe('NotFound');
    // Named, because "a 404 happened" is not something an operator can act on and the
    // library id is the one thing they can check.
    expect(body.Exception?.Message).toContain('L-nope');
  });

  it('deletes a user and everything that belongs to them', async () => {
    const id = await userId('ann');
    expect((await call(`/user/users/${id}`, { method: 'DELETE' })).status).toBe(200);

    expect(await harness.db.db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()).toEqual({ n: 0 });
    // The grant goes with it, so a re-created user with the same name starts with no
    // access rather than inheriting the old one's.
    expect(await harness.db.db.prepare('SELECT COUNT(*) AS n FROM user_libraries').first<{ n: number }>()).toEqual({ n: 0 });
    // And the credential stops working.
    const { body } = await harness.rest('ping');
    expect(body['subsonic-response'].error?.code).toBe(40);
  });
});

describe('the user identity', () => {
  it('reports who is calling, so the SPA can show it', async () => {
    const { status, body } = await call('/user/me');
    expect(status).toBe(200);
    // The dev bypass identifies as the configured address, so this is a test of the
    // wiring rather than of Access.
    expect(body.email).toBe('operator@example.com');
  });
});

async function userId(username: string): Promise<string> {
  const row = await harness.db.db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: string }>();
  return row!.id;
}
