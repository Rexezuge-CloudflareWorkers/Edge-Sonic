// Single-KV keyspace: one `CACHE` binding, domains separated by key prefix.
//
// Rationale: D1 is the source of truth for everything, including the library
// index. KV is a loss-tolerant, read-heavy cache only — a miss, an eviction, a
// throwing read, or an absent binding must always be recoverable by recomputing
// from D1. Call sites never touch `env.CACHE` directly; they go through
// `KvCache` with a closed `KvDomainName` registry so prefixes cannot collide and
// TTL/size policy lives in one table.
//
// ## What is the kit's, and what is this repo's
//
// **The machinery is `@rexezuge/runtime`'s.** `KvCache` — the fail-soft guard,
// the circuit breaker, the subrequest charge, the binary entries with their
// etag — comes from the kit, as do `buildKvKey`, `clampTtl`, `digest128`,
// `sanitizeSegment`, `utf8ByteLength` and the three key-format constants.
//
// **The table below is this repo's**, and it is passed to the kit rather than
// taken from it. The kit's three shared domains (`session`, `asset`,
// `metadata`) are the right default for a repo whose cache vocabulary matches
// them, but a TTL is per-repo by definition: `songMeta` is keyed by the file's
// own mtime and lasts a week, while `metadata` is invalidated on mutation and
// lasts two minutes. Adopting the shared table under these names would silently
// turn a week-long cache into a two-minute one — a hundred extra origin reads a
// day for every library, with no error anywhere.
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
// Every live domain keys on the file's own mtimeMs+size, so a re-tagged track's
// entry becomes unreachable when the file moves, while a rescan that finds
// nothing new leaves every entry valid. `songLyrics` extends that key with the
// chosen sidecar's revision and the lyrics reader's version, because its answer
// can come from a different file than the track. A future aggregate-caching
// domain must take scan_state.index_version as its first key part so superseded
// entries go structurally unreachable.

import type { KvDomains } from '@rexezuge/runtime';

type KvDomainName = 'songMeta' | 'albumArt' | 'songLyrics' | 'entityInfo';

const KV_DOMAINS: KvDomains<KvDomainName> = {
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
  // Lyrics text, from a sidecar or the track's own tags.
  //
  // Keyed like `albumArt` — the song's and the chosen sidecar's revisions, plus the lyrics
  // reader's version — because lyrics are re-derived from the origin and never written to
  // D1. 64 KiB holds several thousand lines; a value over it is a lyric file this cache
  // declines to store rather than one the endpoint fails to serve. The negative answer is
  // the same payload with no lines, which is what keeps an instrumental from re-reading
  // every folder on every play.
  songLyrics: {
    ttlSeconds: 2_592_000,
    maxValueBytes: 64 * 1024,
    description: 'Lyrics text for one song, keyed by the song and sidecar revisions.',
  },
  // Album notes and artist biographies read from a track's tags, for the four info
  // endpoints. Never written to D1, so the key carries the info reader's version rather
  // than the row's: a corrected extractor makes superseded entries unreachable without
  // re-reading the whole library. A prose comment is bounded well below 64 KiB.
  entityInfo: {
    ttlSeconds: 2_592_000,
    maxValueBytes: 64 * 1024,
    description: 'Album and artist info read from a track tags, keyed by the file revision.',
  },
};

export { KV_DOMAINS };
export type { KvDomainName };
export { type KvDomainDef } from '@rexezuge/runtime';
