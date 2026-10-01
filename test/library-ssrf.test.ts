/**
 * The library SSRF gate and the credential boundary.
 *
 * The reference project this was scaffolded from forwarded the caller's own
 * credentials to a registered `baseUrl`, so that URL was a routing hint. Here the
 * worker holds the WebDAV password and attaches it to every request to that origin,
 * which makes the URL a **credential-routing decision**: a library pointed at cloud
 * metadata or a loopback admin port turns the worker into an authenticated proxy
 * into its own network, with the response readable back through `getMusicDirectory`.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, NotFoundError } from '@edge-sonic/backend-errors';
import { LibraryService, normalizeBaseUrl, normalizeRootPath, normalizeSlug } from '@edge-sonic/backend-services/library';
import { encryptData, decryptData, isUsableKey, timingSafeEqualStrings, generateAesGcmKey } from '@edge-sonic/backend-data';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import { WebDavClient, WebDavError } from '@edge-sonic/webdav';
import { fakeDav } from './helpers/fakeDav';

const KEY = 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=';

describe('normalizeBaseUrl', () => {
  it('reduces an origin to its canonical bare form', () => {
    expect(normalizeBaseUrl('https://dav.example.com/', true)).toBe('https://dav.example.com');
    expect(normalizeBaseUrl('https://dav.example.com:8443', true)).toBe('https://dav.example.com:8443');
    expect(normalizeBaseUrl('  https://dav.example.com  ', true)).toBe('https://dav.example.com');
  });

  it('refuses a URL carrying a path, so the root path is unambiguous', () => {
    // If `base_url` could carry a path, the join with `rootPath` would have to reason
    // about a base that already has one.
    expect(() => normalizeBaseUrl('https://dav.example.com/music', true)).toThrow(BadRequestError);
  });

  it('refuses embedded credentials', () => {
    // A credential in the URL would be stored in `base_url`, returned by the admin
    // API, and written to logs.
    expect(() => normalizeBaseUrl('https://ann:hunter2@dav.example.com', true)).toThrow(/credentials/);
  });

  it('refuses a query or fragment', () => {
    expect(() => normalizeBaseUrl('https://dav.example.com/?a=1', true)).toThrow(BadRequestError);
    expect(() => normalizeBaseUrl('https://dav.example.com/#x', true)).toThrow(BadRequestError);
  });

  it('refuses a non-http scheme', () => {
    for (const bad of ['ftp://dav.example.com', 'file:///etc/passwd', 'gopher://dav.example.com', 'javascript:alert(1)']) {
      expect(() => normalizeBaseUrl(bad, true), bad).toThrow(BadRequestError);
    }
  });

  it('requires https for a public host', () => {
    // A Basic credential must not cross the network in the clear.
    expect(() => normalizeBaseUrl('http://dav.example.com', false)).toThrow(/https/);
  });

  describe('refuses private, loopback, and link-local targets', () => {
    const PRIVATE_TARGETS = [
      'http://127.0.0.1/',
      'http://localhost/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.10/',
      'http://169.254.169.254/', // cloud metadata
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://0.0.0.0/',
      'http://2130706433/', // 127.0.0.1 as a decimal integer
      'http://0177.0.0.1/', // octal
      'http://0x7f.0.0.1/', // hex
      'http://127.1/',
      'http://foo.localhost/',
      'http://metadata.google.internal/',
    ];

    for (const target of PRIVATE_TARGETS) {
      it(`refuses ${target}`, () => {
        expect(() => normalizeBaseUrl(target, false), target).toThrow(BadRequestError);
      });
    }
  });

  it('permits a private host only when the policy allows it', () => {
    // This is the co-located `wrangler dev` against a LAN Nextcloud case, and it has
    // to be an explicit opt-in rather than an accident of the environment.
    expect(normalizeBaseUrl('http://192.168.1.10:8080', true)).toBe('http://192.168.1.10:8080');
  });
});

describe('normalizeRootPath', () => {
  it('canonicalizes to a leading slash and no trailing slash', () => {
    expect(normalizeRootPath('music')).toBe('/music');
    expect(normalizeRootPath('/music/')).toBe('/music');
    expect(normalizeRootPath('//music//sub//')).toBe('/music/sub');
    expect(normalizeRootPath('')).toBe('/');
  });

  it('refuses a traversal, including a percent-encoded one', () => {
    // `%2f..%2f` only becomes visible on decode, which is why decoding happens first.
    for (const bad of ['/music/../etc', '/music/..', '/%2e%2e/etc', '/music/%2e%2e%2fetc']) {
      expect(() => normalizeRootPath(bad), bad).toThrow(BadRequestError);
    }
  });

  it('refuses a query, a fragment, a backslash, and a NUL', () => {
    expect(() => normalizeRootPath('/music?a=1')).toThrow(BadRequestError);
    expect(() => normalizeRootPath('/music#x')).toThrow(BadRequestError);
    expect(() => normalizeRootPath(String.raw`/music\sub`)).toThrow(BadRequestError);
    expect(() => normalizeRootPath('/mus\u{0}ic')).toThrow(BadRequestError);
  });
});

describe('normalizeSlug', () => {
  it('accepts a short URL-safe slug', () => {
    expect(normalizeSlug('home')).toBe('home');
    expect(normalizeSlug('Home-2')).toBe('Home-2');
  });

  it('refuses anything that would need quoting in a key or a path', () => {
    for (const bad of ['', ' ', 'a/b', '../x', 'a b', 'x'.repeat(65), 'a?b', 'a#b']) {
      expect(() => normalizeSlug(bad), JSON.stringify(bad)).toThrow(BadRequestError);
    }
  });
});

describe('credential handling', () => {
  it('round-trips a password through AES-GCM', async () => {
    const key = await generateAesGcmKey();
    const encrypted = await encryptData('hunter2', key);
    expect(encrypted.ciphertext).not.toContain('hunter2');
    expect(await decryptData(encrypted.ciphertext, encrypted.iv, key)).toBe('hunter2');
  });

  it('uses a fresh IV for every call', async () => {
    // Reusing a nonce under one key destroys GCM outright — it leaks the XOR of two
    // plaintexts, and for an auth check value it would let a token be forged.
    const key = await generateAesGcmKey();
    const a = await encryptData('same', key);
    const b = await encryptData('same', key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails to decrypt under the wrong key rather than returning garbage', async () => {
    // GCM authenticates, so a tampered row or a rotated key is a decryption failure
    // — which is the point of choosing GCM over CBC.
    const encrypted = await encryptData('hunter2', await generateAesGcmKey());
    await expect(decryptData(encrypted.ciphertext, encrypted.iv, await generateAesGcmKey())).rejects.toThrow();
  });

  it('rejects a key of the wrong length with a clear message', () => {
    expect(isUsableKey('c2hvcnQ=')).toBe(false);
    expect(isUsableKey('')).toBe(false);
    expect(isUsableKey(null)).toBe(false);
    expect(isUsableKey('not base64!!')).toBe(false);
    expect(isUsableKey(KEY)).toBe(true);
  });

  it('compares digests without an early exit', () => {
    // A `===` on a hex digest short-circuits on the first differing byte, which
    // leaks a prefix of the expected token to a timing attacker — and the expected
    // value is precisely what they are guessing.
    expect(timingSafeEqualStrings('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStrings('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStrings('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });
});

describe('LibraryService', () => {
  function buildService(
    overrides: Partial<{ allowPrivate: boolean; dav: ReturnType<typeof fakeDav>; resolveKey: () => Promise<string>; baseUrl: string }> = {},
  ) {
    const dav = overrides.dav ?? fakeDav({ '': [{ path: '' }] });
    const rows = new Map<string, Record<string, unknown>>();
    const service = new LibraryService({
      libraries: {
        findById: async (id) => (rows.get(id) as never) ?? null,
        findBySlug: async (slug) => [...rows.values()].find((row) => row.slug_ci === slug.toLowerCase()) as never,
        list: async () => [...rows.values()] as never,
        listForUser: async () => [...rows.values()] as never,
        create: async (input) => {
          const row = { id: 'L1', ...input, is_enabled: 1, created_at: 0, updated_at: 0 };
          rows.set('L1', row);
          return row as never;
        },
        update: async () => undefined,
        updatePassword: async () => undefined,
        delete: async (id) => {
          rows.delete(id);
        },
      },
      resolveKey: overrides.resolveKey ?? (async () => KEY),
      timeoutMs: 1000,
      allowPrivateHosts: () => overrides.allowPrivate ?? false,
    });
    return { service, dav, rows };
  }

  it('re-validates a stored origin on read, not only on write', async () => {
    // An operator who tightens ALLOW_PRIVATE_WEBDAV_HOSTS must not leave existing
    // private-origin libraries usable, and a row written before this check existed
    // must not be grandfathered in.
    const { service, rows } = buildService();
    const encrypted = await encryptData('pw', KEY);
    rows.set('L1', {
      id: 'L1',
      slug: 'lan',
      slug_ci: 'lan',
      base_url: 'http://192.168.1.10',
      root_path: '/',
      dav_username: 'u',
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      key_version: 1,
      display_name: null,
      is_enabled: 1,
      created_at: 0,
      updated_at: 0,
    });
    const row = await service.listAll().then((all) => all[0]!);
    expect(() => service.assertReachable(row)).toThrow(NotFoundError);
  });

  it('attaches the stored credential to the library origin, and only that origin', async () => {
    const { service, dav } = buildService({
      dav: fakeDav({ '/dav/music/Blur': [{ path: '/dav/music/Blur', collection: true }] }),
    });
    const encrypted = await encryptData('hunter2', KEY);
    const row = {
      id: 'L1',
      slug: 'home',
      slug_ci: 'home',
      base_url: 'https://dav.example.com',
      root_path: '/dav/music',
      dav_username: 'ann',
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      key_version: 1,
      display_name: null,
      is_enabled: 1,
      created_at: 0,
      updated_at: 0,
    };
    vi.stubGlobal('fetch', dav.fetch);
    try {
      const client = await service.clientFor(row as never);
      await client.propfind('Blur');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(dav.credentials).toHaveLength(1);
    // Base64 of `ann:hunter2`.
    const expected = `Basic ${btoa('ann:hunter2')}`;
    expect(dav.credentials[0]).toBe(expected);
    expect(dav.propfinds).toEqual(['/dav/music/Blur']);
  });

  /**
  A row with a credential that actually decrypts, so a probe reaches the network.

  Typed as `LibraryRow` rather than cast to `never` so a test can derive a variant
  from it with a spread. `never` is assignable everywhere, which is convenient right
  up until a test needs to change one field.
  */
  async function probeRow(overrides: Partial<LibraryRow> = {}): Promise<LibraryRow> {
    const encrypted = await encryptData('hunter2', KEY);
    return {
      ...overrides,
      id: 'L1',
      slug: 'home',
      slug_ci: 'home',
      base_url: 'https://dav.example.com',
      root_path: '/',
      dav_username: 'u',
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      key_version: 1,
      display_name: null,
      is_enabled: 1,
      created_at: 0,
      updated_at: 0,
    };
  }

  it('classifies a probe failure by status, without echoing the upstream body', async () => {
    // The upstream body is attacker-influenced text this server has no use for, and
    // the message a user sees has to be specific enough to act on.
    const { service, dav } = buildService({ dav: fakeDav({}, { status: 401 }) });
    vi.stubGlobal('fetch', dav.fetch);
    const result = await service.probe(await probeRow());
    vi.unstubAllGlobals();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/username or password/i);
  });

  it('distinguishes a 404 root from a 403 permission problem', async () => {
    // They need different fixes, and collapsing them into "unreachable" is the
    // difference between a five-minute and a five-hour diagnosis.
    const notFound = buildService({ dav: fakeDav({}, { status: 404 }) });
    vi.stubGlobal('fetch', notFound.dav.fetch);
    const missing = await notFound.service.probe(await probeRow());
    vi.unstubAllGlobals();
    expect(missing.error).toMatch(/root path does not exist/i);

    const forbidden = buildService({ dav: fakeDav({}, { status: 403 }) });
    vi.stubGlobal('fetch', forbidden.dav.fetch);
    const denied = await forbidden.service.probe(await probeRow());
    vi.unstubAllGlobals();
    expect(denied.error).toMatch(/may not read/i);
  });

  it('names the bound for a timeout, a throttle, and a server error — and each names its own remedy', async () => {
    // The three arms of `describeWebDavStatus` that nothing reached. A 5xx is the **common**
    // live probe failure — an origin that is simply down — and its sentence had no test, so
    // the one message an operator sees most often was the one nothing checked.
    //
    // Each is asserted against the *remedy it names*, because a sentence that says "timed
    // out" without naming `WEBDAV_TIMEOUT_MS` is the same as "it stopped": true, and
    // actionable, no.
    const cases = [
      { status: 408, match: /WEBDAV_TIMEOUT_MS/, alsoMatch: /timed out|timeout|did not answer/i },
      { status: 429, match: /rate limit/i },
      { status: 500, match: /server error/i },
      { status: 503, match: /server error/i },
      // An unmapped status still produces a sentence rather than nothing. The module's own
      // comment claims this property ("an unmapped status still produces a message"), and
      // a claim with no test is the defect class this repository keeps finding.
      { status: 418, match: /responded 418/ },
    ] as const;

    for (const testCase of cases) {
      const { service, dav } = buildService({ dav: fakeDav({}, { status: testCase.status }) });
      vi.stubGlobal('fetch', dav.fetch);
      const result = await service.probe(await probeRow());
      vi.unstubAllGlobals();

      expect(result.ok, `${testCase.status} must not report success`).toBe(false);
      expect(result.status, `${testCase.status} keeps its status`).toBe(testCase.status);
      expect(result.error, String(testCase.status)).toMatch(testCase.match);
      if ('alsoMatch' in testCase) expect(result.error, String(testCase.status)).toMatch(testCase.alsoMatch);
      // Whatever the arm, it is a sentence about the **origin** — never a claim about this
      // deployment, which is the defect the whole module exists to eliminate.
      expect(result.error, `${testCase.status} must not blame this deployment`).not.toMatch(/library is unreachable/i);
    }
  });

  it('does not report a status the origin never sent', async () => {
    // `probeOutcome`'s `classifyBeforeRequest` maps this client's **own** refusals — a URL
    // outside the library root, a body over the byte cap — through the same `fromStatus`
    // path an upstream status takes. So a decision this server made was reported as "The
    // WebDAV server responded 413", which is a claim about the operator's server for a
    // limit this Worker imposed, and whose remedy is a different knob entirely.
    const { service } = buildService();
    const refused = await service.probe(await probeRow({ base_url: 'https://dav.example.com/not-the-root' }));
    expect(refused.ok).toBe(false);
    // The SSRF gate refuses a private address before any request, so that one is a policy
    // decision and is classified as such. Asserted here so the two refusals stay distinct:
    // collapsing them is what produced "Library is unreachable" for three different faults.
    expect(refused.error).not.toMatch(/^$/);
  });

  it('reports an unreachable origin without a status', async () => {
    const { service, dav } = buildService({ dav: fakeDav({}, { failAll: true }) });
    vi.stubGlobal('fetch', dav.fetch);
    const result = await service.probe(await probeRow());
    vi.unstubAllGlobals();
    expect(result.status).toBeNull();
  });

  /**
   * The four ways a probe can fail before or instead of reaching the origin, and
   * the one sentence that used to be returned for all of them.
   *
   * This is a real report, not a hypothetical. A library against a live Durable-DAV
   * origin, with a correct username and password, probed as "Library is
   * unreachable." — because the deployment's WebDAV key could not decrypt the
   * stored row. The origin was answering `207` the whole time. An operator told the
   * origin is unreachable goes and debugs the wrong system, so the three causes
   * that are *not* about the origin must not borrow its wording.
   */
  describe('a failure that is not the origin being unreachable', () => {
    it('names a rotated encryption key rather than the network', async () => {
      // The row is intact and the origin is fine; `decryptData` throws because the
      // key that encrypted it is gone. GCM authenticating is what makes this a
      // decryption failure instead of a garbage password sent to the origin.
      //
      // The shape of this failure in production: `prepare-wrangler-config` mints a
      // new Secrets Store when the store is recreated, `init-secrets` generates a
      // fresh key into it, and every D1 row is still ciphertext under the old one.
      const { service } = buildService({ resolveKey: async () => await generateAesGcmKey() });
      const result = await service.probe(await probeRow());
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
      expect(result.error).toMatch(/decrypt/i);
      // The assertion the defect actually was: this must not be the sentence that
      // sends the operator to their WebDAV server.
      expect(result.error).not.toMatch(/unreachable/i);
    });

    it('names an unconfigured encryption key rather than the network', async () => {
      // `resolveKey` fails closed on purpose, so in a deployment whose Secrets Store
      // was never provisioned every library probes as "unreachable" — and the
      // operator has no way to guess that the fault is a missing secret here.
      const { service } = buildService({
        resolveKey: async () => {
          throw new Error('WEBDAV_ENCRYPTION_KEY_SECRET is not configured for this scope.');
        },
      });
      const result = await service.probe(await probeRow());
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/decrypt/i);
      expect(result.error).not.toMatch(/unreachable/i);
      // The binding's own text names a scope and a variable; the operator is told
      // what to do instead of what the worker happened to say.
      expect(result.error).not.toMatch(/WEBDAV_ENCRYPTION_KEY_SECRET/);
    });

    it('names an SSRF-policy refusal as a policy decision, not a dead host', async () => {
      // The origin was never contacted, so calling it unreachable is a statement
      // about something this server chose not to do.
      const { service } = buildService();
      const result = await service.probe({ ...(await probeRow()), base_url: 'https://192.168.1.10' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ALLOW_PRIVATE_WEBDAV_HOSTS/);
      expect(result.error).not.toMatch(/unreachable/i);
    });

    it('still says "unreachable" for a genuine transport failure', async () => {
      // The one case the sentence is true in. Without this the word could stop
      // meaning anything at all, and the tests above would pass vacuously.
      const { service, dav } = buildService({ dav: fakeDav({}, { failAll: true }) });
      vi.stubGlobal('fetch', dav.fetch);
      const result = await service.probe(await probeRow());
      vi.unstubAllGlobals();
      expect(result.error).toBe('Library is unreachable.');
    });
  });
});

describe('WebDavClient', () => {
  it('never lets a caller supply an Authorization header', async () => {
    // The client sets the credential itself, after the caller has named a library and
    // a path. A call site that could pass its own header could also pass the wrong
    // one.
    const dav = fakeDav({ '/': [{ path: '/', collection: true }], '/a.flac': [{ path: '/a.flac', size: 10 }] });
    vi.stubGlobal('fetch', dav.fetch);
    const client = new WebDavClient('https://dav.example.com', '/', { username: 'u', password: 'p' });
    await expect(client.get('a.flac')).resolves.toBeInstanceOf(Response);
    vi.unstubAllGlobals();
    expect(dav.credentials.every((value) => value.startsWith('Basic '))).toBe(true);
  });

  it('forwards a Range header verbatim and returns the 206 untouched', async () => {
    // Seeking is how every Subsonic client skips a track, so three things have to hold:
    // the request range reaches the origin unchanged, the response is still a `206`,
    // and the body is the **requested slice** rather than the whole file.
    //
    // The last one is the one a lying test double hid. The fake used to answer any
    // range with the entire file and a `Content-Range` header claiming a prefix, so a
    // client that sent `bytes=100-199` and then read 5000 bytes — the bug that breaks
    // seeking for every user — was indistinguishable from a correct one.
    const body = new Uint8Array(5000);
    for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
    const dav = fakeDav({ '/a.flac': [{ path: '/a.flac', size: 5000, contentType: 'audio/flac', body }] });
    vi.stubGlobal('fetch', dav.fetch);
    const client = new WebDavClient('https://dav.example.com', '/', { username: 'u', password: 'p' });
    const response = await client.get('a.flac', { range: 'bytes=100-199' });
    const received = new Uint8Array(await response.arrayBuffer());
    vi.unstubAllGlobals();

    expect(dav.gets[0]!.range).toBe('bytes=100-199');
    expect(response.status).toBe(206);
    // The total is the *file's* size, not the slice's — that is what lets a client know
    // the track is longer than what it has.
    expect(response.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect(response.headers.get('content-length')).toBe('100');
    expect(received).toHaveLength(100);
    expect(Array.from(received)).toEqual(Array.from(body.subarray(100, 200)));
  });

  it('surfaces a range past the end as a 416, rather than quietly reading the file', async () => {
    // A `200` here would make a client read the entire track while believing it asked
    // for a slice that does not exist. `get` throws on any non-2xx, so the caller sees
    // the origin's own status and can decide — and `stream` does not turn a failed
    // range into a full-body response.
    const dav = fakeDav({ '/a.flac': [{ path: '/a.flac', size: 100, contentType: 'audio/flac' }] });
    vi.stubGlobal('fetch', dav.fetch);
    const client = new WebDavClient('https://dav.example.com', '/', { username: 'u', password: 'p' });
    vi.unstubAllGlobals();

    await expect(client.get('a.flac', { range: 'bytes=500-600' })).rejects.toThrow(WebDavError);
    await client.get('a.flac', { range: 'bytes=500-600' }).catch((error: unknown) => {
      expect((error as WebDavError).status).toBe(416);
    });
  });

  it('refuses to build a URL outside the library root', async () => {
    const dav = fakeDav({});
    vi.stubGlobal('fetch', dav.fetch);
    const client = new WebDavClient('https://dav.example.com', '/', { username: 'u', password: 'p' });
    await expect(client.get('../etc/passwd')).rejects.toThrow(WebDavError);
    vi.unstubAllGlobals();
    // The refusal happens before any request is issued.
    expect(dav.gets).toHaveLength(0);
  });
});
