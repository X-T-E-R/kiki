/**
 * Dirty-draft guard for the settings sections. The settings page owns a set
 * of unsaved editor ids; editors report through `useDirtyReporter`, and the
 * nav asks the set before letting a dirty providers page unmount.
 */

import { createContext, useContext, useEffect } from 'react';

export interface DirtyGuardValue {
  readonly reportDirty: (id: string, dirty: boolean) => void;
}

export const DirtyGuardContext = createContext<DirtyGuardValue | null>(null);

/** Report this editor's dirty state while mounted; cleans up on unmount. */
export function useDirtyReporter(id: string, dirty: boolean): void {
  const guard = useContext(DirtyGuardContext);
  useEffect(() => {
    guard?.reportDirty(id, dirty);
    return () => { guard?.reportDirty(id, false); };
  }, [guard, id, dirty]);
}
