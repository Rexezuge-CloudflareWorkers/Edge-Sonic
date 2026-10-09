/**
 * The queue consumer's **failure policy**, driven through the real
 * `EdgeSonicWorker.onQueue` with the dispatch mocked:
 *
 * - a message whose body cannot be processed (unknown shape, unknown library,
 *   a step that never ran) is *acknowledged* — redelivery cannot fix either,
 *   and acking keeps poison from re-queueing;
 * - a message whose processing *failed* is retried, and only retried, so
 *   Cloudflare's `max_retries` applies and an exhausted message is dead-lettered.
 *
 * The first policy catches messages Cloudflare would otherwise re-deliver for ever;
 * the second is what turns a failed chunk into a retry rather than a silent drop —
 * the previous handler caught everything and acked, so a transient D1 refusal lost
 * the chunk and the budget stayed green.
 */
import { describe, expect, it, vi } from 'vitest';

const consumeQueueMessage = vi.fn();

vi.mock('@edge-sonic/background/queueConsumers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@edge-sonic/background/queueConsumers')>();
  return {
    ...original,
    consumeQueueMessage: (...args: unknown[]) => consumeQueueMessage(...args),
  };
});

const createRequestScope = vi.fn();

vi.mock('@edge-sonic/backend-services/composition', async (importOriginal) => {
  const original = await importOriginal<typeof import('@edge-sonic/backend-services/composition')>();
  return {
    ...original,
    createRequestScope: (...args: unknown[]) => createRequestScope(...args),
  };
});

import { EdgeSonicWorker } from '../apps/api/src/workers/EdgeSonicWorker';

function message(body: unknown) {
  return {
    body,
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  };
}

describe('EdgeSonicWorker.onQueue', () => {
  it('acks a message the consumer handled, even a skip', async () => {
    consumeQueueMessage.mockResolvedValue({ handled: false, reason: 'unknown-kind:x' });
    const worker = new EdgeSonicWorker();
    const one = message({ kind: 'mystery' });

    await worker.onQueue({ messages: [one] }, {} as never);

    expect(one.acked).toBe(true);
    expect(one.retried).toBe(false);
  });

  it('retries, and never acks, a message that threw', async () => {
    consumeQueueMessage.mockRejectedValue(new Error('D1 is refusing writes until midnight UTC'));
    const worker = new EdgeSonicWorker();
    const one = message({ kind: 'scan-chunk', libraryId: 'L1' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await worker.onQueue({ messages: [one] }, {} as never);
    } finally {
      spy.mockRestore();
    }

    expect(one.acked).toBe(false);
    expect(one.retried).toBe(true);
  });

  it('keeps the two decisions per message: a failure does not redeliver its neighbour', async () => {
    consumeQueueMessage.mockResolvedValueOnce({ handled: true, kind: 'scan-chunk' }).mockRejectedValueOnce(new Error('boom'));
    const worker = new EdgeSonicWorker();
    const good = message({ kind: 'scan-chunk', libraryId: 'L1' });
    const bad = message({ kind: 'scan-chunk', libraryId: 'L2' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await worker.onQueue({ messages: [good, bad] }, {} as never);
    } finally {
      spy.mockRestore();
    }

    expect(good.acked).toBe(true);
    expect(good.retried).toBe(false);
    expect(bad.acked).toBe(false);
    expect(bad.retried).toBe(true);
  });
});

describe('EdgeSonicWorker.onScheduled', () => {
  it('a failing fanout is logged, never thrown: cron must not redeliver', async () => {
    createRequestScope.mockImplementation(() => {
      throw new Error('D1 down');
    });
    const worker = new EdgeSonicWorker();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(worker.onScheduled({} as never)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
