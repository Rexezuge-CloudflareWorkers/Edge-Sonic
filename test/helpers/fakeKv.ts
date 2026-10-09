/**
 * KV doubles.
 *
 * A KV namespace is *almost* exactly modelable, which is what makes it worth a double:
 * a Map, a TTL field, and a switch to make every call throw. That last mode is the
 * whole point of `test/kv-outage.test.ts` — the server must answer identically when
 * the cache is absent, throwing, or absent-and-throwing.
 *
 * ### "Almost", and the gap it left was the artwork cache
 *
 * This double returned whatever `put` was handed, so every round-trip in the suite was
 * byte-exact. The real binding does not: **`get()` defaults to `type: 'text'`**, and
 * UTF-8 is not a byte-preserving codec, so a stored JPEG read back as text comes back
 * lossy-decoded — every invalid sequence replaced by U+FFFD, three bytes each. The
 * whole embedded-artwork feature was destroyed by that and nothing failed: the cover
 * was extracted correctly and served correctly on the request that extracted it, and
 * then reported as "no artwork" on every request after, because
 * `sniffImageType(ef bf bd …)` is `null`. 42 covers on the first sweep of an 80-album
 * library, 0 on the second.
 *
 * So the double models the platform's **defaults**, not only its shapes:
 *
 * - `put` accepts a `string` or an `ArrayBuffer`, and stores what it was given.
 * - `get` returns the stored `ArrayBuffer` **only** when asked for `'arrayBuffer'`.
 *   With no type, or `'text'`, it returns `new TextDecoder().decode(bytes)` — the same
 *   lossy decode the platform performs, so a caller that forgets the type sees
 *   precisely what production sees.
 * - `requestedTypes` records what each `get` asked for, so a test can assert the
 *   decision rather than infer it from the bytes.
 *
 * Anything SQL-shaped is deliberately **not** modelled here. `test/integration` runs
 * against real D1, because a hand-written SQL double is a second implementation of
 * SQLite that is subtly wrong in exactly the places that matter.
 */
import type { KvNamespaceLike } from '@edge-sonic/backend-runtime/kv';

/**
The listing arguments, which is the only shape the namespace narrows `list` to.
*/
interface KvListOptions {
  readonly prefix: string;
  readonly limit?: number;
}

export interface FakeKvOptions {
  /**
  Make every operation reject, modelling a namespace that is down.
  */
  failAll?: boolean;
  /**
  Make only reads fail — the "reads time out, writes are fine" case.
  */
  failReads?: boolean;
  /**
   * Hold every `put` until {@link FakeKv.releasePuts} is called.
   *
   * ### Why a `Map` is not enough here
   *
   * This double's `put` is an `async` function whose body contains no `await`, so it
   * settles on the microtask queue — a few ticks before any caller's next `await`. A
   * cache write that is started and **not** awaited therefore lands in time, every time,
   * and the omission is invisible: the suite proves a second request was served from the
   * cache, the cache was populated by a write the product had already abandoned, and the
   * assertion passes for a defect that shipped.
   *
   * It shipped. The artwork cache was the only write in the product issued as
   * `void deps.cache.putBytes(...)`, and work a Workers request handler does not await is
   * not guaranteed to finish — so the cover cache never populated and every cell of an
   * album grid re-read the origin. Against a **50** external-subrequest Free-plan ceiling
   * and up to two reads per cover, that is a request that *fails* rather than one that is
   * slow.
   *
   * So this is not really about KV. It is the observation that an abandoned promise and a
   * completed one look identical to a double that settles instantly, and only a double
   * that can be made slow can tell them apart.
   */
  deferPuts?: boolean;
}

export interface FakeKv {
  readonly ns: KvNamespaceLike;
  /**
  Operation counts, so a test can assert a cache *write* did or did not happen.
  */
  readonly calls: { get: number; put: number; delete: number; list: number };
  /**
   * The `type` each `get` asked for, in order, so a test can assert a reader stated
   * its decision rather than inheriting the platform's default.
   */
  readonly requestedTypes: Array<'text' | 'arrayBuffer' | undefined>;
  entries(): Map<string, string | ArrayBuffer>;
  /**
  Accepted writes, which is the budget a KV-outage test is really checking.
  */
  writes(): number;
  /**
   * Let every held `put` land, and await them. Paired with `deferPuts`.
   */
  releasePuts(): Promise<void>;
}

/**
A namespace that rejects every call, for "binding present but down".
*/
function deadKv(): KvNamespaceLike {
  const refuse = async (): Promise<never> => {
    throw new Error('KV unavailable');
  };
  return { get: refuse, put: refuse, delete: refuse, list: refuse };
}

/**
 * The bytes a stored value carries, whatever type it was written as.
 */
function storedBytes(value: string | ArrayBuffer): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
}

/**
 * What the platform returns for a `get` that did not ask for bytes.
 *
 * A lossy UTF-8 decode, exactly as workerd performs it: a sequence that is not valid
 * UTF-8 becomes U+FFFD rather than an error, so binary data comes back *changed* and
 * nothing throws. This is the behaviour a byte-exact double cannot reproduce, and a
 * caller must therefore be able to run straight into it.
 */
function asText(value: string | ArrayBuffer): string {
  return new TextDecoder().decode(storedBytes(value));
}

function fakeKv(initial: Record<string, string> = {}, options: FakeKvOptions = {}): FakeKv {
  const store = new Map<string, string | ArrayBuffer>(Object.entries(initial));
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  const requestedTypes: Array<'text' | 'arrayBuffer' | undefined> = [];
  const held: Array<() => void> = [];
  let acceptedWrites = 0;

  const refuse = async (): Promise<never> => {
    throw new Error('KV unavailable');
  };

  const ns: KvNamespaceLike = {
    async get(key: string, type?: 'text' | 'arrayBuffer'): Promise<string | ArrayBuffer | null> {
      calls.get += 1;
      requestedTypes.push(type);
      if (options.failAll || options.failReads) return await refuse();
      const value = store.get(key);
      if (value === undefined) return null;
      // `'arrayBuffer'` is the only path that returns bytes. Anything else — including
      // the platform's default, which is `'text'` — goes through the lossy decode, so a
      // `getBytes` that forgets the type reads a corrupted value here exactly as it does
      // in production.
      return type === 'arrayBuffer' ? storedBytes(value).slice().buffer : asText(value);
    },
    async put(key: string, value: string | ArrayBuffer): Promise<void> {
      calls.put += 1;
      if (options.failAll) return await refuse();
      // Held when `deferPuts` is set, so a caller that does not await its write is
      // observable: the entry is absent, and `releasePuts()` is what makes it appear.
      if (options.deferPuts === true) await new Promise<void>((resolve) => held.push(resolve));
      store.set(key, value);
      acceptedWrites += 1;
    },
    async delete(key: string): Promise<unknown> {
      calls.delete += 1;
      return options.failAll ? await refuse() : store.delete(key);
    },
    async list(listing: KvListOptions): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
      calls.list += 1;
      if (options.failAll) return await refuse();
      const keys = [...store.keys()].filter((key) => key.startsWith(listing.prefix)).map((name) => ({ name }));
      return { keys: listing.limit === undefined ? keys : keys.slice(0, listing.limit), list_complete: true };
    },
  };

  return {
    ns,
    calls,
    requestedTypes,
    entries: () => new Map(store),
    writes: () => acceptedWrites,
    // Resolving the gates and then yielding once is enough: the waiting `put` bodies
    // resume on the microtask queue and `store.set` on the tick after this returns.
    releasePuts: async () => {
      for (const release of held.splice(0)) release();
      await Promise.resolve();
    },
  };
}

export { deadKv, fakeKv };
