/**
 * The info service's cache contract.
 *
 * The endpoint tests can prove that a tag reached the wire; only these can prove that the
 * month-long KV entry is keyed on the right things and that a failed read is not remembered.
 * A `503` cached as "this album has no notes" would survive every retry until the file moved
 * or the entry aged out — the same defect the enrichment rule names, one feature over.
 */
import { describe, expect, it } from 'vitest';
import { EntityInfoService, infoKey } from '@edge-sonic/backend-services/index';
import { createKvCache } from '@edge-sonic/backend-runtime/kv';
import { fakeKv } from './helpers/fakeKv';
import type { LibraryRow } from '@edge-sonic/backend-data/dao';
import type { WebDavClient } from '@edge-sonic/webdav';

const library = { id: 'L1' } as LibraryRow;
const song = { path: 'Artist/Album/01.flac', size: 4096, mtime_ms: 1000 };

function flacWith(comment: string): Uint8Array {
  const entry = new TextEncoder().encode(comment);
  const body = new Uint8Array(4 + 4 + 4 + entry.length);
  const view = new DataView(body.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, entry.length, true);
  body.set(entry, 12);
  const bytes = new Uint8Array(4 + 4 + 34 + 4 + body.length + 2);
  bytes.set(new TextEncoder().encode('fLaC'), 0);
  bytes.set([0, 0, 0, 34], 4);
  bytes.fill(0, 8, 42);
  bytes.set([0x84, 0, 0, body.length], 42);
  bytes.set(body, 46);
  bytes.set([0xff, 0xf8], bytes.length - 2);
  return bytes;
}

function service(
  bytes: Uint8Array,
  options: { failFirst?: boolean; store?: ReturnType<typeof fakeKv> } = {},
): { info: EntityInfoService; reads: () => number; store: ReturnType<typeof fakeKv> } {
  const store = options.store ?? fakeKv();
  let reads = 0;
  const info = new EntityInfoService({
    cache: createKvCache(store.ns),
    clientFor: async () =>
      ({
        readPrefix: async () => {
          reads += 1;
          if (options.failFirst && reads === 1) throw new Error('503 from origin');
          return bytes;
        },
      }) as unknown as WebDavClient,
    timeoutMs: 1000,
  });
  return { info, reads: () => reads, store };
}

describe('EntityInfoService', () => {
  it('reads the tag once and answers the second call from the cache', async () => {
    const { info, reads } = service(flacWith('DESCRIPTION=A note'));
    expect((await info.forSong(library, song)).notes).toBe('A note');
    expect((await info.forSong(library, song)).notes).toBe('A note');
    expect(reads()).toBe(1);
  });

  it('caches an absence, so an untagged album does not re-read on every screen', async () => {
    const { info, reads, store } = service(flacWith('TITLE=No prose here'));
    expect(await info.forSong(library, song)).toEqual({ notes: null, albumMusicBrainzId: null, artistMusicBrainzId: null });
    expect(await info.forSong(library, song)).toEqual({ notes: null, albumMusicBrainzId: null, artistMusicBrainzId: null });
    expect(reads()).toBe(1);
    expect(store.calls.put).toBe(1);
  });

  it('caches nothing when the read failed, so a transient 503 is not a month of "no notes"', async () => {
    const { info, reads, store } = service(flacWith('DESCRIPTION=Recovered note'), { failFirst: true });
    expect((await info.forSong(library, song)).notes).toBe(null);
    expect(store.calls.put).toBe(0);
    expect((await info.forSong(library, song)).notes).toBe('Recovered note');
    expect(reads()).toBe(2);
  });

  it('moves the key when the file revision moves, without a delete or an invalidation', async () => {
    const { info, reads } = service(flacWith('DESCRIPTION=A note'));
    await info.forSong(library, song);
    await info.forSong(library, { ...song, mtime_ms: 2000 });
    expect(reads()).toBe(2);
  });

  it('carries the reader version in the key, so a corrected extractor orphan old entries', () => {
    expect(infoKey(library, song)).toContain('v1');
    expect(infoKey(library, song)).toContain('1000x4096');
  });

  it('answers from the origin when the cache is throwing', async () => {
    const store = fakeKv({}, { failAll: true });
    const { info } = service(flacWith('DESCRIPTION=Still works'), { store });
    expect((await info.forSong(library, song)).notes).toBe('Still works');
  });
});
