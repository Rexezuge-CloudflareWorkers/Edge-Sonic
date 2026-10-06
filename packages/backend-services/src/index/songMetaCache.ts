/**
 * What a `songMeta` cache entry holds, and the one question asked about it.
 *
 * ### Why this is its own module
 *
 * The entry's **shape** and the **completeness test** are one decision, and they were
 * both inside `EnrichmentService`, which is why the completeness rule went in without
 * being read next to the shape it is about: a cache entry recording `durationSeconds:
 * null` is not an answer, and nothing about the type says so.
 *
 * It is also the third thing that answers "has this file already been read?", so it
 * belongs beside the other two rather than inside the service that happens to consult it:
 * `shouldEnrich` asks it of a **row** (`enrichmentRetry.ts`), and this asks it of a
 * **cache entry**, and both must say yes for the same file or one of the two is stale.
 * `EnrichmentService` consults the cache *before* the row, so an entry that disagreed
 * with the row's own stamp would decide the answer alone.
 */

/**
 * Cached enrichment, keyed by song id and validated by the file's mtime.
 */
interface CachedEnrichment {
  readonly mtimeMs: number;
  /**
   * Which reader produced this entry. Part of the entry rather than implied by it: an
   * entry written by a reader that could not read something a later reader can is not a
   * value this reader may skip a read for, and the mtime cannot say so — the file really
   * did not move.
   */
  readonly readerVersion: number;
  readonly durationSeconds: number | null;
  readonly bitrateKbps: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly container: string;
}

/**
 * Whether a `songMeta` entry is an **answer**, rather than an absence recorded as one.
 *
 * ### Why `null` is not an answer
 *
 * A cached entry exists so the next `getSong` can skip a read. An entry whose
 * `durationSeconds` is `null` skips a read to produce `null` again — and it does so
 * *forever*, because the entry matches on `mtimeMs` and `readerVersion`, neither of
 * which changes when the thing that made it null goes away. For an Ogg library that is
 * not hypothetical: the prefix read reports no duration **by design** and only the tail
 * read supplies one, so a tail that was refused — or a deployment running with
 * `TAG_READ_TAIL_BYTES=0` — wrote an entry that permanently answered "no duration" for
 * that file's mtime. Raising the setting afterwards changed nothing, because the entry
 * still matched.
 *
 * That is the negative-cache defect from `docs/agents/media/AGENTS.md` — *"we looked and
 * there is nothing" versus "we could not look"* — in the one cache whose entries are
 * written **before** anybody knows whether the answer is complete.
 *
 * ### Why both the writer and the reader ask
 *
 * The writer does not produce one, and the reader does not trust one. Only the second
 * half repairs a deployment that already holds the first's output: an entry written
 * before this rule existed still matches, and nothing else would ever invalidate it — a
 * `reader_version` bump happens by hand, and only on the next change to the reader.
 *
 * ### And the tags in such an entry are still real
 *
 * The incompleteness is `durationSeconds` alone. A file whose comment block was read
 * from the prefix and whose duration was not resolved is the **most** enriched row there
 * is — the artist, album and genre are there — so the row is written in full and only the
 * cache declines to remember it. Discarding the whole result would throw away a correct
 * answer to make room for a retry of the one value that is missing.
 */
function isCompleteEnrichment(entry: CachedEnrichment): boolean {
  return entry.durationSeconds !== null && entry.durationSeconds > 0;
}

export { isCompleteEnrichment };
export type { CachedEnrichment };