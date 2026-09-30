import { useCallback, useRef, useState } from 'react';
import { NOTICE_TIMEOUT_MS } from '../lib/constants';
import type { Notice } from '../types';

/**
 * The setter the shell hands to views and hooks.
 *
 * `(type, text)` rather than a `Notice` object, so call sites read as the event
 * they report. The `Notice` object shape stays the *data* — `describeProbe`
 * returns one, and the `run` helpers forward its fields here.
 */
type ShowNotice = (type: Notice['type'], text: string) => void;

/**
 * A transient status message.
 *
 * The timer is cleared on replace so a fast sequence of messages does not leave an
 * earlier `setTimeout` firing after a later one and cutting it short — the classic
 * "the error banner vanished before I read it" bug.
 */
function useNotice(): { notice: Notice | null; showNotice: ShowNotice; clearNotice: () => void } {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearNotice = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setNotice(null);
  }, []);

  const showNotice = useCallback<ShowNotice>((type, text) => {
    if (timer.current !== null) clearTimeout(timer.current);
    setNotice({ type, text });
    timer.current = setTimeout(() => {
      timer.current = null;
      setNotice(null);
    }, NOTICE_TIMEOUT_MS);
  }, []);

  return { notice, showNotice, clearNotice };
}

export { useNotice };
export { NOTICE_TIMEOUT_MS } from '../lib/constants';
export type { ShowNotice };
