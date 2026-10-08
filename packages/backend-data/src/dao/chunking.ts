/**
 * Chunking for `IN (...)` binding.
 *
 * Its own module because it is not a `SongDAO` concern: `PlaylistDAO` and `SongIndexDAO`
 * need it too, and importing it *from* `SongDAO` would make the dependency point at the
 * wrong file. The chunk size is D1's measured 100-parameter ceiling (see `sqlLimits.ts`),
 * not SQLite's default and not a batching preference.
 */
/**
 * Split `items` into consecutive slices of at most `size`.
 *
 * `size <= 0` **throws** rather than looping. `index += size` never advances when `size` is 0, so
 * the original body spun for ever and grew an unbounded array — in a Durable Object or a Workflow,
 * which is the worst place to hang. The sibling guard already existed in `sqlLimits.ts`
 * (`if (varsPerRow < 1) throw new RangeError(...)`), so the one function that would *hang* rather
 * than throw was the one that lacked a check.
 *
 * `bindChunkSize` is what every caller passes and it floors at 1, so this is a latent guard rather
 * than a reachable defect today — which is the only reason it is cheap to add and the reason it is
 * worth adding: the bound a call site *could* remove is the one nothing exercises until it is gone.
 */
function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunkArray: size must be a positive integer (got ${String(size)}).`);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}


export { chunkArray };
