/**
 * The library-wide enrichment: bounded chunks off the rows still owing a tag read.
 *
 * ### Why real SQLite and a real `EnrichmentService` here
 *
 * The selection (`enriched_at IS NULL OR reader_version != ?`) and the stamp
 * (`applyMetadata`) are the whole feature: a double that reported either one from
 * memory would agree with the service about which rows remain while production
 * re-offered them for ever. So the store is `node:sqlite` through the real DAOs and
 * the tracks are enriched by the real service off `fakeDav` bodies — the same reason
 * `test/scan-convergence.test.ts` runs the real DAO. What is *not* real is the origin,
 * which is the one thing modellable without lying.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { READER_VERSION } from '@edge-sonic/media-tags';
import { ConflictError } from '@edge-sonic/backend-errors';
import { SubrequestCounter } from '@edge-sonic/shared';
import {
  ENRICH_TRACKS_PER_CHUNK,
  SCAN_CHUNK_SUBSREQUEST_BUDGET,
  SUBSREQUESTS_PER_ENRICHED_TRACK,
  WORKER_SUBSREQUEST_CEILING,
} from '@edge-sonic/backend-runtime/config';
import { KvCache } from '@edge-sonic/backend-runtime/kv';
import { WebDavClient } from '@edge-sonic/webdav';
import { SongDAO, SongEnrichmentDAO, ScanStateDAO, billedRowsForTable } from '@edge-sonic/backend-data/dao';
import { EnrichmentService, LibraryEnrichmentService } from '@edge-sonic/backend-services/index';
import { InProcessEnrichDriver } from '@edge-sonic/backend-services/library';
import { sqliteQueryable } from './helpers/sqlite';
import { migrationSql } from './helpers/migrations';
import { fakeDav } from './helpers/fakeDav';
import { fakeKv } from './helpers/fakeKv';

const LIBRARY_ID = 'L1';
const BASE_URL = 'https://dav.example.com';
const ROOT = '/dav';
const TRACK_SIZE = 30_000_000;

const encoder = new TextEncoder();

/**
 * A real FLAC prefix reporting `seconds`, so the service resolves the duration from one
 * ranged read and never needs the tail. Copied from `test/enrichment-config.test.ts`
 * rather than imported: suites do not import from each other, and a fixture both suites
 * depend on belongs in `helpers/` — which this is not, because it is specific to tag
 * bytes rather than shared setup.
 */
function flacPrefix(seconds: number, sampleRate = 44_100): Uint8Array {
  const streamInfo = new Uint8Array(34);
  const view = new DataView(streamInfo.buffer);
  view.setUint16(0, 4096);
  view.setUint16(2, 4096);
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let index = width - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
  };
  push(sampleRate, 20);
  push(1, 3);
  push(15, 5);
  push(sampleRate * seconds, 36);
  for (let index = 0; index < 64; index += 1) {
    if (bits[index]) streamInfo[10 + (index >> 3)]! |= 1 << (7 - (index & 7));
  }
  return new Uint8Array([...encoder.encode('fLaC'), 0x80, 0, 0, 34, ...streamInfo]);
}

function libraryRow() {
  return {
    id: LIBRARY_ID,
    slug: 'home',
    slug_ci: 'home',
    base_url: BASE_URL,
    root_path: ROOT,
    dav_username: 'ann',
    password_ciphertext: '',
    password_iv: '',
    key_version: 1,
    display_name: 'Home',
    is_enabled: 1,
    created_at: 0,
    updated_at: 0,
  };
}

interface Setup {
  service: LibraryEnrichmentService;
  enrichment: EnrichmentService;
  songs: SongDAO;
  enrichSelection: SongEnrichmentDAO;
  scans: ScanStateDAO;
  dav: ReturnType<typeof fakeDav>;
  meter: SubrequestCounter;
  row: ReturnType<typeof libraryRow>;
  close(): void;
}

async function setup(trackCount: number, overrides: { chunkMaxRequests?: number } = {}): Promise<Setup> {
  const handle = sqliteQueryable();
  handle.raw.exec(migrationSql());
  const meter = new SubrequestCounter(WORKER_SUBSREQUEST_CEILING);
  const songs = new SongDAO(handle.db, '', meter);
  const enrichSelection = new SongEnrichmentDAO(handle.db, meter);
  const scans = new ScanStateDAO(handle.db, meter);
  handle.raw
    .prepare(
      'INSERT INTO libraries (id, slug, slug_ci, base_url, root_path, dav_username, password_ciphertext, password_iv, key_version, display_name, is_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 0)',
    )
    .run(LIBRARY_ID, 'home', 'home', BASE_URL, ROOT, 'ann', '', '', 'Home');

  const tree: Record<string, Array<{ path: string; size: number; contentType: string; body: Uint8Array }>> = {};
  const inputs = [];
  for (let index = 1; index <= trackCount; index += 1) {
    const name = `${String(index).padStart(2, '0')}.flac`;
    const full = `${ROOT}/A/${name}`;
    tree[full] = [{ path: full, size: TRACK_SIZE, contentType: 'audio/flac', body: flacPrefix(180) }];
    inputs.push({
      id: `s${index}`,
      libraryId: LIBRARY_ID,
      path: `A/${name}`,
      dirPath: 'A',
      name,
      size: TRACK_SIZE,
      mtimeMs: 1000 + index,
      contentType: 'audio/flac',
      suffix: 'flac',
    });
  }
  // Indexed like the scan leaves them: file facts present, nothing tag-read yet.
  await songs.upsertFileFacts(inputs);
  const dav = fakeDav(tree);
  const cache = fakeKv();
  const row = libraryRow();

  const enrichment = new EnrichmentService({
    songs: {
      findById: (id) => songs.findById(id),
      applyMetadata: (id, metadata) => songs.applyMetadata(id, metadata),
    },
    clientFor: async (_library, onRequest) => new WebDavClient(BASE_URL, ROOT, { username: 'u', password: 'p' }, dav.fetch, onRequest),
    kv: new KvCache(cache.ns, meter),
    resolveKey: async () => 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
    readBytes: 131_072,
    readTailBytes: 65_536,
    timeoutMs: 1000,
  });

  const service = new LibraryEnrichmentService({
    songs: {
      listNeedingEnrichment: (libraryId, readerVersion, limit) => enrichSelection.listNeedingEnrichment(libraryId, readerVersion, limit),
      countNeedingEnrichment: (libraryId, readerVersion) => enrichSelection.countNeedingEnrichment(libraryId, readerVersion),
    },
    scanState: { find: (libraryId) => scans.find(libraryId) },
    subrequests: meter,
    enrichTrack: async (library, facts, onRequest) => {
      const outcome = await enrichment.enrichFacts(library, facts, onRequest);
      return { rowsWritten: outcome.rowsWritten, billedRows: outcome.billedRows };
    },
    chunkMaxRequests: overrides.chunkMaxRequests ?? SCAN_CHUNK_SUBSREQUEST_BUDGET,
    chunkDeadlineMs: 60_000,
    tracksPerChunk: ENRICH_TRACKS_PER_CHUNK,
    readerVersion: READER_VERSION,
  });

  return {
    service,
    enrichment,
    songs,
    enrichSelection,
    scans,
    dav,
    meter,
    row: row as never,
    close: () => handle.close(),
  };
}

describe('LibraryEnrichmentService', () => {
  let teardown: Array<() => void> = [];
  afterEach(() => {
    for (const close of teardown) close();
    teardown = [];
  });
  const open = async (count: number, overrides?: { chunkMaxRequests?: number }): Promise<Setup> => {
    const created = await setup(count, overrides);
    teardown.push(created.close);
    return created;
  };

  it('drains an unenriched library to idle, stamping every row', async () => {
    const { service, songs, dav, row } = await open(3);

    const result = await service.step(row as never);

    expect(result.status).toBe('idle');
    expect(result.enriched).toBe(3);
    expect(result.remaining).toBe(0);
    expect(result.lastError).toBeNull();
    // One prefix read a track — FLAC carries its length up front, so no tail read.
    expect(dav.gets).toHaveLength(3);
    for (const index of [1, 2, 3]) {
      const stored = await songs.findById(`s${index}`);
      expect(stored?.enriched_at).not.toBeNull();
      expect(stored?.reader_version).toBe(READER_VERSION);
      expect(stored?.duration).toBe(180);
    }
    // Measured, not declared: a `songs` write bills the row plus its nine indexes.
    expect(result.rowsWritten).toBe(3);
    expect(result.billedRows).toBe(3 * billedRowsForTable('songs', 1));
    expect(result.subrequests.total).toBeLessThanOrEqual(WORKER_SUBSREQUEST_CEILING);
  });

  it('resumes across chunks with no cursor, because stamped rows leave the selection', async () => {
    // Nine tracks against a page of seven: the first chunk cannot finish, and the second
    // must not re-offer the seven it already stamped.
    const { service, dav, row } = await open(9);

    const first = await service.step(row as never);
    expect(first.status).toBe('enriching');
    expect(first.enriched).toBe(7);
    expect(first.remaining).toBe(2);

    const second = await service.step(row as never);
    expect(second.status).toBe('idle');
    expect(second.enriched).toBe(2);
    expect(second.remaining).toBe(0);
    // Nine range reads across two chunks — no track read twice.
    expect(dav.gets).toHaveLength(9);
  });

  it('costs nothing on a library with nothing owing', async () => {
    const { service, dav, row } = await open(2);
    await service.step(row as never);
    dav.reset();

    const again = await service.step(row as never);

    expect(again.status).toBe('idle');
    expect(again.enriched).toBe(0);
    expect(dav.gets).toHaveLength(0);
  });

  it('refuses while the scan is advancing, and runs once it is idle', async () => {
    const { service, scans, row } = await open(1);
    await scans.ensure(LIBRARY_ID);
    await scans.markScanning(LIBRARY_ID, 0);

    await expect(service.step(row as never)).rejects.toThrow(ConflictError);

    await scans.complete(LIBRARY_ID, 0);
    const result = await service.step(row as never);
    expect(result.status).toBe('idle');
  });

  it('runs beside a stalled scan, which has nothing scheduled to compete with', async () => {
    const { service, scans, row } = await open(1);
    await scans.ensure(LIBRARY_ID);
    await scans.fail(LIBRARY_ID, 'gone');
    await scans.fail(LIBRARY_ID, 'gone');
    await scans.fail(LIBRARY_ID, 'gone');

    const result = await service.step(row as never);
    expect(result.status).toBe('idle');
  });

  it('leaves a transiently failed track unstamped, for the next chunk to retry', async () => {
    const { service, songs, dav, row } = await open(2);
    dav.setGetStatus(503);

    const failed = await service.step(row as never);

    expect(failed.enriched).toBe(0);
    expect(failed.remaining).toBe(2);
    expect(failed.status).toBe('enriching');
    expect((await songs.findById('s1'))?.enriched_at).toBeNull();

    dav.setGetStatus(null);
    const retried = await service.step(row as never);
    expect(retried.status).toBe('idle');
    expect(retried.enriched).toBe(2);
  });

  it('stamps a track the origin answers 404 for, because the file is gone', async () => {
    // A `404` describes the file rather than the request, so it earns the stamp: the row
    // leaves the selection instead of being re-read on every chunk for a file that no
    // longer exists.
    const { service, songs, dav, row } = await open(1);
    dav.setGetStatus(404);

    const result = await service.step(row as never);

    expect(result.enriched).toBe(1);
    expect(result.remaining).toBe(0);
    expect((await songs.findById('s1'))?.enriched_at).not.toBeNull();
  });

  it('stops at the request ceiling with the bound named, and continues next chunk', async () => {
    // Guard, page and remaining count cost three; one track costs five. Eight admits
    // exactly one track and names the bound rather than crossing it.
    const overhead = 3;
    const { service, row } = await open(3, { chunkMaxRequests: overhead + SUBSREQUESTS_PER_ENRICHED_TRACK });

    const first = await service.step(row as never);
    expect(first.status).toBe('enriching');
    expect(first.enriched).toBe(1);
    expect(first.remaining).toBe(2);
    expect(first.stoppedBy).toBe('requests');

    const second = await service.step(row as never);
    expect(second.enriched).toBe(1);
    expect(second.remaining).toBe(1);
  });

  it('pauses without writing when the day’s share is spent', async () => {
    const { service, songs, dav, row } = await open(2);
    const budget = () => ({ billedRowsWrittenToday: 90_000, limit: 90_000, now: Date.now });

    const result = await service.step(row as never, budget);

    expect(result.status).toBe('paused');
    expect(result.resumeAt).not.toBeNull();
    expect(result.enriched).toBe(0);
    expect(dav.gets).toHaveLength(0);
    expect((await songs.findById('s1'))?.enriched_at).toBeNull();
  });

  it('re-reads rows a superseded reader wrote, keyed on the reader as well as the bytes', async () => {
    const { service, songs, enrichSelection, dav, row } = await open(1);
    await service.step(row as never);
    expect(dav.gets).toHaveLength(1);
    // A corrected reader deployed over a library it already wrote: the file has not
    // moved, so a selection on `enriched_at` alone would never offer it again. With a
    // value patch beside the version, because the patch builder writes only what it is
    // given and a version alone is nothing to write.
    await songs.applyMetadata('s1', { duration: 180, bitrate: 100, readerVersion: READER_VERSION - 1 });
    // Offered despite `enriched_at` being set: staleness is the bytes *and* the reader.
    expect(await enrichSelection.listNeedingEnrichment(LIBRARY_ID, READER_VERSION, 7)).toHaveLength(1);

    const reread = await service.step(row as never);

    expect(reread.enriched).toBe(1);
    // Served from the cache entry the first read populated — same bytes, so no second
    // read — and the row carries the current reader again.
    expect(dav.gets).toHaveLength(1);
    expect((await songs.findById('s1'))?.reader_version).toBe(READER_VERSION);
  });

  it('replays a complete cache entry into a row that lost it, without a second read', async () => {
    const { enrichment, songs, dav, row } = await open(1);
    const facts = { id: 's1', path: 'A/01.flac', size: TRACK_SIZE, mtimeMs: 1001 };
    await enrichment.enrichFacts(row as never, facts);
    expect(dav.gets).toHaveLength(1);
    // A restored backup, or a row written after the cache was populated: the bytes are
    // unchanged, so the file must not be re-read — but the row must be re-stamped, or
    // every future page re-offers it for ever. With a value patch beside the version,
    // for the builder's reason above.
    await songs.applyMetadata('s1', { duration: 180, bitrate: 100, readerVersion: READER_VERSION - 1 });

    const replayed = await enrichment.enrichFacts(row as never, facts);

    expect(dav.gets).toHaveLength(1);
    expect(replayed.rowsWritten).toBe(1);
    expect((await songs.findById('s1'))?.reader_version).toBe(READER_VERSION);
  });
});

describe('InProcessEnrichDriver', () => {
  let teardown: Array<() => void> = [];
  afterEach(() => {
    for (const close of teardown) close();
    teardown = [];
  });

  it('reports null while tracks remain and idle once nothing does', async () => {
    const created = await setup(1);
    teardown.push(created.close);
    const driver = new InProcessEnrichDriver(
      () => created.service,
      (libraryId) => created.enrichSelection.countNeedingEnrichment(libraryId, READER_VERSION),
    );

    expect(await driver.readState(LIBRARY_ID)).toBeNull();
    expect(await driver.stateForLibraryList(LIBRARY_ID)).toBeNull();

    await driver.advance(created.row as never);

    const done = await driver.readState(LIBRARY_ID);
    expect(done?.status).toBe('idle');
    expect(done?.remaining).toBe(0);
  });
});
