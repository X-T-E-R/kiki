import { useCallback, useEffect, useRef, useState } from 'react';

/** Transient ✓-saved affirmation with auto-clear, for instant-apply controls. */
export function useSavedTick(): [boolean, () => void, () => void] {
  const [nonce, setNonce] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setNonce(0);
  }, []);
  const ping = useCallback(() => {
    setNonce((value) => value + 1);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setNonce(0);
    }, 2500);
  }, []);
  return [nonce > 0, ping, clear];
}
