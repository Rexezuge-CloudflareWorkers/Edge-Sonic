/**
 * Who wrote a row's grouping: the path convention, or a file's tags.
 *
 * ### Why this is a column and not the marker on the value
 *
 * The suffix appended to a derived name (` (derived)`, configurable as
 * `DERIVED_MARKER`) used to be the **only** record of provenance, and
 * `applyDerivation` read it back out of the stored string to decide whether it was
 * allowed to replace it. That works exactly while the marker is one hardcoded literal,
 * and fails in three distinguishable ways the moment an operator chooses it. All three
 * measured over real SQLite against the real statement:
 *
 * | `DERIVED_MARKER` | `Bonobo (derived)` | `Bonobo` | `Black Sands (Remastered)` |
 * | --- | --- | --- | --- |
 * | `' (derived)'`   | replaced | kept | **kept** |
 * | `''`             | replaced | replaced | **→ replaced** |
 * | `'_ (guess)'`    | **kept** | kept | kept |
 *
 * - **An empty marker is a match-all.** `'%' || ''` is `'%'`, so `ELSE artist` becomes
 *   unreachable and the backfill overwrites every real `ALBUMARTIST` in the library.
 *   Empty is the *requested default*, because empty is what merges a derived `X` with a
 *   tagged `X` into one release instead of publishing it twice.
 * - **Any other marker is a `LIKE` pattern.** `'_ (guess)'` becomes `'%_ (guess)'`,
 *   where `_` matches any single character, so the guard stops recognising its own
 *   guesses: a `derived_version` bump re-selects those rows and declines to change them.
 *   The `reader_version` defect verbatim, one layer down, with no error anywhere.
 * - **`'%'` as a marker is the empty case again**, and an operator writing it is not
 *   told why.
 *
 * So the guard is a column comparison, which has none of those failure modes: `'%'` and
 * `'_'` in the marker are ordinary characters, and an empty marker produces an ordinary
 * name.
 *
 * ### The definition, which is one sentence
 *
 * **`'derived'` means all three of `artist`, `album` and `album_artist` came from
 * `dir_path`. Anything else is `NULL`.**
 *
 * ### What the column is for, stated as the predicate
 *
 * A stored grouping column may be replaced by a derivation **only** when the column is
 * NULL or this column says a derivation owns it:
 *
 * ```
 * CASE WHEN grouping_source = ? OR artist IS NULL THEN ? ELSE artist END
 * ```
 *
 * A gap is always fillable, and a value a derivation is recorded as owning is replaceable.
 * A value a file's tags supplied is neither, so it is left alone — which is the whole safety
 * argument of the backfill, and the assertion `test/schema.int.test.ts` has always made.
 *
 * ### Why "all three" and not "any one"
 *
 * Because the permissive direction is the dangerous one, and the same reasoning decided
 * `IS NOT` over `!=` in `NodeDAO.UPSERT`: a permissive predicate that should have been
 * false can silently become true.
 *
 * `upsertFileFacts` writes all three or none, so a row is normally either wholly derived
 * or wholly tagged. The mixed case is a partial tag read — a file carrying `ALBUM` but no
 * `ALBUMARTIST` — where `applyMetadata` clears this column. Enrichment refines that row's
 * `album_artist` to its tag artist on the same write (see `effectiveAlbumArtist`), because
 * the remaining derived value is the same name through filesystem sanitization and no
 * correction of a separator rule reaches it; the backfill then has nothing to repair.
 * `test/schema.int.test.ts` asserts both directions.
 *
 * ### Why `derived_version` cannot do this as well
 *
 * It answers "which convention version last *examined* this row", and it is stamped
 * unconditionally — including on a row holding a real tag, which is equally not owed a
 * derivation. Repurposing it to mean "which version last *wrote* the grouping" breaks the
 * backfill's selection: a tagged row would sit at `0`, satisfy `derived_version < ?` on
 * every poll for ever, and the backfill would never converge. Stamping it to stop that
 * makes the next bump overwrite the tag instead. Two inputs need two columns.
 */

/**
 * The one value `grouping_source` ever holds.
 *
 * A named constant rather than an inline `'derived'`, because the string is compared in
 * three statements written in three modules and a literal typed beside each of them is a
 * literal that can be spelled three ways. `NULL` is the other answer and is never written
 * as a string.
 *
 * **Bound, never interpolated.** Eight places in `APPLY_DERIVATION` compare against it and
 * one writes it, and an operator's `DERIVED_MARKER` reaches the same statement — so the
 * statement takes the constant as data. A marker of `'%'` is then an ordinary character
 * rather than a pattern, which is the whole point of the column.
 */
const GROUPING_SOURCE_DERIVED = 'derived';

/**
 * The column's value, as `rows.ts` declares it.
 *
 * `SongRow` is layer 0's own row type, so it names the column rather than importing this
 * module for one alias — but it must not invent the union, or a value written by
 * `applyMetadata` and a value read by `SongRow` would be spelled differently and nothing
 * would say so.
 */
type GroupingSource = typeof GROUPING_SOURCE_DERIVED | null;

export { GROUPING_SOURCE_DERIVED };
export type { GroupingSource };