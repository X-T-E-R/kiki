/**
 * OAuth device-code card — renders a pending flow with the user code, copy
 * and open-verification actions, a live expiry countdown, a polling
 * animation, and cancel; terminal states collapse to a status line with
 * retry/dismiss. The parent owns polling (react-query refetchInterval) and
 * the authenticated → refresh-and-collapse transition.
 */

import { useEffect, useState } from 'react';

import type { OAuthFlowSnapshot } from '@kiki/protocol';

import { useHost } from '../host';
import { openExternalUrl } from '../host/external';
import { useI18n } from '../i18n';
import { SECONDARY_BUTTON } from './ui';

export interface OAuthDeviceCardProps {
  readonly snapshot: OAuthFlowSnapshot;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

export function OAuthDeviceCard({
  snapshot,
  cancelling,
  onCancel,
  onRetry,
  onDismiss,
}: OAuthDeviceCardProps) {
  const { t, time } = useI18n();
  const host = useHost();
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [openFailed, setOpenFailed] = useState(false);
  // 1s tick drives the countdown text and the polling animation.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (snapshot.status !== 'pending') return;
    const timer = setInterval(() => { setTick((value) => value + 1); }, 1000);
    return () => { clearInterval(timer); };
  }, [snapshot.status]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(snapshot.user_code);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };

  // Host-aware opener: desktop webviews reject `window.open`, so the flow
  // routes through the shell bridge when one is available. A failure (blocked
  // pop-up, command error) surfaces as a visible inline line instead of being
  // swallowed — the user still has the device code and can open the URL
  // manually.
  const openVerificationPage = async () => {
    setOpenFailed(false);
    try {
      await openExternalUrl(host, snapshot.verification_uri_complete, t('common.popupBlocked'));
    } catch {
      setOpenFailed(true);
    }
  };

  if (snapshot.status !== 'pending') {
    const statusKey =
      snapshot.status === 'denied' ? 'st.oauth.denied'
        : snapshot.status === 'expired' ? 'st.oauth.expired'
          : 'st.oauth.cancelled';
    return (
      <div className="rounded-xl border border-hairline bg-paper p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12.5px] text-ink-soft">
            {t(statusKey)}
            {snapshot.error_message !== undefined ? (
              <span className="ml-1 font-mono text-[11px] text-ink-faint">{snapshot.error_message}</span>
            ) : null}
          </p>
          <div className="flex gap-2">
            <button type="button" className={SECONDARY_BUTTON} onClick={onRetry}>{t('st.oauth.retry')}</button>
            <button type="button" className={SECONDARY_BUTTON} onClick={onDismiss}>{t('st.oauth.dismiss')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="anim-enter rounded-xl border border-accent/30 bg-accent-soft/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-ink">{t('st.oauth.title', { provider: snapshot.provider })}</p>
        <p className="font-mono text-[11px] text-ink-faint">{time.timeUntil(snapshot.expires_at)}</p>
      </div>
      <p className="mt-2 text-[11px] text-ink-soft">{t('st.oauth.codeLabel')}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <code className="rounded-lg border border-hairline bg-panel px-3 py-1.5 font-mono text-[18px] font-semibold tracking-[0.2em] text-ink">
          {snapshot.user_code}
        </code>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => void copyCode()}>
          {copied === 'ok' ? t('st.oauth.copied') : t('st.oauth.copy')}
        </button>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          onClick={() => void openVerificationPage()}
        >
          {t('st.oauth.openPage')}
        </button>
      </div>
      {openFailed ? (
        <p role="alert" className="mt-1 text-[11px] text-danger">{t('common.popupBlocked')}</p>
      ) : null}
      {copied === 'failed' ? <p className="mt-1 text-[11px] text-danger">{t('st.oauth.copyFailed')}</p> : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[11.5px] text-ink-soft">
          <span aria-hidden className="status-dot-busy inline-block h-2 w-2 rounded-full bg-accent" />
          {t('st.oauth.waiting')}
        </p>
        <button type="button" className={SECONDARY_BUTTON} disabled={cancelling} onClick={onCancel}>
          {cancelling ? t('st.oauth.cancelling') : t('st.oauth.cancel')}
        </button>
      </div>
    </div>
  );
}
