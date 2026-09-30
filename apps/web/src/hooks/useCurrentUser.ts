import { useEffect, useState } from 'react';
import type { CurrentUser } from '../types';
import { loadCurrentUser } from '../services/userService';

export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    // The effect owns the "am I still mounted" check, because only the effect
    // knows when the component goes away — same contract as the views' `load`
    // effects. Without it a slow `/me` can set state after unmount.
    let cancelled = false;
    void loadCurrentUser()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setAuthorized(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAuthorized(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { user, setUser, authorized };
}
