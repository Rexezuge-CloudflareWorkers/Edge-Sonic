/**
 * Reading another server's `/rest`, and refusing to send the credential somewhere unsafe.
 *
 * ### The two halves, and why they are in one file
 *
 * `remoteClient` **parses** a response this repository does not control, and `remoteOrigin`
 * **decides whether to make the request at all**. They are one decision in practice: a client that
 * parsed beautifully would still have sent a stored password to whatever host the row named, and a
 * gate that normalised correctly would still be bypassed by a caller that built the URL some other
 * way. So the URL a client uses is always one `normalizeRemoteBaseUrl` produced.
 *
 * ### Why the fixtures are what third-party servers answer, not what this one does
 *
 * This repository's own `/rest` is the most convenient thing to write a fixture from and the
 * least informative, because the shapes differ precisely where the failures live. A single-entry
 * `getPlaylist` collapsing `entry` to an object, a `getBookmarks` with no bookmarks at all, a
 * protocol error arriving as HTTP 200 — none of those are what `dispatch.ts` emits and all of
 * them are what a real import meets. Writing them from our own output would be a fixture that
 * mirrors the code it exists to check.
 *
 * ### The token, not the password
 *
 * The client sends `t=md5(password + salt)` and never `p=`. Asserted because a password in a query
 * string lands in the remote's access log, every proxy's on the way there, and whatever the
 * remote's own request log writes down — and it is invisible from here, which is what makes it the
 * kind of thing nobody notices until somebody reads a log.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestError, NotFoundError } from '@edge-sonic/backend-errors';
import {
  assertRemoteReachable,
  normalizeMountPath,
  normalizeRemoteBaseUrl,
  normalizeRemoteUsername,
  normalizeSourceName,
  RemoteSubsonicClient,
  RemoteSubsonicError,
  unwrapEnvelope,
} from '@edge-sonic/backend-services/import';
import { md5Hex } from '@edge-sonic/subsonic';

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A client with `fetch` stubbed, and the URL it will send to.
 *
 * Deliberately **not** a `call` wrapper that rebuilds the URL: the salt is random, so the only
 * honest way to assert on a token is to read what actually went out.
 */
function clientUnderStub(body: unknown, overrides: { baseUrl?: string; password?: string } = {}) {
  let seen = '';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    // `instanceof URL` rather than `String(input)`: a plain `String()` on a `RequestInfo` widens
    // to `string | URL`, and an object reaching it would stringify as `[object Object]` — so the
    // assertion that reads the query string would be reading a literal that happens to contain
    // `t=`. Narrowed here so that failure cannot be silent.
    seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return jsonResponse(body);
  });
  const client = new RemoteSubsonicClient({
    baseUrl: overrides.baseUrl ?? 'https://music.example.com/sonic',
    username: 'alice',
    password: overrides.password ?? 'hunter2',
    timeoutMs: 1000,
    onRequest: () => undefined,
  });
  return { client, url: () => seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the SSRF gate on an operator-supplied host', () => {
  it('refuses the cloud metadata address', () => {
    // The reason the gate exists: the Worker would send a **stored credential** here, so a
    // registration form is otherwise a way to exfiltrate one to an attacker-chosen endpoint.
    expect(() => normalizeRemoteBaseUrl('http://169.254.169.254', false)).toThrow(BadRequestError);
  });

  it('refuses loopback, private and link-local hosts unless the policy opts in', () => {
    // IPv6 **bracketed**, because that is the URL form — `https://fd00::1` does not parse, and
    // the unbracketed spelling would make this assert a parse failure rather than the gate it is
    // named for.
    for (const host of ['localhost', '10.0.0.5', '192.168.1.1', '[fd00::1]']) {
      expect(() => normalizeRemoteBaseUrl(`https://${host}`, false)).toThrow(BadRequestError);
      // And the opt-in works, because a co-located `wrangler dev` against a LAN server is a real
      // development case rather than a hypothetical one.
      expect(normalizeRemoteBaseUrl(`https://${host}`, true)).toContain(host.replaceAll(/[[\]]/g, ''));
    }
  });

  it('requires https off loopback, because the password is a query parameter', () => {
    expect(() => normalizeRemoteBaseUrl('http://music.example.com', false)).toThrow(/https/);
    // Loopback is the one documented exception, and it is an exception rather than a relaxation.
    // The trailing slash is stripped: `${base}/rest` on a base ending in `/` is a double slash,
    // which is a different URL to every server behind a mount point.
    expect(normalizeRemoteBaseUrl('http://localhost:4533', true)).toBe('http://localhost:4533');
  });

  it('refuses an embedded credential rather than stripping it', () => {
    // Stripping would leave a URL that leaks the caller's own password into logs and support
    // tickets. Refusing tells them the shape is wrong.
    expect(() => normalizeRemoteBaseUrl('https://user:pass@music.example.com', false)).toThrow(/must not embed credentials/);
  });

  it('keeps a mount path, because a reverse-proxied Subsonic has nowhere else to put it', () => {
    // The difference from `normalizeBaseUrl`, which refuses any path because a WebDAV library has
    // a `root_path` column and this has no such column.
    expect(normalizeRemoteBaseUrl('https://example.com/sonic', false)).toBe('https://example.com/sonic');
    expect(normalizeRemoteBaseUrl('https://example.com/sonic/', false)).toBe('https://example.com/sonic');
    // And the root case: `/` must normalize to **nothing**, or every operator who typed the plain
    // host gets a double slash before `/rest`.
    expect(normalizeRemoteBaseUrl('https://example.com/', false)).toBe('https://example.com');
    expect(normalizeRemoteBaseUrl('https://example.com', false)).toBe('https://example.com');
    // Asserted as the URL that will actually be built, because that is where a trailing slash
    // becomes a 404 and not in the normalizer at all.
    expect(`${normalizeRemoteBaseUrl('https://example.com/', false)}/rest/getPlaylists.view`).toBe(
      'https://example.com/rest/getPlaylists.view',
    );
  });

  it('refuses a traversal in the mount path, after decoding', () => {
    // `%2F..%2F` is a traversal attempt that only becomes visible on decode.
    expect(() => normalizeRemoteBaseUrl('https://example.com/sonic%2F..%2Fadmin', false)).toThrow(/\.\./);
    expect(() => normalizeMountPath(String.raw`/a\b`)).toThrow(/illegal character/);
    expect(() => normalizeMountPath('/a?b=1')).toThrow(/query or fragment/);
    expect(normalizeMountPath('/')).toBe('');
    expect(normalizeMountPath('/sonic/')).toBe('/sonic');
  });

  it('re-checks a stored row on read, and reports a refusal as absence', () => {
    // Re-validation on read matters because the policy can change after the row is written, so an
    // operator who tightens `ALLOW_PRIVATE_WEBDAV_HOSTS` must not leave an existing private origin
    // usable. And it is a `NotFoundError` rather than a `BadRequestError` on purpose: the URL is
    // fine, the host is merely no longer permitted, and the operator can still see the row in their
    // own list — so "your URL is malformed" would be the wrong sentence.
    expect(() => assertRemoteReachable({ base_url: 'https://10.0.0.5' }, false)).toThrow(NotFoundError);
    expect(() => assertRemoteReachable({ base_url: 'https://music.example.com' }, false)).not.toThrow();
    // The opt-in still works, so a development deployment is not broken by the check.
    expect(() => assertRemoteReachable({ base_url: 'https://10.0.0.5' }, true)).not.toThrow();
  });

  it('refuses a control character in a name or username, because both reach a log line', () => {
    // A newline in a log field is a record of an event nobody can read.
    expect(() => normalizeSourceName('old\nserver')).toThrow(/control characters/);
    expect(() => normalizeRemoteUsername('ali\nce')).toThrow(/control characters/);
    expect(normalizeSourceName('  old server  ')).toBe('old server');
    expect(() => normalizeSourceName('')).toThrow(BadRequestError);
  });
});

describe('a protocol error arrives as HTTP 200, and must not read as an empty payload', () => {
  it('refuses an envelope whose status is failed', () => {
    // This is the failure that matters most: `getPlaylists` on a wrong password answers
    // `200 {"status":"failed",...}`, and a client checking only the HTTP status reads an error as
    // "no playlists" — then starts an import that imports nothing and reports success.
    expect(() =>
      unwrapEnvelope(
        JSON.stringify({
          'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: 40, message: 'Wrong username or password.' } },
        }),
        200,
        'getPlaylists',
      ),
    ).toThrow(RemoteSubsonicError);
  });

  it("names the remote's own message rather than inventing one", () => {
    try {
      unwrapEnvelope(
        JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 50, message: 'User is not authorized.' } } }),
        200,
        'getPlaylists',
      );
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as RemoteSubsonicError).message).toContain('not authorized');
      // And the remote's code, because "the server said 50" and "the server said something we did
      // not understand" want different responses.
      expect((error as RemoteSubsonicError).remoteCode).toBe('50');
    }
  });

  it('says what a non-JSON body actually was', () => {
    // Almost always an HTML error page from a proxy, which is a different problem from a Subsonic
    // server answering wrongly, and the operator needs to be told which.
    expect(() => unwrapEnvelope('<!doctype html><h1>502</h1>', 502, 'getPlaylists')).toThrow(/non-JSON body \(HTTP 502\)/);
  });

  it('refuses a 200 that is not an envelope at all', () => {
    expect(() => unwrapEnvelope('{"ok":true}', 200, 'getPlaylists')).toThrow(/without a subsonic-response envelope/);
  });

  it('strips the envelope attributes so a caller cannot read `status` as a result', () => {
    const payload = unwrapEnvelope(
      JSON.stringify({
        'subsonic-response': {
          status: 'ok',
          version: '1.16.1',
          type: 'edge-sonic',
          serverVersion: '0.1.0',
          openSubsonic: true,
          playlists: {},
        },
      }),
      200,
      'getPlaylists',
    );
    // Returned **once**, where the shape is known — rather than at each of the seven call sites,
    // which is seven chances to forget and one caller that reads `status: 'ok'` as an album.
    expect(Object.keys(payload)).toEqual(['playlists']);
  });
});

describe('a single-element list collapses to a bare object, and must survive it', () => {
  it('reads a one-track playlist as one track, not zero', async () => {
    // The single most consequential case in this file. `{"entry": {...}}` where this server would
    // send `[...]`, read naively, imports a one-track playlist as an **empty** one — which is
    // indistinguishable from a playlist whose tracks did not resolve.
    const { client } = clientUnderStub({
      'subsonic-response': { status: 'ok', playlist: { id: 'p1', entry: { id: 'r1', title: 'Only' } } },
    });

    const songs = await client.getPlaylist('p1');

    expect(songs).toHaveLength(1);
    expect(songs[0].id).toBe('r1');
  });

  it('reads a many-track playlist as many', async () => {
    const { client } = clientUnderStub({
      'subsonic-response': { status: 'ok', playlist: { entry: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } },
    });

    expect(await client.getPlaylist('p1')).toHaveLength(3);
  });

  it('reads an absent wrapper as empty, because "nothing to report" is not a failure', async () => {
    // `getBookmarks` on a server with no bookmarks may omit the key entirely. An absent key is `[]`,
    // and an empty list is a different answer from an error.
    const { client } = clientUnderStub({ 'subsonic-response': { status: 'ok' } });

    expect(await client.getBookmarks()).toEqual([]);
    expect(await client.getPlaylists()).toEqual([]);
    expect(await client.getPlayQueue()).toEqual({ entries: [], currentId: null, positionMs: null });
  });

  it('reads a collapsed artist list inside getStarred2', async () => {
    const { client } = clientUnderStub({
      'subsonic-response': {
        status: 'ok',
        starred2: {
          song: { id: 's1', title: 'One', path: 'A/One.flac' },
          album: { id: 'al1', name: 'Only Album', artist: 'A' },
          artist: { id: 'ar1', name: 'Only Artist' },
        },
      },
    });

    const starred = await client.getStarred();
    expect(starred.songs).toHaveLength(1);
    expect(starred.albums).toHaveLength(1);
    expect(starred.artists).toHaveLength(1);
  });

  it('tolerates counts sent as strings, because some servers send them as text', async () => {
    const { client } = clientUnderStub({
      'subsonic-response': { status: 'ok', starred2: { song: { id: 's1', playCount: '7', userRating: '4' } } },
    });

    const [song] = (await client.getStarred()).songs;
    expect(song.playCount).toBe(7);
    expect(song.userRating).toBe(4);
  });

  it('reports a path as absent rather than inventing one', async () => {
    // `Child.path` exists in the schema and Navidrome emits it, but **this server deliberately does
    // not** — so path matching works against most third-party sources and never against another
    // Edge-Sonic. A missing path must be `null` rather than `''`, or every no-path-remote looks
    // like it published the empty path.
    const { client } = clientUnderStub({ 'subsonic-response': { status: 'ok', playlist: { entry: { id: 'r1' } } } });

    expect((await client.getPlaylist('p1'))[0].path).toBeNull();
  });

  it('drops an entry with no id, because it cannot be matched against anything', async () => {
    const { client } = clientUnderStub({ 'subsonic-response': { status: 'ok', playlist: { entry: [{ title: 'No id' }, { id: 'r1' }] } } });

    expect(await client.getPlaylist('p1')).toHaveLength(1);
  });
});

describe('the credential is a token, not the password', () => {
  it('sends `t` and `s` and never `p`', async () => {
    const { client, url } = clientUnderStub({ 'subsonic-response': { status: 'ok', playlists: {} } });

    await client.getPlaylists();

    // A password in a query string lands in the remote's access log, in every proxy's on the way
    // there, and in whatever the remote's own request log writes down — none of which is visible
    // from here.
    const seen = url();
    expect(seen).not.toContain('p=hunter2');
    const parsed = new URL(seen);
    expect(parsed.searchParams.get('t')).toMatch(/^[0-9a-f]{32}$/);
    // And the token is genuinely the password plus that salt, because a server verifying it is the
    // whole reason it is sent.
    expect(parsed.searchParams.get('t')).toBe(md5Hex(`hunter2${parsed.searchParams.get('s')}`));
  });

  it('uses a fresh salt per request, so a token is not reusable', async () => {
    const tokens: (string | null)[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      tokens.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).searchParams.get('t'));
      return jsonResponse({ 'subsonic-response': { status: 'ok', playlists: {} } });
    });
    const client = new RemoteSubsonicClient({
      baseUrl: 'https://m.example.com',
      username: 'a',
      password: 'b',
      timeoutMs: 1000,
      onRequest: () => undefined,
    });

    await client.getPlaylists();
    await client.getPlaylists();

    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('charges the meter for every request', async () => {
    // **Before** issuing, not after: a charge that happens once the work is done cannot stop the
    // request that crosses the ceiling, which is the only reason to count at all.
    const onRequest = vi.fn();
    vi.stubGlobal('fetch', async () => jsonResponse({ 'subsonic-response': { status: 'ok', playlists: {} } }));
    const client = new RemoteSubsonicClient({ baseUrl: 'https://m.example.com', username: 'a', password: 'b', timeoutMs: 1000, onRequest });

    await client.getPlaylists();
    await client.getPlaylists();

    expect(onRequest).toHaveBeenCalledTimes(2);
  });

  it('omits a null parameter rather than sending the string "null"', async () => {
    // The parameter's **presence** is what the remote reads, so sending it empty would look like an
    // empty id rather than an absent one.
    const { client, url } = clientUnderStub({ 'subsonic-response': { status: 'ok' } });

    await client.call('getAlbum', { id: null, other: 'x' });

    expect(url()).toContain('other=x');
    expect(url()).not.toContain('id=null');
  });

  it('addresses the mount path without doubling the slash', async () => {
    const { client, url } = clientUnderStub({ 'subsonic-response': { status: 'ok', playlists: {} } });

    await client.getPlaylists();

    expect(new URL(url()).pathname).toBe('/sonic/rest/getPlaylists.view');
  });

  it('translates a timeout into a status, because a bare abort is neither', async () => {
    // Without this a slow remote is indistinguishable from an unreachable one, and the operator is
    // told to debug their own server — the mistake `probeOutcome.ts` exists to prevent.
    vi.stubGlobal('fetch', async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error('aborted');
    });
    const client = new RemoteSubsonicClient({
      baseUrl: 'https://m.example.com',
      username: 'a',
      password: 'b',
      timeoutMs: 1,
      onRequest: () => undefined,
    });

    await expect(client.getPlaylists()).rejects.toThrow(/did not answer in time/);
  });

  it('refuses a body too large to read, because a remote is untrusted input', async () => {
    // `response.json()` on an unbounded body is an unbounded `JSON.parse` against a 10 ms CPU budget
    // — the same class of concern as the ReDoS guards.
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(5 * 1024 * 1024), { status: 200 }));
    const client = new RemoteSubsonicClient({
      baseUrl: 'https://m.example.com',
      username: 'a',
      password: 'b',
      timeoutMs: 1000,
      onRequest: () => undefined,
    });

    await expect(client.getPlaylists()).rejects.toThrow(/too large to read/);
  });

  it('reports an unreachable host without claiming the remote refused', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network error');
    });
    const client = new RemoteSubsonicClient({
      baseUrl: 'https://m.example.com',
      username: 'a',
      password: 'b',
      timeoutMs: 1000,
      onRequest: () => undefined,
    });

    try {
      await client.getPlaylists();
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as RemoteSubsonicError).status).toBeNull();
      expect((error as RemoteSubsonicError).message).toContain('could not be reached');
    }
  });
});
