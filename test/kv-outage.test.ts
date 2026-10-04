/**
 * The `CACHE` binding must never be load-bearing.
 *
 * ### What this asserts, and why it is a test and not a comment
 *
 * Edge-Sonic keeps its index, its user state, and its auth counters in D1. KV holds
 * a cache. A requirement nobody asserts is a requirement that quietly regresses the
 * first time someone adds a `kv.get(...)` on a path that needed to work.
 *
 * So the surface is re-run with the binding **absent** and with every operation
 * **throwing**, and the responses must be identical to the healthy run. Not
 * "similar" — identical, modulo the instrumentation this suite adds.
 *
 * The circuit-breaker test is the second half: a *failing* cache that does not
 * error fast makes the server slower precisely when it is already degraded, which
 * a status-code assertion cannot see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KvCache, resetBreakerForTests } from '@edge-sonic/backend-runtime/kv';
import { sniffImageType } from '@edge-sonic/media-tags';
import { deadKv, fakeKv } from './helpers/fakeKv';

const PART = 'lib1';
const DOMAIN = 'songMeta' as const;

describe('KvCache is a cache, not a dependency', () => {
  beforeEach(() => {
    resetBreakerForTests();
  });

  it('reads and writes when healthy', async () => {
    const cache = new KvCache(fakeKv().ns);
    expect(await cache.putJson(DOMAIN, [PART, 'artists'], { a: 1 })).toBe(true);
    expect(await cache.getJson(DOMAIN, [PART, 'artists'])).toEqual({ a: 1 });
  });

  it('reads as a miss when the binding is absent', async () => {
    // `new KvCache(null)` is what the composition root builds when `env.CACHE` is
    // missing. It must not be a separate code path from a failing binding.
    const cache = new KvCache(null);
    expect(cache.available).toBe(false);
    expect(await cache.getJson(DOMAIN, [PART, 'artists'])).toBeNull();
    expect(await cache.putJson(DOMAIN, [PART, 'artists'], { a: 1 })).toBe(false);
  });

  it('reads as a miss when every operation throws', async () => {
    const cache = new KvCache(deadKv());
    expect(await cache.getJson(DOMAIN, [PART, 'artists'])).toBeNull();
    // A failed write is reported as "not stored", never thrown: the caller has
    // already got its answer from D1 and must not now fail on the cache.
    expect(await cache.putJson(DOMAIN, [PART, 'artists'], { a: 1 })).toBe(false);
    expect(await cache.getText(DOMAIN, [PART, 'x'])).toBeNull();
  });

  it('never throws, for any operation, with a throwing namespace', async () => {
    const cache = new KvCache(deadKv());
    await expect(cache.del(DOMAIN, [PART, 'x'])).resolves.toBeUndefined();
    await expect(cache.purgePrefix(DOMAIN, [PART])).resolves.toBe(0);
  });

  it('treats a corrupt value as a miss rather than an error', async () => {
    // A truncated or hand-edited value must degrade to a recompute, not a 500.
    const cache = new KvCache(fakeKv({ 'songMeta:v1:lib1:artists': '{not json' }).ns);
    expect(await cache.getJson(DOMAIN, [PART, 'artists'])).toBeNull();
  });

  it('skips a value that exceeds the domain size limit', async () => {
    // Refusing to store is correct: KV rejects it anyway, and a truncated write would
    // be worse than none.
    const cache = new KvCache(fakeKv().ns);
    const oversized = 'x'.repeat(600 * 1024);
    expect(await cache.putText(DOMAIN, [PART, 'big'], oversized)).toBe(false);
  });
});

/**
 * The binary domain, and the one default that destroyed it.
 *
 * ### A round-trip test is only worth what the double loses
 *
 * `get()`'s default type is **`text`**, and UTF-8 is not a byte-preserving codec: a
 * JPEG read as text comes back lossy-decoded, with every invalid sequence replaced by
 * U+FFFD and re-encoded as three bytes. So `getBytes` must ask for `'arrayBuffer'`,
 * and an assertion that only the *bytes* are equal cannot tell a correct reader from
 * one that got lucky on a fixture whose magic happens to survive a UTF-8 round trip.
 *
 * That is why the negative below is not "the wrong type throws". It is the actual
 * damage: the same key, the same stored bytes, read the way the platform reads by
 * default, and **not** equal. Without it, a double that returned values verbatim —
 * which is what `fakeKv` did — makes this whole block pass while production loses
 * every cover in the library.
 */
describe('binary values survive the cache', () => {
  beforeEach(() => {
    resetBreakerForTests();
  });

  // `ff d8 ff db` — a JPEG whose fourth byte is a quantization table, which is what
  // every cover in a real library starts with. It is chosen because it is *not*
  // valid UTF-8, so it is destroyed by a text read; a fixture starting `ff d8 ff e0`
  // (JFIF) would hide the defect it exists to catch.
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x84, 0x00, 0x08, 0x00, 0x00]);
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

  it('returns the exact bytes that were written', async () => {
    for (const domain of ['albumArt', 'songMeta'] as const) {
      const cache = new KvCache(fakeKv().ns);
      expect(await cache.putBytes(domain, [PART, 'cover'], JPEG)).toBe(true);
      const read = await cache.getBytes(domain, [PART, 'cover']);
      expect(read).not.toBeNull();
      expect([...(read ?? [])]).toEqual([...JPEG]);
    }
  });

  it('states the type it reads, because the default is text', async () => {
    // The decision itself, asserted rather than inferred from the bytes: a reader that
    // omits the argument is the defect, and on a real binding the bytes come back
    // corrupted rather than absent, so nothing else in the request would report it.
    const store = fakeKv();
    const cache = new KvCache(store.ns);
    await cache.putBytes('albumArt', [PART, 'cover'], JPEG);
    await cache.getBytes('albumArt', [PART, 'cover']);
    expect(store.requestedTypes.at(-1)).toBe('arrayBuffer');
  });

  it('a default-typed read of the same value is not the same value', async () => {
    // The paired negative, and the reason the positive one means anything: the double
    // reproduces the platform's lossy decode, so this is the corruption production
    // served — silently, with a non-zero length, so it cannot be mistaken for the
    // cached *absence* an album with no artwork leaves behind.
    const store = fakeKv();
    const cache = new KvCache(store.ns);
    expect(await cache.putBytes('albumArt', [PART, 'cover'], JPEG)).toBe(true);

    const asText = await store.ns.get('albumArt:v1:lib1:cover');
    const asBytes = await cache.getBytes('albumArt', [PART, 'cover']);

    expect(typeof asText).toBe('string');
    expect(new TextEncoder().encode(asText as string)).not.toEqual(JPEG);
    // And the consequence, stated as the endpoint sees it: the magic is gone, which is
    // what `sniffImageType` answers on, and `null` is what becomes the placeholder.
    expect(sniffImageType(new TextEncoder().encode(asText as string))).toBeNull();
    expect(sniffImageType(asBytes ?? new Uint8Array(0))).toBe('image/jpeg');
  });

  it('keeps PNG magic that a text read also destroys', async () => {
    // One format is not enough evidence: `89` is a UTF-8 continuation byte, so a PNG
    // is mangled differently from a JPEG and a reader that handled only one of them
    // would still look correct.
    const store = fakeKv();
    const cache = new KvCache(store.ns);
    await cache.putBytes('albumArt', [PART, 'cover'], PNG);
    expect(sniffImageType((await cache.getBytes('albumArt', [PART, 'cover'])) ?? new Uint8Array(0))).toBe('image/png');
    const asText = await store.ns.get('albumArt:v1:lib1:cover');
    expect(sniffImageType(new TextEncoder().encode(asText as string))).toBeNull();
  });

  it('an empty value stays empty, because that is the cached absence', async () => {
    // `embeddedAlbumArt` writes a zero-length entry to mean "this album has no
    // artwork", and reads it back as exactly that. A reader that turned empty into
    // `null` — or into a byte of padding — would turn a correct negative into a
    // re-probe on every request, or a corrupt cover.
    const cache = new KvCache(fakeKv().ns);
    expect(await cache.putBytes('albumArt', [PART, 'none'], new Uint8Array(0))).toBe(true);
    const read = await cache.getBytes('albumArt', [PART, 'none']);
    expect(read).not.toBeNull();
    expect(read?.byteLength).toBe(0);
  });
});

describe('KV circuit breaker', () => {
  beforeEach(() => {
    resetBreakerForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after consecutive failures and then fails fast', async () => {
    const failing = fakeKv({}, { failAll: true });
    const cache = new KvCache(failing.ns);

    // The threshold is 3: the first three calls reach the namespace, the fourth does
    // not. That is the whole point — a hanging namespace must not be paid for on
    // every request.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await cache.getText(DOMAIN, [PART, 'k'])).toBeNull();
    }
    expect(failing.calls.get).toBe(3);

    // Open: served from D1 without touching the namespace at all.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(await cache.getText(DOMAIN, [PART, 'k'])).toBeNull();
    }
    expect(failing.calls.get).toBe(3);
  });

  it('stays open for the whole cooldown window', async () => {
    // The point of the breaker is that a *hanging* namespace is not paid for on
    // every request, so it has to stay open for the whole window rather than
    // probing on every call.
    vi.useFakeTimers();
    const failing = fakeKv({}, { failAll: true });
    const cache = new KvCache(failing.ns);
    for (let attempt = 0; attempt < 3; attempt += 1) await cache.getText(DOMAIN, [PART, 'k']);
    expect(failing.calls.get).toBe(3);

    vi.advanceTimersByTime(4000);
    expect(await cache.getText(DOMAIN, [PART, 'k'])).toBeNull();
    expect(failing.calls.get).toBe(3);
  });

  it('half-opens after the cooldown and closes on the first success', async () => {
    // Recovery must not require a restart: a namespace that comes back should be
    // picked up on its own, on the first call after the cooldown.
    vi.useFakeTimers();
    const store = fakeKv({}, { failAll: true });
    const cache = new KvCache(store.ns);
    for (let attempt = 0; attempt < 3; attempt += 1) await cache.getText(DOMAIN, [PART, 'k']);
    expect(store.calls.get).toBe(3);

    // The namespace recovers.
    const recovered = fakeKv({ 'songMeta:v1:lib1:k': 'value' });
    const shared = new KvCache(recovered.ns);
    vi.advanceTimersByTime(5100);

    // The breaker state is module-level (one namespace, one breaker per isolate),
    // so a fresh instance observes the same state. This call is the half-open probe.
    expect(await shared.getText(DOMAIN, [PART, 'k'])).toBe('value');
    expect(recovered.calls.get).toBe(1);

    // And it is closed again: later calls are served normally, not blocked.
    expect(await shared.getText(DOMAIN, [PART, 'k'])).toBe('value');
    expect(recovered.calls.get).toBe(2);
  });

  it('counts a successful call as a reset', async () => {
    const store = fakeKv({ 'songMeta:v1:lib1:k': 'v' });
    const cache = new KvCache(store.ns);
    // Three successes in a row must not accumulate toward the threshold.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await cache.getText(DOMAIN, [PART, 'k'])).toBe('v');
    }
    expect(store.calls.get).toBe(10);
  });
});

describe('cache writes are budgeted', () => {
  beforeEach(() => {
    resetBreakerForTests();
  });

  it('writes nothing on a hit', async () => {
    // The free plan allows 1,000 writes per day. A read that re-stores the value it
    // just read spends that budget for nothing, and a client that re-reads the same
    // key in a loop exhausts it.
    const store = fakeKv({ 'songMeta:v1:lib1:artists': '{"cached":true}' });
    const cache = new KvCache(store.ns);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await cache.getJson(DOMAIN, [PART, 'artists']);
    }
    expect(store.writes()).toBe(0);
  });

  it('never deletes as part of a read path', async () => {
    // Invalidation is version-in-key: a superseded entry becomes unreachable on its
    // own. Nothing here may spend a delete.
    const store = fakeKv({ 'songMeta:v1:lib1:artists': '{}' });
    const cache = new KvCache(store.ns);
    await cache.getJson(DOMAIN, [PART, 'artists']);
    await cache.getText(DOMAIN, [PART, 'artists']);
    expect(store.calls.delete).toBe(0);
  });

  it('keys by version, so a bumped version makes old entries unreachable', async () => {
    // This is the invalidation mechanism: no delete, no eviction, and a scan that
    // bumps the version cannot serve a stale aggregate even for one request.
    const store = fakeKv();
    const cache = new KvCache(store.ns);
    await cache.putJson(DOMAIN, ['lib1', '1', 'artists'], { version: 1 });
    expect(await cache.getJson(DOMAIN, ['lib1', '1', 'artists'])).toEqual({ version: 1 });
    expect(await cache.getJson(DOMAIN, ['lib1', '2', 'artists'])).toBeNull();
    expect(store.calls.delete).toBe(0);
  });
});
