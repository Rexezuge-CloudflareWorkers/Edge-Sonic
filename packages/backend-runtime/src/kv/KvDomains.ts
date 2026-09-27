// Single-KV keyspace: one `CACHE` binding, domains separated by key prefix.
//
// Rationale: D1 is the source of truth for everything, including the library
// index. KV is a loss-tolerant, read-heavy cache only — a miss, an eviction, a
// throwing read, or an absent binding must always be recoverable by recomputing
// from D1. Call sites never touch `env.CACHE` directly; they go through
// `KvCache` with a closed `KvDomainName` registry so prefixes cannot collide and
// TTL/size policy lives in one table.
//
// The registry is a closed union on purpose: a typo cannot silently create a new
// keyspace, and the TTL/size policy for every cached value lives in one table
// rather than at each call site.
//
// ## Invalidation is version-in-key, never delete
//
// Every domain that caches a *derived aggregate* takes the library's
// `scan_state.index_version` as its first key part. A completed scan increments
// the version, so every entry written under the old version becomes
// structurally unreachable and ages out by TTL. That means:
//
//   - invalidation costs ZERO KV writes and ZERO deletes, against a free plan
//     allowance of 1,000 each per day;
//   - a scan that bumps the version cannot serve a stale aggregate even for a
//     single request, so there is no "eventually consistent" window to reason
//     about;
//   - nothing has to evict-then-restore. A `delete`-then-`put` on a value the
//     re-resolution already produced spends two scarce operations per request to
//     move a key to the value it already had, and a client that 404s on every
//     inner path used to exhaust a whole day's budget in ~40 minutes while
//     answering every request correctly.

const KV_KEY_VERSION = 'v1';
const KV_MAX_KEY_LENGTH = 512;
const KV_MIN_TTL_SECONDS = 60;

type KvDomainName = 'libIndex' | 'libTree' | 'songMeta' | 'authThrottle';

interface KvDomainDef {
  ttlSeconds?: number;
  maxValueBytes: number;
  /**
   * Whether the first key part must be a library `index_version`. Domains that
   * cache a derived aggregate must be `true`; see the version-in-key note above.
   */
  versionScoped: boolean;
  description: string;
}

const KV_DOMAINS: Record<KvDomainName, KvDomainDef> = {
  // `getArtists` / `getAlbumList2` aggregations. Expensive to build and read on
  // every home screen, and stale the moment a scan completes.
  libIndex: {
    ttlSeconds: 3600,
    maxValueBytes: 512 * 1024,
    versionScoped: true,
    description: 'Derived artist and album aggregates for one library, keyed by scan index_version.',
  },
  // `getMusicDirectory` / `getIndexes` folder listings.
  libTree: {
    ttlSeconds: 3600,
    maxValueBytes: 256 * 1024,
    versionScoped: true,
    description: 'Materialized folder listing for one library, keyed by scan index_version.',
  },
  // `getSong` enrichment results (duration, bitrate, tags).
  songMeta: {
    ttlSeconds: 604_800,
    maxValueBytes: 4096,
    versionScoped: false,
    description: 'Tag enrichment for one song, invalidated by the file mtime rather than by scan version.',
  },
  // Auth failure counters.
  authThrottle: {
    ttlSeconds: 900,
    maxValueBytes: 1024,
    versionScoped: false,
    description: 'Failed-authentication counters. Writes ONLY on a failure, so legitimate traffic spends nothing.',
  },
};

function fnv1aHex(input: string): string {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sanitizeSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) throw new Error('KV key segment must not be empty.');
  return encodeURIComponent(trimmed);
}

function buildKvKey(domain: KvDomainName, parts: readonly string[]): string {
  const def = KV_DOMAINS[domain];
  if (!def) throw new Error(`Unknown KV domain: ${domain}.`);
  if (parts.length === 0) throw new Error(`KV domain ${domain} requires at least one key part.`);
  const prefix = `${domain}:${KV_KEY_VERSION}:`;
  const joined = parts.map((part) => sanitizeSegment(part)).join(':');
  const full = prefix + joined;
  if (full.length <= KV_MAX_KEY_LENGTH) return full;
  // Deterministic fallback: a miss just recomputes, so a 32-bit digest is fine.
  return `${prefix}h:${fnv1aHex(joined)}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function clampTtl(ttlSeconds: number | undefined, domain: KvDomainName): number | undefined {
  const effective = ttlSeconds ?? KV_DOMAINS[domain].ttlSeconds;
  if (effective === undefined) return undefined;
  return Number.isFinite(effective) ? Math.max(KV_MIN_TTL_SECONDS, Math.floor(effective)) : undefined;
}

export { KV_DOMAINS, KV_KEY_VERSION, KV_MAX_KEY_LENGTH, KV_MIN_TTL_SECONDS };
export { buildKvKey, clampTtl, fnv1aHex, utf8ByteLength };
export type { KvDomainDef, KvDomainName };
