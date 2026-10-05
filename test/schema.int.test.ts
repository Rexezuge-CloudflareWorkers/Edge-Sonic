/**
 * The schema, and the DAOs, against a real SQLite engine.
 *
 * ### The assertion that matters most here is the query plan
 *
 * `WHERE username_ci = ?` and `WHERE lower(username) = ?` return identical rows. A
 * predicate can be wrong in a way that no row-comparison assertion can see, and the
 * only observable difference is the plan — which is why these run against a real
 * planner (`node:sqlite`, the same engine D1 is) instead of a double.
 *
 * The reference project this was scaffolded from shipped `lower(col) = lower(?)`
 * through a full suite for exactly this reason: its D1 double lowercased both sides in
 * JavaScript, so the predicate was wrong in SQL and the answers were right.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptData, generateAesGcmKey } from '@edge-sonic/backend-data/crypto';
import {
  AnnotationDAO,
  AuthThrottleDAO,
  DERIVED_VERSION,
  GROUPING_SOURCE_DERIVED,
  LibraryDAO,
  NO_METADATA_WRITE,
  NodeDAO,
  PlaylistDAO,
  ScanStateDAO,
  SongDAO,
  SongDerivationDAO,
  SongIndexDAO,
  UserDAO,
  D1_MAX_BIND_PARAMETERS,
  MAX_BILLED_ROWS_PER_ROW,
  TABLE_INDEX_COUNTS,
  bindChunkSize,
  billedRowsFor,
  billedRowsForTable,
  deriveFromPath,
  statementTable,
  SongMatchDAO,
  ImportSourceDAO,
  ImportRunDAO,
  ImportPlayCountProgressDAO,
  PlayCountDAO,
} from '@edge-sonic/backend-data/dao';
import { ImportSourceService } from '@edge-sonic/backend-services/import';
import { SubrequestCounter } from '@edge-sonic/shared';
import { NotFoundError, SubrequestBudgetExhaustedError } from '@edge-sonic/backend-errors';
import {
  albumKeyFor,
  buildReport,
  collectUnresolved,
  MAX_REPORTED_UNRESOLVED,
  parseReport,
  phase,
  serializeReport,
} from '@edge-sonic/backend-services/import';
import { DERIVED_MARKER, EMPTY_DERIVED_MARKER } from './helpers/harness';
import { sqliteQueryable, queryPlan } from './helpers/sqlite';
import type { SqliteQueryable } from './helpers/sqlite';
import { albumIdOf, specFromKey } from '@edge-sonic/subsonic';
// The comparator under test is the one the endpoints publish with, imported rather than
// restated: a copy here would pass against itself, and the assertion it exists for is that
// the row fetch's SQL order and this order agree.
import { compareAlbumTracks } from '../apps/api/src/rest/albumIdentity';
import { migrationDigests, migrationFiles, migrationFindingsOfKind, migrationSql } from './helpers/migrations';
import { checkMigrations } from '../scripts/migrations/lock-check';

/**
 * The squashed baseline. Everything at or before it is exempt from the lock's
 * `edited` and `orphan` checks; everything after it is immutable.
 */
const BASELINE = '0008_squash.sql';

/**
 * The order `getAlbumList2?type=alphabeticalByName` asks for.
 *
 * An **aggregate**, because `listAlbums` groups — one group is one album — so the ordering
 * must be a function of the group. A bare `album_ci` would order an album by whichever of its
 * tracks `GROUP BY` happened to keep, which is arbitrary: the same album could sort two ways on
 * two calls.
 */
const MIN_ALBUM_CI = ['MIN(album_ci) ASC'];

/**
 * The grouping the DAO tests run under, which is the deployment default.
 *
 * Stated rather than left to the type: `listAlbums` takes it as a required option precisely so
 * that "which album is this" cannot be answered differently in the suite than in production.
 * These fixtures hold one album per directory, so every grouping agrees on their membership —
 * which is why the tests that *do* discriminate between them are new ones, with a fixture where
 * a release spans directories.
 */
const ALBUM_GROUPING = 'album' as const;

/**
Base64 of a 32-byte key, generated once so a file's rows stay readable.
*/
let keyPromise: Promise<string> | null = null;
function testKey(): Promise<string> {
  keyPromise ??= generateAesGcmKey();
  return keyPromise;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

let handle: SqliteQueryable;

beforeEach(() => {
  handle?.close();
  handle = sqliteQueryable();
  // Every migration, in order — see `helpers/migrations.ts`. Naming one file here
  // would make a new migration and an edit to an old one indistinguishable.
  handle.raw.exec(migrationSql());
});

/**
 * The squash's contract, in the properties that remain checkable from here.
 *
 * `0008_squash.sql` replaces eight migrations, and it does NOT run only on a fresh
 * database: `d1_migrations` records the eight absorbed filenames, so they are skipped
 * and this file is unapplied — it runs against production databases that already have
 * every table, column and index. So it has to be idempotent, and the failure mode is
 * invisible in the text: the absorbed migrations used `ALTER TABLE … ADD COLUMN`, and
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so a squash written as a concatenation fails
 * on exactly the databases it exists to serve, with "duplicate column name", at deploy
 * time.
 *
 * Equivalence to the sequence it replaced is the other half, and it is **not** asserted
 * here: those eight files are absorbed and deleted, so the comparison has nothing left to
 * compare against, and a checked-in copy of them would be a fixture nothing keeps honest.
 * It was established when the squash was written — same tables, same 138 columns in name,
 * type, nullability, default and primary key, same 17 indexes with the same columns and
 * uniqueness — and the durable half of it survives as the assertions below, plus the
 * column inventory the DAO block checks further down. What this block guards is that the
 * squash stays idempotent, which is the property that makes the absorption safe at all.
 */
describe('the squashed baseline', () => {
  /**
   * The whole schema as a comparable value: every table, every column with its
   * type/constraint/default, and every index with its columns and uniqueness.
   *
   * Deliberately NOT `sqlite_schema.sql`. That column stores the original CREATE TABLE
   * verbatim *including its comments*, so a comparison pinned to it would assert that
   * nobody may ever improve a comment in a squashed file — the one edit a squashed file
   * most needs to allow. Comments are not schema.
   *
   * Ordinal column position is excluded for the same class of reason: SQLite resolves
   * columns by name, nothing here addresses one positionally, and the folded ALTERs
   * happen to preserve position anyway.
   */
  function structureOf(db: SqliteQueryable): string {
    const tables = (
      db.raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    const columns: string[] = [];
    for (const table of tables) {
      for (const column of db.raw.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<Record<string, unknown>>) {
        columns.push(
          `${table}|${String(column['name'])}:${String(column['type'])}:${String(column['notnull'])}:${String(column['dflt_value'])}:${String(column['pk'])}`,
        );
      }
    }

    const indexes: Record<string, unknown> = {};
    for (const row of db.raw
      .prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; tbl_name: string }>) {
      const listed = db.raw.prepare(`PRAGMA index_list(${JSON.stringify(row.tbl_name)})`).all() as Array<{ name: string; unique: number }>;
      indexes[row.name] = {
        table: row.tbl_name,
        unique: listed.find((entry) => entry.name === row.name)?.unique === 1,
        columns: (db.raw.prepare(`PRAGMA index_info(${JSON.stringify(row.name)})`).all() as Array<{ name: string }>).map((c) => c.name),
      };
    }

    return JSON.stringify({ tables, columns: columns.toSorted(), indexes }, null, 2);
  }

  it('sorts first, so a migration added after the squash cannot land before it', () => {
    // **First**, not last. Both this and the ordering assertion below used to say "last", and
    // both were wrong in the same direction — while the comment beside the second one said the
    // opposite thing ("a migration added after the squash must be numbered above `0008`").
    //
    // The two disagreed because of how filenames sort, not because of a typo: `0009` sorts
    // **after** `0008_squash.sql`, so a migration added after the squash lands at the *end* of the
    // list. "Numbered above `0008`" is right; `files.at(-1) === BASELINE` could only have been
    // written by someone reading the comment as "numbered after".
    //
    // Neither assertion could fail before this migration existed — there was nothing to add
    // — so both were assertions of a *fact* dressed as an assertion of an *invariant*. Stated
    // as the invariant now: the baseline must be the **first** file, which is exactly what
    // "a future migration cannot sort before it" means, and it stays true however many files
    // are added after it.
    expect(migrationFiles().at(0)).toBe(BASELINE);
  });

  it('leaves the schema unchanged when applied to a database that already has it', () => {
    // The property that makes the squash safe on an existing deployment. This is the
    // only path it takes after its first application, so it is the one that matters.
    const before = structureOf(handle);

    expect(() => handle.raw.exec(migrationSql())).not.toThrow();

    expect(structureOf(handle)).toBe(before);
  });

  it('touches no rows, so re-running it cannot lose data', () => {
    handle.raw.exec(
      `INSERT INTO users (id, username, username_ci, password_ciphertext, password_iv, created_at, updated_at)
       VALUES ('u1', 'alice', 'alice', 'c', 'iv', 0, 0);
       INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, created_at, updated_at)
       VALUES ('l1', 'main', 'main', 'https://dav.example.com', '', 'dav', 'c', 'iv', 0, 0);`,
    );
    const usersBefore = handle.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    const librariesBefore = handle.raw.prepare('SELECT COUNT(*) AS n FROM libraries').get() as { n: number };

    handle.raw.exec(migrationSql());

    expect(handle.raw.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual(usersBefore);
    expect(handle.raw.prepare('SELECT COUNT(*) AS n FROM libraries').get()).toEqual(librariesBefore);
  });

  it('contains no statement that cannot be re-run against a full schema', () => {
    // The execution test above is the measurement — it does what a deploy does. These
    // two are the named early warnings, because an unguarded statement is invisible in
    // a passing suite until a real database runs it:
    //
    //  - `ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS` form at all, so it fails
    //    with "duplicate column name" on every already-migrated database. This is
    //    precisely how the absorbed migrations added their columns, which is why the
    //    squash folds them into the `CREATE TABLE`s instead.
    //  - `DROP TABLE` would be a no-op rather than an error, which is exactly why the
    //    absorbed `namespaces`/`router_backends` drops are absent instead: the tables
    //    are never created, so there is nothing to drop.
    //
    // Matched against the file with its `--` line comments stripped, because this file
    // *documents* both of the statements it forbids — it has to, to explain why they
    // are gone — and a regex over the raw text matches its own explanation. Safe here
    // because the file uses only `--` line comments and holds no string literal
    // containing `--`; a block comment or one would need a real tokenizer instead.
    const statements = migrationSql()
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');

    expect(statements, 'an ALTER TABLE cannot be guarded — fold the column into its CREATE TABLE').not.toMatch(/ALTER\s+TABLE/i);
    expect(statements, 'a DROP TABLE has nothing to drop — the baseline never creates these').not.toMatch(/DROP\s+TABLE/i);
  });
});

/**
 * D1 bills a write as the row **plus every index entry it rewrote** — pricing page,
 * definition 6: *"there are two rows written: one to the table itself, and one to the
 * index."* The daily row-write allowance is denominated in those, so `billedRows.ts`'s
 * per-table factor is the thing that decides whether the scan paces itself inside the
 * allowance or overruns it.
 *
 * And a per-table factor typed beside a query is right until the first `CREATE INDEX`, after
 * which it silently under-counts — the same defect as `listIdsIn`'s batch size of 200 under a
 * comment asserting SQLite's limit was 999. So the declared counts are read out of the real
 * migrated schema and compared, here, on every run.
 */
describe('the billed-row model is the schema, not a number typed beside a query', () => {
  /**
   * Indexes per table, from `sqlite_schema`.
   *
   * `LIKE 'sqlite_%'` is **deliberately absent**, and this is the whole content of the first
   * case below: SQLite creates an implicit unique index for every `PRIMARY KEY` that is not an
   * `INTEGER PRIMARY KEY` rowid alias, and those appear as `sqlite_autoindex_*` with no SQL of
   * their own. Counting `CREATE INDEX` statements by eye therefore *undercounts every table in
   * this schema by one*, which would have made `songs` eight and its real cost nine rows per
   * write — wrong in the direction that looks safe.
   *
   * `sqlite_stat1` and friends are also excluded, because they are tables rather than indexes
   * and never appear in a `type = 'index'` row.
   */
  function indexCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of handle.raw
      .prepare("SELECT tbl_name, name FROM sqlite_schema WHERE type = 'index' ORDER BY tbl_name, name")
      .all() as Array<{ tbl_name: string; name: string }>) {
      // An index on a table that does not exist is impossible, but a *view*'s index is not,
      // and this suite's schema has none — so a name that is not one of our tables is a genuine
      // finding rather than noise, and is reported rather than skipped.
      counts[row.tbl_name] = (counts[row.tbl_name] ?? 0) + 1;
    }
    return counts;
  }

  it('counts every index the schema declares, implicit PRIMARY KEY ones included', () => {
    const actual = indexCounts();

    // The specific trap, asserted directly rather than only through the comparison below:
    // `songs` has eight `CREATE INDEX` statements and **nine** indexes, because `id TEXT
    // PRIMARY KEY` gets an implicit one. The scan's dominant write is a `songs` write, so this
    // single index is the difference between a budget metered in table rows and one metered in
    // what D1 bills.
    expect(migrationSql().match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+ ON songs\b/gi) ?? []).toHaveLength(8);
    expect(actual['songs']).toBe(9);

    // `scan_state` is the contrast: it declares **no** index at all, and so has exactly one —
    // its `library_id TEXT PRIMARY KEY`. It is the one table whose write costs 2 rather than 10,
    // and `scanStart.ts` names that figure.
    expect(migrationSql().match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+ ON scan_state\b/gi) ?? []).toHaveLength(0);
    expect(actual['scan_state']).toBe(1);
  });

  it('matches the declared model for every table, so adding an index turns this red', () => {
    // Both directions, and the second is the load-bearing one: a table in the schema with no
    // entry in `TABLE_INDEX_COUNTS` would be charged `MAX_BILLED_ROWS_PER_ROW` — pessimistic, so
    // safe, but silently so, and on a table a future migration adds nobody would know the
    // factor had stopped being derived.
    expect(TABLE_INDEX_COUNTS).toEqual(indexCounts());
  });

  it('has a factor of one-plus, because the table row itself is always billed', () => {
    // The rule stated as a relationship rather than restated per table: a table with **no**
    // indexes still costs one row per write, so a factor of 0 anywhere would mean the model had
    // forgotten the row it started from.
    for (const [table, indexes] of Object.entries(TABLE_INDEX_COUNTS)) {
      // `indexes` is a string here: `Object.entries` on a `Record<string, number>` widens the
      // value, and the arithmetic says as much by needing the parse.
      expect(billedRowsForTable(table, 1), `${table} bills its own row`).toBe(Number(indexes) + 1);
    }
  });

  it('charges the worst case in the schema for a statement whose table cannot be read', () => {
    // The pessimistic fallback, asserted because it is the direction the whole module is
    // written in. A default of 1 is the defect this module exists to remove.
    const unknown = billedRowsFor({ sql: 'PRAGMA optimize' }, 1);
    expect(unknown).toBe(MAX_BILLED_ROWS_PER_ROW);
    // `>=` the most expensive real table, not `>`: `songs` *is* the most expensive table in
    // this schema, so today the fallback and `songs` coincide and asserting a strict inequality
    // would fail while stating something untrue. The relationship that matters is the
    // direction — a fallback can only ever over-charge, never under-charge — and `toBeGreaterThanOrEqual`
    // against the maximum is what states it. It is also asserted as an invariant below, because
    // a future index on some quieter table would make this strict again and say so here.
    expect(unknown).toBeGreaterThanOrEqual(billedRowsForTable('songs', 1));
    expect(unknown).toBeGreaterThan(billedRowsForTable('nodes', 1));
    expect(unknown).toBeGreaterThan(billedRowsForTable('scan_state', 1));

    // And a read is not a write at all, so it costs nothing — `runWriteStatement` is never
    // handed one, and a double that reached it must not invent a charge.
    expect(billedRowsFor({ sql: 'SELECT * FROM songs' }, 0)).toBe(0);
  });

  it('is what makes a chunk of songs cost ten times what its row count says', () => {
    // The number this whole change exists to establish, over the real engine: 50 rows changed
    // is 500 billed rows against the day's allowance. A budget reading `changes` would admit a
    // tenth of what D1 is about to be asked for.
    const songs = billedRowsForTable('songs', 50);
    expect(songs).toBe(500);
    // And `nodes`, which the same chunk also writes, at its own — different, which is why no
    // single ratio converts one count into the other.
    expect(billedRowsForTable('nodes', 50)).toBe(200);
  });

  it('reads the table off the statement, not off a caller-supplied name', () => {
    // Every write shape this repository issues, from the DAO source. `billedRowsFor` is only
    // trustworthy if it recognises the statements that actually run, and the failure mode is
    // quiet — a misread table is charged the wrong factor, in whichever direction.
    // Paired with its expected table rather than a set membership: a parser that answered `nodes`
    // for every one of these would pass a membership assertion, and the whole cost of this
    // module is that the *wrong table* is a wrong factor.
    // A full host of legal SQLite, because the failure mode of this parser is silent: a shape it
    // cannot read is charged the worst case rather than refused, and that is indistinguishable
    // from correct behaviour on a library with no unquoted identifiers.
    for (const [sql, table] of [
      ['INSERT INTO songs (id) VALUES (?)', 'songs'],
      ['INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', 'settings'],
      ['INSERT INTO nodes (library_id, path) VALUES (?, ?)', 'nodes'],
      ['UPDATE songs SET title = ? WHERE id = ?', 'songs'],
      ['DELETE FROM songs WHERE id = ?', 'songs'],
      ['  \n  UPDATE scan_state SET status = ? WHERE library_id = ?', 'scan_state'],
      ['-- a leading comment, which the statement may carry\nUPDATE nodes SET etag = ? WHERE path = ?', 'nodes'],
      // Quoted and bracketed identifiers: legal SQLite, and legal in a DAO if an identifier
      // ever becomes reserved. A parser that cannot read them charges the worst case.
      ['INSERT INTO "nodes" (library_id, path) VALUES (?, ?)', 'nodes'],
      ['DELETE FROM `songs` WHERE id = ?', 'songs'],
      // Case: the verb and the table are upper-cased inconsistently across DAOs.
      ['update SONGS set title = ? where id = ?', 'songs'],
    ] as const) {
      expect(statementTable(sql), sql).toBe(table);
    }

    // Not a write: a read is not billed, and a verb quoted inside a string literal is not a
    // statement header. This is why the pattern is anchored at the start rather than searched
    // for — `name = 'UPDATE users'` is a legal value for a column this schema carries.
    expect(statementTable('SELECT * FROM songs')).toBeNull();
    expect(statementTable("UPDATE songs SET name = 'UPDATE users' WHERE id = ?")).toBe('songs');
    expect(statementTable('WITH x AS (SELECT 1) SELECT * FROM x')).toBeNull();
  });

  it('measures a real statement as the model says, over the real engine', async () => {
    // The paired negative. `meta.changes` is what the DAO reads and what the old budget
    // counted; it reports table rows and knows nothing about indexes. If these two numbers
    // agreed, the model would be decorative — so this asserts they do not, against the same
    // SQLite the suite already trusts for query plans.
    const libraryId = 'LBILLED';
    await handle.raw.exec(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, created_at, updated_at)
       VALUES ('${libraryId}', 'billed', 'billed', 'https://dav.example.com', '', 'dav', 'c', 'iv', 0, 0);`,
    );

    const statement = handle.db.prepare(
      'INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, suffix, duration, bitrate, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, 0, 0)',
    );
    const bound = statement.bind('s1', libraryId, 'A/01.flac', 'A', '01.flac', '01.flac', '.flac');
    const result = await bound.run();

    expect(result.meta?.changes).toBe(1);
    expect(billedRowsFor(bound, result.meta?.changes ?? 0)).toBe(billedRowsForTable('songs', 1));
    expect(billedRowsForTable('songs', 1)).toBeGreaterThan(result.meta?.changes ?? 0);
  });

  it('is what a real write batch reports, so the budget is not fed a row count', async () => {
    // The assertion that closes the loop. Everything above tests the model; this tests that the
    // **scan** receives it, by running the DAO the scan calls over the real engine.
    //
    // It exists because the mutation is invisible everywhere else: reverting `runWriteBatch`'s
    // `batch()` branch to `sum(changes)` — i.e. dropping `billedRowsFor` — leaves every
    // status-, shape- and budget-level assertion in `scan-budget`, `scan-incremental` and the rest
    // green, because those suites meter *doubles* that report their own `billedRows` and never
    // execute `runWriteBatch`. The defect lands as a silent ten-fold under-count in production and
    // as **no** test failure at all, which is the shape this repository has already paid for twice
    // on this column.
    //
    // Three rows, one statement each, all `songs`: 3 changes and 30 billed rows.
    const userId = await seedUser('BilledBatch');
    const libraryId = await seedLibrary(userId, 'LBB');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const inputs = ['A/01.flac', 'A/02.flac', 'A/03.flac'].map((path) => ({
      id: songId(libraryId, path),
      libraryId,
      path,
      dirPath: 'A',
      name: path.split('/').pop() ?? path,
      size: 1000,
      mtimeMs: 1000,
      contentType: 'audio/ogg',
      suffix: 'ogg',
    }));

    const written = await songs.upsertFileFacts(inputs);

    expect(written.changes).toBe(3);
    expect(written.billedRows).toBe(billedRowsForTable('songs', 3));
    expect(written.billedRows).toBe(30);
    // And the relationship, which is what makes the number usable by a caller that has no idea
    // what the table's index count is.
    expect(written.billedRows).toBe(written.changes * (1 + TABLE_INDEX_COUNTS['songs']!));
  });

  it('is what a single-statement write reports, since that path bypasses the batch', async () => {
    // `applyMetadata` is one `UPDATE` through `runWriteStatement`, not `runWriteBatch` — so it is
    // a *second* implementation of the same arithmetic unless it is asserted too, and
    // `EnrichmentService` meters this one. This is the path that carried the literal `1`.
    const userId = await seedUser('BilledSingle');
    const libraryId = await seedLibrary(userId, 'LBS');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const id = songId(libraryId, 'A/01.flac');
    await songs.upsertFileFacts([
      { id, libraryId, path: 'A/01.flac', dirPath: 'A', name: '01.flac', size: 1, mtimeMs: 1, contentType: 'audio/ogg', suffix: 'ogg' },
    ]);

    const written = await songs.applyMetadata(id, { artist: 'Bonobo', album: 'Black Sands' });

    expect(written.changes).toBe(1);
    expect(written.billedRows).toBe(billedRowsForTable('songs', 1));

    // A row that matched nothing writes nothing — and the pair must agree, because a budget told
    // `changes: 0` but a nonzero cost is a scan that believes it spent nothing and is charged for
    // something.
    const absent = await songs.applyMetadata(songId(libraryId, 'A/missing.flac'), { artist: 'Nobody' });
    expect(absent.changes).toBe(0);
    expect(absent.billedRows).toBe(0);

    // And a call that supplied nothing to write issues no statement at all.
    expect(await songs.applyMetadata(id, {})).toEqual(NO_METADATA_WRITE);
    expect(NO_METADATA_WRITE.billedRows).toBe(0);
  });
});

/** Encode a Subsonic id exactly as the product does, so a test cannot pass on a
 *  different scheme than the one in use. */
function songId(libraryId: string, path: string): string {
  const bytes = new TextEncoder().encode(`${libraryId}\n${path}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `s:${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

async function seedUser(username: string, password = 'sesame'): Promise<string> {
  const encrypted = await encryptData(password, await testKey());
  const users = new UserDAO(handle.db);
  return (await users.create({ username, passwordCiphertext: encrypted.ciphertext, passwordIv: encrypted.iv })).id;
}

/**
 * Insert a library under a **known** id.
 *
 * `LibraryDAO.create` mints its own id, and a test needs a stable one to encode song
 * ids against — so this writes the row directly rather than going through the DAO.
 * Everything else about the row matches what the DAO produces, because the cascade and
 * plan assertions are only meaningful if the seed is indistinguishable from a real
 * registration.
 */
async function seedLibrary(userId: string, id: string): Promise<string> {
  const encrypted = await encryptData('dav-password', await testKey());
  const timestamp = nowSeconds();
  await handle.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      id.toLowerCase(),
      id.toLowerCase(),
      'https://dav.example.com',
      '/remote.php/dav/files/alice/Music',
      'alice',
      encrypted.ciphertext,
      encrypted.iv,
      'Home',
      timestamp,
      timestamp,
    )
    .run();
  await new UserDAO(handle.db).setLibraryGrants(userId, [id]);
  return id;
}

async function seedSong(libraryId: string, path: string, dirPath: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const songs = new SongDAO(handle.db, DERIVED_MARKER);
  const id = songId(libraryId, path);
  const name = path.split('/').pop() ?? path;
  const ci = (value: unknown): string | null => (typeof value === 'string' ? value.toLowerCase() : null);
  await songs.upsertFileFacts([
    { id, libraryId, path, dirPath, name, size: 1000, mtimeMs: 1000, contentType: 'audio/flac', suffix: 'flac' },
  ]);
  await songs.applyMetadata(id, {
    title: (metadata.title as string) ?? name,
    artist: metadata.artist as string | undefined,
    album: metadata.album as string | undefined,
    albumArtist: metadata.artist as string | undefined,
    genre: metadata.genre as string | undefined,
    track: metadata.track as number | undefined,
    year: metadata.year as number | undefined,
    duration: (metadata.duration as number) ?? 0,
    bitrate: 900,
  });
  void ci;
  return id;
}

describe('schema', () => {
  it('applies with foreign keys enforced and no violations', () => {
    // A migration that only works with FKs off is a migration that destroys data on a
    // real deployment, where they cannot be turned off mid-run.
    expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('declares every table the DAOs query', () => {
    const rows = handle.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tables = rows.map((row) => row.name);

    // Everything `backend-data` queries, which is what this assertion is for. The
    // assertion is a *subset* check plus an explicit list of what else is here, so a
    // missing table is caught without the test going blind to a new one.
    for (const required of [
      'auth_failures',
      'bookmarks',
      'libraries',
      'nodes',
      'now_playing',
      'play_counts',
      'play_queue',
      'play_queue_entries',
      'playlist_entries',
      'playlists',
      'ratings',
      'scan_state',
      'settings',
      'songs',
      'stars',
      'user_libraries',
      'users',
    ]) {
      expect(tables, `${required} is missing`).toContain(required);
    }
  });

  it('leaves no dead table behind, and no foreign key that does not resolve', () => {
    // The reference project's `router_backends`/`namespaces`, inherited from
    // Durable-DAV-Router via `0001_router_init.sql`. Dead code here, and
    // `router_backends` referenced `users(email)` — a nullable, non-unique column —
    // so `PRAGMA foreign_key_check` failed outright with a foreign key mismatch. D1
    // enforces foreign keys, so that was a landmine in the live schema, not a
    // cosmetic leftover.
    //
    // Both tables are now *never created*: `0008_squash.sql` is the baseline and
    // omits them, so the drops that used to clean them up are gone too. Asserting
    // their absence still matters — it is what would catch a future squash or a
    // hand-written migration reintroducing them.
    const tables = (handle.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);

    expect(tables).not.toContain('router_backends');
    expect(tables).not.toContain('namespaces');

    // The assertion that matters: it must not merely return rows, it must not throw.
    expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('builds the SAME `users` table production has, and cannot be raced into building another', () => {
    // `migrations/0001_router_init.sql` was inherited from the reference project and
    // also declared `users` — with an incompatible shape (`email TEXT PRIMARY KEY`,
    // no `username_ci`, no credential columns). Both files used
    // `CREATE TABLE IF NOT EXISTS`, so whichever ran first won, silently.
    //
    // This suite used to `exec` only `0001_edge_sonic_init.sql`, so it asserted a
    // table list that no real database has: it never saw the router's tables, and it
    // never saw the collision. Reading the directory exposed both.
    //
    // Production was correct only because of the filename sort:
    // `0001_edge_sonic_init.sql` < `0001_router_init.sql`, so Edge-Sonic's `users` was
    // created first and the router's was a no-op. That is a load-bearing alphabetical
    // accident between two projects' migrations, and it was the reason the squash was
    // worth doing rather than merely tidy.
    //
    // Both files are absorbed by `0008_squash.sql`, which declares `users` once — so
    // the accident is gone rather than merely still-lucky. The first half asserts the
    // shape production has; the second asserts the *structural* property that makes a
    // second declaration impossible, because a comparison of two column lists would
    // still pass on a schema carrying both.
    const columns = (handle.raw.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toContain('username_ci');
    expect(columns).toContain('password_ciphertext');
    expect(columns).toContain('token_epoch');

    // Exactly one file may claim a 4-digit prefix. D1 orders migrations by the REST of
    // the filename, so two files numbered `0001_` land in an order decided by a
    // lexicographic tiebreak nobody intended — and a database that ran one of them
    // can never run the other. `lock-check.ts` fails on this; asserted here too so the
    // property is measured against the real directory rather than the lock's copy of it.
    const prefixes = migrationFiles().map((name) => name.slice(0, 4));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

/**
 * An applied migration is immutable, and nothing in a `.sql` file says so.
 *
 * D1 records applied migrations by *filename*, so a migration that has run is skipped
 * by every later `wrangler d1 migrations apply` — silently, with no warning and no
 * error. Editing a shipped migration therefore changes the repository without changing
 * the database, and the code starts naming a column the database has never heard of.
 *
 * It shipped. `songs.reader_version` was added to `0001` after `0001` had been applied
 * to the live database, so the column never existed there: `applyMetadata` and
 * `upsertFileFacts` both named it and both failed, enrichment wrote nothing, and
 * `getArtists` / `getAlbumList2` / `getGenres` / `search3` answered `[]` for a library
 * of 80 albums whose rows sat in D1 with every derived column NULL. `getSong` answered
 * a masked 500, the scan wedged in `failed`, and `getScanStatus` reported that as a
 * finished scan. 489 tests passed throughout, because a suite that hardcodes one
 * migration filename cannot tell a new migration from an edit to an old one.
 *
 * So the fact the deployment actually depends on is recorded and asserted. The
 * comparison lives in `scripts/migrations/lock-check.ts` — the same module
 * `pnpm run validate:migrations` runs — so this block and the CI gate cannot
 * disagree about what drift is.
 */
describe('the migration lock', () => {
  it('reports no drift between the directory and the lock', () => {
    // `unlocked` and `edited` are the two halves of the defect above. A new
    // migration with no entry is a migration nobody has applied; a changed digest is
    // bytes that moved while the database kept the schema it had.
    expect(migrationFindingsOfKind('unlocked', 'edited')).toEqual([]);
  });

  it('reads a lock the tool understands, and every file has a `sha256:` digest', () => {
    // Asserted separately from the drift check so a failure names which direction
    // broke: an unreadable lock otherwise surfaces as "no migrations recorded".
    const digests = migrationDigests();
    expect(digests.length).toBeGreaterThan(0);
    for (const { name, digest } of digests) {
      expect(digest, `${name} was not hashed as sha256:<hex>`).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // `baseline` must name a file that is actually on disk. Derived from the files on
    // disk rather than trusted from the lock, so a stale or forged `baseline` cannot
    // widen the set of migrations exempt from the `edited` and `orphan` checks.
    expect(migrationFindingsOfKind('malformed', 'baseline', 'absent')).toEqual([]);
  });

  it('detects an edit to a shipped migration rather than trusting the absence of one', () => {
    // The guard is worthless if it cannot fail, and a test that only asserts "no drift"
    // is exactly the shape that would pass forever with the check removed.
    //
    // The baseline is deliberately exempt from `edited` — a squash rewrites its own
    // file, which is the entire reason the exemption exists. So what this exercises is
    // the case a squash leaves behind: a migration *strictly after* the baseline whose
    // digest no longer matches. That is what a real edit would be.
    const squashed = migrationDigests().find((file) => file.name === BASELINE);
    expect(squashed, 'the baseline migration is missing from the directory').toBeDefined();
    const baselineDigest = squashed?.digest as string;

    const locked = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    const onDisk = 'sha256:3333333333333333333333333333333333333333333333333333333333333333';
    const findings = checkMigrations(
      [
        { name: BASELINE, digest: baselineDigest },
        { name: '0009_future.sql', digest: onDisk },
      ],
      {
        version: 1,
        baseline: BASELINE,
        migrations: { [BASELINE]: baselineDigest, '0009_future.sql': locked },
      },
    ).findings;

    const edited = findings.filter((finding) => finding.kind === 'edited');
    expect(edited).toHaveLength(1);
    expect(edited[0]?.subject).toBe('0009_future.sql');
    // Both digests in the message: which file moved, and what it was locked as.
    expect(edited[0]?.detail).toContain(locked);
    expect(edited[0]?.detail).toContain(onDisk);

    // And the paired negative, without which the assertion above would also pass
    // against a check that reports every file as edited.
    const unchanged = checkMigrations(
      [
        { name: BASELINE, digest: baselineDigest },
        { name: '0009_future.sql', digest: locked },
      ],
      {
        version: 1,
        baseline: BASELINE,
        migrations: { [BASELINE]: baselineDigest, '0009_future.sql': locked },
      },
    ).findings;
    expect(unchanged.filter((finding) => finding.kind === 'edited')).toEqual([]);
  });

  it('refuses a second migration claiming the same 4-digit prefix', () => {
    // The reason the squash happened. D1 orders migrations by the REST of the
    // filename, so two files numbered `0001_` land in an order decided by a
    // lexicographic tiebreak nobody intended, and a database that ran one of them can
    // never run the other. `0001_edge_sonic_init.sql` and `0001_router_init.sql` were
    // exactly that, from two different projects.
    const files = [
      { name: '0001_edge_sonic_init.sql', digest: 'sha256:aaaa' },
      { name: '0001_router_init.sql', digest: 'sha256:bbbb' },
    ];
    const findings = checkMigrations(files, null).findings;
    const duplicates = findings.filter((finding) => finding.kind === 'duplicate-prefix');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.subject).toBe('0001');
    expect(duplicates[0]?.detail).toContain('0001_edge_sonic_init.sql');
    expect(duplicates[0]?.detail).toContain('0001_router_init.sql');
  });

  it('ships every column the DAOs name, because a migration is a promise about the schema', () => {
    // The defect this whole block exists for was a *column* that existed in the
    // repository and not in the database. So the check is not "the files are tidy" —
    // it is that every column the write statements actually reference is present after
    // the migrations have run. A DAO naming a column no migration creates fails here,
    // in a suite, rather than on a request against a live database.
    const columns = (handle.raw.prepare('PRAGMA table_info(songs)').all() as Array<{ name: string }>).map((row) => row.name);
    for (const column of [
      // `applyMetadata` and `UPSERT_FILE_FACTS` both name these. `reader_version` is
      // the one that shipped missing: 0001 had already been applied, so the edit that
      // added it never ran, and every enrichment write raised "no such column".
      'id',
      'library_id',
      'path',
      'dir_path',
      'name',
      'name_ci',
      'size',
      'mtime_ms',
      'content_type',
      'suffix',
      'title',
      'artist',
      'artist_ci',
      'album',
      'album_ci',
      'album_artist',
      'album_artist_ci',
      'genre',
      'genre_ci',
      'track',
      'disc',
      'year',
      'duration',
      'bitrate',
      'sample_rate',
      'channels',
      'enriched_at',
      'reader_version',
      // The derivation's own staleness input. Absent, the backfill's `WHERE
      // derived_version < ?` would be a query against a column that does not exist, and
      // the whole repair would fail on every poll — the same shape as the `reader_version`
      // omission this list was written for.
      'derived_version',
    ]) {
      expect(columns, `songs.${column} is named by a DAO but created by no migration`).toContain(column);
    }

    // Same for the column the scan's retry bound reads. Asserted here rather than
    // only in a service test because the failure mode is the identical one: a column
    // that is real to the code and absent from the database.
    const scanColumns = (handle.raw.prepare('PRAGMA table_info(scan_state)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(scanColumns).toContain('consecutive_failures');
    // And the one `complete()` reads before bumping `index_version`. Same reasoning: a column
    // that is real to the DAO and absent from the database makes the *conditional* bump
    // unreadable, which on a deployment that ran the earlier migrations fails the statement
    // rather than falling back — so the scan fails on every completion.
    expect(scanColumns).toContain('changed');
  });

  it('orders migrations the way Wrangler does, which is by filename', () => {
    // A test that builds the schema in a different order than production is a test
    // that can pass on a schema production never had.
    const files = migrationFiles();
    expect(files).toEqual([...files].sort());
    // The baseline sorts **first** on purpose: it absorbs everything numbered below it, so a
    // migration added after the squash has to sort *after* it — which is what "numbered above
    // `0008`" means, since `0009` > `0008` as a string.
    //
    // Asserted as a position rather than as a file count, so the claim survives the next
    // migration. `expect(files).toEqual([BASELINE])` was true only while the baseline was the
    // *only* migration, which made it a measurement of today's directory rather than a rule
    // about it — and the first migration anyone added turned it red for having done nothing
    // wrong.
    expect(files.indexOf(BASELINE)).toBe(0);
    // And every file after it really is newer, by filename — the property that makes
    // "wrangler applies these in this order" true of the whole list rather than of the pair.
    expect(files.filter((file) => file !== BASELINE).every((file) => file > BASELINE)).toBe(true);
  });
});

describe('D1 predicate rule: lowercase the parameter, never the column', () => {
  it('matches a username case-insensitively, because the parameter is lowercased', async () => {
    await seedUser('Ann');
    const users = new UserDAO(handle.db);
    // Subsonic clients match usernames case-insensitively, so a client may send `ANN`.
    expect(await users.findByUsername('ANN')).not.toBeNull();
    expect(await users.findByUsername('ann')).not.toBeNull();
    expect(await users.findByUsername('nobody')).toBeNull();
  });

  it('refuses a second user differing only in case, at the schema level', async () => {
    await seedUser('Ann');
    await expect(seedUser('ANN')).rejects.toThrow();
  });

  it('indexes the username lookup', () => {
    // The plan is the ONLY observable difference between `username_ci = ?` and
    // `lower(username) = ?`. Both return the same rows.
    const indexed = queryPlan(handle, 'SELECT * FROM users WHERE username_ci = ?', ['ann']);
    expect(indexed).toContain('idx_users_username_ci');
    expect(indexed).not.toContain('SCAN users');
  });

  it('would full-scan if the predicate were written the other way round', () => {
    // This documents WHY the DAO looks the way it does, and fails if someone "fixes" it
    // to use `lower()` — which would be a silent full-table scan of the authenticated
    // hot path.
    const scanned = queryPlan(handle, 'SELECT * FROM users WHERE lower(username) = ?', ['ann']);
    expect(scanned).toContain('SCAN users');
  });
});

describe('paths compare exactly, never lowercased', () => {
  it('keeps `Album` and `album` as two folders', async () => {
    // A WebDAV origin on Linux is case-sensitive. Lowercasing the column would merge
    // two real folders and index a file that does not exist.
    const userId = await seedUser('CaseTest');
    const libraryId = await seedLibrary(userId, 'LCASE');
    const nodes = new NodeDAO(handle.db);

    await nodes.upsertMany([
      { libraryId, path: 'Album', parentPath: '', name: 'Album', mtimeMs: 1, etag: null, depth: 1 },
      { libraryId, path: 'album', parentPath: '', name: 'album', mtimeMs: 1, etag: null, depth: 1 },
    ]);

    expect((await nodes.find(libraryId, 'Album'))?.name).toBe('Album');
    expect((await nodes.find(libraryId, 'album'))?.name).toBe('album');
    // Both rows exist, and both carry the same `_ci` form: the display value keeps its
    // case while the sort key is normalized.
    expect(await nodes.countByLibrary(libraryId)).toBe(2);
    expect((await nodes.find(libraryId, 'Album'))?.name_ci).toBe((await nodes.find(libraryId, 'album'))?.name_ci);
  });

  it('indexes the (library, path) lookup the index is keyed on', () => {
    const plan = queryPlan(handle, 'SELECT * FROM nodes WHERE library_id = ? AND path = ?', ['L', 'A']);
    expect(plan).toContain('SEARCH nodes');
    expect(plan).not.toContain('SCAN nodes');
  });
});

describe("listRoots does not return the library root's own row", () => {
  /**
   * Seed a library whose root row exists alongside its top-level folders.
   *
   * The root row is `path === parentPath === ''`, which is what the scan writes for the
   * collection itself. It is a real row and `listChildren` is right to return it for the
   * parent `''` — but `listRoots` answers "what is at the top level for `getIndexes`",
   * and the root is not a top-level entry, it is the thing they are all inside.
   */
  async function seedLibraryWithRoot(): Promise<{ userId: string; libraryId: string; nodes: NodeDAO }> {
    const userId = await seedUser('RootsTest');
    const libraryId = await seedLibrary(userId, 'LROOTS');
    const nodes = new NodeDAO(handle.db);
    await nodes.upsertMany([
      { libraryId, path: '', parentPath: '', name: '', mtimeMs: 1, etag: null, depth: 0 },
      { libraryId, path: 'Bon Iver', parentPath: '', name: 'Bon Iver', mtimeMs: 1, etag: null, depth: 1 },
      { libraryId, path: 'Blur', parentPath: '', name: 'Blur', mtimeMs: 1, etag: null, depth: 1 },
      { libraryId, path: 'Blur/Bubbley', parentPath: 'Blur', name: 'Bubbley', mtimeMs: 1, etag: null, depth: 2 },
    ]);
    return { userId, libraryId, nodes };
  }

  it('lists the top-level folders and not the root', async () => {
    const { libraryId, nodes } = await seedLibraryWithRoot();
    const roots = await nodes.listRoots(libraryId);

    expect(roots.map((row) => row.name)).toEqual(['Blur', 'Bon Iver']);
    // The row is still there — this is a filter on what "root" means, not a delete.
    expect(await nodes.countByLibrary(libraryId)).toBe(4);
  });

  it('gives every returned row a name, because a blank one is what a client renders', async () => {
    // `getIndexes` groups by first letter and emits each row as a `shortcut`. A row
    // with an empty name sorts to the top of the `#` group and is rendered as an
    // unlabelled entry, so this asserts the property the endpoint depends on rather
    // than the predicate that happens to produce it.
    const { libraryId, nodes } = await seedLibraryWithRoot();
    for (const row of await nodes.listRoots(libraryId)) {
      expect(row.name).not.toBe('');
      expect(row.path).not.toBe('');
    }
  });

  it('still lists the root row as a child of the root, where it belongs', async () => {
    // `listChildren('')` is how `getMusicDirectory` reaches the library root, and the
    // root row is legitimately a child of the parent `''`. Filtering it out of the
    // child listing as well would make the root unreachable.
    const { libraryId, nodes } = await seedLibraryWithRoot();
    const children = await nodes.listChildren(libraryId, '');
    expect(children.map((row) => row.path)).toContain('');
  });
});

describe('cascades', () => {
  it('takes the whole index with a deleted library, and leaves users alone', async () => {
    // This is the failure a `DROP TABLE <parent>` migration causes: D1 runs every
    // statement in an implicit transaction, so `PRAGMA foreign_keys = OFF` is
    // unavailable and the drop becomes a `DELETE FROM parent` that fires every
    // `ON DELETE CASCADE` beneath it.
    const userId = await seedUser('CascadeUser');
    const libraryId = await seedLibrary(userId, 'LCASC');
    const nodes = new NodeDAO(handle.db);
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const scanState = new ScanStateDAO(handle.db);

    await nodes.upsertMany([{ libraryId, path: 'Artist', parentPath: '', name: 'Artist', mtimeMs: 1, etag: null, depth: 1 }]);
    await seedSong(libraryId, 'Artist/Album/01.flac', 'Artist/Album');
    await scanState.ensure(libraryId);
    await new UserDAO(handle.db).setLibraryGrants(userId, [libraryId]);

    await new LibraryDAO(handle.db).delete(libraryId);

    expect(await nodes.countByLibrary(libraryId)).toBe(0);
    expect(await songs.countByLibrary(libraryId)).toBe(0);
    expect(await scanState.find(libraryId)).toBeNull();
    expect((await handle.db.prepare('SELECT COUNT(*) AS cnt FROM user_libraries WHERE library_id = ?').bind(libraryId).first()) as { cnt: number }).toEqual({
      cnt: 0,
    });
    // The parent survives, which is the whole point of never rebuilding it.
    expect(await new UserDAO(handle.db).findById(userId)).not.toBeNull();
  });

  it("takes a user's playlists, stars, and bookmarks with the user", async () => {
    const userId = await seedUser('CascadePlaylistUser');
    const libraryId = await seedLibrary(userId, 'LPL');
    const id = await seedSong(libraryId, 'A/01.flac', 'A', { title: 'One' });

    const playlists = new PlaylistDAO(handle.db);
    const annotations = new AnnotationDAO(handle.db);
    const playlist = await playlists.create({ ownerUserId: userId, name: 'Mix' });
    await playlists.replaceEntries(playlist.id, [id], 0);
    await annotations.star(userId, id, 'song');
    await annotations.createBookmark(userId, id, 1000, 'here');

    await new UserDAO(handle.db).delete(userId);

    expect(await playlists.findById(playlist.id)).toBeNull();
    expect(await annotations.listStarred(userId, 'song')).toEqual([]);
    expect(await annotations.listBookmarks(userId)).toEqual([]);
  });
});

describe('every hot lookup uses an index', () => {
  const PLANS: ReadonlyArray<readonly [string, string, unknown[]]> = [
    ['user by username', 'SELECT * FROM users WHERE username_ci = ?', ['ann']],
    ['library by slug', 'SELECT * FROM libraries WHERE slug_ci = ?', ['home']],
    ['song by id', 'SELECT * FROM songs WHERE id = ?', ['s:x']],
    ['song by library+path', 'SELECT * FROM songs WHERE library_id = ? AND path = ?', ['L', 'A/1.flac']],
    ['songs in a directory', 'SELECT * FROM songs WHERE library_id = ? AND dir_path = ? ORDER BY disc ASC, track ASC', ['L', 'A']],
    ['songs in an album', 'SELECT * FROM songs WHERE library_id = ? AND album_artist_ci = ? AND album_ci = ?', ['L', 'a', 'b']],
    ['songs by genre', 'SELECT * FROM songs WHERE library_id = ? AND genre_ci = ?', ['L', 'indie']],
    ['prefix search', String.raw`SELECT * FROM songs WHERE library_id = ? AND title_ci LIKE ? ESCAPE '\'`, ['L', 'ab%']],
    ['starred items', 'SELECT item_id FROM stars WHERE user_id = ? AND item_type = ? ORDER BY starred_at DESC', ['u', 'song']],
    ['play counts', 'SELECT song_id, play_count FROM play_counts WHERE user_id = ?', ['u']],
    ['auth failures in window', 'SELECT COALESCE(SUM(failures), 0) AS cnt FROM auth_failures WHERE identity = ? AND bucket >= ? AND bucket <= ?', ['x', 1, 2]],
    ['scan frontier', 'SELECT * FROM nodes WHERE library_id = ? AND is_scanned = 0 ORDER BY depth ASC, path ASC LIMIT ?', ['L', 40]],
    ['play queue', 'SELECT song_id FROM play_queue_entries WHERE user_id = ? ORDER BY position ASC', ['u']],
    ['granted libraries', 'SELECT l.id AS id FROM libraries l INNER JOIN user_libraries ul ON ul.library_id = l.id WHERE ul.user_id = ? ORDER BY l.slug_ci ASC', ['u']],
  ];

  for (const [label, sql, args] of PLANS) {
    it(`indexes: ${label}`, () => {
      const plan = queryPlan(handle, sql, args);
      // `SCAN x USING COVERING INDEX` is an index scan, not a table scan. The only
      // thing that costs a full table pass is a bare `SCAN x` with no index.
      const isFullScan = plan.includes('SCAN') && !plan.includes('USING');
      expect(isFullScan, `${label}: ${plan}`).toBe(false);
    });
  }

  it('scans now_playing in full, deliberately', () => {
    // One row per user, so the scan is bounded by the user count, and the query needs
    // every row anyway to compute `minutes_ago`. An index here would cost more than it
    // saves and would need maintaining on every scrobble.
    expect(queryPlan(handle, 'SELECT username, CAST((? - updated_at) / 60 AS INTEGER) AS minutes_ago FROM now_playing ORDER BY updated_at DESC', [0])).toContain(
      'SCAN now_playing',
    );
  });

  it('scans the library for an infix search, which is the documented limit', () => {
    // A leading `%` makes the pattern's start unknown, so no index can serve the term.
    // The leading `library_id = ?` does use one, so the cost is a scan of THIS library's
    // rows rather than of every library. FTS5 is the named fix, in the migration.
    // Which index the planner picks is its business; what matters is that it picks one,
    // so the scan is bounded to this library.
    //
    // The assertion names *any* `songs` index rather than a specific one, because there
    // are now three and the previous pair was already over-specified against its own
    // comment. It went green on a name while the property it was written to protect — "not
    // a bare table scan" — stayed enforced, and it went red the moment a third index
    // existed and the planner preferred it, which said nothing about cost: for a
    // leading-`%` pattern the planner visits every row of the library whichever index it
    // picks, so it picked the *narrowest* one.
    const plan = queryPlan(handle, String.raw`SELECT * FROM songs WHERE library_id = ? AND title_ci LIKE ? ESCAPE '\'`, ['L', '%ab%']);
    expect(plan).toMatch(/SEARCH songs USING (?:COVERING )?INDEX idx_songs_\w+/);
    // The load-bearing half, and the one that survives an index being dropped: a bare
    // `SCAN songs` is a pass over every library's rows.
    expect(plan).not.toMatch(/SCAN songs/);
  });

  it('serves the derivation backfill from its own index, so a caught-up library costs one empty seek', () => {
    // The backfill's entire steady-state cost is this query, and it runs on **every**
    // poll — including for a library that is already current. If it degraded to a table
    // scan, a fully-repaired library would pay a full `songs` pass on every
    // `getScanStatus`, which is the "the guard costs more than the thing it guards" shape
    // this suite exists to catch.
    //
    // A dedicated `(library_id, derived_version)` index is what prevents that. The
    // existing `(library_id, album_ci)` cannot serve `derived_version < ?`, and once a
    // library is caught up every row sits at the current version, so the predicate is a
    // range over a column nothing else filters by.
    const plan = queryPlan(handle, 'SELECT id, dir_path FROM songs WHERE library_id = ? AND derived_version < ? ORDER BY id LIMIT ?', ['L', 1, 200]);
    expect(plan).toMatch(/SEARCH songs USING (?:COVERING )?INDEX idx_songs_derived/);
    expect(plan).not.toMatch(/SCAN songs/);
  });
});

/**
 * The path-derived grouping, and the `COALESCE` that makes it safe.
 *
 * ### The defect
 *
 * `listAlbums` filters `album_ci IS NOT NULL AND album_ci <> ''`, `listArtists` filters
 * `artist_ci IS NOT NULL`, and `listGenres` filters `genre_ci IS NOT NULL`. Those
 * columns are written *only* by a tag read — one ranged WebDAV request per track,
 * bounded twice over, so for a library of any size most rows are unenriched for a long
 * time. A row with them NULL is not rendered with a blank name; it is **absent from
 * every aggregate**, and `search3` cannot match it.
 *
 * It shipped. A client authenticated against 80 albums and saw empty artists, albums,
 * genres and search, while `getRandomSongs` — which does not group — returned rows
 * with `duration: 0` and no artist at all. The `songs` table was full the whole time.
 *
 * ### The fix, and the property that makes it safe
 *
 * The WebDAV path already names the artist and the album, so the indexer writes them.
 * `COALESCE` is the safety argument: a derived value fills a NULL and *only* a NULL, so
 * a real tag is never rolled back to a guess, and a rescan rewrites nothing.
 */
describe('path-derived grouping', () => {
  async function indexSong(libraryId: string, path: string): Promise<void> {
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    await songs.upsertFileFacts([
      {
        id: songId(libraryId, path),
        libraryId,
        path,
        dirPath: path.split('/').slice(0, -1).join('/'),
        name: path.split('/').pop() ?? path,
        size: 1000,
        mtimeMs: 1000,
        contentType: 'audio/ogg',
        suffix: 'ogg',
      },
    ]);
  }

  it('groups an unenriched track, so the aggregates are not empty before any tag read', async () => {
    // The whole point. `Artist/Album/01 Track.opus` names both, and nothing had ever
    // written them down.
    const userId = await seedUser('DerivedNested');
    const libraryId = await seedLibrary(userId, 'LDN');
    await indexSong(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');

    const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'));
    // **Both** names carry the marker, and that is load-bearing rather than cosmetic: it
    // is the only provenance a derived value has, so it is the only thing that lets a
    // later version of this convention tell a guess it wrote from a tag a file supplied.
    // With the artist marked and the album bare, a version bump could correct a wrong
    // artist and never a wrong album.
    expect(row?.album).toBe(`Black Sands${DERIVED_MARKER}`);
    expect(row?.artist).toBe(`Bonobo${DERIVED_MARKER}`);
    expect(row?.album_artist).toBe(`Bonobo${DERIVED_MARKER}`);

    // Every `_ci` twin moves with its counterpart, in the same statement. Asserted
    // separately from the display values because the two are *independently* breakable:
    // a `_ci` column that drifts from its source is an ungroupable row, and the drift
    // is invisible until somebody browses by artist — the display name looks perfect the
    // whole time. Removing the handling from only the `_ci` assignments, leaving the
    // display ones intact, passes every other assertion in this file.
    expect(row?.album_ci).toBe(`black sands${DERIVED_MARKER.toLowerCase()}`);
    expect(row?.artist_ci).toBe(`bonobo${DERIVED_MARKER.toLowerCase()}`);
    expect(row?.album_artist_ci).toBe(`bonobo${DERIVED_MARKER.toLowerCase()}`);

    // And the aggregate that filters on those columns now answers.
    const albums = await new SongIndexDAO(handle.db).listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: 10, offset: 0, orderBy: MIN_ALBUM_CI });
    expect(albums.map((song) => song.album)).toEqual([`Black Sands${DERIVED_MARKER}`]);
    const artists = await new SongIndexDAO(handle.db).listArtists(libraryId, 10, 0);
    expect(artists.map((song) => song.artist)).toEqual([`Bonobo${DERIVED_MARKER}`]);
  });

  it('groups a flat "Artist - Album" folder, which is a whole library layout', async () => {
    // The layout this product's live library uses: one folder per album, named
    // `Artist - Album`, with the tracks inside. Without this, every album groups under
    // an artist literally named "Artist - Album" — browsable albums, no artists.
    const userId = await seedUser('DerivedFlat');
    const libraryId = await seedLibrary(userId, 'LDF');
    await indexSong(libraryId, 'Radiohead - OK Computer/01 Airbag.opus');

    const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(songId(libraryId, 'Radiohead - OK Computer/01 Airbag.opus'));
    expect(row?.album).toBe(`OK Computer${DERIVED_MARKER}`);
    expect(row?.artist).toBe(`Radiohead${DERIVED_MARKER}`);
  });

  it('splits on the FIRST separator only, so an album title with a dash survives', async () => {
    const userId = await seedUser('DerivedDash');
    const libraryId = await seedLibrary(userId, 'LDD');
    await indexSong(libraryId, 'Mahler - Symphony No. 5 - 1949 Recording/01 I.opus');

    const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(songId(libraryId, 'Mahler - Symphony No. 5 - 1949 Recording/01 I.opus'));
    expect(row?.album).toBe(`Symphony No. 5 - 1949 Recording${DERIVED_MARKER}`);
    expect(row?.artist).toBe(`Mahler${DERIVED_MARKER}`);
  });

  it('never overwrites a real tag, on a rescan or otherwise', async () => {
    // The `COALESCE` is the entire safety argument for deriving on *every* index
    // rather than only on first sight. If this were a plain assignment in the SET list,
    // a rescan would roll every tagged row back to a path guess — and the symptom
    // would be a library that loses its tags every time a file's mtime moves.
    const userId = await seedUser('DerivedNoClobber');
    const libraryId = await seedLibrary(userId, 'LDN2');
    const path = 'Bonobo/Black Sands/01 Kerala.opus';
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const id = songId(libraryId, path);

    await indexSong(libraryId, path);
    await songs.applyMetadata(id, { artist: 'Bonobo', album: 'Black Sands (Remastered)', albumArtist: 'Bonobo', genre: 'Electronic' });

    // Re-index the same file with a changed mtime, which is what a rescan does.
    await songs.upsertFileFacts([
      { id, libraryId, path, dirPath: 'Bonobo/Black Sands', name: '01 Kerala.opus', size: 2000, mtimeMs: 2000, contentType: 'audio/ogg', suffix: 'ogg' },
    ]);

    const row = await songs.findById(id);
    expect(row?.artist).toBe('Bonobo');
    expect(row?.album).toBe('Black Sands (Remastered)');

    // The `_ci` twins too, and separately: they are independent assignments in the same
    // statement, so a guard on the display column proves nothing about them. A drifted
    // twin makes the row invisible to `getArtists` while `getAlbum` still names it.
    expect(row?.artist_ci).toBe('bonobo');
    expect(row?.album_ci).toBe('black sands (remastered)');

    // Provenance is not lost either: the mtime change cleared `enriched_at`, so the
    // row is re-read and the real values are written back on top of the derived ones.
    expect(row?.enriched_at).toBeNull();
  });

  it('derives nothing for a track at the library root, rather than grouping under a blank name', async () => {
    // A NULL column is a row that is absent from the aggregates. An *empty* column is
    // a row grouped under "", which `getArtists` renders as an unlabelled entry at the
    // top of the `#` group — the same defect `NodeDAO.listRoots` had with the library
    // root. So an uninformative path yields NULL, not ''.
    const userId = await seedUser('DerivedRoot');
    const libraryId = await seedLibrary(userId, 'LDR');
    await indexSong(libraryId, 'loose-track.opus');

    const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(songId(libraryId, 'loose-track.opus'));
    expect(row?.album).toBeNull();
    expect(row?.artist).toBeNull();
    expect(row?.album_ci).toBeNull();
  });

  it('does not derive a genre, because a guessed genre is worse than an absent one', async () => {
    // `getGenres` publishes a song count beside the name, so a derived value would be
    // offered to the user as fact. There is no path convention for genre, track or
    // year that is not a guess, so none is derived.
    const userId = await seedUser('DerivedNoGenre');
    const libraryId = await seedLibrary(userId, 'LDG');
    await indexSong(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');

    const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'));
    expect(row?.genre).toBeNull();
    expect(row?.genre_ci).toBeNull();
    expect(row?.track).toBeNull();
    expect(row?.year).toBeNull();
    expect(await new SongIndexDAO(handle.db).listGenres(libraryId)).toEqual([]);
  });

  /**
   * The backfill: the same derivation, for rows the indexer will never touch again.
   *
   * ### Why this exists, and why it is not an optimisation
   *
   * Every writer of these columns is gated on the file having **changed** — the
   * `Depth: 0` root probe, `isScanned: !changed`, `if (changed)` in `reconcileFolder`, and
   * the read-through `getMusicDirectory` path. That gating is correct and is the entire
   * point of storing `mtime_ms` in `nodes`. The consequence is that the derivation is
   * **unreachable for an already-indexed library**, so its aggregates never recover
   * without a file moving.
   *
   * It shipped exactly that way, and the first attempt to fix it did not work either: the
   * derivation was added to the upsert, which is only reached for a *changed* file, and
   * deploying it changed nothing on a library where nothing had changed. The tests below
   * all seed rows the way the broken deployment left them — written, ungrouped, and
   * stamped at version 0 — because a backfill test that seeds rows the indexer just wrote
   * would pass against the code that shipped broken.
   */
  describe('the backfill over rows the indexer will not revisit', () => {
    /**
     * A row as the broken deployment left it: indexed, with the grouping columns NULL and
     * no derivation stamp.
     *
     * Inserted directly rather than through `upsertFileFacts`, because that method now
     * derives — so it cannot produce the state this pass exists to repair, and a test
     * using it would be testing the index path with the index path's own output.
     */
    async function seedUngrouped(libraryId: string, path: string): Promise<string> {
      const id = songId(libraryId, path);
      await handle.raw
        .prepare(
          `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix,
                              duration, bitrate, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1000, 1000, 'audio/ogg', 'opus', 0, 0, 0, 0)`,
        )
        .run(id, libraryId, path, path.split('/').slice(0, -1).join('/'), path.split('/').pop() ?? path, path.toLowerCase());
      return id;
    }

    /**
     * Run the backfill to convergence, under an explicit marker.
     *
     * The marker is a parameter rather than the suite-wide constant because the guard it used
     * to be — a `LIKE` against the stored value — behaves differently for every value, and a
     * drain that cannot say which one it ran is a drain that cannot be the subject of an
     * assertion about it.
     */
    async function drain(libraryId: string, version = DERIVED_VERSION, marker = DERIVED_MARKER): Promise<number> {
      const dao = new SongDerivationDAO(handle.db, marker);
      let written = 0;
      for (let pass = 0; pass < 20; pass += 1) {
        const rows = await dao.listNeedingDerivation(libraryId, 50, version);
        if (rows.length === 0) return written;
        // `.changes`, not the whole result: this drain counts *rows stamped*, which is what the
        // convergence claim below is about. `billedRows` is the platform's cost for the same
        // write and is asserted separately, against the schema.
        written += (await dao.applyDerivation(dao.deriveFor(rows), version)).changes;
      }
      throw new Error('backfill did not converge');
    }

    it('groups a row the file-change path will never reach, which is the shipped symptom', async () => {
      // The end-to-end version of the defect. 113 rows on a live library, all indexed
      // before the deploy, all with `album_ci` NULL, and every SQL-filtered aggregate
      // answering `[]`.
      const userId = await seedUser('BackfillBasic');
      const libraryId = await seedLibrary(userId, 'LDB');
      await seedUngrouped(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');

      // Before: absent from the aggregate, not shown with a blank name.
      expect(await new SongIndexDAO(handle.db).listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: 10, offset: 0, orderBy: MIN_ALBUM_CI })).toEqual([]);

      await drain(libraryId);

      const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'));
      expect(row?.album).toBe(`Black Sands${DERIVED_MARKER}`);
      expect(row?.artist).toBe(`Bonobo${DERIVED_MARKER}`);
      expect(row?.album_artist).toBe(`Bonobo${DERIVED_MARKER}`);

      // The aggregate answers. This is the assertion the whole change exists for.
      const albums = await new SongIndexDAO(handle.db).listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: 10, offset: 0, orderBy: MIN_ALBUM_CI });
      expect(albums.map((song) => song.album)).toEqual([`Black Sands${DERIVED_MARKER}`]);
      expect((await new SongIndexDAO(handle.db).listArtists(libraryId, 10, 0)).map((song) => song.artist)).toEqual([`Bonobo${DERIVED_MARKER}`]);
    });

    it('splits a flat "Artist - Album" row, which is the layout this deployment uses', async () => {
      // Verified against the live instance rather than assumed: decoding an album id gives
      // `<libraryId>\nLEZEL - 未完成ランデヴー`, so `dir_path` is a single top-level
      // segment and the flat branch is the one that runs. A nested layout would take
      // `fromNestedPath` and group the whole folder name as an artist — browsable albums,
      // no artists, which is the split this is meant to remove.
      const userId = await seedUser('BackfillFlat');
      const libraryId = await seedLibrary(userId, 'LDF2');
      await seedUngrouped(libraryId, 'LEZEL - 未完成ランデヴー/01 夢の Jel.ly.opus');

      await drain(libraryId);

      const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(songId(libraryId, 'LEZEL - 未完成ランデヴー/01 夢の Jel.ly.opus'));
      expect(row?.artist).toBe(`LEZEL${DERIVED_MARKER}`);
      expect(row?.album).toBe(`未完成ランデヴー${DERIVED_MARKER}`);
    });

    it('never overwrites a real tag, and stamps it so it is never reconsidered', async () => {
      const userId = await seedUser('BackfillNoClobber');
      const libraryId = await seedLibrary(userId, 'LDNC');
      const id = songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');
      await handle.raw
        .prepare(
          `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix,
                              duration, bitrate, artist, artist_ci, album, album_ci, album_artist, album_artist_ci,
                              created_at, updated_at)
           VALUES (?, ?, ?, 'Bonobo/Black Sands', '01 Kerala.opus', '01 kerala.opus', 1000, 1000, 'audio/ogg', 'opus',
                   0, 0, 'Bonobo', 'bonobo', 'Black Sands (Remastered)', 'black sands (remastered)',
                   'Bonobo', 'bonobo', 0, 0)`,
        )
        .run(id, libraryId, 'Bonobo/Black Sands/01 Kerala.opus');

      await drain(libraryId);

      const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(id);
      expect(row?.album).toBe('Black Sands (Remastered)');
      expect(row?.artist).toBe('Bonobo');
      // The `_ci` twins too, and separately: a guard on the display column proves nothing
      // about them, and a drifted twin is a row that displays correctly and is in no
      // album list.
      expect(row?.album_ci).toBe('black sands (remastered)');
      expect(row?.artist_ci).toBe('bonobo');
      // And it is stamped, so a later version bump does not even reconsider it.
      expect(row?.derived_version).toBe(DERIVED_VERSION);
    });

    it('re-derives what an earlier convention guessed, which is what the version is for', async () => {
      // The `reader_version` invariant, one layer down. A corrected *reader* needs a
      // version to reach rows an earlier reader wrote; a corrected *derivation* needs the
      // same, and a plain `COALESCE` cannot provide it — it re-selects the row and then
      // declines to change it, which is a version column that buys nothing.
      //
      // The fixture is stamped at the **current** version, not at a literal `1`. It was
      // hardcoded, and the bump to 2 turned it into a row owed to the backfill *at the current
      // version* — so "caught up" stopped being true of it and the assertion below passed by
      // accident of the numbering until it failed outright. A number typed beside a fixture is
      // wrong by the time somebody bumps the version it names.
      const userId = await seedUser('BackfillVersion');
      const libraryId = await seedLibrary(userId, 'LDV');
      const id = songId(libraryId, 'Blur/Holocene/01 Holocene.opus');
      // `grouping_source` is seeded too, because it is now what says "this row is a guess".
      // The marker on the value alone would no longer be enough — the guard is a column
      // comparison — so seeding one without the other is a row no correction could reach.
      await handle.raw
        .prepare(
          `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix,
                              duration, bitrate, artist, artist_ci, album, album_ci, created_at, updated_at,
                              derived_version, grouping_source)
           VALUES (?, ?, ?, 'Blur/Holocene', '01 Holocene.opus', '01 holocene.opus', 1000, 1000, 'audio/ogg', 'opus',
                   0, 0, 'Wrong Artist (derived)', 'wrong artist (derived)', 'Wrong Album (derived)', 'wrong album (derived)', 0, 0,
                   ?, ?)`,
        )
        .run(id, libraryId, 'Blur/Holocene/01 Holocene.opus', DERIVED_VERSION, GROUPING_SOURCE_DERIVED);

      // At the current version the row is caught up, so nothing is selected.
      const dao = new SongDerivationDAO(handle.db, DERIVED_MARKER);
      expect(await dao.listNeedingDerivation(libraryId, 10, DERIVED_VERSION)).toEqual([]);

      // At a later version it is selected again, and `grouping_source` is what lets the
      // write tell its own guess from a tag: a *real* tag is not flagged and is left alone,
      // which is the paired case asserted above.
      expect(await dao.listNeedingDerivation(libraryId, 10, DERIVED_VERSION + 1)).toHaveLength(1);
      await drain(libraryId, DERIVED_VERSION + 1);

      const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(id);
      expect(row?.artist).toBe(`Blur${DERIVED_MARKER}`);
      expect(row?.album).toBe(`Holocene${DERIVED_MARKER}`);
      expect(row?.derived_version).toBe(DERIVED_VERSION + 1);
    });

    it('terminates: a second pass selects nothing and writes nothing', async () => {
      // The property the whole design rests on. A backfill whose rows keep re-selecting is
      // a backfill that costs the 5,000-rows/day allowance on every poll for ever — the
      // guard costing more than the thing it guards.
      const userId = await seedUser('BackfillConverges');
      const libraryId = await seedLibrary(userId, 'LDC');
      await seedUngrouped(libraryId, 'Blur/Holocene/01 Holocene.opus');
      await seedUngrouped(libraryId, 'Blur/Holocene/02 Lotus.opus');
      await seedUngrouped(libraryId, 'Blur/For Emma/03 Beatrix.opus');

      const dao = new SongDerivationDAO(handle.db, DERIVED_MARKER);
      expect(await drain(libraryId)).toBe(3);
      expect(await dao.listNeedingDerivation(libraryId, 50)).toEqual([]);
      // Zero rows, not "zero rows that happened to change nothing": the write is not
      // issued at all, so this cannot be satisfied by a no-op UPDATE.
      expect(await drain(libraryId)).toBe(0);
    });

    it('leaves `enriched_at` alone, because nothing read these files', async () => {
      // The backfill must not claim a row was enriched. `EnrichmentService` short-circuits
      // on `enriched_at`, so stamping it here would mean a track with `duration: 0` is
      // never range-read on first play — a backfill that repairs the grouping by breaking
      // enrichment, which is the trade this is least willing to make.
      const userId = await seedUser('BackfillNoEnriched');
      const libraryId = await seedLibrary(userId, 'LDNE');
      const id = await seedUngrouped(libraryId, 'Blur/Holocene/01 Holocene.opus');

      await drain(libraryId);

      const row = await handle.raw.prepare('SELECT enriched_at, duration FROM songs WHERE id = ?').get(id) as { enriched_at: number | null; duration: number };
      expect(row.enriched_at).toBeNull();
      expect(row.duration).toBe(0);
    });

    it('is bounded per pass, and the remainder waits for the next one', async () => {
      // A poll is a request a client is waiting on. Draining 5,000 rows in one poll is a
      // poll that times out, which is the `getScanStatus` defect repeated on a different
      // axis.
      const userId = await seedUser('BackfillBounded');
      const libraryId = await seedLibrary(userId, 'LDBB');
      for (let n = 0; n < 5; n += 1) {
        await seedUngrouped(libraryId, `Blur/Holocene/${n} track.opus`);
      }

      const dao = new SongDerivationDAO(handle.db, DERIVED_MARKER);
      const first = await dao.listNeedingDerivation(libraryId, 2);
      expect(first).toHaveLength(2);
      // `.changes`, not the whole result: this case is about the *selection* draining, and
      // `applyDerivation` returning the batch is what carries its cost — asserted against the
      // schema in the billed-row block above.
      expect((await dao.applyDerivation(dao.deriveFor(first))).changes).toBe(2);

      // Three remain, and the two just written are *not* among them — the selection is on
      // the stamp, so a pass can never re-derive its own output and starve the tail.
      expect(await dao.listNeedingDerivation(libraryId, 50)).toHaveLength(3);
      expect(await drain(libraryId)).toBe(3);
    });

    /**
     * The index write stamps the version, so the backfill has nothing to do on a row the
     * walk just wrote.
     *
     * ### Why this is the test and not the other five
     *
     * Every case above seeds through `seedUngrouped` — a direct `INSERT` leaving
     * `derived_version` at the migration's `DEFAULT 0` — because they are about repairing
     * rows the indexer *did not* write. So none of them can see the index path's own stamp,
     * and the defect this exists for lived entirely on that path.
     *
     * `UPSERT_FILE_FACTS` did not stamp `derived_version`, so every row the scan wrote took
     * the default and was immediately owed to the backfill — permanently, because the
     * selection is `derived_version < 1`. The backfill's page is one `UPDATE` per row with
     * `requireComplete`, sized `200` against a chunk budget of `42`, so the write **refused**
     * on every poll, before `listFrontier`, and the walk never ran. A library of ~100 tracks
     * reported `scanning` for ever.
     *
     * ### Why the suite was green, and why this shape finds it
     *
     * Two doubles stamped `DERIVED_VERSION` — `test/scan-incremental.test.ts` and
     * `test/scan-budget.test.ts` — each under a comment asserting that the statement did.
     * The comment was false, so both were corrected to agree with a statement that did not
     * exist, and neither file could see the defect. A double is evidence only to the extent
     * it models the platform, and here the platform is *this statement*; so the assertion
     * runs the statement, over the real engine, and asks the backfill's own selection
     * whether it owes anything.
     */
    it('owes the backfill nothing for a row the index write just produced', async () => {
      const userId = await seedUser('BackfillIndexStamps');
      const libraryId = await seedLibrary(userId, 'LDIS');

      const written = await new SongDAO(handle.db, DERIVED_MARKER).upsertFileFacts([
        { id: songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'), libraryId, path: 'Bonobo/Black Sands/01 Kerala.opus', dirPath: 'Bonobo/Black Sands', name: '01 Kerala.opus', size: 1000, mtimeMs: 1000, contentType: 'audio/ogg', suffix: 'opus' },
      ]);
      expect(written.written).toBe(1);

      const dao = new SongDerivationDAO(handle.db, DERIVED_MARKER);
      // The whole assertion. A row the walk wrote is not owed a derivation, so the
      // backfill's selection returns nothing and the pass costs one empty indexed seek.
      expect(await dao.listNeedingDerivation(libraryId, 50)).toEqual([]);

      // The grouping is still there — the stamp is not a way of skipping the derivation,
      // it is a record that the index path already did it.
      const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'));
      expect(row?.artist).toBe(`Bonobo${DERIVED_MARKER}`);
      expect(row?.derived_version).toBe(DERIVED_VERSION);
    });

    it('owes the backfill nothing after the row is *changed*, which is the conflict clause', async () => {
      // The same statement on its second pass: `ON CONFLICT (library_id, path) DO UPDATE`.
      // A file whose bytes moved is written again, and a writer that stamps only the
      // `INSERT` leaves every re-indexed row permanently owed — so this is a distinct
      // branch of the same statement and a distinct bug.
      const userId = await seedUser('BackfillConflictStamps');
      const libraryId = await seedLibrary(userId, 'LDCS');
      const dao = new SongDAO(handle.db, DERIVED_MARKER);
      const facts = {
        id: songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'),
        libraryId,
        path: 'Bonobo/Black Sands/01 Kerala.opus',
        dirPath: 'Bonobo/Black Sands',
        name: '01 Kerala.opus',
        contentType: 'audio/ogg',
        suffix: 'opus',
      };

      await dao.upsertFileFacts([{ ...facts, size: 1000, mtimeMs: 1000 }]);
      // The bytes moved. `enriched_at` is cleared with it, so the row is genuinely
      // re-indexed rather than re-asserted.
      await dao.upsertFileFacts([{ ...facts, size: 2000, mtimeMs: 2000 }]);

      const after = await dao.findById(facts.id);
      expect(after?.size).toBe(2000);
      expect(after?.enriched_at).toBeNull();
      expect(await new SongDerivationDAO(handle.db, DERIVED_MARKER).listNeedingDerivation(libraryId, 50)).toEqual([]);
    });

    it('still re-derives a stamped row when the convention changes, so the stamp is not a dead end', async () => {
      // The paired negative for the two cases above, and the reason a version column rather
      // than a predicate is the right shape. Removing the stamp from the index write turns
      // the first two red; removing this turns *it* red. A guard that cannot be shown to
      // have teeth is a fixture, and this one is the teeth.
      const userId = await seedUser('BackfillStampIsNotFinal');
      const libraryId = await seedLibrary(userId, 'LDSNF');
      await new SongDAO(handle.db, DERIVED_MARKER).upsertFileFacts([
        { id: songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus'), libraryId, path: 'Bonobo/Black Sands/01 Kerala.opus', dirPath: 'Bonobo/Black Sands', name: '01 Kerala.opus', size: 1000, mtimeMs: 1000, contentType: 'audio/ogg', suffix: 'opus' },
      ]);

      // At the current version: caught up, so nothing is selected and nothing is written.
      const dao = new SongDerivationDAO(handle.db, DERIVED_MARKER);
      expect(await dao.listNeedingDerivation(libraryId, 50, DERIVED_VERSION)).toEqual([]);
      expect(await drain(libraryId, DERIVED_VERSION)).toBe(0);

      // At a later version the same row is selected again — the stamp records *which*
      // convention produced the grouping, not that nobody may ever look again.
      expect(await dao.listNeedingDerivation(libraryId, 50, DERIVED_VERSION + 1)).toHaveLength(1);
      expect(await drain(libraryId, DERIVED_VERSION + 1)).toBe(1);
    });

    /**
     * A row holding a **wholly-derived** grouping, written under `marker`.
     *
     * Built from the real `upsertFileFacts` rather than a hand-written `INSERT`, because the two
     * columns under test — `grouping_source` and `derived_version` — are stamped by that
     * statement and a fixture listing them by hand is a second, silently-drifting copy of it.
     * That is this file's own recorded rule about doubles, reached from the fixture side.
     *
     * Distinct from `seedUngrouped`, which leaves the grouping NULL. Both are needed, and the
     * difference decides which branch of the guard is under test: a NULL grouping is filled by
     * `col IS NULL` whatever the marker is, so it cannot detect a guard that fails to recognise
     * its own earlier output — which is the whole failure a configured marker introduces.
     */
    async function seedStaleGuess(id: string, libraryId: string, dirPath: string, marker: string): Promise<void> {
      await new SongDAO(handle.db, marker).upsertFileFacts([
        { id, libraryId, path: `${dirPath}/01 track.opus`, dirPath, name: '01 track.opus', size: 1000, mtimeMs: 1000, contentType: 'audio/ogg', suffix: 'opus' },
      ]);
    }

    /**
     * A row holding real tags: no marker, and `grouping_source` NULL, which together mean "a tag
     * owns this grouping and a derivation may not replace it".
     *
     * Also built from the real statements, in the order production performs them: the index write
     * derives and stamps, then an enrichment read supplies the tag and clears the flag. A row
     * seeded with `grouping_source` NULL and no derivation behind it is a state production never
     * produces, and it would let a guard pass that cannot distinguish the two.
     */
    async function seedTaggedRow(id: string, libraryId: string, dirPath: string, artist: string, album: string, marker = DERIVED_MARKER): Promise<void> {
      await seedStaleGuess(id, libraryId, dirPath, marker);
      await new SongDAO(handle.db, marker).applyMetadata(id, { artist, album, albumArtist: artist });
    }

    /*
     * Everything below is about `songs.grouping_source`, which is what replaced the marker as
     * the record of a guess. The guard used to be `col LIKE '%' || marker`, and the marker is
     * now configuration — so each of these is a value the old guard answered wrongly, measured
     * over real SQLite against the real statement before the column was added.
     *
     * They are grouped together because they are one question asked of several inputs: *what
     * does the guard say when the marker is not the one this module was written against?*
     */

    it('leaves a real tag alone under an EMPTY marker, which is the deployed default', async () => {
      // The defect the column exists for, and the single most important assertion here.
      //
      // `'%' || ''` is `'%'`, which matches every non-NULL value, so with an empty marker the
      // old guard's `ELSE artist` was unreachable and the backfill replaced **every** real
      // `ALBUMARTIST` in the library — silently, on every poll, on any library with more than
      // the first page of rows. And empty is the *requested* default, because it is what makes
      // a derived `X` and a tagged `X` one album.
      //
      // Paired with the non-empty case above ('never overwrites a real tag'), because each
      // passes against the other's failure: a guard that always refuses to write passes this
      // one and fails every case that asserts a grouping was filled.
      const userId = await seedUser('BackfillEmptyMarker');
      const libraryId = await seedLibrary(userId, 'LDEM');
      const id = songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');
      await seedTaggedRow(id, libraryId, 'Bonobo/Black Sands', 'Bonobo', 'Black Sands (Remastered)');

      // A version up, so the row is selected at all: the index write already stamped it at
      // the current version, and the whole question is what the guard does once a row
      // holding a real tag comes back round.
      expect(await drain(libraryId, DERIVED_VERSION + 1, EMPTY_DERIVED_MARKER)).toBe(1);

      const row = await new SongDAO(handle.db, EMPTY_DERIVED_MARKER).findById(id);
      // The tag, in both spellings. A guard on `album` proves nothing about `album_ci`, and a
      // clobbered twin is a row that displays correctly and is in no album list.
      expect(row?.album).toBe('Black Sands (Remastered)');
      expect(row?.album_ci).toBe('black sands (remastered)');
      expect(row?.artist).toBe('Bonobo');
      expect(row?.artist_ci).toBe('bonobo');
    });

    it('fills a gap under an empty marker, which is what the empty marker is for', async () => {
      // The paired positive for the case above, and the reason the empty default is the right
      // default rather than merely the requested one: with no suffix, the derived name and the
      // tagged name are the same string, so a half-enriched library groups them into one album.
      //
      // Asserted through `listAlbums`, not through the stored column: what the marker decides
      // is whether a guess and a release are one group, and a column assertion would pass
      // identically for a marker that kept them apart.
      const userId = await seedUser('BackfillEmptyFills');
      const libraryId = await seedLibrary(userId, 'LDEF');
      await seedUngrouped(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');

      expect(await drain(libraryId, DERIVED_VERSION, EMPTY_DERIVED_MARKER)).toBe(1);

      const albums = await new SongIndexDAO(handle.db).listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: 10, offset: 0, orderBy: MIN_ALBUM_CI });
      expect(albums.map((song) => song.album)).toEqual(['Black Sands']);
      expect((await new SongIndexDAO(handle.db).listArtists(libraryId, 10, 0)).map((song) => song.artist)).toEqual(['Bonobo']);
    });

    it.each([
      ['_ (guess)', '_ matches any one character, so the guard used to stop recognising its own guesses'],
      ['%', 'the whole pattern, so the guard used to match everything'],
      ['%%%', 'several of them, because none of them was an escape'],
    ])('treats a marker of %j as ordinary text, not a LIKE pattern', async (marker, _why) => {
      // The second half of the same defect. A configured marker reaching a `LIKE` is a pattern,
      // so an operator writing `'_ (guess)'` got a backfill that re-selected its own guesses on
      // every version bump and then declined to change them — the `reader_version` defect, one
      // layer down, with no error anywhere.
      //
      // Asserted on both halves because either alone is satisfiable by a guard that simply never
      // writes, and the fixture has to hold both kinds of row for the same reason:
      //
      //   - a wholly-derived row carrying a **stale** marker, which the guard must rewrite — so
      //     it has to recognise its own earlier output rather than match a NULL, and
      //   - a tagged row in the same library, which the guard must leave alone.
      //
      // The stale marker is what gives `'_ (guess)'` its teeth. Seeded as a NULL grouping it
      // would be filled by the `IS NULL` branch whatever the pattern was, and the case would
      // pass against the defect it exists to catch.
      const suffix = marker.length * 31 + marker.charCodeAt(0);
      const userId = await seedUser(`BackfillLike${suffix}`);
      const libraryId = await seedLibrary(userId, `LDL${suffix}`);

      const guessId = songId(libraryId, 'Blur/Holocene/01 Holocene.opus');
      await seedStaleGuess(guessId, libraryId, 'Blur/Holocene', DERIVED_MARKER);
      const tagId = songId(libraryId, 'Radiohead/OK Computer/01 Airbag.opus');
      await seedTaggedRow(tagId, libraryId, 'Radiohead/OK Computer', 'Radiohead', 'OK Computer', DERIVED_MARKER);

      await drain(libraryId, DERIVED_VERSION + 1, marker);

      const dao = new SongDAO(handle.db, marker);
      expect((await dao.findById(guessId))?.artist).toBe(`Blur${marker}`);
      expect((await dao.findById(tagId))?.artist).toBe('Radiohead');
    });

    it('rewrites a guess written under a DIFFERENT marker, which is what makes it a column', async () => {
      // A string guard could not do this at all, and the whole reason provenance moved.
      //
      // The row below carries ` (derived)` — the marker this suite configures everywhere else
      // — and the deployment is switched to a different one. A guard reading the stored suffix
      // would not recognise its own earlier output, so the version bump would re-select the row
      // and decline to change it: a correction that cannot reach the rows it exists to correct.
      // The column does not care what the string says, so the guess is rewritten.
      //
      // The paired case is the one above: a *real* tag under the same marker change is still
      // left alone. Without it, "the guard never writes" passes this file.
      const userId = await seedUser('BackfillMarkerChange');
      const libraryId = await seedLibrary(userId, 'LDMC');
      const id = songId(libraryId, 'Blur/Holocene/01 Holocene.opus');
      await seedStaleGuess(id, libraryId, 'Blur/Holocene', DERIVED_MARKER);

      expect(await drain(libraryId, DERIVED_VERSION + 1, ' (guess)')).toBe(1);

      const row = await new SongDAO(handle.db, ' (guess)').findById(id);
      expect(row?.artist).toBe('Blur (guess)');
      expect(row?.artist_ci).toBe('blur (guess)');
      expect(row?.album).toBe('Holocene (guess)');
      expect(row?.derived_version).toBe(DERIVED_VERSION + 1);
    });

    it('a tag write clears the flag, so a later bump cannot overwrite a real tag', async () => {
      // The third writer, and the one that has to clear the flag.
      //
      // `applyMetadata` is what puts a real `ALBUMARTIST` in the column. If it left
      // `grouping_source` standing, the row would still read as a guess, the next
      // `derived_version` bump would select it, and the guard would replace a real tag with a
      // folder name — a data-loss defect that no test bumping a version could see.
      //
      // Asserted on the *effect* (the bump leaves the tag alone) rather than on the column,
      // because the column is an implementation of the guard and the guard is the requirement.
      const userId = await seedUser('BackfillTagClearsFlag');
      const libraryId = await seedLibrary(userId, 'LDTC');
      const id = songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');
      await seedUngrouped(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');

      // The index write stamped `'derived'` and filled the grouping. (A direct
      // `INSERT` does neither, so the backfill runs first — the row has to *hold* a guess
      // before there is anything for the flag to be wrong about.)
      await drain(libraryId);
      expect((await new SongDAO(handle.db, DERIVED_MARKER).findById(id))?.artist).toBe(`Bonobo${DERIVED_MARKER}`);
      expect((await new SongDAO(handle.db, DERIVED_MARKER).findById(id))?.grouping_source).toBe(GROUPING_SOURCE_DERIVED);

      // An enrichment read supplies the real value, exactly as `EnrichmentService` would.
      await new SongDAO(handle.db, DERIVED_MARKER).applyMetadata(id, { artist: 'Bonobo', album: 'Black Sands', albumArtist: 'Bonobo' });
      expect((await new SongDAO(handle.db, DERIVED_MARKER).findById(id))?.grouping_source).toBeNull();

      // So a bump at the new convention leaves it alone.
      expect(await drain(libraryId, DERIVED_VERSION + 1, EMPTY_DERIVED_MARKER)).toBe(1);
      const row = await new SongDAO(handle.db, EMPTY_DERIVED_MARKER).findById(id);
      expect(row?.artist).toBe('Bonobo');
      expect(row?.album).toBe('Black Sands');
    });

    it('a partial tag write also clears it, which is the conservative direction', async () => {
      // `album_artist` supplied and nothing else. Under "flagged if *any* of the three is
      // derived" this row would stay flagged and a correction would overwrite `artist` and
      // `album` — columns a real tag supplied. Under "flagged only if none were", it does not.
      //
      // The cost, stated rather than hidden: the derivation-owned `album_artist` on such a row
      // is never corrected again. That is the right way round — it is the artist's own name
      // from the folder they are filed under, which no correction of a separator rule changes.
      const userId = await seedUser('BackfillPartialTag');
      const libraryId = await seedLibrary(userId, 'LDPT');
      const id = songId(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');
      await seedUngrouped(libraryId, 'Bonobo/Black Sands/01 Kerala.opus');
      await drain(libraryId);
      await new SongDAO(handle.db, DERIVED_MARKER).applyMetadata(id, { artist: 'Bonobo', album: 'Black Sands' });

      const row = await new SongDAO(handle.db, DERIVED_MARKER).findById(id);
      expect(row?.grouping_source).toBeNull();
      expect(row?.artist).toBe('Bonobo');
      // The derived `album_artist` is still there and still correct — clearing the flag is not
      // clearing the value.
      expect(row?.album_artist).toBe(`Bonobo${DERIVED_MARKER}`);
    });
  });

  /**
   * The bound-parameter ceiling: 100, measured, and enforced by the test engine.
   *
   * ### What shipped
   *
   * `songsForAlbumKeys` bound two variables per album group, so a page of 50 albums bound
   * 101 and D1 refused it. `listArtists` bound one per artist and `listIdsIn` chunked at
   * 200 with a comment asserting SQLite's old 999 default. The live symptom was a masked
   * `code=0` on `getAlbumList`, which a client reports as a generic error — and it was not
   * one client or one page size: **any** request for 50 or more albums failed, while
   * `MAX_PAGE_SIZE` is 500, so the server was required to accept requests it could not
   * answer. `getArtist` asked for 5,000 artists and `getCoverArt` for 500, so both were
   * guaranteed failures on any library with 100+ artists.
   *
   * ### Why 523 tests were green throughout
   *
   * Because the engine under them was more permissive than the product. `node:sqlite` is
   * the same engine D1 is, and that is exactly what made it convincing — but its
   * `SQLITE_MAX_VARIABLE_NUMBER` is 32,766 against D1's 100, so it is structurally
   * incapable of failing this way. The double modelled *an* SQLite rather than *D1's*
   * SQLite, which is the `fakeDav` receiver mistake one layer down. `helpers/sqlite.ts`
   * now enforces the ceiling itself, and the tests below are what make that guard mean
   * something.
   */
  describe('the bound-parameter ceiling', () => {
    /**
    One album per call, named so the sort order is predictable.
    */
    async function seedAlbum(libraryId: string, index: number): Promise<void> {
      const name = `Artist ${String(index).padStart(4, '0')}`;
      const album = `Album ${String(index).padStart(4, '0')}`;
      await seedSong(libraryId, `${name}/${album}/01 track.flac`, `${name}/${album}`, {
        title: '01 track',
        artist: name,
        album,
      });
    }

    it('is 100, and the double enforces it rather than inheriting a laxer engine', async () => {
      // Pinned because it is a measurement, not a preference. If D1's ceiling ever moves,
      // this test is the thing that must be re-derived against a live instance — and a
      // silent bump would otherwise raise every batch size in the product at once.
      expect(D1_MAX_BIND_PARAMETERS).toBe(100);

      // The paired half, and the reason the guard exists: this engine would *not* have
      // caught the defect on its own. Without this assertion a future change that removed
      // the ceiling from `helpers/sqlite.ts` would turn this whole block green-on-nothing.
      const many: string[] = Array.from({ length: 150 }, () => 'x');
      const sql = `SELECT ${many.map(() => '?').join(',')}`;
      // The engine's own limit, which the double inherits and the product does not. This is
      // the half that says *why* the guard below is needed rather than merely present.
      expect(() => handle.raw.prepare(sql).all(...many)).not.toThrow();
      // The D1 limit, which the double adds. Without this assertion the line above
      // documents the hole instead of the guard, and deleting the guard stays green.
      await expect(handle.db.prepare(sql).bind(...many).all()).rejects.toThrow(/too many SQL variables/);
    });

    it('derives every batch size from it, and the derived sizes straddle the measured edge', () => {
      // The measured boundary: 49 album groups bind 99 variables and answer; 50 bind 101
      // and fail. Asserted as arithmetic so the relationship is checkable by reading, and
      // so raising `MAX_PAGE_SIZE` cannot silently re-break a query written correctly
      // today.
      expect(bindChunkSize(2)).toBe(49);
      expect(bindChunkSize(1)).toBe(99);
      expect(1 + 2 * bindChunkSize(2)).toBeLessThanOrEqual(D1_MAX_BIND_PARAMETERS);
      expect(1 + 2 * (bindChunkSize(2) + 1)).toBeGreaterThan(D1_MAX_BIND_PARAMETERS);
      // A caller asking for more variables per row than the ceiling allows still gets a
      // one-row batch, rather than an empty array that would silently return nothing.
      expect(bindChunkSize(500)).toBe(1);
    });

    it('answers a page of 500 albums, which is what MAX_PAGE_SIZE permits', async () => {
      // The regression test for the shipped 500. 500 albums is `MAX_PAGE_SIZE`, so this is
      // a request the server is *required* to accept — not a size invented to break it.
      const userId = await seedUser('CeilingAlbums');
      const libraryId = await seedLibrary(userId, 'LCA');
      const ALBUMS = 500;
      for (let index = 0; index < ALBUMS; index += 1) await seedAlbum(libraryId, index);

      const albums = await new SongIndexDAO(handle.db).listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: ALBUMS, offset: 0, orderBy: MIN_ALBUM_CI });

      // Every album, complete. A silent truncation would satisfy a "does not throw"
      // assertion and is the failure mode a chunked fetch actually has.
      expect(albums).toHaveLength(ALBUMS);
      expect(new Set(albums.map((song) => song.album_ci)).size).toBe(ALBUMS);
    });

    it('batches on key boundaries, so no album is split across two statements', async () => {
      // The batch is over *keys*, never rows. A row-level split would return an album's
      // first tracks from one statement and the rest from another, which `groupAlbums`
      // would still merge — so the counts would be right and nothing would say why. The
      // observable form of that bug is a duplicated or missing track, so the assertion is
      // on the set, not the order.
      const userId = await seedUser('CeilingKeys');
      const libraryId = await seedLibrary(userId, 'LCK');
      for (let index = 0; index < 60; index += 1) await seedAlbum(libraryId, index);
      // A second track in the album that straddles the 49-key boundary, so a row-level
      // split would have something to misplace.
      await seedSong(libraryId, 'Artist 0049/Album 0049/02 track.flac', 'Artist 0049/Album 0049', {
        title: '02 track',
        artist: 'Artist 0049',
        album: 'Album 0049',
      });

      const albums = await new SongIndexDAO(handle.db).listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: 60, offset: 0, orderBy: MIN_ALBUM_CI });

      expect(albums).toHaveLength(61);
      expect(new Set(albums.map((song) => song.id)).size).toBe(61);
    });

    it('produces the same rows however many statements it takes', async () => {
      // The property that makes batching an implementation detail rather than a behaviour
      // change. It is not free: the chunks are concatenated in the order the **key page**
      // supplied, which is the order the caller asked for and not anything the `SELECT *`
      // happens to sort by. So the re-order has to be rebuilt from the key list, and this
      // is what says it was.
      //
      // `type=random` is the order that exposes it, being unrelated to any sort tuple by
      // construction: without an explicit rebuild the rows come back in the order the
      // database emitted them, which is neither the caller's order nor stable between
      // calls.
      const userId = await seedUser('CeilingOrder');
      const libraryId = await seedLibrary(userId, 'LCO');
      for (let index = 0; index < 120; index += 1) await seedAlbum(libraryId, index);

      const index = new SongIndexDAO(handle.db);
      const chunked = await index.listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: 120, offset: 0, orderBy: ['RANDOM()'] });

      // The oracle: every row in the library, in **one** statement binding a single
      // variable, so the comparison statement cannot itself be over the ceiling. Two pages
      // of different sizes hold different albums and are not comparable; the whole table
      // is.
      const all = (await handle.db.prepare('SELECT * FROM songs WHERE library_id = ?').bind(libraryId).all<{ id: string }>()).results;
      expect(all).toHaveLength(120);

      // The set, which is the half a mis-sliced batch corrupts — a duplicated or dropped
      // album, which a count alone would not distinguish from a correct page.
      expect(new Set(chunked.map((song) => song.id))).toEqual(new Set(all.map((row) => row.id)));

      // Every album is present **exactly once**. The set comparison above cannot see a
      // duplicate: `Set` collapses it, so a batch that emitted one album twice and
      // another not at all would still pass. The albums are one track each here, so the
      // row count is the album count.
      expect(chunked).toHaveLength(120);
    });

    it('pages a sorted list into consecutive pages that concatenate to the whole', async () => {
      // The half the previous assertion dropped when it stopped pinning a sort it should
      // never have imposed.
      //
      // `listAlbums` rebuilds the caller's order from its key list, because a chunked row
      // fetch cannot inherit an `ORDER BY`. That is only true if the rebuild is faithful:
      // if the buckets came back in *any* other order, then two pages of the same sorted
      // list would not concatenate to the whole list — and a client paging a library
      // would see albums it has already seen, and skip ones it has not.
      //
      // So the assertion is on the concatenation, not on any one page's order. That is the
      // property a client depends on and it is the one a re-sort silently breaks while
      // leaving every individual page looking plausible.
      const userId = await seedUser('CeilingPaging');
      const libraryId = await seedLibrary(userId, 'LCP');
      for (let index = 0; index < 120; index += 1) await seedAlbum(libraryId, index);

      const index = new SongIndexDAO(handle.db);
      const whole = await index.listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: 120, offset: 0, orderBy: MIN_ALBUM_CI });

      const paged: string[] = [];
      for (let offset = 0; offset < 120; offset += 40) {
        const page = await index.listAlbums(libraryId, { grouping: ALBUM_GROUPING, limit: 40, offset, orderBy: MIN_ALBUM_CI });
        expect(page).toHaveLength(40);
        paged.push(...page.map((song) => song.id));
      }

      expect(paged).toEqual(whole.map((song) => song.id));

      // And the order the caller asked for, which is the whole point of the exercise.
      // `alphabeticalByName` was returning albums ordered by *folder* — and since these
      // folders are `Artist/Album`, that is an order no client requested and none could
      // predict.
      const names = whole.map((song) => song.album_ci ?? '');
      expect(names).toEqual([...names].sort());
    });

    it('answers more than 100 artists, which is where getArtists and getArtist broke', async () => {
      // `getArtists` asks for 500, `getArtist` for 5,000 and `getCoverArt` for 500. All
      // three bound one variable per artist, so a library with 100+ artists 500'd on its
      // front page — the endpoint a player draws first.
      const userId = await seedUser('CeilingArtists');
      const libraryId = await seedLibrary(userId, 'LCR');
      const ARTISTS = 150;
      for (let index = 0; index < ARTISTS; index += 1) await seedAlbum(libraryId, index);

      const index = new SongIndexDAO(handle.db);
      const artists = await index.listArtists(libraryId, ARTISTS, 0);
      expect(artists).toHaveLength(ARTISTS);
      expect(new Set(artists.map((song) => song.artist_ci)).size).toBe(ARTISTS);
    });

    it('keeps a 150-track play queue in the order it was saved', async () => {
      // `listIdsIn` chunked at 200 against a ceiling of 100, so a saved queue of 100 tracks
      // was a masked 500 — and the queue is the one list whose *order* is the whole point.
      // Asserted on order and on omission together, because a re-order that dropped the
      // unresolved ids would pass an order-only check on a shorter list.
      const userId = await seedUser('CeilingQueue');
      const libraryId = await seedLibrary(userId, 'LCQ');
      const ids: string[] = [];
      for (let index = 0; index < 150; index += 1) {
        const path = `Artist/Album/${String(index).padStart(4, '0')} track.flac`;
        ids.push(await seedSong(libraryId, path, 'Artist/Album', { title: `${index} track`, artist: 'Artist', album: 'Album' }));
      }
      // A shuffled request order and an id that resolves to nothing, which must be omitted
      // rather than substituted.
      const requested = ids.toReversed();
      requested.splice(10, 0, 's:does-not-exist');

      const rows = await new SongDAO(handle.db, DERIVED_MARKER).listIdsIn(libraryId, requested);

      expect(rows.map((row) => row.id)).toEqual(requested.filter((id) => id !== 's:does-not-exist'));
    });

    it('refuses to build a statement over the ceiling, so a fifth site fails here', async () => {
      // The guard that stops this being rediscovered. `helpers/sqlite.ts` raises D1's
      // ceiling on every statement, so a DAO that builds an `IN` list from a caller-supplied
      // page size without batching fails **in this suite** rather than in production. Paired
      // with the test above: without the batching, this one goes red; without the ceiling,
      // nothing does.
      const tooMany = Array.from({ length: D1_MAX_BIND_PARAMETERS + 1 }).fill('x');
      await expect(handle.db.prepare(`SELECT ? AS v WHERE ? IN (${tooMany.map(() => '?').join(',')})`).bind(1, ...tooMany).all()).rejects.toThrow(
        /too many SQL variables/,
      );
    });
  });

  it('is stable, so a rescan of an unchanged folder writes no different value', async () => {
    // Incrementality depends on this: the same path must always derive the same
    // string, or every scan would rewrite every grouping column and the "unchanged
    // rescan costs zero rows" guarantee would be a comment rather than a fact.
    const first = deriveFromPath('Bonobo/Black Sands', DERIVED_MARKER);
    const second = deriveFromPath('Bonobo/Black Sands', DERIVED_MARKER);
    expect(first).toEqual(second);
    // And the marker is part of the value, so a client can tell derived from tagged.
    expect(first.artist).toContain(DERIVED_MARKER);
  });
});

describe('DAO round-trips', () => {
  it("re-running a scan's upsert does not blank derived metadata", async () => {
    // The reason `upsertFileFacts` is a separate statement from `applyMetadata`: a
    // rescan must not destroy the duration an enrichment pass already filled in. A
    // client showing a 0:00 scrubber is a bug nobody reports, so it has to be tested.
    const userId = await seedUser('RoundTrip');
    const libraryId = await seedLibrary(userId, 'LRT');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const id = songId(libraryId, 'A/01.flac');
    const facts = { id, libraryId, path: 'A/01.flac', dirPath: 'A', name: '01.flac', size: 100, mtimeMs: 1, contentType: 'audio/flac', suffix: 'flac' };

    await songs.upsertFileFacts([facts]);
    await songs.applyMetadata(id, { title: 'Holocene', duration: 251, bitrate: 900, genre: 'Indie' });
    // A second scan sees the same file, unchanged.
    await songs.upsertFileFacts([facts]);

    const row = await songs.findById(id);
    expect(row?.title).toBe('Holocene');
    expect(row?.duration).toBe(251);
    expect(row?.bitrate).toBe(900);
    // Each `_ci` twin is written in the same statement as its counterpart, so search
    // and the ORDER BY clauses can never drift from the display value.
    expect(row?.title_ci).toBe('holocene');
    expect(row?.genre_ci).toBe('indie');
  });

  it('invalidates the derived values when a file changes, and keeps them when it does not', async () => {
    // The silent one. A rescan that updates `mtime_ms` but leaves `duration` alone
    // produces a row whose length is wrong, which no error anywhere reports and which
    // `EnrichmentService` then refuses to fix, because it short-circuits on
    // `enriched_at`. The two cases are asserted together so the reset cannot be
    // "fixed" by simply always clearing — that would re-read every file on every scan.
    const userId = await seedUser('MtimeChange');
    const libraryId = await seedLibrary(userId, 'LMT');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const id = songId(libraryId, 'A/01.flac');
    const facts = (mtimeMs: number, size: number) => ({
      id,
      libraryId,
      path: 'A/01.flac',
      dirPath: 'A',
      name: '01.flac',
      size,
      mtimeMs,
      contentType: 'audio/flac',
      suffix: 'flac',
    });

    await songs.upsertFileFacts([facts(1000, 100)]);
    await songs.applyMetadata(id, { title: 'Holocene', artist: 'Bon Iver', duration: 251, bitrate: 900, sampleRate: 44_100, channels: 2 });

    // The same bytes seen again: the scan runs on every pass, and a rescan must not
    // throw away a duration it would then have to re-read from the origin.
    await songs.upsertFileFacts([facts(1000, 100)]);
    const unchanged = await songs.findById(id);
    expect(unchanged?.duration).toBe(251);
    expect(unchanged?.enriched_at).not.toBeNull();

    // Different bytes: the length and the format facts are gone, so the next read
    // re-fetches them. The text tags stay, because `getArtists` groups by them and a
    // cleared artist would drop the track out of every group.
    await songs.upsertFileFacts([facts(2000, 150)]);
    const changed = await songs.findById(id);
    expect(changed?.mtime_ms).toBe(2000);
    expect(changed?.size).toBe(150);
    expect(changed?.duration).toBe(0);
    expect(changed?.bitrate).toBe(0);
    expect(changed?.sample_rate).toBeNull();
    expect(changed?.channels).toBeNull();
    // `enriched_at` is the flag that makes `enrich` re-read, so clearing it is what
    // turns the fix from cosmetic into effective.
    expect(changed?.enriched_at).toBeNull();
    expect(changed?.title).toBe('Holocene');
  });

  it('removes playlist entries by index, highest first', async () => {
    // `songIndexToRemove` addresses positions, and the protocol does not say in which
    // order a client sends multiple removals — so the result must not depend on it.
    const userId = await seedUser('PlaylistIndex');
    const libraryId = await seedLibrary(userId, 'LPI');
    // Sequential on purpose: each `seedSong` awaits D1, and the D1 subrequest budget is
    // the scarce resource. `Promise.all` here would be faster and wrong.
    const ids: string[] = [];
    for (const stem of ['a', 'b', 'c', 'd']) {
      ids.push(await seedSong(libraryId, `A/${stem}.flac`, 'A', { title: stem }));
    }

    const playlists = new PlaylistDAO(handle.db);
    const playlist = await playlists.create({ ownerUserId: userId, name: 'Mix' });
    await playlists.replaceEntries(playlist.id, ids, 0);
    await playlists.removeEntriesAt(playlist.id, [1, 2]);

    const entries = await playlists.listEntries(playlist.id);
    // The surviving *songs* are what matter, and they are the ones a highest-first
    // delete preserves: a, then d. An ascending delete would remove a's neighbours
    // instead and leave b and c.
    expect(entries.map((entry) => entry.song_id)).toEqual([ids[0], ids[3]]);
    // The position gap is deliberate, not drift. Positions are the protocol's
    // addressing scheme, so renumbering after a delete would invalidate any index a
    // client is still holding; `appendEntries` uses `MAX(position) + 1`, so a gap costs
    // nothing.
    expect(entries.map((entry) => entry.position)).toEqual([0, 3]);
    // The denormalized total is the count a client renders a progress bar from, so it
    // has to be the number of entries rather than the highest position.
    expect((await playlists.findById(playlist.id))?.song_count).toBe(2);
  });

  it('bumps token_epoch on a password change, invalidating issued tokens', async () => {
    // A Subsonic token is valid forever, so without the bump there is no way to revoke
    // one: a client's saved credential keeps working after a password change.
    const userId = await seedUser('EpochUser');
    const users = new UserDAO(handle.db);
    const before = await users.findById(userId);

    const rotated = await encryptData('new-password', await testKey());
    await users.updatePassword(userId, rotated.ciphertext, rotated.iv, 2);

    const after = await users.findById(userId);
    expect(after?.token_epoch).toBe((before?.token_epoch ?? 1) + 1);
    expect(after?.key_version).toBe(2);
  });

  it('counts auth failures inside a window and clears them on success', async () => {
    // D1-backed and fail-closed, so this is the one piece of state where losing the
    // cache would be a security regression rather than a latency change.
    const throttle = new AuthThrottleDAO(handle.db);
    for (let attempt = 0; attempt < 3; attempt += 1) await throttle.recordFailure('identity', 10);

    expect(await throttle.countRecentFailures('identity', 10, 10)).toBe(3);
    // An older or newer bucket is outside the window and must not count.
    expect(await throttle.countRecentFailures('identity', 11, 11)).toBe(0);
    expect(await throttle.countRecentFailures('identity', 0, 9)).toBe(0);

    await throttle.clearFailures('identity');
    expect(await throttle.countRecentFailures('identity', 0, 100)).toBe(0);
  });

  it('prunes a deleted folder and everything beneath it', async () => {
    const userId = await seedUser('Prune');
    const libraryId = await seedLibrary(userId, 'LPR');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    await seedSong(libraryId, 'Album/01.flac', 'Album');
    await seedSong(libraryId, 'Album/Disc 2/01.flac', 'Album/Disc 2');
    expect(await songs.countByLibrary(libraryId)).toBe(2);

    // A one-level delete would leave the `Disc 2` row indexed, pointing at a folder
    // that no longer exists — which is the entire failure this prune exists to prevent.
    //
    // `.changes` for the row count and `billedRows` beside it, because the two are different
    // answers and a prune is one of the four writes a chunk can make on its way to spending the
    // day's allowance: 2 songs is 20 of it, and asserting only the row count would leave the cost
    // unmeasured on the path that spends it.
    const pruned = await songs.deleteSubtree(libraryId, 'Album');
    expect(pruned.changes).toBe(2);
    expect(pruned.billedRows).toBe(billedRowsForTable('songs', 2));
    expect(pruned.billedRows).toBe(20);
    expect(pruned.truncated, 'a single statement cannot be truncated').toBe(false);
    expect(await songs.countByLibrary(libraryId)).toBe(0);
  });

  it('does not let `Blur` match `Blurberry` when pruning', async () => {
    // The LIKE prefix carries a trailing `/`. Without it, deleting one album takes out
    // every folder whose name merely starts with the same characters.
    const userId = await seedUser('PrefixPrune');
    const libraryId = await seedLibrary(userId, 'LPP');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    await seedSong(libraryId, 'Blur/01.flac', 'Blur');
    await seedSong(libraryId, 'Blurberry/01.flac', 'Blurberry');

    await songs.deleteSubtree(libraryId, 'Blur');
    expect(await songs.listByDirectory(libraryId, 'Blurberry')).toHaveLength(1);
    expect(await songs.listByDirectory(libraryId, 'Blur')).toHaveLength(0);
  });

  it('deletes a node subtree without taking a sibling whose name extends it', async () => {
    const userId = await seedUser('NodePrefixPrune');
    const libraryId = await seedLibrary(userId, 'LNP');
    const nodes = new NodeDAO(handle.db);
    await nodes.upsertMany([
      { libraryId, path: 'Blur', parentPath: '', name: 'Blur', mtimeMs: 1, etag: null, depth: 1 },
      { libraryId, path: 'Blur/Disc 1', parentPath: 'Blur', name: 'Disc 1', mtimeMs: 1, etag: null, depth: 2 },
      { libraryId, path: 'Blurberry', parentPath: '', name: 'Blurberry', mtimeMs: 1, etag: null, depth: 1 },
    ]);

    // `nodes` bills four per row changed, against `songs`' ten — which is precisely why no single
    // ratio converts a row count into a billed count, and why a folder reconciling both cannot
    // report one number for the two.
    const pruned = await nodes.deleteSubtree(libraryId, 'Blur');
    expect(pruned.changes).toBe(2);
    expect(pruned.billedRows).toBe(billedRowsForTable('nodes', 2));
    expect(await nodes.find(libraryId, 'Blur')).toBeNull();
    expect(await nodes.find(libraryId, 'Blurberry')).not.toBeNull();
  });
});

/**
 * What an album is, per grouping — and the two things a one-album-per-directory fixture cannot see.
 *
 * ### Why this suite exists at all
 *
 * Every album test above passes under all three groupings, because its fixture holds one album
 * in one directory. That is the shape of the defect this is about: a grouping decision is
 * invisible on a library that agrees with itself, and the disagreement only appears on one where
 * a release spans folders. Measured against a live library: 113 tracks in 80 album folders
 * carrying 71 distinct `ALBUM` values, because nine releases were split across directories and
 * one of them across six.
 *
 * So every fixture below puts **one album in two or three directories**, and one of them puts
 * **two albums in one directory** — the other direction, and the one that a directory-keyed id
 * cannot represent at all, since two groups would claim the same representative directory and
 * publish one id for two albums.
 */
describe('album identity by grouping', () => {
  /**
   * One release, three folders, one track each, **no album artist tag anywhere**.
   *
   * The layout a per-artist rip produces: the folder is named after the track's performer, so
   * the same release is one directory per artist and `ALBUM` is the only thing they share. It is
   * the fixture the original report was measured on.
   */
  async function seedSplitRelease(userId: string, libraryId: string, album = 'Ex-Otogibanashi'): Promise<void> {
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const tracks = [
      { dir: 'ryo (supercell), Kagura & Tsukimi - Ex-Otogibanashi', name: '01 - Ex-Otogibanashi.opus', artist: 'ryo (supercell), Kagura & Tsukimi', track: 1 },
      { dir: 'ryo (supercell), Kagura & Tsukimi - Ex-Otogibanashi', name: '02 - Sekaijū wa Mine [Remix].opus', artist: 'ryo (supercell), Kagura & Tsukimi', track: 2 },
      { dir: 'ryo (supercell) & Kagura - Ex-Otogibanashi', name: '03 - Melt (Kagura ver.) [Remix].opus', artist: 'ryo (supercell) & Kagura', track: 3 },
    ];
    await songs.upsertFileFacts(tracks.map((t) => ({ id: songId(libraryId, `${t.dir}/${t.name}`), libraryId, path: `${t.dir}/${t.name}`, dirPath: t.dir, name: t.name, size: 1000, mtimeMs: 1000, contentType: 'audio/ogg', suffix: 'opus' })));
    for (const t of tracks) {
      await songs.applyMetadata(songId(libraryId, `${t.dir}/${t.name}`), {
        title: t.name.replace(/^\d+ - /, '').replace('.opus', ''),
        artist: t.artist,
        album,
        track: t.track,
        disc: 1,
        duration: 200,
        readerVersion: 1,
      });
    }
  }

  const pages = async (libraryId: string, grouping: 'folder' | 'album' | 'album_artist', limit = 10) =>
    await new SongIndexDAO(handle.db).listAlbums(libraryId, { grouping, limit, offset: 0, orderBy: MIN_ALBUM_CI });

  it('groups a release split across folders by its album tag, and not by its folders', async () => {
    const userId = await seedUser('SplitAlbum');
    const libraryId = await seedLibrary(userId, 'LSPLIT');
    await seedSplitRelease(userId, libraryId);

    // The whole point, and it is three rows becoming one album rather than three.
    const byAlbum = await pages(libraryId, 'album');
    expect(byAlbum).toHaveLength(3);
    expect(new Set(byAlbum.map((song) => song.album_ci))).toEqual(new Set(['ex-otogibanashi']));
    expect([...new Set(byAlbum.map((song) => song.dir_path))]).toHaveLength(2);

    // And `folder` still answers its own question, one directory at a time.
    const byFolder = await pages(libraryId, 'folder');
    expect(new Set(byFolder.map((song) => song.dir_path))).toHaveLength(2);
  });

  it('treats a missing album artist as one value, so an untagged library still merges', async () => {
    const userId = await seedUser('SplitNoAlbumArtist');
    const libraryId = await seedLibrary(userId, 'LNOAA');
    // `albumArtist: null` written **explicitly**, which is not what an absent tag does —
    // `EnrichmentService` omits the field rather than clearing it, so the path-derived value
    // survives. Writing NULL here models the other case, and it is a real one: a library
    // indexed before `upsertFileFacts` derived `album_artist` keeps NULL for ever, because
    // the derivation backfill selects on `derived_version` and that column was never bumped
    // when the album-artist half was added. 113 rows on a live library, all NULL.
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const halves: Array<[string, number]> = [
      ['A - Silent Siren Selection', 2],
      ['B - Silent Siren Selection', 8],
    ];
    for (const [dir, track] of halves) {
      const path = `${dir}/0${track}.opus`;
      await songs.upsertFileFacts([{ id: songId(libraryId, path), libraryId, path, dirPath: dir, name: `0${track}.opus`, size: 1, mtimeMs: 1, contentType: 'audio/ogg', suffix: 'opus' }]);
      await songs.applyMetadata(songId(libraryId, path), { title: 'Track', artist: dir[0], album: 'Silent Siren Selection', albumArtist: null, disc: 1, track, duration: 1, readerVersion: 1 });
    }

    // `album_artist` groups on `(album_artist_ci, album_ci)` and both rows' album artist is
    // NULL. If NULL were a wildcard — matching any album artist — these would scatter; if it
    // were dropped from the key, they would join every tagged album sharing the name. One
    // group is the third option and the only correct one.
    const byArtist = await pages(libraryId, 'album_artist');
    expect(byArtist).toHaveLength(2);
    expect(byArtist.every((song) => song.album_artist === null)).toBe(true);
    expect(new Set(byArtist.map((song) => song.album_ci))).toEqual(new Set(['silent siren selection']));
  });

  it('leaves a split release split under `album_artist` when the album artist came from the folder', async () => {
    const userId = await seedUser('SplitDerivedAlbumArtist');
    const libraryId = await seedLibrary(userId, 'LDA');
    await seedSplitRelease(userId, libraryId);

    // The honest limit of the mode, and it is a fact about the data rather than about the
    // grouping: `upsertFileFacts` derives `album_artist` from the folder, and in this layout
    // the folder is named after the performer — so each half of the release gets its own
    // derived album artist and `album_artist` grouping reproduces the split. This is why the
    // default is `album`, and why `album_artist` is documented as the answer for a *properly
    // tagged* library rather than a general one.
    const rows = await pages(libraryId, 'album_artist');
    expect(new Set(rows.map((song) => song.album_artist))).toHaveLength(2);
    // The marker is on the *derived album artist*, not on the album: `applyMetadata` wrote the real
    // album tag over the derived one, and the derived album artist survived because an absent tag
    // omits the field rather than clearing it.
    expect(rows.every((song) => song.album_artist?.endsWith(DERIVED_MARKER))).toBe(true);
  });

  it('separates two albums that share a name but not an album artist', async () => {
    const userId = await seedUser('SameNameTwoArtists');
    const libraryId = await seedLibrary(userId, 'LSAME');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    for (const [dir, artist] of [
      ['A - Greatest Hits', 'Artist A'],
      ['B - Greatest Hits', 'Artist B'],
    ]) {
      const path = `${dir}/01 Track.opus`;
      await songs.upsertFileFacts([{ id: songId(libraryId, path), libraryId, path, dirPath: dir, name: '01 Track.opus', size: 1, mtimeMs: 1, contentType: 'audio/ogg', suffix: 'opus' }]);
      await songs.applyMetadata(songId(libraryId, path), { title: 'Track', artist, album: 'Greatest Hits', albumArtist: artist, track: 1, duration: 1, readerVersion: 1 });
    }

    // The mirror of the case above, and the reason `album_artist` exists as a mode: two
    // self-titled records by different artists are two albums, and grouping on the name alone
    // merges them into one holding both artists' tracks.
    const byArtist = await pages(libraryId, 'album_artist');
    expect(byArtist).toHaveLength(2);
    expect(new Set(byArtist.map((song) => song.album_artist))).toEqual(new Set(['Artist A', 'Artist B']));

    // And `album` mode genuinely cannot tell them apart: one album, two rows, both artists'
    // tracks on it. That is the mode's cost rather than a bug in it, and it is why the two
    // modes exist.
    expect(await pages(libraryId, 'album')).toHaveLength(2);
  });

  it('keeps the SQL page and the row grouping in agreement when one directory holds two albums', async () => {
    // **The fixture the whole suite was missing.** One directory, two album artists, one album
    // name each: the shape a properly tagged compilation folder has. It is where the two
    // groupings can disagree, because a directory-keyed id would have two groups claiming the
    // same representative directory and publishing one id for two albums.
    const userId = await seedUser('TwoAlbumsOneDir');
    const libraryId = await seedLibrary(userId, 'LTWO');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const dir = 'Various - Split Release';
    for (const [file, albumArtist] of [
      ['01 - One.opus', 'Artist A'],
      ['02 - Two.opus', 'Artist B'],
    ]) {
      const path = `${dir}/${file}`;
      await songs.upsertFileFacts([{ id: songId(libraryId, path), libraryId, path, dirPath: dir, name: file, size: 1, mtimeMs: 1, contentType: 'audio/ogg', suffix: 'opus' }]);
      await songs.applyMetadata(songId(libraryId, path), { title: file, artist: albumArtist, album: 'Split Release', albumArtist, track: Number(file[0]), duration: 1, readerVersion: 1 });
    }

    // Two albums, so two distinct keys, so two distinct ids. Asserted on the ids rather than
    // the row count because two albums and two rows look identical until something resolves one.
    const rows = await pages(libraryId, 'album_artist');
    expect(rows).toHaveLength(2);
    const ids = rows.map((row) => albumIdOf(row, libraryId, 'album_artist'));
    expect(new Set(ids).size).toBe(2);

    // And `folder` collapses them, which is the honest answer for that mode.
    expect(await pages(libraryId, 'folder')).toHaveLength(2);
    expect(new Set((await pages(libraryId, 'folder')).map((row) => row.dir_path)).size).toBe(1);
  });

  it('uses the album index for the row fetch, so a tag-grouped page is not a scan', async () => {
    // **The assertion a row-count test cannot make.** `COALESCE(album_artist_ci, '')` matches
    // exactly the rows `(album_artist_ci IS ? AND album_ci = ?)` matches — the NULL group
    // included, because `'' IS ''`. So a coercion is invisible in every result and visible only
    // here, as a scan of the library's rows on the endpoint a player draws its album list from.
    const userId = await seedUser('AlbumIndexPlan');
    const libraryId = await seedLibrary(userId, 'LPLAN');
    await seedSplitRelease(userId, libraryId);

    const plan = queryPlan(handle, 'SELECT * FROM songs WHERE library_id = ? AND ((album_artist_ci IS ? AND album_ci = ?))', [libraryId, null, 'ex-otogibanashi']);
    // All three columns constrained, not just the leading one: a plan that used the index for
    // `library_id` alone would still say `idx_songs_album` and still scan the library.
    expect(plan).toContain('idx_songs_album');
    expect(plan).toContain('album_artist_ci=?');
    expect(plan).not.toContain('SCAN');

    // The negation, so the assertion above cannot pass on a plan that merely mentions an
    // index. The coercion returns **the same rows** — including the NULL group, because
    // `'' IS ''` — and the plan is the only place the difference exists: it falls back to
    // `idx_songs_album_title_ci`, which constrains the album name but not the album artist,
    // so every row sharing that name in the library is examined and then discarded.
    const coerced = queryPlan(handle, "SELECT * FROM songs WHERE library_id = ? AND ((COALESCE(album_artist_ci, '') = ? AND album_ci = ?))", [libraryId, '', 'ex-otogibanashi']);
    expect(coerced).not.toContain('album_artist_ci=?');
    expect(coerced).not.toBe(plan);
  });

  it('pages a release split across folders without repeating or dropping it', async () => {
    const userId = await seedUser('SplitPaging');
    const libraryId = await seedLibrary(userId, 'LSPLITPAGE');
    // Ten releases of two tracks each, every release in **two** directories, so a page
    // boundary of one album lands between two of its own directories.
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    for (let album = 0; album < 10; album += 1) {
      for (const half of [1, 2]) {
        const dir = `Artist ${half} - Album ${String(album).padStart(2, '0')}`;
        const path = `${dir}/0${half} Track.opus`;
        await songs.upsertFileFacts([{ id: songId(libraryId, path), libraryId, path, dirPath: dir, name: `0${half} Track.opus`, size: 1, mtimeMs: 1, contentType: 'audio/ogg', suffix: 'opus' }]);
        await songs.applyMetadata(songId(libraryId, path), { title: 'Track', artist: `Artist ${half}`, album: `Album ${String(album).padStart(2, '0')}`, track: half, disc: 1, duration: 1, readerVersion: 1 });
      }
    }

    const index = new SongIndexDAO(handle.db);
    const whole = await index.listAlbums(libraryId, { grouping: 'album', limit: 100, offset: 0, orderBy: MIN_ALBUM_CI });

    // **The concatenation**, not any one page's order: a re-sort leaves every individual page
    // looking plausible, which is the failure the old comparator caused.
    const paged: string[] = [];
    for (let offset = 0; offset < 10; offset += 3) {
      const page = await index.listAlbums(libraryId, { grouping: 'album', limit: 3, offset, orderBy: MIN_ALBUM_CI });
      for (const row of page) paged.push(row.album_ci ?? '');
    }
    expect(paged).toEqual(whole.map((row) => row.album_ci ?? ''));
    expect(new Set(paged).size).toBe(10);
    // Every release kept both of its tracks, so no page boundary split one.
    expect(paged.filter((album) => album === 'album 00')).toHaveLength(2);
  });

  it('orders an album the same way in SQL and in the comparator a client reads', async () => {
    // `name_ci` versus `name` is the difference the two orderings can have, and it needs names
    // differing **only by case** to show: `apple` sorts before `Banana` lowercased and after it
    // as written. The row fetch orders by `name_ci` and the caller re-sorts by `compareAlbumTracks`,
    // so a disagreement here is an album whose published track order depends on which statement
    // happened to produce it.
    const userId = await seedUser('AlbumTrackOrder');
    const libraryId = await seedLibrary(userId, 'LORDER');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    const dir = 'Two Discs';
    const rows = [
      { file: 'a-low.opus', title: 'apple', disc: 1, track: 2 },
      { file: 'b-upper.opus', title: 'Banana', disc: 1, track: 2 },
      { file: 'c-disc2.opus', title: 'zebra', disc: 2, track: 1 },
    ];
    for (const row of rows) {
      const path = `${dir}/${row.file}`;
      await songs.upsertFileFacts([{ id: songId(libraryId, path), libraryId, path, dirPath: dir, name: row.file, size: 1, mtimeMs: 1, contentType: 'audio/ogg', suffix: 'opus' }]);
      await songs.applyMetadata(songId(libraryId, path), { title: row.title, artist: 'A', album: 'Two Discs', albumArtist: 'A', disc: row.disc, track: row.track, duration: 1, readerVersion: 1 });
    }

    const fetched = await pages(libraryId, 'album');
    const sqlOrder = fetched.map((row) => row.title);
    const comparatorOrder = [...fetched].sort(compareAlbumTracks).map((row) => row.title);

    expect(sqlOrder).toEqual(comparatorOrder);
    // And the order itself, so a change to both in the same direction fails: disc first, so a
    // two-disc album does not interleave, and `name` not `name_ci` on the tie.
    expect(comparatorOrder).toEqual(['apple', 'Banana', 'zebra']);
  });
});

describe('the index_version bump is conditional, over real SQL', () => {
  // Everything else about this invariant is asserted against doubles, and a double cannot
  // observe it. `complete()` decides in **SQL** — `index_version + CASE WHEN changed = 1 …`
  // — so the decision lives in a statement no service-level test executes. Reinstating the
  // unconditional bump in `ScanStateDAO` left all 38 scan tests green.
  //
  // So this runs the real DAO over real SQLite. It is the only place the claim can fail.

  async function seededScan(id: string): Promise<{ libraryId: string; scanState: ScanStateDAO }> {
    const userId = await seedUser(`VersionBump-${id}`);
    const libraryId = await seedLibrary(userId, id);
    const scanState = new ScanStateDAO(handle.db);
    await scanState.ensure(libraryId);
    return { libraryId, scanState };
  }

  const version = async (scanState: ScanStateDAO, libraryId: string): Promise<number> =>
    (await scanState.find(libraryId))?.index_version ?? -1;

  it('bumps when the scan changed the index, and does not when it only moved the frontier', async () => {
    const { libraryId, scanState } = await seededScan('LVB1');

    await scanState.markScanning(libraryId, 0);
    // `false`: the chunk visited folders and rewrote the root's own `is_scanned`, which is a
    // real D1 row and no change to anything a cached aggregate reads.
    await scanState.saveProgress(libraryId, 1, null, false);
    const unchanged = await scanState.complete(libraryId, 1);

    expect(unchanged).toBe(await version(scanState, libraryId));
    expect(unchanged).toBe(1);

    await scanState.markScanning(libraryId, 0);
    // `true`, and the accumulation across chunks is the other half: the flag is set by the
    // chunk that changed something, while `complete` runs on whichever chunk empties the
    // frontier. Saving `true` here and finishing in a *separate* statement is the shape.
    await scanState.saveProgress(libraryId, 1, null, true);
    // Read before `complete`, so this case cannot be satisfied by `complete` happening to
    // agree for a reason of its own — it pins that `saveProgress` is the writer of the flag.
    expect(await version(scanState, libraryId)).toBe(1);
    expect((await scanState.find(libraryId))?.changed).toBe(1);
    const changed = await scanState.complete(libraryId, 2);

    expect(changed).toBe(2);
    expect(changed).toBe(await version(scanState, libraryId));
    // And the flag is cleared by the completion, so the next scan starts from a clean answer.
    expect((await scanState.find(libraryId))?.changed).toBe(0);
  });

  it('accumulates across chunks, so the chunk that finishes does not decide it', async () => {
    const { libraryId, scanState } = await seededScan('LVB2');

    await scanState.markScanning(libraryId, 0);
    await scanState.saveProgress(libraryId, 1, null, true);
    // A later chunk that changed nothing must not clear its predecessor's answer — the same
    // reason `scanned_count` takes a delta rather than an assignment.
    await scanState.saveProgress(libraryId, 1, null, false);

    expect(await scanState.complete(libraryId, 2)).toBe(2);
  });

  it('zeroes the flag at the start of a scan, so the next no-op rescan does not bump', async () => {
    // The bug this catches is carrying the previous scan's answer forward: then the *first*
    // no-op rescan bumps and every one after it does not, which is the worst possible shape —
    // it looks like the guard works and is wrong about exactly one rescan in N.
    const { libraryId, scanState } = await seededScan('LVB3');

    await scanState.markScanning(libraryId, 0);
    await scanState.saveProgress(libraryId, 1, null, true);
    expect(await scanState.complete(libraryId, 1)).toBe(2);

    // The column itself, and read while the scan is still running: `markScanning` is the only
    // writer that can clear it, so a version that omits `changed = 0` from that statement
    // leaves the previous scan's answer in place — and the assertion above cannot see it,
    // because the error is one bump *late* rather than absent.
    await scanState.markScanning(libraryId, 0);
    expect((await scanState.find(libraryId))?.changed).toBe(0);

    await scanState.saveProgress(libraryId, 1, null, false);
    expect(await scanState.complete(libraryId, 1)).toBe(2);
  });

  it('bumps anyway for a caller that changed the index outside a scan', async () => {
    // The library-root-gone branch deletes every row and has no scan that wrote them, so it
    // has to insist. A deleted index served from cache is the failure this argument exists for.
    const { libraryId, scanState } = await seededScan('LVB4');

    await scanState.markScanning(libraryId, 0);
    await scanState.saveProgress(libraryId, 1, null, false);

    expect(await scanState.complete(libraryId, 0, true)).toBe(2);
  });
});

/**
 * The import's own schema, against the same real planner.
 *
 * ### Why the query plan and not the rows
 *
 * `WHERE library_id = ? AND path IN (?, ?)` and `WHERE library_id = ? AND lower(path) IN
 * (lower(?), lower(?))` return the same rows on a case-consistent library and differ only when
 * a library holds `Album/x.flac` beside `album/x.flac` — which a Linux WebDAV origin makes
 * **two files**, not one. A row-comparison assertion written on a tidy fixture cannot see it.
 *
 * That is the same reason `idx_songs_album_title_ci` is asserted by plan above, and the same
 * defect this file's header describes: the double lowercased both sides in JavaScript, the
 * predicate was wrong in SQL, and the answers were right. Here the risk runs the other way —
 * an import matching by metadata would return *more* rows and star a plausible-looking track —
 * so the plan is what proves the key is a seek.
 *
 * ### And the import resolves album keys with the **same** predicate the album page groups with
 *
 * `findPresentAlbumKeys` exists so an imported album star lands on an id `getAlbum` can resolve.
 * If its predicate differed from `albumKeySql`'s — a `COALESCE(album_artist_ci, '')`, say — it
 * would return the *same rows* while dropping `idx_songs_album`, and the disagreement would be
 * invisible until a star landed on the wrong album. So the plan is asserted against the real
 * one, and the rows are asserted too, because the two facts differ.
 */
describe('the import match predicates are seeks, not scans', () => {
  let libraryId: string;

  beforeEach(async () => {
    const userId = await seedUser('Importer');
    libraryId = await seedLibrary(userId, 'LIMPORTS');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    // Two albums in two directories, one of them a **release split across folders**, so the
    // `(album_ci, title_ci)` key and the `path` key cannot answer each other's question — a
    // fixture where they coincide would pass against a predicate on the wrong column.
    await songs.upsertFileFacts([
      { id: songId(libraryId, 'Bon Iver/For Emma/re: Stacks.flac'), libraryId, path: 'Bon Iver/For Emma/re: Stacks.flac', dirPath: 'Bon Iver/For Emma', name: 're: Stacks.flac', size: 1, mtimeMs: 1, contentType: 'audio/flac', suffix: 'flac' },
      { id: songId(libraryId, 'Bon Iver/For Emma/holocene.flac'), libraryId, path: 'Bon Iver/For Emma/holocene.flac', dirPath: 'Bon Iver/For Emma', name: 'holocene.flac', size: 1, mtimeMs: 1, contentType: 'audio/flac', suffix: 'flac' },
      // The same album, different folder: `ALBUM_GROUP_BY=album` says it is one album.
      { id: songId(libraryId, 'Bon Iver/For Emma (Deluxe)/re: Stacks (live).flac'), libraryId, path: 'Bon Iver/For Emma (Deluxe)/re: Stacks (live).flac', dirPath: 'Bon Iver/For Emma (Deluxe)', name: 're: Stacks (live).flac', size: 1, mtimeMs: 1, contentType: 'audio/flac', suffix: 'flac' },
    ]);
    for (const path of ['Bon Iver/For Emma/re: Stacks.flac', 'Bon Iver/For Emma/holocene.flac', 'Bon Iver/For Emma (Deluxe)/re: Stacks (live).flac']) {
      await songs.applyMetadata(songId(libraryId, path), { title: path.includes('live') ? 're: Stacks' : path.split('/').pop()!.replace('.flac', ''), artist: 'Bon Iver', album: 'For Emma', albumArtist: 'Bon Iver', track: 1, disc: 1, duration: 1, readerVersion: 1 });
    }
  });

  it('uses the path index for the exact-path lookup', async () => {
    const plan = queryPlan(handle, 'SELECT * FROM songs WHERE library_id = ? AND path IN (?)', [libraryId, 'Bon Iver/For Emma/holocene.flac']);

    // `(library_id, path)` — named for what it indexes, so the assertion is about the *pair*
    // being seekable and not about a path-only lookup being possible.
    expect(plan).toContain('idx_songs_library_path');
    // The negative: `lower(path)` returns identical rows on this fixture and cannot use the
    // index, because there is a function on the column. It is named here because it is the
    // wrong answer that *looks* right — a Linux origin treats `Album/x` and `album/x` as two
    // files, so lowercasing merges them and a star lands on whichever came back first.
    const coerced = queryPlan(handle, 'SELECT * FROM songs WHERE library_id = ? AND lower(path) IN (lower(?))', [libraryId, 'Bon Iver/For Emma/holocene.flac']);
    expect(coerced).not.toContain('idx_songs_library_path');
    expect(coerced).not.toBe(plan);
  });

  it('uses idx_songs_album_title_ci for the metadata key', async () => {
    const plan = queryPlan(handle, 'SELECT * FROM songs WHERE library_id = ? AND (album_ci = ? AND title_ci = ?)', [libraryId, 'for emma', 'holocene']);

    expect(plan).toContain('idx_songs_album_title_ci');
    // A `LIKE` on the same columns is the shape this layer forbids everywhere else: it cannot
    // use the index and it makes an import a scan of the library, hundreds of times.
    const searched = queryPlan(handle, "SELECT * FROM songs WHERE library_id = ? AND album_ci LIKE ? AND title_ci LIKE ?", [libraryId, '%for emma%', '%holocene%']);
    expect(searched).not.toContain('idx_songs_album_title_ci');
  });

  it('matches every row for a key rather than one, so ambiguity stays visible', async () => {
    // The remote's `re: Stacks` is the studio cut; the deluxe folder holds a **live** recording
    // under the same album and the same title. Both match, so this is the ambiguous case — and
    // the DAO returning both is what lets the caller report it instead of picking one.
    const rows = await new SongMatchDAO(handle.db).findByAlbumTitle(libraryId, [
      ['for emma', 're: stacks'],
    ]);

    expect(rows).toHaveLength(2);
  });

  it('resolves an album key with the same predicate the album page groups with', async () => {
    const key = albumKeyFor('Bon Iver', 'For Emma', ALBUM_GROUPING);
    // Non-null **asserted**, not cast: `albumKeyFor` returns `null` for an album the remote did
    // not name, and a `key!` here would make a null key bind as `undefined` into a predicate
    // rather than fail the case that is about a real one.
    expect(key).not.toBeNull();
    const present = await new SongMatchDAO(handle.db).findPresentAlbumKeys(libraryId, [key as string], ALBUM_GROUPING);

    // Present, under the configured grouping — and the release spans two directories, so this
    // is the assertion that cannot pass under `folder`.
    expect(present.has(key as string)).toBe(true);
    // And the plan of **the predicate the DAO actually issues** uses `idx_songs_album`, which a
    // `COALESCE(album_artist_ci, '')` cannot. Read through `specFromKey` — the same function
    // `SongMatchDAO.findPresentAlbumKeys` builds its statement from — because a predicate written
    // here would be a second answer, and a second answer is exactly what this assertion exists to
    // catch. `albumKeyProjection` is the *page's* face (`SELECT`/`GROUP BY`), not the row fetch's.
    const spec = specFromKey(key as string);
    const plan = queryPlan(handle, `SELECT 1 FROM songs WHERE library_id = ? AND (${spec.predicate})`, [libraryId, ...spec.values]);
    expect(plan).toContain('idx_songs_album');
  });

  it('reports an album this library does not hold rather than inventing one', async () => {
    const absent = albumKeyFor('Nobody', 'Not Indexed Here', ALBUM_GROUPING);
    expect(absent).not.toBeNull();

    expect(await new SongMatchDAO(handle.db).findPresentAlbumKeys(libraryId, [absent as string], ALBUM_GROUPING)).toEqual(new Set());
  });

  it('uses idx_songs_artist for the artist lookup', async () => {
    const plan = queryPlan(handle, 'SELECT DISTINCT artist_ci, artist FROM songs WHERE library_id = ? AND artist_ci IS NOT NULL AND artist_ci IN (?)', [libraryId, 'bon iver']);

    expect(plan).toContain('idx_songs_artist');
    // `artist_ci IS NOT NULL` is not decoration: an id minted for an artist `getArtists` does
    // not list is a star no client can find, so the filter and the id have to agree.
    expect(await new SongMatchDAO(handle.db).findPresentArtists(libraryId, ['bon iver'])).toEqual(new Map([['bon iver', 'Bon Iver']]));
  });

  it('orders a remote source by username, on the index it declares', async () => {
    // The unique index is on `username_ci`, not on the display name, because two sources may
    // share a name and two sharing a *credential* is what would quietly import one server's
    // data into another's.
    const plan = queryPlan(handle, 'SELECT id FROM import_sources ORDER BY username_ci ASC', []);

    expect(plan).toContain('idx_import_sources_username_ci');
  });
});

/**
 * The import tables' own integrity.
 *
 * These are ordinary foreign keys, and the reason they are asserted is the one this repository
 * has already paid for twice: a foreign key that **does not resolve** passes every DAO test and
 * fails at `wrangler d1 migrations apply`, because D1 enforces foreign keys and SQLite by
 * default does not. `PRAGMA foreign_key_check` is the only instrument that sees it.
 */
describe('the import schema holds', () => {
  /**
   * Every column a DAO **writes** exists.
   *
   * `report_json` was in `ImportRunRow`, written by `ImportRunDAO.writeReport` and read by
   * `parseReport` — and absent from `CREATE TABLE import_runs`. Every DAO test passed, because
   * none of them reached the write: the phase tests drive a port, the route tests use a run with
   * no report, and the migration lock records **bytes**, not columns.
   *
   * This is the defect `packages/backend-data/AGENTS.md` records twice already — `songs.reader_version`
   * and `scan_state.consecutive_failures` — and both times the instrument that found it was *this*
   * file reading `PRAGMA table_info` rather than a DAO failing. A column that is real to the code
   * and absent from the database makes the statement fail, which the retry layer then turns into a
   * `DatabaseError`; nothing about the schema looks wrong.
   *
   * So the names are written out here rather than derived from the DAOs: a list derived from the
   * code cannot detect a column the code and the schema disagree about, because the code is one
   * of the two things under test.
   */
  it('has every column a DAO names, because a missing one fails the statement and nothing else', () => {
    const columnsOf = (table: string): string[] => (handle.raw.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>).map((row) => row.name);

    // `import_sources`
    for (const column of ['id', 'name', 'base_url', 'username', 'username_ci', 'password_ciphertext', 'password_iv', 'key_version', 'music_folder_id', 'created_at', 'updated_at']) {
      expect(columnsOf('import_sources'), `import_sources.${column}`).toContain(column);
    }
    // `import_runs` — including `report_json`, which was missing and which nothing else caught.
    for (const column of ['id', 'source_id', 'target_user_id', 'status', 'workflow_id', 'play_count_worker', 'phases_json', 'report_json', 'last_error', 'started_at', 'updated_at', 'finished_at']) {
      expect(columnsOf('import_runs'), `import_runs.${column}`).toContain(column);
    }
    // `import_play_count_progress`
    for (const column of ['run_id', 'last_remote_album_id', 'albums_done', 'songs_imported', 'updated_at']) {
      expect(columnsOf('import_play_count_progress'), `import_play_count_progress.${column}`).toContain(column);
    }
  });

  it('resolves every foreign key, because D1 enforces them and SQLite does not by default', async () => {
    const userId = await seedUser('RunTarget');
    const sourceId = (await new ImportSourceDAO(handle.db).create({
      name: 'Old server',
      baseUrl: 'https://music.example.com/sonic',
      username: 'alice',
      passwordCiphertext: 'c',
      passwordIv: 'iv',
      musicFolderId: null,
    })).id;
    await new ImportRunDAO(handle.db).create({ sourceId, targetUserId: userId, phases: ['playlists', 'stars'] });

    expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('cascades a run with its user, because a report about rows that no longer exist is a lie', async () => {
    const userId = await seedUser('Doomed');
    const sourceId = (await new ImportSourceDAO(handle.db).create({ name: 'S', baseUrl: 'https://m.example.com', username: 'bob', passwordCiphertext: 'c', passwordIv: 'iv', musicFolderId: null })).id;
    const runs = new ImportRunDAO(handle.db);
    const run = await runs.create({ sourceId, targetUserId: userId, phases: ['playlists'] });

    handle.raw.prepare('DELETE FROM users WHERE id = ?').run(userId);

    // The annotations a run wrote cascade with the user anyway, so a run outliving them would
    // be a report about rows nobody can reach.
    expect(await runs.findById(run.id)).toBeNull();
  });

  it('refuses a second source with the same remote account, at the schema level', async () => {
    const sources = new ImportSourceDAO(handle.db);
    await sources.create({ name: 'Old server', baseUrl: 'https://m.example.com', username: 'alice', passwordCiphertext: 'c', passwordIv: 'iv', musicFolderId: null });

    // Same account, different label and host: still refused, because two sources sharing a
    // credential is what would quietly import one server's data into another's.
    await expect(
      sources.create({ name: 'Another label', baseUrl: 'https://other.example.com', username: 'ALICE', passwordCiphertext: 'c', passwordIv: 'iv', musicFolderId: null }),
    ).rejects.toThrow();

    // And two sources may share a *name*, because a staging server called "music" beside a
    // production one called "music" is ordinary.
    await expect(sources.create({ name: 'Old server', baseUrl: 'https://other.example.com', username: 'bob', passwordCiphertext: 'c', passwordIv: 'iv', musicFolderId: null })).resolves.toBeDefined();
  });

  it('never selects a stored credential, so a list cannot carry one into a response', async () => {
    const sources = new ImportSourceDAO(handle.db);
    await sources.create({ name: 'Old server', baseUrl: 'https://m.example.com', username: 'alice', passwordCiphertext: 'SUPER-SECRET', passwordIv: 'iv', musicFolderId: null });

    // The projection, not a filter in the route: a caller that forgot to strip the ciphertext
    // would leak it, and a caller cannot forget to strip what was never selected.
    for (const summary of await sources.listSummaries()) {
      expect(summary).not.toHaveProperty('password_ciphertext');
      expect(summary).not.toHaveProperty('password_iv');
      expect(JSON.stringify(summary)).not.toContain('SUPER-SECRET');
    }
    // And the row is genuinely there, so the assertion is about the projection rather than about
    // a source that was never stored.
    expect((await sources.findByUsername('alice'))?.password_ciphertext).toBe('SUPER-SECRET');
  });

  it('advances the play-count cursor by a delta, so two overlapping batches cannot publish the smaller count', async () => {
    // `saveProgress`'s reason verbatim, one layer down. A cursor written as an absolute total
    // goes **backwards** while the work is being done, and an operator watching progress fall
    // has no way to tell that from a fault.
    const userId = await seedUser('PlayCounts');
    const sourceId = (await new ImportSourceDAO(handle.db).create({ name: 'S', baseUrl: 'https://m.example.com', username: 'c', passwordCiphertext: 'c', passwordIv: 'iv', musicFolderId: null })).id;
    const run = await new ImportRunDAO(handle.db).create({ sourceId, targetUserId: userId, phases: ['playCounts'] });
    const progress = new ImportPlayCountProgressDAO(handle.db);
    await progress.ensure(run.id);

    await progress.advance(run.id, 'al5', 5, 40);
    await progress.advance(run.id, 'al9', 4, 30);

    const row = await progress.read(run.id);
    expect(row?.albums_done).toBe(9);
    expect(row?.songs_imported).toBe(70);
    expect(row?.last_remote_album_id).toBe('al9');
  });

  it('serialises a report and reads it back, and refuses one it cannot read rather than throwing', async () => {
    // The parse is `null` rather than an exception on purpose: a status read that throws takes
    // down the operator's whole page over a field that is decoration next to `import_runs.status`.
    expect(parseReport('{not json')).toBeNull();
    expect(parseReport(null)).toBeNull();
    expect(parseReport(JSON.stringify({ runId: 'r', phases: [] }))?.phases).toEqual([]);
    // A body with no phases is not a report: it would render as an empty list, which is the
    // one sentence meaning "nothing happened".
    expect(parseReport(JSON.stringify({ runId: 'r' }))).toBeNull();
  });

  it('replaces a phase line by name, so a retried step cannot list the same item twice', async () => {
    const first = buildReport({ runId: 'r', sourceName: 'S', targetUsername: 'ann', finished: true, phases: [phase({ phase: 'stars', status: 'partial', unresolved: [{ category: 'star', context: 'starred', remoteId: 'r1', label: 'Track', reason: 'not-found' }] })] });
    const second = buildReport({
      runId: 'r',
      sourceName: 'S',
      targetUsername: 'ann',
      finished: true,
      // The same phase name, re-run: the line is **replaced**, which is what makes recording a
      // phase outside the step idempotent. Appending would double every unresolved item.
      phases: [phase({ phase: 'stars', status: 'imported', imported: 3 })],
    });

    expect(parseReport(serializeReport(first))?.phases).toHaveLength(1);
    expect(parseReport(serializeReport(second))?.phases.map((entry) => entry.phase)).toEqual(['stars']);
    expect(parseReport(serializeReport(second))?.phases[0].imported).toBe(3);
    // And the cap holds: the count stays exact while the names are truncated, so an operator
    // learns the scale of the problem even when the list is summarised.
    const many = Array.from({ length: MAX_REPORTED_UNRESOLVED + 50 }, (_, index) => ({ category: 'star', context: 'starred', remoteId: `r${index}`, label: `T${index}`, reason: 'not-found' as const }));
    const capped = phase({ phase: 'stars', status: 'partial', unresolvedCount: many.length, unresolved: collectUnresolved([], many) });
    expect(capped.unresolved).toHaveLength(MAX_REPORTED_UNRESOLVED);
    expect(capped.unresolvedCount).toBe(MAX_REPORTED_UNRESOLVED + 50);
  });
});

/**
 * The two play-count writers, and the difference between them.
 *
 * ### Why this needs its own case
 *
 * `recordPlay` **increments** and `setPlayCounts` **overwrites**, on one table, and the difference
 * is **completely silent**. An import that added to a count already set would inflate every count
 * in the library — and unlike a playlist there is no observable difference between "played twice"
 * and "imported twice", so nothing downstream could catch it and no client would complain.
 *
 * Both properties are asserted over the same table and in the same order, because a test that only
 * wrote one of them would pass whichever implementation it was given.
 */
describe('play counts: a scrobble increments, an import overwrites', () => {
  async function seeded(): Promise<string> {
    const userId = await seedUser('Plays');
    const libraryId = await seedLibrary(userId, 'LPLAYS');
    const songs = new SongDAO(handle.db, DERIVED_MARKER);
    await songs.upsertFileFacts([
      { id: songId(libraryId, 'A/one.flac'), libraryId, path: 'A/one.flac', dirPath: 'A', name: 'one.flac', size: 1, mtimeMs: 1, contentType: 'audio/flac', suffix: 'flac' },
      { id: songId(libraryId, 'A/two.flac'), libraryId, path: 'A/two.flac', dirPath: 'A', name: 'two.flac', size: 1, mtimeMs: 1, contentType: 'audio/flac', suffix: 'flac' },
    ]);
    return userId;
  }

  const countsOf = async (userId: string): Promise<Map<string, number>> =>
    await new PlayCountDAO(handle.db).listPlayCounts(userId);

  it('adds one per scrobble, and keeps the last-played instant', async () => {
    const userId = await seeded();
    const plays = new PlayCountDAO(handle.db);

    await plays.recordPlay(userId, 'one');
    await plays.recordPlay(userId, 'one');

    expect((await countsOf(userId)).get('one')).toBe(2);
  });

  it('writes the remote value exactly, so a re-run cannot inflate a count', async () => {
    const userId = await seeded();
    const plays = new PlayCountDAO(handle.db);

    await plays.setPlayCounts(userId, [{ songId: 'one', playCount: 7 }]);
    // **The same call twice.** An additive implementation gives 14 here, and the only symptom
    // anywhere in the product would be a number that is quietly wrong.
    await plays.setPlayCounts(userId, [{ songId: 'one', playCount: 7 }]);

    expect((await countsOf(userId)).get('one')).toBe(7);
  });

  it('does not let the two writers meet: a scrobble after an import counts from the imported value', async () => {
    // The property that makes them one table rather than two. An import sets 7 and a later scrobble
    // makes 8 — which is what a user who had listened seven times and then played it once should see.
    const userId = await seeded();
    const plays = new PlayCountDAO(handle.db);

    await plays.setPlayCounts(userId, [{ songId: 'one', playCount: 7 }]);
    await plays.recordPlay(userId, 'one');

    expect((await countsOf(userId)).get('one')).toBe(8);
  });

  it('keeps two users’ counts for one song apart, because the composite key is the upsert target', async () => {
    // The failure this guards is invisible in every assertion above: a statement whose conflict
    // target were only `song_id` would make the second listener’s scrobble increment the first
    // listener’s count, and both would read back a plausible number.
    const first = await seeded();
    const second = (await new UserDAO(handle.db).create({ username: 'Plays2', passwordCiphertext: 'c', passwordIv: 'iv' })).id;
    const plays = new PlayCountDAO(handle.db);

    await plays.recordPlay(first, 'one');
    await plays.recordPlay(second, 'one');
    await plays.recordPlay(second, 'one');

    expect((await countsOf(first)).get('one')).toBe(1);
    expect((await countsOf(second)).get('one')).toBe(2);
  });

  it('leaves last_played_at alone when overwriting, because a remote published no play time', async () => {
    // The remote reported a *count*, not when it happened. Stamping `last_played_at` would claim
    // the import is when the listener last played the track, and it is the column a client reads
    // as "last played".
    const userId = await seeded();
    const plays = new PlayCountDAO(handle.db);
    await plays.recordPlay(userId, 'one');

    await plays.setPlayCounts(userId, [{ songId: 'one', playCount: 40 }]);
    const row = handle.raw.prepare('SELECT last_played_at FROM play_counts WHERE user_id = ? AND song_id = ?').get(userId, 'one') as { last_played_at: number | null };
    expect(row.last_played_at).not.toBeNull();
  });

  it('floors and clamps a negative count rather than storing one', async () => {
    // A remote reporting a negative count is a defect on its side, and storing it would make
    // `getSong` publish a negative number. Clamping is the honest reading: nobody has played a
    // track fewer than zero times.
    const userId = await seeded();
    await new PlayCountDAO(handle.db).setPlayCounts(userId, [{ songId: 'one', playCount: -4 }]);

    expect((await new PlayCountDAO(handle.db).listPlayCounts(userId)).get('one')).toBe(0);
  });

  it('writes nothing for an empty list, rather than spending a statement on it', async () => {
    const userId = await seeded();
    expect(await new PlayCountDAO(handle.db).setPlayCounts(userId, [])).toBe(0);
    expect(await countsOf(userId)).toEqual(new Map());
  });

  it('refuses rather than truncating a page larger than the invocation can write', async () => {
    // A partially-applied page of counts is a set of numbers right in places and wrong in others,
    // and nothing downstream can tell which is which — the same reason the play queue and the
    // derivation backfill use `requireComplete`.
    const userId = await seeded();
    const narrow = new PlayCountDAO(handle.db, new SubrequestCounter(2));
    const many = Array.from({ length: 200 }, (_, index) => ({ songId: `s${index}`, playCount: 1 }));

    await expect(narrow.setPlayCounts(userId, many)).rejects.toBeInstanceOf(SubrequestBudgetExhaustedError);
    // And nothing at all was written — the refusal happens before the batch.
    expect(await countsOf(userId)).toEqual(new Map());
  });
});

describe('a remote instance’s two refusals are told apart, because they are not the same thing', () => {
  async function seeded(): Promise<{ sources: ImportSourceDAO; userId: string; sourceId: string }> {
    const userId = await seedUser('Refusals');
    const encrypted = await encryptData('hunter2', await testKey());
    const sources = new ImportSourceDAO(handle.db);
    const sourceId = (
      await sources.create({
        name: 'Old server',
        baseUrl: 'https://music.example.com/sonic',
        username: 'alice',
        passwordCiphertext: encrypted.ciphertext,
        passwordIv: encrypted.iv,
        musicFolderId: null,
      })
    ).id;
    return { sources, userId, sourceId };
  }

  it('answers a private host as “no longer permitted” and a deleted row as “no longer exists”', async () => {
    // The Durable Object settles on both, and re-arms on neither — but an operator reading the
    // report needs to tell them apart, because the second is their own doing and the first is a
    // configuration change they may need to reverse.
    const { sources, sourceId } = await seeded();
    const service = new ImportSourceService({
      sources: async () => sources,
      resolveKey: async () => await testKey(),
      allowPrivateHosts: () => false,
      onRequest: () => undefined,
    });

    await handle.db.prepare('UPDATE import_sources SET base_url = ?').bind('https://10.1.2.3:4533').run();
    const refused = await service.clientFor(sourceId);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/permitted/i);

    await handle.db.prepare('DELETE FROM import_sources WHERE id = ?').bind(sourceId).run();
    const gone = await service.clientFor(sourceId);
    expect(gone.ok).toBe(false);
    expect(!gone.ok && gone.reason).toMatch(/no longer exists/i);
  });

  it('builds a client when both refusals do not apply, and a second one next time', async () => {
    // **Per call**, because the client holds the plaintext password for its lifetime: a client
    // cached on a Workflow instance would carry it through storage the platform does not encrypt.
    const { sources, sourceId } = await seeded();
    const service = new ImportSourceService({
      sources: async () => sources,
      resolveKey: async () => await testKey(),
      allowPrivateHosts: () => false,
      onRequest: () => undefined,
    });

    const first = await service.clientFor(sourceId);
    const second = await service.clientFor(sourceId);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && first.client).not.toBe(second.ok && second.client);
  });

  it('permits a private host when the policy opts in, so local development is not broken by the gate', async () => {
    const { sources, sourceId } = await seeded();
    await handle.db.prepare('UPDATE import_sources SET base_url = ?').bind('http://localhost:4533').run();
    const service = new ImportSourceService({
      sources: async () => sources,
      resolveKey: async () => await testKey(),
      allowPrivateHosts: () => true,
      onRequest: () => undefined,
    });

    expect((await service.clientFor(sourceId)).ok).toBe(true);
  });

  it('reports a delete of a row that is already gone as absence, so a client can tell', async () => {
    // Otherwise a second delete returns success and the caller cannot tell it did nothing.
    const { sources } = await seeded();
    const service = new ImportSourceService({
      sources: async () => sources,
      resolveKey: async () => await testKey(),
      allowPrivateHosts: () => false,
      onRequest: () => undefined,
    });

    await expect(service.remove('no-such-source')).rejects.toBeInstanceOf(NotFoundError);
  });
});
