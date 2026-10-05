/**
 * Building the `applyMetadata` patch.
 *
 * ### Why this is a function and not an inline loop
 *
 * `applyMetadata` assembles a `SET` clause from whatever fields the caller supplied, and
 * every field is optional. Three rules govern that assembly, and all three have bitten:
 *
 * - **Absent means "leave alone", not "clear".** A format with no comment block must not
 *   erase the metadata a previous read found, and — because `upsertFileFacts` now
 *   derives `album`/`artist` from the path — must not erase the derived fallback either.
 *   That fallback is what keeps a track in `getArtists` and `getAlbumList2` until a real
 *   tag replaces it, so clearing it drops the track out of every group.
 * - **A text column and its `_ci` twin move together, or not at all.** A `_ci` column
 *   that drifts from its counterpart is an ungroupable row, and the drift is invisible
 *   until somebody browses by artist or searches for the track.
 * - **Writing a grouping column clears `grouping_source`.** The third writer of the
 *   grouping's provenance, and the one that has to: a tag write that left the flag
 *   standing would leave the row looking like a guess, and the next `derived_version`
 *   bump would replace a real `ALBUMARTIST` with a folder name. See below.
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
 * The metadata fields whose value can come from a file's tags rather than from the path
 * convention.
 *
 * `SongMetadataInput`'s **own** spelling, not the column's, because this list indexes the
 * input to decide whether provenance changed — and the input is camelCase while the columns are
 * not. A SQL column name here would silently match nothing, which is the one outcome that
 * would look like a correct test.
 *
 * `title` is absent because it is never derived, and `genre` because a guessed genre is one
 * this product refuses to publish — so neither can be "replaced by a derivation" and neither
 * has any provenance to clear.
 */
const GROUPING_FIELDS = ['artist', 'album', 'albumArtist'] as const;

/**
 * Build the patch for a partial metadata update.
 *
 * Returns empty assignments for a metadata object with no defined fields, which the caller must
 * treat as "nothing to write" rather than issuing an empty `UPDATE` — on D1 that is a round trip
 * for no change, and a round trip against the daily allowance.
 *
 * ### Clearing `grouping_source` is part of writing a grouping column
 *
 * `grouping_source` records that no tag has written this row's `artist`/`album`/
 * `album_artist`, and the backfill's guard reads it to decide whether it may replace a
 * stored value. So a tag write that left the flag standing would leave the row looking
 * like a guess, and the next `derived_version` bump would overwrite a real `ALBUMARTIST`
 * with a folder name — silent, and correct in the tests that do not bump a version.
 *
 * It is cleared whenever *any* of the three moves, which is the conservative direction:
 * a partial tag read — a file with `ALBUM` and no `ALBUMARTIST` — leaves the row
 * un-flagged, so a later correction of the convention may not rewrite the derivation-owned
 * `album_artist`. That costs a correction reaching one column and buys a correction never
 * clobbering a tag. See `groupingSource.ts`.
 *
 * Cleared to SQL `NULL` rather than to the empty string, so the flag has exactly two
 * states and an absent one is not a third.
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

  let wroteGrouping = false;
  pushText('title', metadata.title);
  pushText('artist', metadata.artist);
  pushText('album', metadata.album);
  pushText('album_artist', metadata.albumArtist);
  pushText('genre', metadata.genre);
  for (const field of GROUPING_FIELDS) {
    if (metadata[field] !== undefined) wroteGrouping = true;
  }
  if (wroteGrouping) {
    assignments.push('grouping_source = ?');
    values.push(null);
  }
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

/**
 * What one metadata write changed, and what it cost against the daily row-write allowance.
 *
 * `changes` is 0 or 1 — one `WHERE id = ?` — and distinguishes "the statement ran and matched
 * nothing" from "it ran and wrote a row": what the caller needs to know whether the row it meant to
 * enrich actually moved.
 *
 * `billedRows` is ten per changed row, and is the number D1's daily allowance is denominated in —
 * the row plus every index entry the write rewrote. It lives beside the patch builder because both
 * are about *this* statement: the builder says which columns move, and this says what they cost.
 */
interface MetadataWriteResult {
  readonly changes: number;
  readonly billedRows: number;
}

/**
 * A call that supplied nothing to write, so "wrote nothing" is one value rather than a branch at
 * every call site. Same reasoning as the empty patch above: the absence is the same absence however
 * it is spelled.
 */
const NO_METADATA_WRITE: MetadataWriteResult = { changes: 0, billedRows: 0 };

export { buildMetadataPatch, GROUPING_FIELDS, SCALAR_COLUMNS, NO_METADATA_WRITE };
export type { MetadataPatch, MetadataWriteResult };
