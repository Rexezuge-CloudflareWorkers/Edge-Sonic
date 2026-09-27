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

interface FakeKvOptions {
  /** Make every operation reject, modelling a namespace that is down. */
  failAll?: boolean;
  /** Make only reads fail — the "reads time out, writes are fine" case. */
  failReads?: boolean;
}

interface FakeKv {
  readonly ns: KvNamespaceLike;
  /** Operation counts, so a test can assert a cache *write* did or did not happen. */
  readonly calls: { get: number; put: number; delete: number; list: number };
  entries(): Map<string, string>;
  /** Accepted writes, which is the budget a KV-outage test is really checking. */
  writes(): number;
}

/** A namespace that rejects every call, for "binding present but down". */
function deadKv(): KvNamespaceLike {
  const refuse = async (): Promise<never> => {
    throw new Error('KV unavailable');
  };
  return { get: refuse, put: refuse, delete: refuse, list: refuse };
}

function fakeKv(initial: Record<string, string> = {}, options: FakeKvOptions = {}): FakeKv {
  const store = new Map<string, string>(Object.entries(initial));
  const calls = { get: 0, put: 0, delete: 0, list: 0 };
  let acceptedWrites = 0;

  const refuse = async (): Promise<never> => {
    throw new Error('KV unavailable');
  };

  const ns: KvNamespaceLike = {
    async get(key: string): Promise<string | null> {
      calls.get += 1;
      if (options.failAll || options.failReads) return await refuse();
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      calls.put += 1;
      if (options.failAll) return await refuse();
      store.set(key, value);
      acceptedWrites += 1;
    },
    async delete(key: string): Promise<unknown> {
      calls.delete += 1;
      if (options.failAll) return await refuse();
      return store.delete(key);
    },
    async list(options: { prefix: string; limit?: number }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
      calls.list += 1;
      if (options.failAll) return await refuse();
      const keys = [...store.keys()].filter((key) => key.startsWith(options.prefix)).map((name) => ({ name }));
      return { keys: options.limit === undefined ? keys : keys.slice(0, options.limit), list_complete: true };
    },
  };

  return { ns, calls, entries: () => new Map(store), writes: () => acceptedWrites };
}

export { fakeKv, deadKv };
export type { FakeKv, FakeKvOptions };
