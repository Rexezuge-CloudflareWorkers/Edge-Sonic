/**
 * Queue wiring for the composition root.
 *
 * Reads `SCAN_QUEUE` off `env` like every other binding: absent
 * in tests and local dev, present when the deployment template declares them.
 * A sender that is not a `send` function is treated as absent rather than
 * throwing at scope-construction time.
 */
import type { Container } from '@edge-sonic/backend-runtime/di';
import { QueueService } from '../queue/queueService';
import type { QueueSender } from '../queue/queueService';
import type { RequestScopeEnv } from './serviceFactory';
import { Tokens } from './tokens';

function asSender(value: unknown): QueueSender | null {
  if (typeof value === 'object' && value !== null && typeof (value as { send?: unknown }).send === 'function') {
    return value as QueueSender;
  }
  return null;
}

function bindQueue(scope: Container, env: RequestScopeEnv): void {
  const queueEnv = env as {
    SCAN_QUEUE?: unknown;
  };
  scope.bindValue(
    Tokens.QueueService,
    new QueueService({
      scanQueue: asSender(queueEnv.SCAN_QUEUE),
    }),
  );
}

export { bindQueue };
