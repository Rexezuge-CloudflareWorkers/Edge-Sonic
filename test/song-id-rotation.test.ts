/**
 * The song-id rotation backfill: legacy long ids become short ones, a page per
 * chunk, until none remain.
 *
 * New rows are minted short at insert; every row indexed before the switch
 * still carries `s:base64url(libraryId + "\n" + path)`, which clients file
 * downloads under — over 255 bytes is ENAMETOOLONG. The walk only touches
 * changed files, so untouched rows would keep long ids for ever without this.
 */
import { describe, expect, it } from 'vitest';
import { SubrequestCounter } from '@edge-sonic/shared';
import { SCAN_CHUNK_SUBSREQUEST_BUDGET, WORKER_SUBSREQUEST_CEILING } from '@edge-sonic/backend-runtime/config';
import { ScanBudget } from '@edge-sonic/backend-services/index';
import { NO_ROTATION, rotatePendingSongIds } from '@edge-sonic/backend-services/index/songIdBackfill';

const LIBRARY = '1dbaa3df-0f27-4905-b232-61e13fa22f18';

function budget(): ScanBudget {
  return new ScanBudget({ meter: new SubrequestCounter(WORKER_SUBSREQUEST_CEILING), maxRequests: SCAN_CHUNK_SUBSREQUEST_BUDGET, deadlineMs: 20_000 });
}

function store(rows: Array<{ id: string; path: string }>) {
  const rotated: Array<{ path: string; oldId: string; newId: string }> = [];
  return {
    rotated,
    listLegacySongIds: async (_libraryId: string, limit: number) =>
      rows
        .filter((row) => row.id.length > 32)
        .slice(0, limit)
        .map((row) => ({ id: row.id, library_id: LIBRARY, path: row.path })),
    rotateSongId: async (_libraryId: string, path: string, oldId: string, newId: string) => {
      const index = rows.findIndex((row) => row.path === path && row.id === oldId);
      if (index === -1) return { changes: 0, written: 0, truncated: false, billedRows: 0 };
      rows[index] = { id: newId, path };
      rotated.push({ path, oldId, newId });
      return { changes: 1, written: 1, truncated: false, billedRows: 10 };
    },
  };
}

function legacyId(path: string): string {
  return `s:${Buffer.from(`${LIBRARY}\n${path}`).toString('base64url')}`;
}

describe('rotatePendingSongIds', () => {
  it('rotates a page and reports both counts', async () => {
    const rows = [
      { id: legacyId('Blur/01.flac'), path: 'Blur/01.flac' },
      { id: legacyId('Blur/02.flac'), path: 'Blur/02.flac' },
    ];
    const fake = store(rows);
    const cost = await rotatePendingSongIds(fake, LIBRARY, budget());
    expect(cost.rowsWritten).toBe(2);
    expect(cost.billedRows).toBe(20);
    expect(fake.rotated).toHaveLength(2);
    // New ids are short — the property the whole repair exists for.
    for (const { newId } of fake.rotated) {
      expect(newId.length).toBeLessThanOrEqual(32);
      expect(newId).toMatch(/^s:[\w-]{22}$/);
    }
    // And already-short rows are never selected: the set strictly shrinks.
    expect(await fake.listLegacySongIds(LIBRARY, 10)).toEqual([]);
  });

  it('is free when nothing is owed', async () => {
    // The empty page is the steady state a healthy poll pays one read for.
    const empty = store([]);
    expect(await rotatePendingSongIds(empty, LIBRARY, budget())).toEqual(NO_ROTATION);
  });

  it('defers a page the chunk cannot hold whole rather than half-renaming', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: legacyId(`A/${i}.flac`), path: `A/${i}.flac` }));
    const fake = store(rows);
    // A chunk with almost nothing left: the read returns rows and the write
    // refuses them whole, so nothing is renamed and the next poll retries.
    const tight = new ScanBudget({ meter: new SubrequestCounter(WORKER_SUBSREQUEST_CEILING), maxRequests: 2, deadlineMs: 20_000 });
    expect(await rotatePendingSongIds(fake, LIBRARY, tight)).toEqual(NO_ROTATION);
    expect(fake.rotated).toEqual([]);
  });
});
