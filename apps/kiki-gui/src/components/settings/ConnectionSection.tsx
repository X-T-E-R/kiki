import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { isDesktopRuntime, restartNativeServer } from '../../lib/desktop';
import { useI18n } from '../../i18n';
import { errorText } from '../../i18n/locale';
import { useBusySessionCount } from '../../lib/busySessions';
import { clearRestartRequirement } from '../../lib/settings';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';

export function ConnectionSection() {
  const { config, meta, wsStatus, socket, disconnect, applyConnection } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const isDesktop = isDesktopRuntime();
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const busySessions = useBusySessionCount();
  // Inline editing: the page owns the (url, token) pair, so the value is
  // edited where it is shown instead of behind disconnect → connect screen.
  const [urlDraft, setUrlDraft] = useState(config.url);
  const [tokenDraft, setTokenDraft] = useState(config.token);
  useEffect(() => {
    setUrlDraft(config.url);
    setTokenDraft(config.token);
  }, [config]);
  const draftsDirty =
    urlDraft.trim() !== config.url.trim() || tokenDraft.trim() !== config.token.trim();

  const restart = async () => {
    setRestarting(true);
    setFeedback(null);
    try {
      await restartNativeServer();
      clearRestartRequirement();
      // Fresh sidecar on the same endpoint: reattach the WS and refetch
      // instead of reloading the page.
      socket?.nudge();
      await queryClient.invalidateQueries();
      setFeedback({ tone: 'success', text: t('st.conn.restarted') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard id="st-card-conn-server" title={t('st.conn.connectedTitle')}>
        <div className="space-y-3">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draftsDirty) return;
              applyConnection({ url: urlDraft.trim(), token: tokenDraft.trim() });
            }}
          >
            <div>
              <label htmlFor="st-conn-url" className="mb-1 block text-[11px] font-medium text-ink-soft">{t('connect.serverUrl')}</label>
              <input
                id="st-conn-url"
                className={`${INPUT} font-mono`}
                value={urlDraft}
                onChange={(event) => { setUrlDraft(event.target.value); }}
                spellCheck={false}
              />
            </div>
            <div>
              <label htmlFor="st-conn-token" className="mb-1 block text-[11px] font-medium text-ink-soft">{t('connect.token')}</label>
              <input
                id="st-conn-token"
                type="password"
                className={`${INPUT} font-mono`}
                value={tokenDraft}
                onChange={(event) => { setTokenDraft(event.target.value); }}
                spellCheck={false}
              />
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" className={PRIMARY_BUTTON} disabled={!draftsDirty}>{t('st.conn.apply')}</button>
              <span className="text-[11px] leading-snug text-ink-faint">{t('st.conn.applyHint')}</span>
            </div>
          </form>
          <div className="space-y-1 border-t border-hairline pt-3 text-[12.5px] text-ink-soft">
            <p>{t('st.conn.version')}: <span className="font-mono text-ink">{meta.server_version}</span></p>
            <p>{t('st.conn.backend')}: <span className="font-mono text-ink">{meta.backend ?? 'v1'}</span></p>
            <p>{t('st.conn.wsLabel')}: <span className={wsStatus === 'open' ? 'font-medium text-success' : 'font-medium text-amber-ink'}>{t(`st.conn.ws.${wsStatus}`)}</span></p>
            <button type="button" onClick={() => { socket?.nudge(); }} className={SECONDARY_BUTTON}>{t('st.conn.reconnect')}</button>
          </div>
        </div>
      </SectionCard>

      <SectionCard id="st-card-conn-owned" title={t('st.conn.ownedTitle')} badge="desktop">
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-soft">
            {t('st.conn.ownedBody')}
          </p>
          <button type="button" className={PRIMARY_BUTTON} disabled={!isDesktop || restarting} onClick={() => { setConfirmRestart(true); }}>
            {restarting ? t('st.conn.restarting') : t('st.conn.restart')}
          </button>
          {!isDesktop ? <Hint>{t('st.conn.browserHint')}</Hint> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <SectionCard id="st-card-conn-disconnect" title={t('st.conn.disconnectTitle')}>
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-soft">{t('st.conn.disconnectBody')}</p>
          <button
            type="button"
            data-conn-disconnect
            className={DANGER_GHOST_BUTTON}
            onClick={() => { setConfirmDisconnect(true); }}
          >
            {t('sidebar.disconnect')}
          </button>
        </div>
      </SectionCard>

      <ConfirmDialog
        open={confirmDisconnect}
        overlayId="confirm-conn-disconnect"
        title={t('st.conn.disconnectConfirmTitle')}
        body={t('st.conn.disconnectConfirmBody')}
        confirmLabel={t('sidebar.disconnect')}
        tone="danger"
        onConfirm={() => { setConfirmDisconnect(false); disconnect(); }}
        onCancel={() => { setConfirmDisconnect(false); }}
      />

      <ConfirmDialog
        open={confirmRestart}
        overlayId="confirm-conn-restart"
        title={t('st.restart.confirmTitle')}
        body={
          busySessions !== undefined && busySessions > 0
            ? t('st.restart.confirmBodyActive', { count: busySessions })
            : t('st.restart.confirmBodyIdle')
        }
        confirmLabel={t('st.conn.restart')}
        tone="danger"
        onConfirm={() => { setConfirmRestart(false); void restart(); }}
        onCancel={() => { setConfirmRestart(false); }}
      />
    </div>
  );
}
