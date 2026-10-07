/**
 * Queue consumer + cron fanout (Strategy over the same services the
 * alarm/direct paths use).
 *
 * Pure dispatch: takes a scope factory so tests drive the real `ScanService`
 * without workerd. A message whose shape is wrong is a logged skip — its
 * redelivery would never succeed. A message whose *processing* fails throws,
 * so the queue's retry budget applies and an exhausted message lands in the
 * dead-letter queue rather than being acknowledged as handled.
 */
import { Tokens } from '@edge-sonic/backend-services/composition';
import { isScanQueueMessage } from '@edge-sonic/backend-services/queue';
import type { createScanWorkerScope } from './ScanWorkerFactory';
import { createLogger } from '@edge-sonic/backend-runtime/logger';

const logger = createLogger('queue');

type WorkerScope = ReturnType<typeof createScanWorkerScope>;

type QueueOutcome = { readonly handled: true; readonly kind: string } | { readonly handled: false; readonly reason: string };

async function consumeQueueMessage(message: unknown, scopeFor: () => WorkerScope): Promise<QueueOutcome> {
  if (!isScanQueueMessage(message)) {
    const raw = typeof message === 'object' && message !== null ? (message as { kind?: unknown }).kind : undefined;
    const kind = typeof raw === 'string' && raw.length > 0 ? raw : 'unknown';
    logger.warn(`skipping unknown message kind "${kind}"`);
    return { handled: false, reason: `unknown-kind:${kind}` };
  }
  const scope = scopeFor();
  const libraries = await scope.get(Tokens.LibraryDAO)();
  const library = await libraries.findById(message.libraryId);
  if (library === null) {
    // The registration is gone, so the message can never be processed; skip rather
    // than retry it into the dead-letter queue.
    logger.warn('scan-chunk for an unknown library; acknowledged');
    return { handled: false, reason: 'library-gone' };
  }
  const scan = scope.get(Tokens.ScanService);
  // A throw propagates on purpose: the scan did not complete, so the message is
  // retried by the queue and, past `max_retries`, dead-lettered. The same `step`
  // body is what the operator's manual path runs, so a queue-driven chunk
  // overlapping the alarm is the overlap the manual path already permits, with
  // the same delta accounting on the frontier.
  await scan.step(library);
  return { handled: true, kind: 'scan-chunk' };
}

/**
 * Cron fanout: one scan-chunk message per registered library.
 *
 * Bounded by `MAX_LIBRARIES` and fail-soft: a DB refusal enqueues nothing and
 * logs, so a spent allowance does not turn maintenance into a retry loop.
 * Returns the library ids it enqueued for.
 */
async function librariesDueForCron(scopeFor: () => WorkerScope): Promise<readonly string[]> {
  const scope = scopeFor();
  try {
    const libraries = await scope.get(Tokens.LibraryDAO)();
    const rows = await libraries.list();
    return rows.map((row) => row.id);
  } catch (error) {
    logger.warn('library listing failed, enqueuing nothing:', error);
    return [];
  }
}

export { consumeQueueMessage, librariesDueForCron };
export type { QueueOutcome };
