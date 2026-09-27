import { useCallback, useRef, useState } from 'react';
import type { Notice } from '../types';

const NOTICE_TIMEOUT_MS = 6000;

/**
 * A transient status message.
 *
 * The timer is cleared on replace so a fast sequence of messages does not leave an
 * earlier `setTimeout` firing after a later one and cutting it short — the classic
 * "the error banner vanished before I read it" bug.
 */
function useNotice(): { notice: Notice | null; showNotice: (notice: Notice) => void; clearNotice: () => void } {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearNotice = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setNotice(null);
  }, []);

  const showNotice = useCallback(
    (next: Notice) => {
      if (timer.current !== null) clearTimeout(timer.current);
      setNotice(next);
      timer.current = setTimeout(() => {
        timer.current = null;
        setNotice(null);
      }, NOTICE_TIMEOUT_MS);
    },
    [],
  );

  return { notice, showNotice, clearNotice };
}

export { useNotice, NOTICE_TIMEOUT_MS };
