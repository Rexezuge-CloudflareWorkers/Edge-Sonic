/**
 * Queue producer (Adapter over Cloudflare Queues).
 *
 * Fail-soft like `KvCache`: an absent binding is a miss, not an error, so
 * tests, local dev, and deployments without queues keep the alarm/direct
 * paths. A throwing `send` is a logged skip for the same reason — a scan that
 * cannot enqueue still advances on its next poll or alarm.
 */
import type { QueueMessage } from './queueMessages';

interface QueueSender {
  send(message: unknown): Promise<void>;
}

interface QueueServiceDeps {
  scanQueue: QueueSender | null;
}

class QueueService {
  private readonly scanQueue: QueueSender | null;

  public constructor(deps: QueueServiceDeps) {
    this.scanQueue = deps.scanQueue ?? null;
  }

  public hasScanQueue(): boolean {
    return this.scanQueue !== null;
  }

  public async enqueueScan(libraryId: string): Promise<boolean> {
    if (this.scanQueue === null) return false;
    try {
      const message: QueueMessage = { kind: 'scan-chunk', libraryId };
      await this.scanQueue.send(message);
      return true;
    } catch (error) {
      console.warn('[QueueService] scan enqueue failed; the alarm/poll paths remain the truth:', error);
      return false;
    }
  }
}

export { QueueService };
export type { QueueSender, QueueServiceDeps };
