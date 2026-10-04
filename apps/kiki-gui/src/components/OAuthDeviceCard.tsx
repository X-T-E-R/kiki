/**
 * The one device sign-in card, shared by every account method — Kimi Code, a
 * ChatGPT subscription, a Grok Build login — because they all complete the
 * same way: a code, a verification page, and a wait for the server to confirm.
 *
 * Pending shows the code at a size meant to be read off the screen, one
 * primary action (open the verification page) and the wait. Terminal states
 * collapse to one line that says what happened and one action that recovers,
 * so a denial, an expiry and a cancel do not read as three failures with
 * three vocabularies. The parent owns polling and the authenticated →
 * refresh-and-collapse transition.
 */

import { useEffect, useState } from 'react';

import type { OAuthFlowSnapshot } from '@kiki/protocol';

import { useHost } from '../host';
import { openExternalUrl } from '../host/external';
import { useI18n } from '../i18n';
import { Icon } from './icons';
import { SECONDARY_BUTTON } from './ui';

export interface OAuthDeviceCardProps {
  readonly snapshot: OAuthFlowSnapshot;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
  /** Display name of the sign-in method; defaults to the provider id. */
  readonly label?: string;
  /** The server's reason for a terminal state, when it sent one. */
  readonly errorMessage?: string | undefined;
}

export function OAuthDeviceCard({
  snapshot,
  cancelling,
  onCancel,
  onDismiss,
  label,
  errorMessage,
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
    // The card owns the reason while it is on screen: one sentence, plus the
    // server's own text when it sent one, which names the actual failure. The
    // row above then carries only the state and the retry, so the two never
    // say the same thing twice.
    const detail = errorMessage ?? snapshot.error_message;
    return (
      <div data-oauth-terminal={snapshot.status} className="anim-enter rounded-xl border border-hairline bg-paper p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-[12.5px] text-ink-soft">
            {t(`st.oauth.${snapshot.status}` as 'st.oauth.denied')}
            {detail !== undefined ? (
              <span className="ml-1 break-all font-mono text-[11px] text-ink-faint">{detail}</span>
            ) : null}
          </p>
          <button type="button" data-oauth-dismiss className={SECONDARY_BUTTON} onClick={onDismiss}>
            {t('st.oauth.dismiss')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="anim-enter rounded-xl border border-hairline bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-ink">{t('st.oauth.title', { provider: label ?? snapshot.provider })}</p>
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
          className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
          onClick={() => void openVerificationPage()}
        >
          <Icon name="external" size={12} />
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
        <button type="button" data-oauth-cancel className={SECONDARY_BUTTON} disabled={cancelling} onClick={onCancel}>
          {cancelling ? t('st.oauth.cancelling') : t('st.oauth.cancel')}
        </button>
      </div>
    </div>
  );
}
