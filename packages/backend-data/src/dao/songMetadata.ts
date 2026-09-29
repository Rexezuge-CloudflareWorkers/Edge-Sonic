/**
 * Building the `applyMetadata` patch.
 *
 * ### Why this is a function and not an inline loop
 *
 * `applyMetadata` assembles a `SET` clause from whatever fields the caller supplied, and
 * every field is optional. Two rules govern that assembly, and both have bitten:
 *
 * - **Absent means "leave alone", not "clear".** A format with no comment block must not
 *   erase the metadata a previous read found, and — because `upsertFileFacts` now
 *   derives `album`/`artist` from the path — must not erase the derived fallback either.
 *   That fallback is what keeps a track in `getArtists` and `getAlbumList2` until a real
 *   tag replaces it, so clearing it drops the track out of every group.
 * - **A text column and its `_ci` twin move together, or not at all.** A `_ci` column
 *   that drifts from its counterpart is an ungroupable row, and the drift is invisible
 *   until somebody browses by artist or searches for the track.
 *
 * Written here rather than inline so the column list and the shape it targets are read
 * together — the reason `SongMetadataInput` lives beside the statement in `songSql.ts`,
 * and the reason this sits beside the builder that consumes it.
 */
import type { SongMetadataInput } from './songSql';

/**
 * The `SET` clause and its bound values, in the order they were pushed.
 *
 * Order matters: the values array and the `?` placeholders are positional, so building
 * them in one pass is what keeps them aligned. A field added in one list and not the
 * other is a wrong value written to the wrong column, with no error.
 */
interface MetadataPatch {
  readonly assignments: readonly string[];
  readonly values: readonly unknown[];
}

/**
 * The scalar columns, in the order they are written.
 *
 * An ordered list rather than a set, so the generated `SET` clause is byte-stable and a
 * diff of it is readable. `duration` and `bitrate` are here for the same reason the
 * others are: both are `NOT NULL` in the schema, so an unreadable value is `0` rather
 * than null, and the *caller* cannot be trusted to know which columns those are.
 */
const SCALAR_COLUMNS = ['track', 'disc', 'year', 'duration', 'bitrate', 'sample_rate', 'channels', 'reader_version'] as const;

/**
 * Build the patch for a partial metadata update.
 *
 * Returns empty assignments for a metadata object with no defined fields, which the
 * caller must treat as "nothing to write" rather than issuing an empty `UPDATE` — a
 * statement that writes no columns still costs a row from a 5,000/day allowance on some
 * paths, and on D1 it is a round trip for no change.
 */
function buildMetadataPatch(metadata: SongMetadataInput): MetadataPatch {
  const assignments: string[] = [];
  const values: unknown[] = [];

  /**
   * A scalar column. `undefined` is skipped — see the module note.
   */
  const push = (column: string, value: string | number | null | undefined): void => {
    if (value === undefined) return;
    assignments.push(`${column} = ?`);
    values.push(value);
  };

  /**
   * A text column **and its `_ci` twin**, in the same statement.
   *
   * The twin is the reason this is one function rather than six call sites: a caller
   * that pushed only the display column would produce a row that displays correctly
   * and cannot be found by any query, and the drift is invisible until somebody searches
   * for the exact track that is missing.
   *
   * A `null` writes NULL to both. An empty string is *not* normalized to null: it is a
   * value the file supplied, and the aggregates filter on `<> ''` themselves.
   */
  const pushText = (column: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    assignments.push(`${column} = ?`, `${column}_ci = ?`);
    values.push(value, value === null ? null : value.toLowerCase());
  };

  pushText('title', metadata.title);
  pushText('artist', metadata.artist);
  pushText('album', metadata.album);
  pushText('album_artist', metadata.albumArtist);
  pushText('genre', metadata.genre);
  // `reader_version` is written through the same `push` as every other scalar, and in
  // the same statement as the values, because a row whose `enriched_at` moved without it
  // is a row no future reader can tell apart from a current one.
  const scalars: Record<(typeof SCALAR_COLUMNS)[number], unknown> = {
    track: metadata.track,
    disc: metadata.disc,
    year: metadata.year,
    duration: metadata.duration,
    bitrate: metadata.bitrate,
    sample_rate: metadata.sampleRate,
    channels: metadata.channels,
    reader_version: metadata.readerVersion,
  };
  for (const column of SCALAR_COLUMNS) push(column, scalars[column] as string | number | null | undefined);

  return { assignments, values };
}

export { buildMetadataPatch, SCALAR_COLUMNS };
export type { MetadataPatch };
