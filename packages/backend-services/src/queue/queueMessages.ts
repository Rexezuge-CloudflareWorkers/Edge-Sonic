/**
 * Queue message shapes (Producer/Consumer contract).
 *
 * One queue: scan chunks. An import queue existed alongside it, but its producer was
 * never wired and its consumer acknowledged messages without doing the work — the
 * Workflow and the play-count Durable Object are the import path. A dead binding is a
 * Dead resource on the account, so it was deleted rather than left declared.
 *
 * Messages are validated, never cast: a queue redelivers poison messages, so
 * an unknown shape must be a logged skip rather than a throw that re-queues
 * for ever.
 */

type ScanQueueMessage = {
  readonly kind: 'scan-chunk';
  readonly libraryId: string;
};

type QueueMessage = ScanQueueMessage;

function isScanQueueMessage(value: unknown): value is ScanQueueMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'scan-chunk' && typeof record.libraryId === 'string' && record.libraryId.length > 0;
}

function isQueueMessage(value: unknown): value is QueueMessage {
  return isScanQueueMessage(value);
}

export type { ScanQueueMessage, QueueMessage };
export { isScanQueueMessage, isQueueMessage };
