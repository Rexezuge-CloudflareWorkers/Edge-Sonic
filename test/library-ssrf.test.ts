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
    expect(() => normalizeRootPath('/music\\sub')).toThrow(BadRequestError);
    expect(() => normalizeRootPath('/mus\u0000ic')).toThrow(BadRequestError);
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
  function buildService(overrides: Partial<{ allowPrivate: boolean; dav: ReturnType<typeof fakeDav> }> = {}) {
    const dav = overrides.dav ?? fakeDav({ '': [{ path: '' }] });
    const rows = new Map<string, Record<string, unknown>>();
    const service = new LibraryService({
      libraries: {
        findById: async (id) => (rows.get(id) as never) ?? null,
        findBySlug: async (slug) => [...rows.values()].find((row) => row.slug_ci === slug.toLowerCase()) as never,
        list: async () => [...rows.values()] as never,
        listForUser: async () => [...rows.values()] as never,
        countForUser: async () => rows.size,
        create: async (input) => {
          const row = { id: 'L1', ...input, is_enabled: 1, created_at: 0, updated_at: 0 };
          rows.set('L1', row);
          return row as never;
        },
        update: async () => undefined,
        updatePassword: async () => undefined,
        setEnabled: async () => undefined,
        delete: async (id) => {
          rows.delete(id);
        },
      },
      resolveKey: async () => KEY,
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

  /** A row with a credential that actually decrypts, so a probe reaches the network. */
  async function probeRow() {
    const encrypted = await encryptData('hunter2', KEY);
    return {
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
    } as never;
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

  it('reports an unreachable origin without a status', async () => {
    const { service, dav } = buildService({ dav: fakeDav({}, { failAll: true }) });
    vi.stubGlobal('fetch', dav.fetch);
    const result = await service.probe(await probeRow());
    vi.unstubAllGlobals();
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
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
    // Seeking is how every Subsonic client skips a track. A `206` has to stay a
    // `206`, and the body must not be re-buffered.
    const dav = fakeDav({ '/a.flac': [{ path: '/a.flac', size: 5000, contentType: 'audio/flac' }] });
    vi.stubGlobal('fetch', dav.fetch);
    const client = new WebDavClient('https://dav.example.com', '/', { username: 'u', password: 'p' });
    const response = await client.get('a.flac', { range: 'bytes=100-199' });
    vi.unstubAllGlobals();

    expect(dav.gets[0]!.range).toBe('bytes=100-199');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toContain('bytes 0-');
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

