import { describe, expect, it } from 'vitest';
import { isD1ErrorRetryable } from '@edge-sonic/backend-data/utils';
import { SCAN_CHUNK_SUBSREQUEST_BUDGET, SUBSREQUESTS_PER_FOLDER_BASE } from '@edge-sonic/backend-runtime/config';
import { ALBUMS_PER_BATCH } from '../apps/background/src/PlayCountImportWorker';

describe('hardening phase 3: deterministic faults never retry', () => {
  it('too many SQL variables is not retryable despite matching /too many/', () => {
    expect(isD1ErrorRetryable('Failed to list: too many SQL variables')).toBe(false);
    expect(isD1ErrorRetryable('too many SQL variables')).toBe(false);
  });

  it('transient faults still retry', () => {
    expect(isD1ErrorRetryable('database is locked')).toBe(true);
    expect(isD1ErrorRetryable('network connection lost')).toBe(true);
    expect(isD1ErrorRetryable('')).toBe(false);
  });
});

describe('hardening phase 3: one cost for one unit of work', () => {
  it('play-count batch derives from the folder base cost', () => {
    expect(ALBUMS_PER_BATCH).toBe(Math.max(1, Math.floor(SCAN_CHUNK_SUBSREQUEST_BUDGET / SUBSREQUESTS_PER_FOLDER_BASE)));
  });
});
