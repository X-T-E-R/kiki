import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useLocation, useNavigate, type NavigateOptions, type To } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { ConfirmDialog } from '../ConfirmDialog';
import { DirtyGuardContext, useDirtyGuardState } from '../dirtyGuard';

/**
 * Test harness: the app's real dirty guard over a MemoryRouter. In-page
 * details (`?model=`, `?agent=`) open and close through the router, and a
 * dirty editor asks with the same "Discard and leave / Keep editing" prompt
 * the app shell shows. `reportDirty` still sees every dirty report.
 */
export function RouterDirtyGuard({ reportDirty, children }: {
  reportDirty?: (id: string, dirty: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const location = useLocation();
  const go = useNavigate();
  const perform = useCallback((target: To | number, options?: NavigateOptions) => {
    if (typeof target === 'number') return go(target);
    return go(target, options);
  }, [go]);
  const guard = useDirtyGuardState(location, perform);
  // Stable identity: editors report from effects keyed on this callback.
  const reportRef = useRef({ outer: reportDirty, inner: guard.value.reportDirty });
  reportRef.current = { outer: reportDirty, inner: guard.value.reportDirty };
  const report = useCallback((id: string, dirty: boolean) => {
    reportRef.current.outer?.(id, dirty);
    reportRef.current.inner(id, dirty);
  }, []);
  const value = useMemo(() => ({ ...guard.value, reportDirty: report }), [guard.value, report]);
  return (
    <DirtyGuardContext.Provider value={value}>
      {children}
      <ConfirmDialog stacked open={guard.pending} title={t('st.dirty.leaveTitle')} body={t('st.dirty.leaveBody')}
        confirmLabel={t('st.dirty.leaveConfirm')} cancelLabel={t('st.dirty.stay')}
        onConfirm={() => { void guard.confirm(); }} onCancel={guard.cancel} />
    </DirtyGuardContext.Provider>
  );
}
