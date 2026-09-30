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
// ## Invalidation is in the key, never a delete
//
// No domain here is invalidated by a delete, and the reason is the free plan's
// 1,000 writes and 1,000 deletes per day against 100,000 reads. A
// `delete`-then-`put` on a value the re-resolution already produced spends two
// scarce operations per request to move a key to the value it already had, and a
// client that 404s on every inner path used to exhaust a whole day's budget in
// ~40 minutes while answering every request correctly.
//
// ### Two ways to do it, and **no live domain uses either one yet**
//
// The version-in-key rule — a domain that caches a *derived aggregate* takes the
// library's `scan_state.index_version` as its first key part, so a completed scan
// makes every entry written under the old version **structurally unreachable**
// and invalidation costs zero writes at all — was implemented on two domains,
// `libIndex` and `libTree`. Neither had a production caller, so the mechanism had
// no surface: `index_version` is read nowhere in this file or in `KvCache`.
//
// Both domains are removed rather than left to imply a live strategy, and
// `versionScoped` goes with them. What remains is the other rule, and it is the
// one the two live domains use:
//
//   - **`songMeta`** — keyed by the file's `mtimeMs`+`size`, so a re-tagged track's
//     entry becomes unreachable when the file moves.
//   - **`albumArt`** — the same key, for the same reason: re-tagging changes the
//     picture without moving anything else in the library, whereas a rescan that
//     finds nothing new bumps `index_version` and would orphan every cached image
//     for no reason.
//
// So the honest statement today is "invalidation is in the key", and the aggregate
// case is a rule this codebase has *reasoned about* rather than one it exercises. A
// domain that caches a derived aggregate must be `versionScoped: true` and take the
// version as its first part — and `versionScoped` is asserted against the live set
// rather than assumed, so adding a domain cannot quietly opt out of it.

const KV_KEY_VERSION = 'v1';
const KV_MAX_KEY_LENGTH = 512;
const KV_MIN_TTL_SECONDS = 60;

type KvDomainName = 'songMeta' | 'albumArt';

interface KvDomainDef {
  ttlSeconds?: number;
  maxValueBytes: number;
  description: string;
}

const KV_DOMAINS: Record<KvDomainName, KvDomainDef> = {
  // `getSong` enrichment results (duration, bitrate, tags).
  songMeta: {
    ttlSeconds: 604_800,
    maxValueBytes: 4096,
    description: 'Tag enrichment for one song, invalidated by the file mtime rather than by scan version.',
  },
  // Album artwork extracted from a track's own tags.
  //
  // **Not version-scoped, and keyed by the source file's `mtimeMs`+`size` instead** —
  // the `songMeta` rule, not the `libIndex` one. A rescan that finds nothing new bumps
  // `index_version` and would orphan every cached image for no reason, whereas the
  // thing that actually invalidates artwork is the *file* changing: re-tagging a track
  // changes its picture without moving anything else in the library.
  //
  // 8 MiB because this is the one domain holding real payloads. KV's own per-value
  // ceiling is 25 MiB, and a `put` over a domain's `maxValueBytes` is **skipped**
  // rather than attempted — so an unusually large image costs a re-read on the next
  // request instead of a failed write, and never an error.
  //
  // The free plan's 1,000 writes/day is the real constraint: a first full browse of a
  // library larger than that exhausts the day's writes, and `KvCache` fails soft, so
  // the remainder is simply served from the origin on every request. Slower, correct.
  albumArt: {
    ttlSeconds: 2_592_000,
    maxValueBytes: 8 * 1024 * 1024,
    description: 'Album artwork bytes, keyed by the source track path and its mtime/size.',
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
