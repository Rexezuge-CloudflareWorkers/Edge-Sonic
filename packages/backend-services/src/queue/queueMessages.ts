/**
 * Queue message shapes (Producer/Consumer contract).
 *
 * Two queues, never one: scan chunks and import batches have opposite latency
 * profiles and separate budgets, for the same reason `SCAN` and `IMPORT_DO`
 * are separate Durable Object namespaces. One queue would let an import walk
 * block a scan chunk behind it.
 *
 * Messages are validated, never cast: a queue redelivers poison messages, so
 * an unknown shape must be a logged skip rather than a throw that re-queues
 * for ever.
 */

type ScanQueueMessage = {
  readonly kind: 'scan-chunk';
  readonly libraryId: string;
};

type ImportQueueMessage = {
  readonly kind: 'import-batch';
  readonly runId: string;
};

type QueueMessage = ScanQueueMessage | ImportQueueMessage;

function isScanQueueMessage(value: unknown): value is ScanQueueMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'scan-chunk' && typeof record.libraryId === 'string' && record.libraryId.length > 0;
}

function isImportQueueMessage(value: unknown): value is ImportQueueMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'import-batch' && typeof record.runId === 'string' && record.runId.length > 0;
}

function isQueueMessage(value: unknown): value is QueueMessage {
  return isScanQueueMessage(value) || isImportQueueMessage(value);
}

export type { ScanQueueMessage, ImportQueueMessage, QueueMessage };
export { isScanQueueMessage, isImportQueueMessage, isQueueMessage };
