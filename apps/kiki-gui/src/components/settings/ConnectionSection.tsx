import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { errorText, issueText } from '@kiki/session-core/i18n';
import {
  clearRestartRequirement,
  CONNECTION_SETTINGS_DEFAULT_TAB,
  CONNECTION_SETTINGS_TABS,
  connectionTabLabelKey,
  MAX_REQUEST_TIMEOUT_SECONDS,
  MIN_REQUEST_TIMEOUT_SECONDS,
  normalizeConnectionTab,
  readSettings,
  validateRequestTimeoutSeconds,
  writeSettings,
  type ConnectionSettingsTab,
} from '@kiki/session-core/settings';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useBusySessionCount } from '../../lib/busySessionsHook';
import { useConnection } from '../../state/connection';
import { connectionLog, formatConnectionLog, subscribeConnectionLog } from '../../state/connectionDiagnostics';
import { copyTextToClipboard } from '../../lib/clipboard';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, SavedTick, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';
import { CommitInput, SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';
import { ExternalConnectionSection } from './ExternalConnectionSection';

export function ConnectionSection() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { search } = useLocation();
  const tab = normalizeConnectionTab(new URLSearchParams(search).get('tab')) ?? CONNECTION_SETTINGS_DEFAULT_TAB;

  const selectTab = (next: ConnectionSettingsTab) => {
    if (next === tab) return;
    const params = new URLSearchParams(search);
    params.set('tab', next);
    navigate(`/settings/connection?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={t('st.section.connection')} className="flex gap-1 border-b border-hairline">
        {CONNECTION_SETTINGS_TABS.map((candidate) => {
          const active = candidate === tab;
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={active}
              data-connection-tab={candidate}
              onClick={() => { selectTab(candidate); }}
              className={`-mb-px min-h-8 border-b-2 px-3 py-1.5 text-[13px] transition-colors ${
                active
                  ? 'border-ink font-medium text-ink'
                  : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {t(connectionTabLabelKey(candidate))}
            </button>
          );
        })}
      </div>
      {tab === 'external' ? <ExternalConnectionSection /> : <CurrentConnectionContent />}
    </div>
  );
}

function CurrentConnectionContent() {
  const host = useHost();
  const { config, meta, wsStatus, socket, scopeId, sshLabel, activateLocal, disconnect, applyConnection } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const isDesktop = host.kind === 'tauri';
  const isSsh = scopeId.startsWith('ssh:');
  const [restarting, setRestarting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const busySessions = useBusySessionCount();
  const [savedRequestTimeout, setSavedRequestTimeout] = useState(() => readSettings().requestTimeoutSeconds);
  const [timeoutSaved, pingTimeoutSaved] = useSavedTick();
  // Inline editing: the page owns the (url, token) pair, so the value is
  // edited where it is shown instead of behind disconnect → connect screen.
  const [urlDraft, setUrlDraft] = useState(config.url);
  const [tokenDraft, setTokenDraft] = useState<SecretDraft>(KEEP_SECRET);
  useEffect(() => {
    setUrlDraft(config.url);
    setTokenDraft(KEEP_SECRET);
  }, [config.url, config.token]);
  const nextToken = tokenDraft.mode === 'set' ? tokenDraft.value.trim()
    : tokenDraft.mode === 'clear' ? '' : config.token.trim();
  const draftsDirty = urlDraft.trim() !== config.url.trim() || nextToken !== config.token.trim();
  const applyDrafts = () => {
    if (!draftsDirty) return;
    applyConnection({ url: urlDraft.trim(), token: nextToken });
  };
  const discardDrafts = () => { setUrlDraft(config.url); setTokenDraft(KEEP_SECRET); };
  // The token lives in this browser, so revealing it is a local read.
  const revealToken = useCallback(async () => config.token, [config.token]);

  // Validated by CommitInput before this runs.
  const saveRequestTimeout = (seconds: number) => {
    writeSettings({ requestTimeoutSeconds: seconds });
    setSavedRequestTimeout(seconds);
    pingTimeoutSaved();
  };
  const timeoutIssue = (text: string): string | null => {
    const issue = validateRequestTimeoutSeconds(text === '' ? Number.NaN : Number(text));
    return issue === null ? null : issueText(locale, issue);
  };

  const restart = async () => {
    if (isSsh) return;
    setRestarting(true);
    setFeedback(null);
    try {
      await host.restartServer?.();
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
        <div className="space-y-4">
          {isSsh ? (
            <div className="rounded-lg bg-ink/[0.04] px-3 py-2 text-[12px] text-ink">
              <p className="font-medium">{t('connect.remoteScope')} · {sshLabel}</p>
              <p className="mt-1 text-ink-soft">{t('connect.sshRemoteSettings')}</p>
              <button type="button" onClick={activateLocal} className={`${SECONDARY_BUTTON} mt-2`}>
                {t('connect.switchLocal')}
              </button>
            </div>
          ) : null}
          <div
            role="group"
            aria-label={t('st.conn.statusTitle')}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-hairline bg-paper px-3 py-2"
          >
            <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px]">
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-full ${wsStatus === 'open' ? 'bg-success' : 'bg-amber-ink'}`}
                />
                <dt className="text-ink-faint">{t('st.conn.wsLabel')}</dt>
                <dd className={wsStatus === 'open' ? 'font-medium text-success' : 'font-medium text-amber-ink'}>
                  {t(`st.conn.ws.${wsStatus}`)}
                </dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-ink-faint">{t('st.conn.version')}</dt>
                <dd className="font-mono text-ink">{meta.server_version}</dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="text-ink-faint">{t('st.conn.backend')}</dt>
                <dd className="font-mono text-ink">{meta.backend ?? 'v1'}</dd>
              </div>
            </dl>
            <button type="button" onClick={() => { socket?.nudge(); }} className={SECONDARY_BUTTON}>
              {t('st.conn.reconnect')}
            </button>
          </div>
          {!isSsh ? <form
            className="space-y-4"
            onSubmit={(event) => { event.preventDefault(); applyDrafts(); }}
          >
            <div className="space-y-1.5">
              <label htmlFor="st-conn-url" className="block text-[13px] font-medium text-ink">{t('connect.serverUrl')}</label>
              <input
                id="st-conn-url"
                className={`${INPUT} font-mono`}
                value={urlDraft}
                onChange={(event) => { setUrlDraft(event.target.value); }}
                spellCheck={false}
              />
            </div>
            <SecretField
              id="st-conn-token"
              label={t('connect.token')}
              source={config.token === '' ? 'none' : 'kiki'}
              sourceText={t('st.conn.tokenHint')}
              clearable={false}
              draft={tokenDraft}
              onChange={setTokenDraft}
              reveal={config.token === '' ? undefined : revealToken}
            />
            <SettingsDraftFooter id="connection-endpoint" dirty={draftsDirty} saveLabel={t('st.conn.apply')}
              onSave={applyDrafts} onDiscard={discardDrafts} />
            {draftsDirty ? <Hint>{t('st.conn.applyHint')}</Hint> : null}
          </form> : null}
        </div>
      </SectionCard>

      <SectionCard id="st-card-conn-timeout" title={t('st.conn.timeoutTitle')}>
        {/* One number on this device: it saves itself on blur/Enter. */}
        <SettingField
          label={t('st.conn.timeoutLabel')}
          htmlFor="st-conn-request-timeout"
          help={t('st.conn.timeoutHint', { minimum: MIN_REQUEST_TIMEOUT_SECONDS, maximum: MAX_REQUEST_TIMEOUT_SECONDS })}
        >
          <SavedTick show={timeoutSaved} />
          <CommitInput
            id="st-conn-request-timeout"
            className="w-24 text-right"
            inputMode="numeric"
            value={String(savedRequestTimeout)}
            validate={timeoutIssue}
            onCommit={(text) => { saveRequestTimeout(Number(text)); }}
          />
        </SettingField>
      </SectionCard>

      <ConnectionLogCard />

      {!isSsh ? <SectionCard id="st-card-conn-owned" title={t('st.conn.ownedTitle')} badge="desktop">
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-soft">
            {t('st.conn.ownedBody')}
          </p>
          <button type="button" className={SECONDARY_BUTTON} disabled={!isDesktop || restarting} onClick={() => { setConfirmRestart(true); }}>
            {restarting ? t('st.conn.restarting') : t('st.conn.restart')}
          </button>
          {!isDesktop ? <Hint>{t('st.conn.browserHint')}</Hint> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard> : null}

      <SectionCard id="st-card-conn-disconnect" title={t('st.conn.disconnectTitle')}>
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-soft">
            {isSsh ? t('connect.sshDisconnectBody') : t('st.conn.disconnectBody')}
          </p>
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
        body={isSsh ? t('connect.sshDisconnectBody') : t('st.conn.disconnectConfirmBody')}
        confirmLabel={isSsh ? t('connect.switchLocal') : t('sidebar.disconnect')}
        tone="danger"
        onConfirm={() => { setConfirmDisconnect(false); disconnect(); }}
        onCancel={() => { setConfirmDisconnect(false); }}
      />

      <ConfirmDialog
        open={confirmRestart && !isSsh}
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

/** The client's own record of socket drops, copied whole for a bug report. */
function ConnectionLogCard() {
  const { t } = useI18n();
  const log = useSyncExternalStore(subscribeConnectionLog, connectionLog, connectionLog);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const closes = log.filter((entry) => entry.kind === 'close').length;
  const gaps = log.filter((entry) => entry.kind === 'timer_gap').length;
  const copy = async () => {
    try {
      await copyTextToClipboard(formatConnectionLog(log));
      setFeedback({ tone: 'success', text: t('st.conn.logCopied') });
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.conn.logCopyFailed', { reason: error instanceof Error ? error.message : String(error) }) });
    }
  };
  return (
    <SectionCard id="st-card-conn-log" title={t('st.conn.logTitle')}>
      <div className="space-y-3" data-conn-log>
        <p className="text-[12.5px] text-ink-soft">{t('st.conn.logBody')}</p>
        <p className="text-[12.5px] tabular-nums text-ink" data-conn-log-summary>
          {closes === 0 ? t('st.conn.logEmpty') : t('st.conn.logSummary', { closes, gaps, total: log.length })}
        </p>
        <button type="button" className={SECONDARY_BUTTON} data-conn-log-copy disabled={log.length === 0} onClick={() => { void copy(); }}>
          {t('st.conn.logCopy')}
        </button>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
