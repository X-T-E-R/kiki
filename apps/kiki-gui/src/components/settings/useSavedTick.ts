import { useCallback, useEffect, useRef, useState } from 'react';

/** Transient ✓-saved affirmation with auto-clear, for instant-apply controls. */
export function useSavedTick(): [boolean, () => void] {
  const [nonce, setNonce] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const ping = useCallback(() => {
    setNonce((value) => value + 1);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setNonce(0); }, 2500);
  }, []);
  return [nonce > 0, ping];
}
