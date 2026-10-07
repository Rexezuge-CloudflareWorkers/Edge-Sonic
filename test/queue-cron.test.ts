import { describe, expect, it, vi } from 'vitest';
import { QueueService } from '@edge-sonic/backend-services/queue';
import { isQueueMessage, isScanQueueMessage } from '@edge-sonic/backend-services/queue';
import { consumeQueueMessage, librariesDueForCron } from '../apps/background/src/queueConsumers';

describe('queue messages: validated, never cast', () => {
  it('accepts the scan-chunk shape, and nothing else', () => {
    expect(isScanQueueMessage({ kind: 'scan-chunk', libraryId: 'L1' })).toBe(true);
    expect(isQueueMessage({ kind: 'scan-chunk', libraryId: 'L1' })).toBe(true);
    expect(isQueueMessage({ kind: 'import-batch', runId: 'R1' })).toBe(false);
  });

  it('rejects empty ids and unknown kinds without throwing', () => {
    expect(isScanQueueMessage({ kind: 'scan-chunk', libraryId: '' })).toBe(false);
    expect(isScanQueueMessage({ kind: 'scan-chunk' })).toBe(false);
    expect(isQueueMessage({ kind: 'reindex-everything' })).toBe(false);
    expect(isQueueMessage(null)).toBe(false);
    expect(isQueueMessage('scan-chunk')).toBe(false);
  });
});

describe('QueueService: fail-soft producer', () => {
  it('enqueues nothing without bindings', async () => {
    const queue = new QueueService({ scanQueue: null });
    expect(queue.hasScanQueue()).toBe(false);
    expect(await queue.enqueueScan('L1')).toBe(false);
  });

  it('sends typed messages and survives a throwing sender', async () => {
    const sent: unknown[] = [];
    const queue = new QueueService({
      scanQueue: { send: async (message: unknown) => void sent.push(message) },
    });
    const throwing = new QueueService({
      scanQueue: {
        send: async () => {
          throw new Error('queue down');
        },
      },
    });
    expect(await throwing.enqueueScan('L1')).toBe(false);
    expect(await queue.enqueueScan('L1')).toBe(true);
    expect(sent).toEqual([{ kind: 'scan-chunk', libraryId: 'L1' }]);
  });
});

describe('queue consumer: poison never re-queues', () => {
  it('skips unknown messages instead of throwing', async () => {
    const outcome = await consumeQueueMessage({ kind: 'reindex-everything' }, () => {
      throw new Error('scope must not be built for poison');
    });
    expect(outcome).toEqual({ handled: false, reason: 'unknown-kind:reindex-everything' });
  });

  it('a failing step propagates, so the message is retried rather than dropped', async () => {
    const scopeFor = () => ({
      get: (token: symbol): unknown => {
        if (token.description === 'LibraryDAO') {
          return async () => ({ findById: async () => ({ id: 'L1' }) });
        }
        if (token.description === 'ScanService') {
          return { step: async () => { throw new Error('D1 refused the chunk writes'); } };
        }
        throw new Error(`unexpected token ${String(token)}`);
      },
    });
    await expect(
      consumeQueueMessage({ kind: 'scan-chunk', libraryId: 'L1' }, scopeFor as never),
    ).rejects.toThrow('D1 refused the chunk writes');
  });

  it('reports a gone library instead of stepping', async () => {
    const scopeFor = () => ({
      get: (token: symbol) => {
        if (token.description === 'LibraryDAO') {
          return async () => ({ findById: async () => null });
        }
        throw new Error(`unexpected token ${String(token)}`);
      },
    });
    const outcome = await consumeQueueMessage(
      { kind: 'scan-chunk', libraryId: 'gone' },
      scopeFor as never,
    );
    expect(outcome).toEqual({ handled: false, reason: 'library-gone' });
  });
});

describe('cron fanout: bounded and fail-soft', () => {
  it('lists libraries for enqueue', async () => {
    const scopeFor = () => ({
      get: () => async () => ({
        list: async () => [{ id: 'L1' }, { id: 'L2' }],
      }),
    });
    await expect(librariesDueForCron(scopeFor as never)).resolves.toEqual(['L1', 'L2']);
  });

  it('enqueues nothing when D1 refuses', async () => {
    const scopeFor = () => ({
      get: () => {
        throw new Error('D1 down');
      },
    });
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      await expect(librariesDueForCron(scopeFor as never)).resolves.toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
