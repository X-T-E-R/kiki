/**
 * Entering a remote space, and getting back to this window's own space.
 *
 * A remote Kiki is not a local home: the window's own home never changes, and
 * the remote space is a scope the source home's broker serves. So entering it
 * is the same guarded scope navigation the local switcher uses — the connection
 * and protocol are verified before anything is committed, and a failure leaves
 * the current space, draft and page exactly where they were. The reload that
 * follows re-selects the remote scope from the handoff; it is never a native
 * `--home` switch.
 */

import { useCallback } from 'react';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import { parseActiveSpacePayload } from '../../../lib/spaceStorage';
import { requestScopeNavigation } from '../../../lib/navScope';
import { remoteSpaceScope } from '../../../lib/remoteConnections';
import { pushToast } from '../../../lib/toasts';
import { useConnection } from '../../../state/connection';

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Switch this window into a registered remote Kiki's space. */
export function useRemoteSpaceEntry() {
  const host = useHost();
  const { connectionId, spaceKey } = useConnection();
  const { t } = useI18n();
  return useCallback((id: string, name: string) => {
    // Remote spaces need the desktop host: a browser window has no control home.
    if (host.kind !== 'tauri' || id === connectionId) return;
    void requestScopeNavigation(remoteSpaceScope(id)).catch((error: unknown) => {
      if (isAbort(error)) return;
      pushToast({ tone: 'error', text: t('sidebar.space.remoteFailed', { name }) });
    });
  }, [host.kind, connectionId, spaceKey, t]);
}

/**
 * Leave a remote space for the space this window really belongs to. The window
 * keeps its own home throughout (the remote scope never changed it), so the
 * return target is read from the desktop rather than remembered in state that a
 * reload could lose.
 */
export function useReturnToLocalSpace() {
  const host = useHost();
  const { t } = useI18n();
  return useCallback(() => {
    const go = async () => {
      const payload = host.activeSpace === undefined ? null : await host.activeSpace().catch(() => null);
      const homeId = parseActiveSpacePayload(payload)?.homeId ?? 'main';
      await requestScopeNavigation({ homeId, scopeId: 'local' });
    };
    void go().catch((error: unknown) => {
      if (isAbort(error)) return;
      pushToast({ tone: 'error', text: t('sidebar.space.backFailed') });
    });
  }, [host, t]);
}
