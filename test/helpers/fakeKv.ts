/**
 * KV doubles.
 *
 * A KV namespace is *exactly* modelable, which is what makes it worth a double: a
 * Map, a TTL field, and a switch to make every call throw. That last mode is the
 * whole point of `test/kv-outage.test.ts` — the server must answer identically when
 * the cache is absent, throwing, or absent-and-throwing.
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
  entries(): Map<string, string>;
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

function fakeKv(initial: Record<string, string> = {}, options: FakeKvOptions = {}): FakeKv {
  const store = new Map<string, string>(Object.entries(initial));
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  const held: Array<() => void> = [];
  let acceptedWrites = 0;

  const refuse = async (): Promise<never> => {
    throw new Error('KV unavailable');
  };

  const ns: KvNamespaceLike = {
    async get(key: string): Promise<string | null> {
      calls.get += 1;
      return options.failAll || options.failReads ? (await refuse()) : store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
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
      return options.failAll ? (await refuse()) : store.delete(key);
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
