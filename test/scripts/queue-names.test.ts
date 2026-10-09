import { describe, expect, it } from 'vitest';
import { queueNamesIn } from '../../scripts/lib/wrangler-config/resources';

describe('queueNamesIn: what the deploy creates', () => {
  it('returns nothing when no queues are declared', () => {
    expect(queueNamesIn({})).toEqual([]);
    expect(queueNamesIn({ queues: {} })).toEqual([]);
  });

  it('creates each queue once when producers and consumers name it twice', () => {
    expect(
      queueNamesIn({
        queues: {
          producers: [
            { binding: 'SCAN_QUEUE', queue: 'edge-sonic-scan' },
            { binding: 'IMPORT_QUEUE', queue: 'edge-sonic-scan-dlq' },
          ],
          consumers: [{ queue: 'edge-sonic-scan' }, { queue: 'edge-sonic-scan-dlq' }],
        },
      }),
    ).toEqual(['edge-sonic-scan', 'edge-sonic-scan-dlq']);
  });

  it('keeps first-seen order and skips empty names', () => {
    expect(
      queueNamesIn({
        queues: {
          producers: [
            { binding: 'A', queue: '' },
            { binding: 'B', queue: 'q2' },
          ],
          consumers: [{ queue: 'q1' }, { queue: 'q2' }],
        },
      }),
    ).toEqual(['q2', 'q1']);
  });
});
