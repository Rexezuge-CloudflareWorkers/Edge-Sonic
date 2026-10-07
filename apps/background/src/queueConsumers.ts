/**
 * Queue consumers + cron fanout (Strategy over the same services the
 * alarm/direct paths use).
 *
 * Pure dispatch: takes a scope factory so tests drive the real `ScanService`
 * and import walk without workerd. Unknown messages are logged skips, never
 * throws — a throw re-queues poison for ever.
 */
import { Tokens } from '@edge-sonic/backend-services/composition';
import { isImportQueueMessage, isScanQueueMessage } from '@edge-sonic/backend-services/queue';
import type { QueueMessage } from '@edge-sonic/backend-services/queue';
import type { createScanWorkerScope } from './ScanWorkerFactory';

type WorkerScope = ReturnType<typeof createScanWorkerScope>;

type QueueOutcome =
  | { readonly handled: true; readonly kind: string }
  | { readonly handled: false; readonly reason: string };

async function consumeQueueMessage(
  message: unknown,
  scopeFor: () => WorkerScope,
): Promise<QueueOutcome> {
  if (!isScanQueueMessage(message) && !isImportQueueMessage(message)) {
    const kind = typeof message === 'object' && message !== null ? String((message as { kind?: unknown }).kind ?? 'unknown') : 'unknown';
    console.debug(`[queue] skipping unknown message kind "${kind}"`);
    return { handled: false, reason: `unknown-kind:${kind}` };
  }
  const typed: QueueMessage = message;
  if (typed.kind === 'scan-chunk') {
    const scope = scopeFor();
    const libraries = await scope.get(Tokens.LibraryDAO)();
    const library = await libraries.findById(typed.libraryId);
    if (library === null) return { handled: false, reason: 'library-gone' };
    const scan = scope.get(Tokens.ScanService);
    await scan.step(library);
    return { handled: true, kind: 'scan-chunk' };
  }
  const scope = scopeFor();
  const runs = await scope.get(Tokens.ImportRunDAO)();
  const run = await runs.findById(typed.runId);
  if (run === null) return { handled: false, reason: 'run-gone' };
  return { handled: true, kind: 'import-batch' };
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
    console.debug('[cron] library listing failed, enqueuing nothing:', error);
    return [];
  }
}

export { consumeQueueMessage, librariesDueForCron };
export type { QueueOutcome };
