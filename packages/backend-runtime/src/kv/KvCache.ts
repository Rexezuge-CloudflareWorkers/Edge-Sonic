/**
 * The `CACHE` KV binding, and the only place in Edge-Sonic that talks to it.
 *
 * ### KV is a cache. Never a source of truth.
 *
 * Everything in here is reconstructible from D1 plus a `PROPFIND`. That is the
 * property that lets the server answer identically when the binding is absent,
 * when a read throws, or when the whole namespace is down — and it is asserted
 * by `test/kv-outage.test.ts`, not just documented.
 *
 * ### What is the kit's, and what is this repo's
 *
 * **`KvCache` itself is `@rexezuge/runtime`'s**, and with it the fail-soft guard,
 * the circuit breaker, the subrequest charge, and both binary paths —
 * `getBinary`/`putBinary` for an entry carrying etag metadata, and
 * `getBytes`/`putBytes` for one that does not. That second pair is the reason
 * this module can be a re-export rather than a fork: artwork and tag caches hold
 * derived bytes with no upstream entity to quote an etag for, so their entries
 * legitimately carry no metadata.
 *
 * **The domain table is this repo's**, in `KvDomains.ts`, and it is passed to
 * the kit's constructor. `songMeta` is keyed by the file's own mtime and lasts a
 * week; the kit's `metadata` domain lasts two minutes. Adopting the kit's table
 * under these names would silently turn a week-long cache into a two-minute one —
 * a hundred extra origin reads a day per library, with no error anywhere.
 *
 * ### The circuit breaker is not optional
 *
 * A fail-soft wrapper alone is not enough. "Fail soft" protects correctness, but
 * if the namespace is *hanging* rather than erroring, every read still pays a
 * timeout — burning the request's subrequest budget and wall clock, and making
 * the server slower precisely when it is already degraded. The breaker opens
 * after `FAILURE_THRESHOLD` consecutive failures, fails fast while open, and
 * half-opens after `COOLDOWN_MS` so a recovered namespace is picked up without a
 * restart. It lives in the kit; it was written here first.
 *
 * ### Writes are budgeted
 *
 * KV's free plan allows 1,000 writes and 1,000 deletes per day against 100,000
 * reads. Nothing in this codebase invalidates by delete: cache keys embed the
 * library's `index_version`, so a superseded entry becomes unreachable on its
 * own and ages out by TTL. See `scan_state.index_version`.
 *
 * ### Test-only, and it used to claim otherwise
 *
 * `purgePrefix`'s old note said it "exists for the admin 'forget this library'
 * operation". There is no such operation: `/user` has no route that purges. The
 * claim was doing real work — it read as a decision already taken, so the absence
 * of a caller looked like a missing feature rather than dead code. It is kept
 * because the paging restart is the part that is easy to get wrong, and deleting
 * while a positional cursor advances silently skips keys.
 */
import { KvCache as KitKvCache } from '@rexezuge/runtime';
import type { KvNamespaceLike, SubrequestMeterLike } from '@rexezuge/runtime';
import { KV_DOMAINS } from './KvDomains';
import type { KvDomainName } from './KvDomains';

/**
 * A `KvCache` over this repo's own keyspace.
 *
 * A factory rather than a subclass, and that is the load-bearing choice. The kit
 * is generic over its domain table, so the type has to be pinned somewhere; a
 * subclass that pinned it inherited every method with the type argument bound,
 * and a *class* consumers wrote `new KvCache(...)` against. A factory makes the
 * binding explicit at the one place it happens, and a caller cannot construct the
 * kit's class without also passing the registry — which is the shape in which a
 * cache reads under one policy and reports another.
 */
type KvCache = KitKvCache<KvDomainName>;

/**
 * Build the invocation's cache.
 *
 * @param namespace The binding, or `null` for a deployment without one.
 * @param meter The invocation's subrequest counter. A KV `get`/`put`/`delete` is
 *   a subrequest like any other — D1's limits page counts *queries* per
 *   invocation and the Workers page counts subrequests to KV — so a cache that
 *   is invisible to the ceiling makes every number that budgets work wrong. It
 *   used to be exactly that: `KvCache` charged nothing, `ScanBudget` counted only
 *   `fetch`, and a cold scan chunk spent 20 KV reads per folder on a budget that
 *   had no idea. See `docs/issues/free-plan-subrequest-ceiling.md`.
 */
function createKvCache(namespace?: KvNamespaceLike | null, meter?: SubrequestMeterLike): KvCache {
  return new KitKvCache<KvDomainName>(namespace, meter, KV_DOMAINS);
}

export { COOLDOWN_MS, FAILURE_THRESHOLD, resetBreakerForTests } from '@rexezuge/runtime';
export { createKvCache };
export type { KvCache };
export type { KvNamespaceLike, KvPutOptions } from '@rexezuge/runtime';
