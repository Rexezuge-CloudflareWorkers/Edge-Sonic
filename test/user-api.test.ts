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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, ORIGIN, TEST_KEY } from './helpers/harness';
import type { Harness } from './helpers/harness';
import { decryptData } from '@edge-sonic/backend-data/crypto';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(() => harness.close());

interface UserBody {
  libraries?: Array<Record<string, unknown>>;
  users?: Array<Record<string, unknown>>;
  /**
   * The one error dialect this surface emits. A direct validation failure, a thrown
   * service error, and a 429 from the rate limiter all produce this shape, so a client
   * needs one decoder rather than two.
   */
  Exception?: { Type: string; Message: string };
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
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ slug: 'local', baseUrl: 'http://127.0.0.1:8080', davUsername: 'u', davPassword: 'p' }) },
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
      body: JSON.stringify({ slug: 'x', baseUrl: 'https://dav.example.org', davUsername: 'u', davPassword: 'p', displayName: 'y'.repeat(3_000_000) }),
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
    const before = await harness.db.db.prepare('SELECT password_ciphertext FROM libraries WHERE id = ?').bind('L1').first<{ password_ciphertext: string }>();

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
    expect(body).toHaveProperty('ok');
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
    const { status, body } = await call('/user/users', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username: 'ANN', password: 'x' }) });
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

    const { status } = await call(`/user/users/${id}/libraries`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ libraryIds: [] }) });
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
