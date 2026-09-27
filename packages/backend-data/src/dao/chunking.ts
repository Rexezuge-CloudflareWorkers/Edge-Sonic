/**
 * Chunking for `IN (...)` binding.
 *
 * Its own module because it is not a `SongDAO` concern: `PlaylistDAO` and `SongIndexDAO`
 * need it too, and importing it *from* `SongDAO` would make the dependency point at the
 * wrong file. The chunk size is SQLite's variable count, not a batching preference.
 */
function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}


export { chunkArray };
