/**
 * Backfilling the path-derived grouping onto rows the indexer will never touch again.
 *
 * ### The defect this exists for
 *
 * `upsertFileFacts` derives `album`/`artist` from `dir_path`, and that derivation is
 * reachable only for a file that is **new or whose bytes moved**. Every call site gates
 * on change:
 *
 * - `ScanService.start` — a `Depth: 0` root probe whose mtime matches settles the whole
 *   library in one subrequest.
 * - `scanFolder` — `isScanned: !changed`, so an unmoved folder is never opened.
 * - `reconcileFolder` — `if (changed)`, so an unmoved file is never upserted.
 * - `TreeService` — the read-through `getMusicDirectory` path skips a file present in both
 *   listings with an identical mtime.
 *
 * That is correct, and it is the whole point of storing `mtime_ms` in `nodes`. The defect
 * is that it makes the derivation **unreachable for an already-indexed library**, so the
 * aggregates never recover without a file changing. It shipped: 113 rows, every one
 * indexed before the deploy, every one with `album_ci`/`artist_ci` NULL, and
 * `getArtists`/`getAlbumList2`/`getGenres`/`search3` answering `[]`.
 *
 * It was invisible per-track because `rest/mappers.ts` falls back to the folder name when
 * `album` is NULL, so `getRandomSongs` returned rows that *looked* tagged. That fallback is
 * display-only and is a large part of why this took a whole deployment to name: the one
 * endpoint that does not group in SQL was the one that looked healthy.
 *
 * ### Why the selection is on a version and not on NULL
 *
 * Because "the column is NULL" cannot express a **corrected** convention. Once an earlier
 * derivation has written a value the column is no longer NULL, so a later, better
 * `deriveFromPath` could never reach the rows the earlier one wrote. That is the
 * `reader_version` defect one layer down — a fixed reader could not re-read an existing
 * library — and the reason `derived_version` is a column rather than a predicate.
 *
 * ### Why the derivation happens here and not in SQL
 *
 * `dir_path` is already on the row, so this could be one `UPDATE` with `substr`/`instr`.
 * It is deliberately not: that would be a second implementation of `pathConvention.ts`,
 * free to disagree with it over the separator rules and the `(derived)` marker, and a
 * disagreement between two implementations of a naming convention is invisible until a
 * client groups a library wrongly. One implementation, called from here.
 */
import { BaseDAO } from './BaseDAO';
import { deriveFromPath, DERIVED_MARKER, DERIVED_VERSION } from './pathConvention';
import { nowSeconds } from './identity';

/**
 * One row's backfill input.
 *
 * Only the two fields the derivation needs. `dir_path` is the input to
 * `deriveFromPath`; the id is the key to write back. Reading `*` would pull the whole
 * row — including the derived columns this is about to decide — across a page of them.
 */
interface DerivableRow {
  readonly id: string;
  readonly dir_path: string;
}

/**
 * A row and the names derived for it, ready to write.
 *
 * The names are computed by the caller, which is what keeps `pathConvention` the single
 * implementation: this module transports a decision, it does not make one.
 */
interface DerivationWrite {
  readonly id: string;
  readonly artist: string | null;
  readonly album: string | null;
}

/**
 * Write one row's derived grouping.
 *
 * The assignment is a `CASE` on whether the existing value is itself a *guess*, and that
 * distinction is the entire reason `DERIVED_MARKER` is part of the stored value rather
 * than decoration:
 *
 * - **NULL** — nothing has ever grouped this row. Fill it. This is the case that
 *   matters, and the one an already-indexed library is entirely made of.
 * - **Ends in `DERIVED_MARKER`** — an earlier version of this convention wrote it, so
 *   replace it. This is what makes `derived_version` worth having: a plain `COALESCE`
 *   here would re-select the row on a version bump and then decline to change it, which is
 *   a version column that buys nothing, and a *wrong* guess would sit in the column for
 *   ever — the `reader_version` defect verbatim, one layer down.
 * - **Anything else** — a real tag from an enrichment read. Leave it, and leave its `_ci`
 *   twin alone with it.
 *
 * Every `_ci` twin moves in the same statement as its counterpart. A guard on `artist`
 * proves nothing about `artist_ci`, and dropping the handling from only the twins passes
 * every other assertion and yields a row that displays correctly and is in no album list.
 *
 * `derived_version` is stamped in all three cases, including when the values did not
 * change. That is the backfill's only termination condition: a row that keeps
 * re-selecting because its stamp never moved is a backfill that never converges.
 *
 * `updated_at` moves with the stamp, so a library already at the current version issues no
 * write at all and the "unchanged rescan costs zero rows" guarantee holds.
 */
const APPLY_DERIVATION = `UPDATE songs SET
  artist = CASE WHEN artist IS NULL OR artist LIKE ? THEN ? ELSE artist END,
  artist_ci = CASE WHEN artist_ci IS NULL OR artist_ci LIKE ? THEN ? ELSE artist_ci END,
  album = CASE WHEN album IS NULL OR album LIKE ? THEN ? ELSE album END,
  album_ci = CASE WHEN album_ci IS NULL OR album_ci LIKE ? THEN ? ELSE album_ci END,
  album_artist = CASE WHEN album_artist IS NULL OR album_artist LIKE ? THEN ? ELSE album_artist END,
  album_artist_ci = CASE WHEN album_artist_ci IS NULL OR album_artist_ci LIKE ? THEN ? ELSE album_artist_ci END,
  derived_version = ?,
  updated_at = ?
WHERE id = ?`;

class SongDerivationDAO extends BaseDAO {
  /**
   * Rows whose grouping is missing, or was written by an older convention.
   *
   * Ordered by `id` rather than left to the planner so the page is **stable**: a limit
   * without an order can return the same rows twice or skip others entirely between
   * calls, and a backfill that re-reads a row it already wrote is a backfill that never
   * converges.
   */
  public async listNeedingDerivation(libraryId: string, limit: number, version = DERIVED_VERSION): Promise<DerivableRow[]> {
    const result = await this.withRetry(
      async () =>
        await this.database
          .prepare('SELECT id, dir_path FROM songs WHERE library_id = ? AND derived_version < ? ORDER BY id LIMIT ?')
          .bind(libraryId, version, limit)
          .all<DerivableRow>(),
      'songs.listNeedingDerivation',
    );
    return result.results ?? [];
  }

  /**
   * Stamp a batch of rows at `version`, filling the gaps in their grouping.
   *
   * `applyMetadata` is deliberately **not** reused: it stamps `enriched_at`, which is the
   * assertion "this row's facts were read out of these bytes", and claiming it here would
   * tell `EnrichmentService` that a row nothing read is enriched — so a track with no
   * duration would never be range-read on first play. This writes the grouping and the
   * stamp, and nothing else.
   */
  public async applyDerivation(writes: readonly DerivationWrite[], version = DERIVED_VERSION): Promise<number> {
    const timestamp = nowSeconds();
    // The `_ci` twins are matched with the lowercased marker: the comparison is against
    // the *stored* value, which every writer lowercases, so matching the display-case
    // marker here would silently stop recognising derived rows and turn a version bump
    // back into a no-op for exactly the rows it exists to fix.
    const ciMarker = `%${DERIVED_MARKER.toLowerCase()}`;
    const statements = writes.map((write) => {
      const artistCi = write.artist?.toLowerCase() ?? null;
      const albumCi = write.album?.toLowerCase() ?? null;
      return this.database
        .prepare(APPLY_DERIVATION)
        .bind(
          `%${DERIVED_MARKER}`,
          write.artist,
          ciMarker,
          artistCi,
          `%${DERIVED_MARKER}`,
          write.album,
          ciMarker,
          albumCi,
          // `album_artist` mirrors the derived artist: `getArtist` groups on it, so an
          // album with a NULL album-artist column does not appear under the artist a
          // client navigated to.
          `%${DERIVED_MARKER}`,
          write.artist,
          ciMarker,
          artistCi,
          version,
          timestamp,
          write.id,
        );
    });
    // All-or-nothing, unlike the index write. A partially stamped backfill would leave rows
    // that are neither derived nor un-derived, and the selection is on `derived_version` — so
    // the ones that were stamped would never be revisited and the rest would be re-derived on
    // every poll, for ever. Refusing costs one poll; truncating costs a scan that never
    // converges.
    const written = await this.runWriteBatch(statements, 'songs.applyDerivation', { requireComplete: true });
    return written.changes;
  }

  /**
   * The names `pathConvention` derives for these rows.
   *
   * A method rather than a bare `map` at the call site so the pairing of "read a page"
   * with "derive a page" cannot be half-done: a caller that derived some rows and not
   * others would write a stamp on rows it never decided anything about.
   */
  public static deriveFor(rows: readonly DerivableRow[]): DerivationWrite[] {
    return rows.map((row) => {
      const { artist, album } = deriveFromPath(row.dir_path);
      return { id: row.id, artist, album };
    });
  }
}

export { SongDerivationDAO, APPLY_DERIVATION };
export type { DerivableRow, DerivationWrite };
