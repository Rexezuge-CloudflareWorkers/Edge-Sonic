/**
 * The subrequest ceiling is a measurement, and every charge point is asserted to be one.
 *
 * ### What this file is for
 *
 * Edge-Sonic shipped a scan that died at the platform's ceiling on every chunk and called it
 * "retried, still running". The budget it was checking — `ScanBudget` — metered
 * `WebDavClient.request()` and nothing else, on the strength of a reading that Cloudflare's
 * Workers limits page seemed to support: *subrequests to internal services: 1,000 on Free*.
 * D1's own page contradicts it, and says plainly:
 *
 * > Queries per Worker invocation (read subrequest limits) — 1000 (Workers Paid) / **50 (Free)**
 *
 * So a chunk of 40 folders charged its budget 40 and spent the platform roughly 240. The
 * runtime terminated each invocation with `Too many subrequests by single Worker invocation` —
 * an error no `catch` in the scan can see — and the scan only ever "finished" because each
 * dead invocation left a little progress behind.
 *
 * ### The fix was right and its stated reason was not, and that is now measured
 *
 * Taking the pessimistic reading cost this product ~21× the D1 headroom it actually had.
 * Measured on a Free account on 2026-10-05: **external `fetch` is 50 and D1 statements are
 * 1,000**, in *separate* budgets — 1,000 D1 statements and 50 outbound requests in one
 * invocation survive together, and a DO reached by RPC runs on a fresh budget the caller's
 * ceiling cannot see.
 *
 * Nothing here is broken by that, and the suite below is deliberately unchanged in what it
 * asserts: a too-small ceiling costs throughput, and a too-large one costs invocations. What
 * changes is the record. The two claims that were wrong are stated where they were made:
 *
 * - `subrequests.ts` claimed the platform *forced* the pessimistic reading. It did not — this is
 *   conservatism now, and saying otherwise would stop the next reader from ever finding out.
 * - `SubrequestMeter` claims an overrun "does not raise a catchable error". True of the external
 *   ceiling; **false of D1**, which throws and is caught by an ordinary `try`. A D1 overrun is
 *   therefore diagnosable where an external one is not.
 *
 * Full account, method and limits: `docs/issues/subrequest-budgets-are-two-not-one.md`.
 *
 * ### Why the assertions are per charge point, and why there is a negative for each
 *
 * A total is the easiest thing in the world to assert and the least informative: every charge
 * point could be removed and a test on the total alone would still pass for the paths that
 * happen to be exercised. So each one is asserted on its own — a D1 read, a KV read, a WebDAV
 * request, a Durable Object stub, a Secrets Store read — and each is paired with a **negative**
 * that shows the guard has teeth, because a charge point nothing can fail is a comment.
 *
 * ### The two readings of a D1 `batch()`
 *
 * The platform does not say whether a batch of N statements costs 1 or N. This charges N,
 * which is the reading that cannot kill an invocation; `test/scan-budget.test.ts` measures a
 * chunk under it. If the friendlier reading is right, chunks do slightly more work per poll —
 * a cost in throughput, never an availability problem.
 */
import { describe, expect, it } from 'vitest';
import { SubrequestCounter, UNMETERED_SUBREQUESTS, subrequestSpend, NO_SUBREQUESTS_SPENT } from '@edge-sonic/shared';
import type { SubrequestSpend } from '@edge-sonic/shared';
import { createRequestScope } from '@edge-sonic/backend-services/composition';
import { Tokens } from '@edge-sonic/backend-services/composition';
import { KvCache } from '@edge-sonic/backend-runtime/kv';
import { NodeDAO, SongDAO, SongIndexDAO } from '@edge-sonic/backend-data/dao';
import {
  ENRICH_TRACKS_PER_CHUNK,
  MAX_PAGE_SIZE_CEILING,
  PAGE_ALBUM_KEYS_PER_STATEMENT,
  PAGE_ALBUMS_PER_STATEMENT,
  PAGE_ANNOTATION_READS,
  PAGE_IDS_PER_STATEMENT,
  PAGE_STATEMENTS_PER_GROUP,
  SCAN_CHUNK_FOLDER_LIMIT,
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SCAN_DERIVE_MAX_ROWS_PER_CHUNK,
  SCAN_ENRICH_MAX_PER_FOLDER,
  SUBSREQUESTS_PER_CHUNK_OVERHEAD,
  SUBSREQUESTS_PER_ENRICHED_TRACK,
  SUBSREQUESTS_PER_ENRICH_CHUNK_OVERHEAD,
  SUBSREQUESTS_PER_FOLDER_BASE,
  SUBSREQUEST_INVOCATION_RESERVE,
  WORKER_SUBSREQUEST_CEILING,
  pageStatementCount,
} from '@edge-sonic/backend-runtime/config';
import { SubrequestBudgetExhaustedError } from '@edge-sonic/backend-errors';
import { AppConfiguration } from '@edge-sonic/backend-runtime/config';
import { sqliteQueryable, execScript } from './helpers/sqlite';
import { SongDerivationDAO } from '@edge-sonic/backend-data/dao';
import { DERIVED_MARKER } from './helpers/harness';
import type { DerivationWrite } from '@edge-sonic/backend-data/dao';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * D1 statements one invocation may issue on the Free plan, as **measured** on 2026-10-05.
 *
 * Not a configuration value and deliberately not in `subrequests.ts`: the product does not spend
 * from this budget, it spends from the stricter external one. It is here so the test that
 * documents the conservatism can name the headroom being given up, rather than asserting a
 * relationship against a figure nobody wrote down.
 *
 * Measured: 1,000 statements survive, 1,001 throws
 * `Too many API requests by single Worker invocation`. 1,000 statements **plus** 50 outbound
 * requests in one invocation survive together, which is what establishes the two budgets as
 * separate rather than one pool with a different error message. Full account:
 * `docs/issues/subrequest-budgets-are-two-not-one.md`.
 *
 * **KV, Secrets Store reads and DO storage were not measured.** They are assumed to share this
 * pool on the strength of the platform's own wording ("1,000 subrequests to Cloudflare
 * services"), which is an inference rather than a result.
 */
const D1_MEASURED_CEILING = 1000;

/**
 * The real schema, over the real engine, with one library row so the foreign keys hold.
 *
 * Every migration in the directory, sorted, rather than a hand-listed subset: a named list is a
 * second thing that can fall behind, and the day it does, these tests run against a schema the
 * product does not have. `test/schema.int.test.ts` asserts the directory is complete; this is
 * the same rule applied here for the same reason.
 */
function seeded(): ReturnType<typeof sqliteQueryable> {
  const handle = sqliteQueryable();
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    execScript(handle, readFileSync(`${MIGRATIONS}/${file}`, 'utf8'));
  }
  void handle.db
    .prepare(
      `INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '', 1, ?, 1, 0, 0)`,
    )
    .bind('L1', 'home', 'home', 'https://dav.example.com', '/dav/music', 'ann', 'Home')
    .run();
  return handle;
}

describe('the counter', () => {
  it('counts every kind separately, because the three have different remedies', () => {
    const meter = new SubrequestCounter(10);
    meter.charge(3, 'd1');
    meter.charge(1, 'kv');
    meter.charge(2, 'fetch');

    expect(meter.spent).toBe(6);
    expect(meter.breakdown()).toEqual({ d1: 3, kv: 1, fetch: 2, rpc: 0, secret: 0 });
  });

  it('reports what it spends with the total beside it, zeroes included', () => {
    // An operator surface reading `.d1` off a report that omitted the kinds nothing spent
    // would render a missing field as a missing measurement rather than as `0`.
    const meter = new SubrequestCounter(10);
    meter.charge(4, 'd1');
    const spend: SubrequestSpend = subrequestSpend(meter.breakdown(), meter.spent);

    expect(spend).toEqual({ total: 4, d1: 4, kv: 0, fetch: 0, rpc: 0, secret: 0 });
    expect(NO_SUBREQUESTS_SPENT.total).toBe(0);
  });

  it('ignores a non-positive charge rather than going backwards', () => {
    const meter = new SubrequestCounter(10);
    meter.charge(0);
    meter.charge(-5);
    expect(meter.spent).toBe(0);
  });

  it('resets the total and the breakdown together', () => {
    // Two counters would be two answers, and the operator would be shown a total that does not
    // match the breakdown after the second chunk.
    const meter = new SubrequestCounter(10);
    meter.charge(6, 'd1');
    meter.charge(2, 'fetch');
    meter.reset();

    expect(meter.spent).toBe(0);
    expect(meter.breakdown()).toEqual({ d1: 0, kv: 0, fetch: 0, rpc: 0, secret: 0 });
    expect(meter.ceiling).toBe(10);
  });

  it('enforces nothing when the ceiling is infinite', () => {
    const meter = new SubrequestCounter(Infinity);
    meter.charge(10_000);
    expect(meter.exhausted).toBe(false);
    expect(meter.canAfford(10_000)).toBe(true);
    expect(Number.isFinite(meter.remaining)).toBe(false);
  });

  it('hands out a meter that enforces nothing, for a caller that was given none', () => {
    // The default exists for test doubles, and it is `Infinity` rather than a small number on
    // purpose: a default ceiling of 50 would let an unmetered DAO satisfy a budget assertion.
    UNMETERED_SUBREQUESTS.charge(1_000_000);
    expect(UNMETERED_SUBREQUESTS.exhausted).toBe(false);
    UNMETERED_SUBREQUESTS.charge(-1_000_000);
  });
});

describe('every bound is derived from the one platform number', () => {
  it('states the platform ceiling as the platform states it', () => {
    expect(WORKER_SUBSREQUEST_CEILING).toBe(50);
  });

  /**
   * The ceiling is the **external** one, and the product charges internal-service calls against
   * it anyway. That is a deliberate choice, not a statement about the platform, and the two were
   * routinely confused.
   *
   * Measured against a Free account on 2026-10-05 — see
   * `docs/issues/subrequest-budgets-are-two-not-one.md`:
   *
   * | Budget | Ceiling | Overrun |
   * | --- | --- | --- |
   * | external `fetch` | 50 | kills the invocation, uncatchable |
   * | D1 statements | 1,000 | **throws**, catchable |
   *
   * So `SCAN_CHUNK_MAX_REQUESTS` is ~21× more conservative than the D1 statements it bounds.
   * Nothing is broken by that — a too-small ceiling costs throughput and a too-large one costs
   * availability, so erring this way is right. What is wrong is the *reason* it was originally
   * given, which claimed the platform forced it.
   *
   * This assertion pins the *safety property* rather than the size of the headroom being given
   * up: the budget must stay under the external ceiling whichever number it is, because that
   * ceiling is the one that **kills** the invocation. Pinning the ratio instead would turn this
   * test red the day somebody legitimately raised the budget — which is how a guard gets
   * deleted rather than read.
   */
  it('spends D1 and KV from the external ceiling, which is stricter than the platform requires', () => {
    // 50 is the external figure the platform states.
    expect(WORKER_SUBSREQUEST_CEILING).toBe(50);

    // The property that makes bounding *both* resources by the external ceiling safe: the chunk
    // budget leaves room for the invocation's own external calls. Were this `>=`, a chunk could
    // spend the whole external budget and the invocation hosting it would be terminated — the
    // exact failure this ceiling was adopted to prevent, and one that raising the budget toward
    // D1's measured 1,000 would reintroduce.
    expect(SCAN_CHUNK_SUBSREQUEST_BUDGET).toBeLessThan(WORKER_SUBSREQUEST_CEILING);

    // The headroom being given up is *recorded* rather than asserted, so it is visible to whoever
    // considers raising the budget: 42 against a measured 1,000 is ~4%. Which is why no ratio is
    // pinned here.
    expect(SCAN_CHUNK_SUBSREQUEST_BUDGET).toBeLessThan(D1_MEASURED_CEILING);
  });

  it('leaves room in a chunk for the invocation that hosts it', () => {
    // The chunk budget is the ceiling less a reserve, because authentication, the library
    // grant and `scan_state` are spent before the walk begins and are not the chunk's to skip.
    // A chunk budget equal to the ceiling would be a budget that assumes the rest of the
    // invocation is free — which is the assumption that made every chunk fail.
    expect(SCAN_CHUNK_SUBSREQUEST_BUDGET).toBe(WORKER_SUBSREQUEST_CEILING - SUBSREQUEST_INVOCATION_RESERVE);
    expect(SCAN_CHUNK_SUBSREQUEST_BUDGET).toBeGreaterThan(0);
  });

  it('derives the folder count and the enrich cap, rather than typing them', () => {
    expect(SCAN_CHUNK_FOLDER_LIMIT).toBe(Math.floor(SCAN_CHUNK_SUBSREQUEST_BUDGET / SUBSREQUESTS_PER_FOLDER_BASE));
    expect(SCAN_ENRICH_MAX_PER_FOLDER).toBe(Math.floor(SCAN_CHUNK_SUBSREQUEST_BUDGET / SUBSREQUESTS_PER_ENRICHED_TRACK));
  });

  it('charges an enriched track for everything it spends, not only its range reads', () => {
    // This is the number that was wrong by the most. `MAX_REQUESTS_PER_TRACK` was 2 — a prefix
    // read and a tail read — and the same track also costs a `songMeta` KV read, an
    // `applyMetadata` and a `songMeta` KV write. Admitting twenty tracks per folder on the cost
    // of two each is admitting ~100 subrequests of work onto a budget of 50, which is not a
    // slow chunk but a terminated invocation.
    expect(SUBSREQUESTS_PER_ENRICHED_TRACK).toBe(5);
  });

  it('bounds a maximum-size page by the statements it issues, not by its group count', () => {
    // The page ceiling was 2200, derived from the *group* count while the statement count is
    // driven by the page's track count — so 2,200 albums cost ~100 statements, twice the
    // ceiling. The derivation is the invariant, and it is asserted as a relationship so the
    // numeral can change without the relationship being lost.
    expect(MAX_PAGE_SIZE_CEILING).toBeLessThanOrEqual(500);
    expect(pageStatementCount(MAX_PAGE_SIZE_CEILING)).toBeLessThanOrEqual(SCAN_CHUNK_SUBSREQUEST_BUDGET);
    // And the ceiling is not decorative: a page an order of magnitude larger is unservable, so
    // the derivation is doing work rather than restating the protocol's own maximum.
    expect(pageStatementCount(MAX_PAGE_SIZE_CEILING * 10)).toBeGreaterThan(SCAN_CHUNK_SUBSREQUEST_BUDGET);
  });

  it('counts a page as its groups, their songs and their annotations', () => {
    // All three classes, because the derivation that produced `2200` counted the first and
    // named the others in a comment without including them.
    expect(PAGE_STATEMENTS_PER_GROUP).toBeCloseTo(
      1 / PAGE_ALBUM_KEYS_PER_STATEMENT + 1 / PAGE_ALBUMS_PER_STATEMENT + PAGE_ANNOTATION_READS / PAGE_IDS_PER_STATEMENT,
      10,
    );
    expect(pageStatementCount(0)).toBeGreaterThan(0);
  });

  it('sizes the derivation page so a chunk still visits a folder after spending it', () => {
    // A page the chunk cannot write **whole** is not a slow repair — `applyDerivation`
    // passes `requireComplete` and refuses, and the refusal fires before `listFrontier`,
    // so the walk never runs at all. The page was `200` against a budget of `42`.
    //
    // The relationship, not the numeral: `page` + the chunk's own four statements + one
    // folder's base cost must fit in one chunk. Stated this way because the two halves fail
    // differently — leave out the folder reserve and a chunk that drains the backlog returns
    // `scanning` having visited **zero** folders, which is the same stuck scan with the throw
    // removed; leave out the overhead and the reserve is one folder short of real.
    //
    // No extra `1` for the backfill's read: `SUBSREQUESTS_PER_CHUNK_OVERHEAD` already counts
    // it, so adding one here is the assertion being wrong about its own inputs rather than the
    // derivation being wrong — which is worth stating because the derivation fits the budget
    // *exactly*, and an off-by-one in the assertion is indistinguishable from an off-by-one in
    // the code.
    expect(SCAN_DERIVE_MAX_ROWS_PER_CHUNK).toBe(
      SCAN_CHUNK_SUBSREQUEST_BUDGET - SUBSREQUESTS_PER_CHUNK_OVERHEAD - SUBSREQUESTS_PER_FOLDER_BASE,
    );
    expect(SCAN_DERIVE_MAX_ROWS_PER_CHUNK + SUBSREQUESTS_PER_CHUNK_OVERHEAD + SUBSREQUESTS_PER_FOLDER_BASE).toBeLessThanOrEqual(
      SCAN_CHUNK_SUBSREQUEST_BUDGET,
    );

    // And it is a bound, not a restatement: the old page fitted on no chunk under any
    // configuration, which is the whole defect.
    expect(SCAN_DERIVE_MAX_ROWS_PER_CHUNK).toBeLessThan(SCAN_CHUNK_SUBSREQUEST_BUDGET);
  });

  it('counts the chunk overhead it subtracts, rather than asserting the number', () => {
    // `SUBSREQUESTS_PER_CHUNK_OVERHEAD` is the four statements a chunk spends that belong to
    // no folder: `ensure`, the backfill's read, `listFrontier` and `saveProgress`. Asserting
    // it against the four calls that spend it is what keeps a fifth from being added to the
    // prelude without being counted here — at which point the page is one statement too large
    // and the walk silently stops visiting folders.
    expect(SUBSREQUESTS_PER_CHUNK_OVERHEAD).toBe(4);
  });

  it('sizes the enrichment page so a chunk that spends it whole still fits the ceiling', () => {
    // The relationship, not the numeral: the overhead (scan-state guard, selection page,
    // remaining count) plus five subrequests per track must fit one chunk. A page typed
    // beside the loop is the defect this file exists for — it is right until the ceiling
    // moves, after which a chunk that spends its whole page is terminated by the runtime
    // rather than slowed.
    expect(ENRICH_TRACKS_PER_CHUNK).toBe(
      Math.floor((SCAN_CHUNK_SUBSREQUEST_BUDGET - SUBSREQUESTS_PER_ENRICH_CHUNK_OVERHEAD) / SUBSREQUESTS_PER_ENRICHED_TRACK),
    );
    expect(
      SUBSREQUESTS_PER_ENRICH_CHUNK_OVERHEAD + ENRICH_TRACKS_PER_CHUNK * SUBSREQUESTS_PER_ENRICHED_TRACK,
    ).toBeLessThanOrEqual(SCAN_CHUNK_SUBSREQUEST_BUDGET);
    // And the overhead counts what the chunk actually spends: the idle-only guard's read,
    // the page itself, and the remaining count the progress display is built from.
    expect(SUBSREQUESTS_PER_ENRICH_CHUNK_OVERHEAD).toBe(3);
  });
});

describe('a D1 statement is a subrequest', () => {
  it('charges one for a read, and the read still works', async () => {
    const handle = seeded();
    const meter = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
    const dao = new NodeDAO(handle.db, meter);

    await dao.countByLibrary('L1');

    expect(meter.spent).toBe(1);
    expect(meter.breakdown().d1).toBe(1);
    handle.close();
  });

  it('charges one per statement in a write batch, not one per call', async () => {
    // The pessimistic reading, and the reason it is stated rather than assumed: a batch of N
    // statements is N subrequests if D1's "queries per invocation" is the rule and one if the
    // Workers "subrequests" rule is. Charging one per call would be an undercount by the size
    // of the batch on every album the scan indexes.
    const handle = seeded();
    const meter = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
    const dao = new NodeDAO(handle.db, meter);
    const inputs = Array.from({ length: 10 }, (_, index) => ({
      libraryId: 'L1',
      path: `A/${index}`,
      parentPath: 'A',
      name: String(index),
      mtimeMs: 1,
      etag: null,
      depth: 2,
    }));

    await dao.upsertMany(inputs);

    expect(meter.breakdown().d1).toBe(10);
    handle.close();
  });

  it('truncates a batch that does not fit, and reports that it did', async () => {
    // A 500-track album is ~500 statements against a ceiling of 50, so truncation is the
    // *expected* outcome on a Free plan rather than an edge case — and the caller has to be
    // able to see it, because the scan's one forbidden write is the folder's own row carrying
    // `is_scanned: true`.
    const handle = seeded();
    const meter = new SubrequestCounter(6);
    const dao = new NodeDAO(handle.db, meter);
    const inputs = Array.from({ length: 10 }, (_, index) => ({
      libraryId: 'L1',
      path: `A/${index}`,
      parentPath: 'A',
      name: String(index),
      mtimeMs: 1,
      etag: null,
      depth: 2,
    }));

    const result = await dao.upsertMany(inputs);

    expect(result.truncated).toBe(true);
    expect(result.written).toBe(6);
    expect(meter.spent).toBe(6);
    handle.close();
  });

  it('refuses rather than truncating when the caller needs all of it', async () => {
    // A play queue saved halfway is a *shorter queue* — a wrong answer rather than an
    // unfinished one, and indistinguishable from a queue the client genuinely shortened. The
    // same is true of the derivation backfill, whose selection is on `derived_version`: rows
    // stamped and rows not stamped would leave the un-stamped ones re-selected for ever.
    //
    // So those two callers pass `requireComplete` and get a `413` naming the limit instead of
    // a partial write, and nothing is issued — which is the part worth asserting, because a
    // refusal that had already written half the batch would be the same defect wearing a
    // different error.
    const handle = seeded();
    const meter = new SubrequestCounter(4);
    const dao = new SongDerivationDAO(handle.db, DERIVED_MARKER, meter);
    const writes: DerivationWrite[] = Array.from({ length: 10 }, (_, index) => ({
      id: `s${index}`,
      title: `Track ${index}`,
      album: `Album ${index}`,
      artist: null,
    }));

    await expect(dao.applyDerivation(writes)).rejects.toBeInstanceOf(SubrequestBudgetExhaustedError);
    expect(meter.spent).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    handle.close();
  });

  it('lets a truncating write through where the caller can resume, paired with the refusal above', async () => {
    // The pair is the point. Truncation and refusal are not two implementations of one policy:
    // the scan needs the first because a half-written folder can be finished next chunk, and
    // the queue needs the second because a half-written queue cannot be. Asserting only one
    // would leave a future change to either indistinguishable from a fix.
    const handle = seeded();
    const meter = new SubrequestCounter(4);
    const songs = new SongDAO(handle.db, DERIVED_MARKER, meter);
    const inputs = Array.from({ length: 10 }, (_, index) => ({
      id: `s${index}`,
      libraryId: 'L1',
      path: `A/${index}.flac`,
      dirPath: 'A',
      name: `${index}.flac`,
      size: 1,
      mtimeMs: 1,
      contentType: null,
      suffix: 'flac',
    }));

    const result = await songs.upsertFileFacts(inputs);
    expect(result.truncated).toBe(true);
    expect(result.written).toBe(4);
    handle.close();
  });
});

describe('the wiring', () => {
  it('gives both composition roots\' DAOs a real counter', () => {
    // `createScanWorkerScope` is `createRequestScope`, so there is one composition root to
    // assert — but the assertion exists because an unmetered DAO is invisible: it works, it
    // returns the right rows, and it spends nothing the budget can see.
    const scope = createRequestScope({
      DB: sqliteQueryable().db,
      CACHE: null,
      SUBSONIC_USER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      WEBDAV_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    } as never);

    const meter = scope.get(Tokens.SubrequestMeter);
    expect(meter.ceiling).toBe(WORKER_SUBSREQUEST_CEILING);
    // The cache holds the same one, so a KV operation and a D1 statement cannot be counted by
    // two objects that disagree.
    expect(scope.get(Tokens.KvCache)).toBeInstanceOf(KvCache);
  });
});

describe('a KV operation is a subrequest', () => {
  it('charges a read, a write and a miss', async () => {
    const meter = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
    const store = new Map<string, string>();
    const cache = new KvCache(
      {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => void store.set(key, value),
        delete: async () => undefined,
        list: async () => ({ keys: [], list_complete: true }),
      },
      meter,
    );

    await cache.getText('songMeta', ['a']);
    await cache.putText('songMeta', ['a'], '{"x":1}');
    await cache.getText('songMeta', ['a']);

    // Three calls, two of which were hits — and a miss costs the same as a hit, because both
    // are a request to KV. Counting only the hits would make a warm cache look free and hide
    // the read that warmed it.
    expect(meter.breakdown().kv).toBe(3);
  });

  it('charges nothing when there is no binding, because nothing was requested', () => {
    // Failing soft must not cost budget: an absent `CACHE` answers every request from D1, and
    // charging for a call that was never issued would make the cache's absence look expensive.
    const meter = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
    const cache = new KvCache(null, meter);
    expect(cache.available).toBe(false);
    void cache.getText('songMeta', ['a']);
    expect(meter.spent).toBe(0);
  });
});
describe('a read whose size the caller chose is clamped, and one it did not is refused', () => {
  /**
   * 120 artists is two statements of keys — which is what `bindChunkSize(1)` derives from D1's
   * 100-parameter ceiling, and the reason the batching exists at all.
   */
  function libraryWithArtists(count: number): ReturnType<typeof seeded> {
    const handle = seeded();
    const insert = handle.db.prepare(
      `INSERT INTO songs (id, library_id, path, dir_path, name, name_ci, size, mtime_ms, content_type, suffix,
                          artist, artist_ci, album, album_ci, album_artist, album_artist_ci,
                          duration, bitrate, derived_version, created_at, updated_at)
       VALUES (?, 'L1', ?, ?, ?, ?, 1, 1, 'audio/flac', 'flac', ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0)`,
    );
    for (let index = 0; index < count; index += 1) {
      const artist = `Artist ${String(index).padStart(4, '0')}`;
      void insert
        .bind(`s${index}`, `Artist ${index}/${artist}.flac`, `Artist ${index}`, `${artist}.flac`, `${artist}.flac`, artist, artist.toLowerCase(), artist, artist.toLowerCase(), artist, artist.toLowerCase(), 1)
        .run();
    }
    return handle;
  }

  it('clamps a page of artists to what the remaining budget can fetch rows for', async () => {
    // `listArtists`' callers ask for 500, 5,000 and 500. Five thousand artists is 51 statements
    // before a single row is read, so it was a guaranteed failure on the Free plan for the
    // endpoint a player draws its front page from. Clamping is right here and refusing is not:
    // the caller asked for as many as the server can serve, so a shorter page *is* the answer.
    const handle = libraryWithArtists(120);
    const meter = new SubrequestCounter(4);
    const index = new SongIndexDAO(handle.db, meter);

    const rows = await index.listArtists('L1', 5000, 0);

    // Four statements' worth of keys at 99 a statement, clamped to whole artists.
    expect(rows.length).toBeLessThanOrEqual(4 * 99);
    expect(rows.length).toBeGreaterThan(0);
    expect(meter.spent).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
    handle.close();
  });

  it('refuses an id list it cannot resolve whole, rather than resolving a subset', async () => {
    // The caller's id list *is* the answer, so a subset is a wrong answer rather than an
    // unfinished one — and a shorter queue is indistinguishable from a queue the client
    // deliberately shortened, which has shipped here before from a different cause.
    const handle = libraryWithArtists(1);
    const meter = new SubrequestCounter(2);
    const songs = new SongDAO(handle.db, DERIVED_MARKER, meter);

    // Asserted on the **type**, not the message: a message match would keep passing if the
    // error were reworded, and the thing that matters is that this is the budget error and not
    // a `DatabaseError` — because the two want opposite responses, and only one of them is the
    // client's request being too large.
    await expect(songs.listIdsIn('L1', Array.from({ length: 500 }, (_, index) => `s${index}`))).rejects.toBeInstanceOf(SubrequestBudgetExhaustedError);
    handle.close();
  });
});

describe('the guards have teeth', () => {
  it('fails if the per-statement charge is removed from a write batch', async () => {
    // A guard nothing can fail is a comment. This is the pair for "charges one per statement in
    // a write batch": with `runWriteBatch` charging one call instead of N statements, a batch
    // would cost 1 where it costs 10 — and the scan would start a chunk it cannot finish, which
    // on the Free plan is a terminated invocation rather than a slow one.
    const handle = seeded();
    const meter = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
    const dao = new NodeDAO(handle.db, meter);
    const inputs = Array.from({ length: 10 }, (_, index) => ({ libraryId: 'L1', path: `A/${index}`, parentPath: 'A', name: String(index), mtimeMs: 1, etag: null, depth: 2 }));

    await dao.upsertMany(inputs);

    // Ten rows, ten statements, ten subrequests. If this ever reads 1, the batch is charging
    // per call — and every chunk bound in the product is now optimistic by the batch size.
    expect(meter.breakdown().d1).toBe(inputs.length);
    handle.close();
  });

  it('fails if the truncation report is dropped, because the scan depends on it', async () => {
    // `reconcileFolder` reads `truncated` to decide whether it may write the folder's own row
    // with `is_scanned: true`. Without the report it retires a half-written folder and nothing
    // ever revisits it — the same shape as the "browse path closes the frontier" defect, one
    // layer down.
    const handle = seeded();
    const meter = new SubrequestCounter(6);
    const dao = new NodeDAO(handle.db, meter);
    const inputs = Array.from({ length: 10 }, (_, index) => ({ libraryId: 'L1', path: `A/${index}`, parentPath: 'A', name: String(index), mtimeMs: 1, etag: null, depth: 2 }));

    const result = await dao.upsertMany(inputs);

    expect(result.truncated).toBe(true);
    expect(result.written).toBeLessThan(inputs.length);
    handle.close();
  });

  it('fails if the derived ceilings stop being derived', () => {
    // Pinning the numerals instead of the relationships is how `2200` survived a derivation that
    // no longer bounded anything. Each assertion here would fail the moment someone raised the
    // ceiling without re-deriving what depends on it.
    expect(SCAN_CHUNK_SUBSREQUEST_BUDGET).toBe(WORKER_SUBSREQUEST_CEILING - SUBSREQUEST_INVOCATION_RESERVE);
    expect(SCAN_CHUNK_FOLDER_LIMIT * SUBSREQUESTS_PER_FOLDER_BASE).toBeLessThanOrEqual(SCAN_CHUNK_SUBSREQUEST_BUDGET);
    expect(SCAN_ENRICH_MAX_PER_FOLDER * SUBSREQUESTS_PER_ENRICHED_TRACK).toBeLessThanOrEqual(SCAN_CHUNK_SUBSREQUEST_BUDGET);
  });
});

describe('the operator cannot configure a chunk past what the platform allows', () => {
  /**
   * The clamp, and the warning that names it.
   *
   * `MAX_PAGE_SIZE` was clamped to its derived ceiling for exactly this reason — a configured
   * maximum is an obligation, not a permission — and the two scan bounds had no such clamp,
   * while the operator surface told people to raise one of them. On a Free-plan account, where
   * the platform's ceiling cannot be raised at all, following that advice converts a chunk that
   * pauses into a chunk the runtime terminates.
   */
  it('clamps the chunk ceiling and says so', () => {
    const config = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', SCAN_CHUNK_MAX_REQUESTS: '1000' });

    expect(config.getScanChunkMaxRequests()).toBe(SCAN_CHUNK_SUBSREQUEST_BUDGET);
    const warnings = config.validate();
    expect(warnings.some((warning) => /SCAN_CHUNK_MAX_REQUESTS=1000/.test(warning) && /clamped/.test(warning))).toBe(true);
  });

  it('clamps the folder count and the enrich cap, and says so', () => {
    const folders = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', SCAN_CHUNK_FOLDERS: '40' });
    expect(folders.getScanChunkFolders()).toBe(SCAN_CHUNK_FOLDER_LIMIT);
    expect(folders.validate().some((warning) => /SCAN_CHUNK_FOLDERS=40/.test(warning))).toBe(true);

    const enrich = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', SCAN_ENRICH_MAX_PER_FOLDER: '20' });
    expect(enrich.getScanEnrichMaxPerFolder()).toBe(SCAN_ENRICH_MAX_PER_FOLDER);
    expect(enrich.validate().some((warning) => /SCAN_ENRICH_MAX_PER_FOLDER=20/.test(warning))).toBe(true);
  });

  it('leaves the shipped values alone, so the clamp is not masking a mistake in the defaults', () => {
    const config = AppConfiguration.fromEnv({ ENVIRONMENT: 'production' });

    expect(config.getScanChunkMaxRequests()).toBe(SCAN_CHUNK_SUBSREQUEST_BUDGET);
    expect(config.getScanChunkFolders()).toBe(SCAN_CHUNK_FOLDER_LIMIT);
    expect(config.getScanEnrichMaxPerFolder()).toBe(SCAN_ENRICH_MAX_PER_FOLDER);
    expect(config.validate().filter((warning) => /clamped/.test(warning))).toEqual([]);
  });

  it('still lets an operator lower a bound, which is the direction that helps', () => {
    // A clamp that also refused smaller values would be a setting, not a bound: a deliberately
    // cautious chunk is a legitimate configuration and the only one a Free-plan operator has
    // room to make.
    const config = AppConfiguration.fromEnv({ ENVIRONMENT: 'production', SCAN_CHUNK_MAX_REQUESTS: '10', SCAN_CHUNK_FOLDERS: '2' });

    expect(config.getScanChunkMaxRequests()).toBe(10);
    expect(config.getScanChunkFolders()).toBe(2);
  });
});
