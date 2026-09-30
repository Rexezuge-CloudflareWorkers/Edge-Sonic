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
 * ### The circuit breaker is not optional
 *
 * A fail-soft wrapper alone is not enough. "Fail soft" protects correctness, but
 * if the namespace is *hanging* rather than erroring, every read still pays a
 * timeout — burning the request's subrequest budget and wall clock, and making
 * the server slower precisely when it is already degraded. The breaker opens
 * after `FAILURE_THRESHOLD` consecutive failures, fails fast while open, and
 * half-opens after `COOLDOWN_MS` so a recovered namespace is picked up without a
 * restart.
 *
 * ### Writes are budgeted
 *
 * KV's free plan allows 1,000 writes and 1,000 deletes per day against 100,000
 * reads. Nothing in this codebase invalidates by delete: cache keys embed the
 * library's `index_version`, so a superseded entry becomes unreachable on its
 * own and ages out by TTL. See `scan_state.index_version`.
 */
import { createLogger } from '../logger';
import { KV_DOMAINS, buildKvKey, clampTtl, utf8ByteLength } from './KvDomains';
import type { KvDomainName } from './KvDomains';

const logger = createLogger('KvCache');

/**
Consecutive failures before the breaker opens.
*/
const FAILURE_THRESHOLD = 3;

/**
How long the breaker stays open before a half-open probe.
*/
const COOLDOWN_MS = 5000;

interface KvListPage {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}

interface KvNamespaceLike {
  // Both widened from `string` for `albumArt`, which stores image bytes. The real
  // binding has always accepted and returned both; the narrow signature was this
  // file's assumption, not the platform's, and it is the same class of mistake as a
  // test double modelling *an* implementation of the platform.
  get(key: string): Promise<string | ArrayBuffer | null>;
  put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<KvListPage>;
}

interface KvPutOptions {
  ttlSeconds?: number;
}

const PURGE_LIST_LIMIT = 1000;
const PURGE_MAX_PAGES = 10;

/**
 * Per-isolate breaker state.
 *
 * Module-level rather than per-instance on purpose: the binding is process-wide,
 * so a namespace that is down for one `KvCache` is down for all of them, and a
 * per-instance breaker would give every request scope its own three failures to
 * get through before the fast path engaged.
 */
let consecutiveFailures = 0;
let breakerOpenedAt = 0;

/**
Test seam: force the breaker closed and forget the failure count.
*/
function resetBreakerForTests(): void {
  consecutiveFailures = 0;
  breakerOpenedAt = 0;
}

/**
True while the breaker is open, i.e. calls should be skipped entirely.
*/
function isCircuitOpen(now: number): boolean {
  if (breakerOpenedAt === 0) return false;
  if (now - breakerOpenedAt < COOLDOWN_MS) return true;
  // Cooldown elapsed: allow exactly one probe through by reopening the window.
  breakerOpenedAt = 0;
  consecutiveFailures = FAILURE_THRESHOLD - 1;
  return false;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  breakerOpenedAt = 0;
}

function recordFailure(): void {
  consecutiveFailures += 1;
  if (!(consecutiveFailures >= FAILURE_THRESHOLD && breakerOpenedAt === 0)) {
    return;
  }

  breakerOpenedAt = Date.now();
  logger.warn(`KV circuit opened after ${FAILURE_THRESHOLD} consecutive failures; serving from D1 until it recovers.`);
}

class KvCache {
  constructor(private readonly namespace?: KvNamespaceLike | null) {}

  /**
   * Whether the binding is present.
   *
   * Distinct from "healthy": a present binding can still be failing, and that is
   * the case the breaker exists for. Callers must not branch on this to decide
   * whether they may read D1 — they read D1 regardless.
   */
  public get available(): boolean {
    return !!this.namespace;
  }

  /**
   * Run a KV operation under the breaker.
   *
   * Never throws and never returns a rejection: every failure path is a `null`
   * or `false`, which callers read as "miss" or "not stored".
   */
  private async guard<T>(operation: string, run: () => Promise<T>, fallback: T): Promise<T> {
    const ns = this.namespace;
    if (!ns) return fallback;
    if (isCircuitOpen(Date.now())) return fallback;
    try {
      const result = await run();
      recordSuccess();
      return result;
    } catch (error) {
      recordFailure();
      logger.debug(`KV ${operation} failed, serving from D1: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  }

  public async getText(domain: KvDomainName, parts: readonly string[]): Promise<string | null> {
    return await this.guard(
      'get',
      async () => {
        const raw = await this.namespace!.get(buildKvKey(domain, parts));
        if (raw === null || raw === undefined) return null;
        // Only reachable if bytes were stored under a text key. Decoding is the right
        // answer rather than throwing: the caller reads this as a cache, and a corrupt
        // cache entry should cost a recompute, not a failed request.
        return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      },
      null,
    );
  }

  /**
   * A cached binary value, or `null`.
   *
   * Separate from `getText` rather than a flag on it because a base64 round trip is
   * not free: artwork is routinely 500 KB, and encoding it to text to cache it would
   * cost a third more memory on the way in and on the way out, for every cover, on
   * every request that missed the client's own cache.
   */
  public async getBytes(domain: KvDomainName, parts: readonly string[]): Promise<Uint8Array | null> {
    return await this.guard(
      'get',
      async () => {
        const raw = await this.namespace!.get(buildKvKey(domain, parts));
        if (raw === null || raw === undefined) return null;
        return typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
      },
      null,
    );
  }

  /**
   * Cache a binary value.
   *
   * @returns `false` when it was not stored — no binding, an open circuit, or a value
   *   over the domain's `maxValueBytes`. Never throws, and a `false` is a miss the
   *   next read re-derives from the origin.
   */
  public async putBytes(domain: KvDomainName, parts: readonly string[], value: Uint8Array, options?: KvPutOptions): Promise<boolean> {
    const ns = this.namespace;
    if (!ns) return false;
    const definition = KV_DOMAINS[domain];
    if (!definition) return false;
    if (value.byteLength > definition.maxValueBytes) {
      logger.debug(`KV put skipped for ${domain}: value exceeds ${definition.maxValueBytes} bytes.`);
      return false;
    }
    const ttl = clampTtl(options?.ttlSeconds, domain);
    return await this.guard(
      'put',
      async () => {
        // A copy, and not a `subarray` view: the caller almost always passes a slice of
        // a much larger read buffer, and handing KV a view would pin the whole buffer
        // for as long as the entry lives.
        const copy = value.slice();
        await ns.put(buildKvKey(domain, parts), copy.buffer, ttl === undefined ? undefined : { expirationTtl: ttl });
        return true;
      },
      false,
    );
  }

  public async putText(domain: KvDomainName, parts: readonly string[], value: string, options?: KvPutOptions): Promise<boolean> {
    const ns = this.namespace;
    if (!ns) return false;
    const definition = KV_DOMAINS[domain];
    if (!definition) return false;
    if (utf8ByteLength(value) > definition.maxValueBytes) {
      logger.debug(`KV put skipped for ${domain}: value exceeds ${definition.maxValueBytes} bytes.`);
      return false;
    }
    const ttl = clampTtl(options?.ttlSeconds, domain);
    return await this.guard('put', async () => {
      await ns.put(buildKvKey(domain, parts), value, ttl === undefined ? undefined : { expirationTtl: ttl });
      return true;
    }, false);
  }

  public async getJson<T>(domain: KvDomainName, parts: readonly string[]): Promise<T | null> {
    const raw = await this.getText(domain, parts);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt value is a miss, not an error: the caller falls back to D1 and
      // the next write repairs it.
      return null;
    }
  }

  public async putJson(domain: KvDomainName, parts: readonly string[], value: unknown, options?: KvPutOptions): Promise<boolean> {
    let raw: unknown;
    try {
      raw = JSON.stringify(value);
    } catch {
      return false;
    }
    return typeof raw === 'string' && this.putText(domain, parts, raw, options);
  }

  public async del(domain: KvDomainName, parts: readonly string[]): Promise<void> {
    const ns = this.namespace;
    if (!ns) return;
    await this.guard('delete', async () => {
      await ns.delete(buildKvKey(domain, parts));
    }, undefined);
  }

  /**
   * Delete every key under a prefix.
   *
   * ### Test-only, and it used to claim otherwise
   *
   * The old note said it "exists for the admin 'forget this library' operation". There is
   * no such operation: `/user` has no route that purges, and `Apps` has no caller. The
   * claim was doing real work — it read as a decision already taken, so the absence of a
   * caller looked like a missing feature rather than dead code.
   *
   * Kept because the semantics are worth having and cheap to keep correct: the paging
   * restart is the part that is easy to get wrong, and deleting while a positional cursor
   * advances silently skips keys.
   */
  public async purgePrefix(domain: KvDomainName, parts: readonly string[] = []): Promise<number> {
    const ns = this.namespace;
    if (!ns) return 0;
    const prefix = parts.length === 0 ? `${domain}:` : buildKvKey(domain, parts);
    const result = await this.guard('purge', async () => {
      let deleted = 0;
      // Restart from the start after each page: deleting while a positional
      // cursor advances would skip keys. Each pass removes a full page, so the
      // loop terminates; the page cap bounds worst-case cost.
      for (let page = 0; page < PURGE_MAX_PAGES; page += 1) {
        const listed = await ns.list({ prefix, limit: PURGE_LIST_LIMIT });
        if (listed.keys.length === 0) return deleted;
        for (const key of listed.keys) {
          await ns.delete(key.name);
          deleted += 1;
        }
        if (listed.keys.length < PURGE_LIST_LIMIT) return deleted;
      }
      return deleted;
    }, 0);
    return result;
  }
}

export { KvCache, resetBreakerForTests, FAILURE_THRESHOLD, COOLDOWN_MS };
export type { KvListPage, KvNamespaceLike, KvPutOptions };
