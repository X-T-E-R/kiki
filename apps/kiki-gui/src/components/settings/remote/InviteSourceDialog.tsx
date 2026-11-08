/**
 * The pairing code this Kiki shows. Creating it opens inbound access. The
 * code is single-use and expires; the server keeps only its digest.
 */

import { useEffect, useRef, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import { formatPairingUri, type PairCodeCreateOutput } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import { connectionsApi } from '../../../lib/remoteConnections';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
import { CopyField, connectionFailureText } from './parts';
import { FeedbackLine, type Feedback } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { wechatQrImage } from '../notifications/wechatQr';

function remainingLabel(expiresAt: number, now: number): string {
  const remaining = Math.max(0, expiresAt - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function InviteSourceDialog({ client, onClose, onInvited }: {
  client: KikiClient;
  onClose: () => void;
  onInvited: () => void;
}) {
  const { t, locale } = useI18n();
  const invited = useRef(onInvited);
  invited.current = onInvited;
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Feedback>(null);
  const [issued, setIssued] = useState<PairCodeCreateOutput | null>(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    setSaving(true);
    setFailure(null);
    void connectionsApi(client).createPairCode({}).then(
      (created) => {
        if (!live) return;
        setIssued(created);
        setSelectedEndpoint(created.suggestedEndpoints[0] ?? '');
        setNow(Date.now());
        invited.current();
      },
      (error: unknown) => {
        if (!live) return;
        const reason = connectionFailureText(error instanceof Error ? error.message : '');
        setFailure({ tone: 'error', text: reason === null ? errorText(locale, error) : t(reason) });
      },
    ).finally(() => { if (live) setSaving(false); });
    return () => { live = false; };
  }, [client, generation, locale, t]);
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);

  const expired = issued !== null && issued.expiresAt <= now;
  const activeEndpoint = issued === null
    ? undefined
    : issued.suggestedEndpoints.includes(selectedEndpoint)
      ? selectedEndpoint
      : issued.suggestedEndpoints[0];
  const qrUri = issued !== null && !expired && activeEndpoint !== undefined
    ? formatPairingUri({ endpoint: activeEndpoint, code: issued.code })
    : undefined;
  const qrImage = qrUri === undefined ? undefined : wechatQrImage(qrUri);
  return (
    <Dialog onClose={onClose} overlayId="remote-inbound-invite" ariaLabel={t('st.inbound.inviteTitle')}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
      <div className="space-y-5" data-inbound-pair-code>
        <div>
          <h2 className="text-[14px] font-medium text-ink">{t('st.inbound.inviteTitle')}</h2>
          <p data-inbound-invite-body className="mt-1 max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">{t('st.inbound.inviteBody')}</p>
        </div>
        {issued === null && saving ? <p className="text-[12px] text-ink-faint">{t('st.inbound.codeWorking')}</p> : null}
        {issued !== null ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="min-w-[14rem] flex-1 space-y-3">
                <p data-inbound-code className="font-mono text-[1.75rem] leading-none tracking-[0.14em] text-ink">{issued.code}</p>
                <CopyField id="inbound-pair-code-value" dataAttr="inbound-pair-code"
                  label={t('st.inbound.codeLabel')} value={issued.code}
                  copyLabel={t('st.inbound.codeCopy')} copiedLabel={t('st.inbound.codeCopied')}
                  hint={t('st.inbound.codeOnce')} />
                <p className="text-[12px] text-ink-soft" data-inbound-code-remaining>
                  {expired ? t('st.inbound.codeExpired') : t('st.inbound.codeRemaining', { time: remainingLabel(issued.expiresAt, now) })}
                </p>
              </div>
              {qrImage !== undefined && qrUri !== undefined ? (
                <img src={qrImage} alt={t('st.inbound.inviteTitle')} data-inbound-qr data-inbound-qr-uri={qrUri}
                  className="h-32 w-32 shrink-0 rounded-lg bg-[#fbfaf6] p-1.5" />
              ) : null}
            </div>
            <div data-inbound-code-addresses>
              <p className="text-[13px] text-ink">{t('st.inbound.codeAddresses')}</p>
              {issued.suggestedEndpoints.length === 0 ? (
                <p className="mt-1 text-[12px] text-ink-faint">{t('st.inbound.codeNoAddress')}</p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {issued.suggestedEndpoints.map((address) => (
                    <li key={address}
                      data-inbound-code-address
                      data-inbound-code-address-active={address === activeEndpoint ? '' : undefined}
                      onClick={issued.suggestedEndpoints.length > 1 ? () => { setSelectedEndpoint(address); } : undefined}
                      className={`break-all font-mono text-[12px] ${issued.suggestedEndpoints.length > 1 ? 'cursor-pointer' : ''} ${address === activeEndpoint && issued.suggestedEndpoints.length > 1 ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                      {address}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
        <FeedbackLine feedback={failure} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={SECONDARY_BUTTON} data-inbound-code-regenerate disabled={saving} onClick={() => { setGeneration((value) => value + 1); }}>
            {t('st.inbound.codeRegenerate')}
          </button>
          <button type="button" data-inbound-invite-done className={PRIMARY_BUTTON} onClick={onClose}>{t('st.inbound.invitationDone')}</button>
        </div>
      </div>
    </Dialog>
  );
}
