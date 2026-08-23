/**
 * App-global "restart required" banner. Clicking "Restart now" first runs a
 * fresh, complete busy-session scan; only a scan that ends with zero busy
 * sessions restarts directly. A busy, unknown, or failed scan opens a confirm
 * naming the count (or a conservative warning) instead. Cancel, "Later", and
 * the browser "Acknowledge" leave the requirement armed; only a verified
 * restart clears it, after which the socket reattaches and queries refetch
 * (no page reload).
 */

import { useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useI18n } from '../i18n';
import { errorText } from '../i18n/locale';
import { fetchBusySessionCount, type BusySessionProbe } from '../lib/busySessions';
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
import { ConfirmDialog } from './ConfirmDialog';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

export function useRestartRequirement(): RestartRequirement {
  return useSyncExternalStore(subscribeRestartRequirement, restartRequirementSnapshot);
}

export function RestartBanner() {
  const { t, locale } = useI18n();
  const { client, socket } = useConnection();
  const queryClient = useQueryClient();
  const restart = useRestartRequirement();
  const clickSeqRef = useRef(0);
  const [dismissedAt, setDismissedAt] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [probe, setProbe] = useState<BusySessionProbe | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
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
    } catch (fail) {
      // A failed restart must not clear the requirement.
      setError(errorText(locale, fail));
    } finally {
      setWorking(false);
    }
  };

  const onRestartClick = async () => {
    if (checking || working) return;
    // A new click supersedes any in-flight scan so a stale decision can never
    // restart. A superseded scan neither opens the confirm nor restarts.
    const clickSeq = clickSeqRef.current + 1;
    clickSeqRef.current = clickSeq;
    setChecking(true);
    setError(null);
    setConfirmRestart(false);
    let next: BusySessionProbe;
    try {
      next = await fetchBusySessionCount(client);
    } catch {
      next = { kind: 'unknown' };
    }
    if (clickSeqRef.current !== clickSeq) return;
    setChecking(false);
    setProbe(next);
    // Only an end-to-end scan that resolved zero busy sessions skips the
    // confirm. Busy, unknown (scan failure / incomplete), and any thrown
    // error all route through the confirm.
    if (next.kind === 'idle') {
      await applyRestart();
    } else {
      setConfirmRestart(true);
    }
  };

  const confirmBody =
    probe === null || probe.kind === 'unknown'
      ? t('st.banner.confirmBodyUnknown')
      : probe.kind === 'busy'
        ? t('st.restart.confirmBodyActive', { count: probe.count })
        : t('st.restart.confirmBodyIdle');

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
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={working || checking}
            onClick={() => void onRestartClick()}
          >
            {working ? t('st.restart.working') : checking ? t('st.banner.checking') : t('st.restart.now')}
          </button>
        ) : (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={working || checking}
            title={t('st.restart.desktopOnly')}
            onClick={() => { acknowledgeRestartRequirement(); }}
          >
            {t('st.sidecar.acknowledge')}
          </button>
        )}
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={working || checking}
          onClick={() => { setDismissedAt(restart.changedAt); }}
        >
          {t('st.restart.later')}
        </button>
      </span>
      <ConfirmDialog
        open={confirmRestart}
        overlayId="confirm-banner-restart"
        title={t('st.banner.confirmTitle')}
        body={confirmBody}
        confirmLabel={t('st.banner.confirm')}
        tone="danger"
        busy={working}
        onConfirm={() => { setConfirmRestart(false); void applyRestart(); }}
        onCancel={() => { setConfirmRestart(false); }}
      />
    </div>
  );
}