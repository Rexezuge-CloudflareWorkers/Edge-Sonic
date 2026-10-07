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
  importQueue: QueueSender | null;
}

class QueueService {
  private readonly scanQueue: QueueSender | null;
  private readonly importQueue: QueueSender | null;

  public constructor(deps: QueueServiceDeps) {
    this.scanQueue = deps.scanQueue ?? null;
    this.importQueue = deps.importQueue ?? null;
  }

  public hasScanQueue(): boolean {
    return this.scanQueue !== null;
  }

  public hasImportQueue(): boolean {
    return this.importQueue !== null;
  }

  public async enqueueScan(libraryId: string): Promise<boolean> {
    if (this.scanQueue === null) return false;
    try {
      const message: QueueMessage = { kind: 'scan-chunk', libraryId };
      await this.scanQueue.send(message);
      return true;
    } catch (error) {
      console.debug('[QueueService] scan enqueue failed:', error);
      return false;
    }
  }

  public async enqueueImportBatch(runId: string): Promise<boolean> {
    if (this.importQueue === null) return false;
    try {
      const message: QueueMessage = { kind: 'import-batch', runId };
      await this.importQueue.send(message);
      return true;
    } catch (error) {
      console.debug('[QueueService] import enqueue failed:', error);
      return false;
    }
  }
}

export { QueueService };
export type { QueueSender, QueueServiceDeps };
