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
 * free to disagree with it over the separator rules and the marker, and a disagreement
 * between two implementations of a naming convention is invisible until a client groups a
 * library wrongly. One implementation, called from here.
 */
import { BaseDAO } from './BaseDAO';
import type { WriteBatchResult } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import { UNMETERED_SUBREQUESTS } from '@edge-sonic/shared';
import type { SubrequestMeter } from '@edge-sonic/shared';
import { deriveFromPath, deriveTitleFromFileName, DERIVED_VERSION } from './pathConvention';
import { GROUPING_SOURCE_DERIVED } from './groupingSource';
import { nowSeconds } from './identity';

/**
 * One row's backfill input.
 *
 * Only the two fields the derivation needs. `dir_path` is the input to `deriveFromPath`;
 * the id is the key to write back. Reading `*` would pull the whole row — including the
 * derived columns this is about to decide — across a page of them.
 */
interface DerivableRow {
  readonly id: string;
  readonly dir_path: string;
  /**
   * The file's own name, suffix included.
   *
   * Read because `title` is derived from it rather than from `dir_path` — the directory
   * answers "which album", and only the file answers "which track". A `DerivableRow`
   * without it could not derive a title, which is the field this backfill exists to
   * repair on the library the version bump was measured against.
   */
  readonly name: string;
}

/**
 * A row and the names derived for it, ready to write.
 *
 * The names are computed by the caller, which is what keeps `pathConvention` the single
 * implementation: this module transports a decision, it does not make one.
 */
interface DerivationWrite {
  readonly id: string;
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
}

/**
 * Write one row's derived grouping.
 *
 * The assignment is a `CASE` on **whether a tag owns this row's grouping**, and that
 * distinction is what decides everything else:
 *
 * - **A gap** — the column is NULL. Fill it. This is the case that matters, and the one
 *   an already-indexed library is entirely made of.
 * - **`grouping_source = 'derived'`** — an earlier version of this convention wrote it, so
 *   replace it. This is what makes `derived_version` worth having: a plain `COALESCE`
 *   here would re-select the row on a version bump and then decline to change it, which is
 *   a version column that buys nothing, and a *wrong* guess would sit in the column for
 *   ever — the `reader_version` defect verbatim, one layer down.
 * - **Anything else** — a real tag from an enrichment read. Leave it, and leave its `_ci`
 *   twin alone with it.
 *
 * The predicate is a **column comparison**, which it used not to be. It was
 * `col LIKE '% (derived)'`, reading the marker back out of the stored value, and that only
 * works while the marker is one hardcoded literal: an empty marker is `'%'` and matches
 * every value — so the backfill overwrote every real `ALBUMARTIST` in the library — and
 * any other marker is a `LIKE` pattern, so `'_ (guess)'` matched nothing and the guard
 * stopped recognising its own guesses. Both measured in `groupingSource.ts`. An operator's
 * marker is now data reaching this statement and nothing here treats it as a pattern.
 *
 * Every `_ci` twin moves in the same statement as its counterpart, with the same predicate.
 * A guard on `artist` proves nothing about `artist_ci`, and dropping the handling from only
 * the twins passes every other assertion and yields a row that displays correctly and is in
 * no album list.
 *
 * `grouping_source` is restated by the same statement, in the same shape as every other
 * assignment and for the same reason: a row whose grouping moved while its provenance did
 * not is a row the next bump will decide wrongly. It becomes `'derived'` when the row
 * already was, or when all three grouping columns were NULL — nothing a tag wrote, which
 * is the definition. It is cleared when a tag owns the row, and the `ELSE` is written as
 * `NULL` rather than as `grouping_source` because that is provably what it is: reaching
 * the `ELSE` means the column was not `'derived'` *and* some column held a value.
 *
 * ### `title` is the one column with no guard, and the one that must not have one
 *
 * Every other assignment above is guarded by `grouping_source`, so a bump *replaces* a value
 * the flag owns and *fills* one it does not. `title` is guarded by `IS NULL` alone, and the
 * flag's own definition below counts three columns rather than four. Both are the same fix:
 * a file whose tags carry a `TITLE` but no `ARTIST`/`ALBUM`/`ALBUMARTIST` was written by a
 * build that cleared the flag only for the three, so it holds a **real tag title** *and*
 * `'derived'` at once — while a tagless enriched file holds a **derived** title *and*
 * `'derived'` at once. Nothing on the row distinguishes the two, so a guarded `title` reads
 * the first as the second's filename guess and overwrites a real tag, permanently, because
 * `enriched_at` is set and the file is then never re-read.
 *
 * Fill-once is the direction to be wrong in. The grouping pays nothing for it; the title
 * pays with a rule that is *not* versioned, so a correction to `deriveTitleFromFileName`
 * cannot reach a title this derivation already wrote and has to be a deliberate decision. A
 * deleted tag is worse than either. `songMetadata.ts` carries the same argument where
 * `GROUPING_FIELDS` is declared, because the flag's meaning is a fact both statements share.
 *
 *
 * `derived_version` is stamped in all three cases, including when the values did not
 * change. That is the backfill's only termination condition: a row that keeps
 * re-selecting because its stamp never moved is a backfill that never converges.
 *
 * `updated_at` moves with the stamp, so a library already at the current version issues no
 * write at all and the "unchanged rescan costs zero rows" guarantee holds.
 *
 * Every `?` is positional, so the bind order below and the placeholder order above are one
 * fact. `GROUPING_SOURCE_DERIVED` is bound eight times rather than interpolated once,
 * because an interpolated string is a place a value becomes syntax, and this module has a
 * configured value reaching the same statement.
 */
const APPLY_DERIVATION = `UPDATE songs SET
  title = CASE WHEN title IS NULL THEN ? ELSE title END,
  title_ci = CASE WHEN title_ci IS NULL THEN ? ELSE title_ci END,
  artist = CASE WHEN grouping_source = ? OR artist IS NULL THEN ? ELSE artist END,
  artist_ci = CASE WHEN grouping_source = ? OR artist_ci IS NULL THEN ? ELSE artist_ci END,
  album = CASE WHEN grouping_source = ? OR album IS NULL THEN ? ELSE album END,
  album_ci = CASE WHEN grouping_source = ? OR album_ci IS NULL THEN ? ELSE album_ci END,
  album_artist = CASE WHEN grouping_source = ? OR album_artist IS NULL THEN ? ELSE album_artist END,
  album_artist_ci = CASE WHEN grouping_source = ? OR album_artist_ci IS NULL THEN ? ELSE album_artist_ci END,
  grouping_source = CASE
    WHEN grouping_source = ? OR (artist IS NULL AND album IS NULL AND album_artist IS NULL) THEN ?
    ELSE NULL END,
  derived_version = ?,
  updated_at = ?
WHERE id = ?`;

class SongDerivationDAO extends BaseDAO {
  /**
   * The marker this DAO appends to a derived name, from the deployment's configuration.
   *
   * Injected rather than imported because `backend-data` is layer 0 and the configuration
   * layer sits above it, and read once at construction rather than per call because the
   * value is the same for the whole request and a derivation that used two markers inside
   * one page would write a grouping split across both spellings.
   */
  constructor(database: D1Queryable, private readonly derivedMarker: string, subrequests: SubrequestMeter = UNMETERED_SUBREQUESTS) {
    super(database, subrequests);
  }

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
          .prepare('SELECT id, dir_path, name FROM songs WHERE library_id = ? AND derived_version < ? ORDER BY id LIMIT ?')
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
  public async applyDerivation(writes: readonly DerivationWrite[], version = DERIVED_VERSION): Promise<WriteBatchResult> {
    if (writes.length === 0) return { changes: 0, written: 0, truncated: false, billedRows: 0 };
    const timestamp = nowSeconds();
    const statements = writes.map((write) => {
      const artistCi = write.artist?.toLowerCase() ?? null;
      const albumCi = write.album?.toLowerCase() ?? null;
      return this
        .prepare(APPLY_DERIVATION)
        .bind(
          // `title` first, in the same order as the `SET` list above it. Positional
          // binding is why the two are one fact: every `?` below has exactly one
          // counterpart there, and a pair that drifts is a statement that writes one
          // column's guard with another's value.
          //
          // **Fill-once, and deliberately unguarded.** `grouping_source` cannot guard these
          // two without widening what it means from three columns to four, and every row
          // already stamped under the old definition would then be read under the new one.
          // A file tagged `TITLE` but not `ARTIST`/`ALBUM`/`ALBUMARTIST` holds a real tag
          // title *and* `'derived'`, and a tagless enriched file holds a derived title *and*
          // `'derived'` — indistinguishable on the row, so a guard here deletes the first,
          // for ever, because `enriched_at` is set.
          //
          // A dedicated provenance column is the shape that would hold both, and the schema
          // rules are what stop it: SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
          // (measured on 3.53.4), a migration may not `ALTER`, and editing the locked
          // baseline is the `songs.reader_version` defect. So the title pays for its safety
          // with a rule that is **not versioned**: a corrected `deriveTitleFromFileName`
          // cannot reach a title this derivation already wrote. Asserted in
          // `test/schema.int.test.ts`, so the cost is a claim and not a surprise.
          write.title,
          write.title.toLowerCase(),
          GROUPING_SOURCE_DERIVED,
          write.artist,
          GROUPING_SOURCE_DERIVED,
          artistCi,
          GROUPING_SOURCE_DERIVED,
          write.album,
          GROUPING_SOURCE_DERIVED,
          albumCi,
          // `album_artist` mirrors the derived artist: `getArtist` groups on it, so an
          // album with a NULL album-artist column does not appear under the artist a
          // client navigated to.
          GROUPING_SOURCE_DERIVED,
          write.artist,
          GROUPING_SOURCE_DERIVED,
          artistCi,
          GROUPING_SOURCE_DERIVED,
          GROUPING_SOURCE_DERIVED,
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
    // The whole `WriteBatchResult`, not `written.changes`. This runs **on every poll**, before
    // the status check, so its cost is the one the daily allowance is most exposed to — and
    // returning a count left the caller with no way to charge it. `requireComplete` means
    // `truncated` is always false here; the field comes back because the type is the batch's.
    return await this.runWriteBatch(statements, 'songs.applyDerivation', { requireComplete: true });
  }

  /**
   * The names `pathConvention` derives for these rows.
   *
   * A method rather than a bare `map` at the call site so the pairing of "read a page"
   * with "derive a page" cannot be half-done: a caller that derived some rows and not
   * others would write a stamp on rows it never decided anything about.
   *
   * An **instance** method rather than a static one, because the marker is configured: a
   * static method reading a module constant would derive every page in a deployment
   * against the same hardcoded suffix the operator is not using.
   */
  public deriveFor(rows: readonly DerivableRow[]): DerivationWrite[] {
    return rows.map((row) => {
      const { artist, album } = deriveFromPath(row.dir_path, this.derivedMarker);
      return { id: row.id, title: deriveTitleFromFileName(row.name), artist, album };
    });
  }
}

export { SongDerivationDAO, APPLY_DERIVATION };
export type { DerivableRow, DerivationWrite };