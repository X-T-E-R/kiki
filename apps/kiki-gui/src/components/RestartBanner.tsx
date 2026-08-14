/**
 * App-global "restart required" banner — visible on every page once a
 * restart-gated setting changes. Restart rides the desktop sidecar bridge,
 * then the shared socket reconnects and queries refetch; no page reload.
 * "Later" dismisses for this app run only (a new change re-arms the banner).
 * In the browser, "Acknowledge" also hides for this app run — but keeps the
 * pending requirement intact, since only a desktop restart satisfies it.
 */

import { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../i18n';
import { errorText } from '../i18n/locale';
import { isDesktopRuntime, restartNativeServer } from '../lib/desktop';
import {
  acknowledgeRestartRequirement,
  clearRestartRequirement,
  isRestartRequirementAcknowledged,
  restartRequirementSnapshot,
  subscribeRestartRequirement,
  type RestartRequirement,
} from '../lib/settings';
import { useConnection } from '../state/connection';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

export function useRestartRequirement(): RestartRequirement {
  return useSyncExternalStore(subscribeRestartRequirement, restartRequirementSnapshot);
}

export function RestartBanner() {
  const { t, locale } = useI18n();
  const { socket } = useConnection();
  const queryClient = useQueryClient();
  const restart = useRestartRequirement();
  const [dismissedAt, setDismissedAt] = useState<string | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDesktop = isDesktopRuntime();

  if (!restart.required || dismissedAt === restart.changedAt || isRestartRequirementAcknowledged(restart)) {
    return null;
  }

  const applyRestart = async () => {
    setWorking(true);
    setError(null);
    try {
      await restartNativeServer();
      clearRestartRequirement();
      // The sidecar restarted on the same endpoint: reattach the shared WS
      // immediately and let every query refetch against the fresh process.
      socket.nudge();
      await queryClient.invalidateQueries();
    } catch (error) {
      setError(errorText(locale, error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-rule/40 bg-amber-card px-4 py-1.5 text-[12px] font-medium text-amber-ink"
    >
      <span>{t('st.restart.banner')}</span>
      {restart.fields.length > 0 ? (
        <span className="font-mono text-[10.5px] opacity-80">{t('st.restart.fields', { fields: restart.fields.join(', ') })}</span>
      ) : null}
      {error !== null ? <span role="alert" className="text-danger">{error}</span> : null}
      <span className="flex items-center gap-2">
        {isDesktop ? (
          <button type="button" className={PRIMARY_BUTTON} disabled={working} onClick={() => void applyRestart()}>
            {working ? t('st.restart.working') : t('st.restart.now')}
          </button>
        ) : (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={working}
            title={t('st.restart.desktopOnly')}
            onClick={() => { acknowledgeRestartRequirement(); }}
          >
            {t('st.sidecar.acknowledge')}
          </button>
        )}
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={working}
          onClick={() => { setDismissedAt(restart.changedAt); }}
        >
          {t('st.restart.later')}
        </button>
      </span>
    </div>
  );
}
