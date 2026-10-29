import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { errorText, issueText } from '@kiki/session-core/i18n';
import {
  clearRestartRequirement,
  readSettings,
  validateRequestTimeoutSeconds,
  validateReadingTimeoutSeconds,
  writeSettings,
} from '@kiki/session-core/settings';
import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import { useBusySessionCount } from '../../lib/busySessionsHook';
import { useConnection } from '../../state/connection';
import { connectionLog, formatConnectionLog, subscribeConnectionLog } from '../../state/connectionDiagnostics';
import { copyTextToClipboard } from '../../lib/clipboard';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, SavedTick, type Feedback } from '../controls';
import { useDirtyReporter, useGuardedNavigate } from '../dirtyGuard';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';
import { CommitInput, SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

export function ConnectionSection() {
  const navigate = useGuardedNavigate();
  const { search } = useLocation();
  // The external tab's Cloudflare card moved to the Connection services page;
  // a bookmarked `?tab=external` follows it and lands on the card itself.
  useEffect(() => {
    if (new URLSearchParams(search).get('tab') === 'external') {
      void navigate('/settings/connection-services#st-card-conn-external', { replace: true });
    }
  }, [search, navigate]);
  return (
    <div className="space-y-4">
      <CurrentConnectionContent />
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
  const [editingEndpoint, setEditingEndpoint] = useState(false);
  const busySessions = useBusySessionCount();
  const log = useSyncExternalStore(subscribeConnectionLog, connectionLog, connectionLog);
  const closes = log.filter((entry) => entry.kind === 'close').length;
  const [savedRequestTimeout, setSavedRequestTimeout] = useState(() => readSettings().requestTimeoutSeconds);
  const [timeoutSaved, pingTimeoutSaved] = useSavedTick();
  const [savedReadingTimeout, setSavedReadingTimeout] = useState(() => readSettings().readingTimeoutSeconds);
  const [readingTimeoutSaved, pingReadingTimeoutSaved] = useSavedTick();
  // Inline editing: the page owns the (url, token) pair, so the value is
  // edited where it is shown instead of behind disconnect → connect screen.
  const [urlDraft, setUrlDraft] = useState(config.url);
  const [tokenDraft, setTokenDraft] = useState<SecretDraft>(KEEP_SECRET);
  useEffect(() => {
    setUrlDraft(config.url);
    setTokenDraft(KEEP_SECRET);
    setEditingEndpoint(false);
  }, [config.url, config.token]);
  const nextToken = tokenDraft.mode === 'set' ? tokenDraft.value.trim()
    : tokenDraft.mode === 'clear' ? '' : config.token.trim();
  const draftsDirty = urlDraft.trim() !== config.url.trim() || nextToken !== config.token.trim();
  useDirtyReporter('connection-endpoint', draftsDirty && !isSsh);
  const applyDrafts = () => {
    if (!draftsDirty) return;
    setEditingEndpoint(false);
    applyConnection({ url: urlDraft.trim(), token: nextToken });
  };
  const discardDrafts = () => {
    setUrlDraft(config.url);
    setTokenDraft(KEEP_SECRET);
    setEditingEndpoint(false);
  };
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

  const statusDotClass = wsStatus === 'open'
    ? 'bg-success'
    : wsStatus === 'connecting'
      ? 'bg-amber-ink status-dot-busy'
      : 'bg-danger';
  const statusTextClass = wsStatus === 'open'
    ? 'text-success'
    : wsStatus === 'connecting'
      ? 'text-amber-ink'
      : 'text-danger';

  return (
    <div className="space-y-4">
      <SectionCard
        id="st-card-conn-server"
        title={t('st.conn.connectedTitle')}
        actions={
          <button
            type="button"
            data-conn-reconnect
            onClick={() => { socket?.nudge(); }}
            className={wsStatus !== 'open' ? PRIMARY_BUTTON : SECONDARY_BUTTON}
          >
            {t('st.conn.reconnect')}
          </button>
        }
      >
        <div className="space-y-3">
          <div role="group" aria-label={t('st.conn.statusTitle')} className="space-y-1.5">
            <div className="flex items-center gap-2" data-conn-ws-status={wsStatus}>
              <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass}`} />
              <span className={`text-[14px] font-medium ${statusTextClass}`}>{t(`st.conn.ws.${wsStatus}`)}</span>
            </div>

            {isSsh ? (
              <div className="space-y-1.5 pt-1 text-[12.5px] text-ink">
                <p className="font-medium">{t('connect.remoteScope')} · {sshLabel}</p>
                <p className="text-ink-soft">{t('connect.sshRemoteSettings')}</p>
                <button type="button" onClick={activateLocal} className={`${SECONDARY_BUTTON} mt-1`}>
                  {t('connect.switchLocal')}
                </button>
              </div>
            ) : !editingEndpoint ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="break-all font-mono text-[15px] text-ink" data-conn-url>
                  {config.url.trim() || (typeof window !== 'undefined' ? window.location.origin : '')}
                </span>
                <button
                  type="button"
                  data-conn-edit
                  onClick={() => { setEditingEndpoint(true); }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                >
                  {t('st.secret.edit')}
                </button>
              </div>
            ) : null}

            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-faint">
              <span>{t('st.conn.version')} <span className="font-mono text-ink-soft">{meta.server_version}</span></span>
              <span aria-hidden>·</span>
              <span>{t('st.conn.backend')} <span className="font-mono text-ink-soft">{meta.backend ?? 'v1'}</span></span>
              <span aria-hidden>·</span>
              {closes > 0 ? (
                <a
                  href="#st-card-conn-log"
                  data-conn-drops-link
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById('st-card-conn-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className="text-ink-soft underline decoration-hairline underline-offset-2 hover:text-ink"
                >
                  {t('st.conn.dropsSinceStart', { closes })}
                </a>
              ) : (
                <span>{t('st.conn.dropsSinceStart', { closes: 0 })}</span>
              )}
              {!isSsh && config.token.trim() === '' ? (
                <>
                  <span aria-hidden>·</span>
                  <span data-conn-no-token>{t('st.conn.noToken')}</span>
                </>
              ) : null}
            </p>
          </div>

          {!isSsh && editingEndpoint ? <form
            className="space-y-4 pt-3"
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
            <SettingsDraftFooter
              id="connection-endpoint"
              dirty={draftsDirty}
              persistent
              saveLabel={t('st.conn.apply')}
              onSave={applyDrafts}
              onDiscard={discardDrafts}
              extra={
                !draftsDirty ? (
                  <button
                    type="button"
                    data-conn-edit-cancel
                    className={SECONDARY_BUTTON}
                    onClick={discardDrafts}
                  >
                    {t('common.cancel')}
                  </button>
                ) : undefined
              }
            />
            {draftsDirty ? <Hint>{t('st.conn.applyHint')}</Hint> : null}
          </form> : null}

          {/* Same connection, so the waits live with the address rather than a
              second card: the two numbers this device applies to requests on it. */}
          <div id="st-card-conn-timeout" className="grid gap-x-8 gap-y-3 pt-3 sm:grid-cols-2">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <label htmlFor="st-conn-request-timeout" className="text-[13px] text-ink">{t('st.conn.timeoutLabel')}</label>
              <span className="flex items-center gap-1.5">
                <SavedTick show={timeoutSaved} />
                <CommitInput
                  id="st-conn-request-timeout"
                  className="w-20 text-right"
                  inputMode="numeric"
                  value={String(savedRequestTimeout)}
                  validate={timeoutIssue}
                  onCommit={(text) => { saveRequestTimeout(Number(text)); }}
                />
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <label htmlFor="st-conn-reading-timeout" className="text-[13px] text-ink">{t('st.conn.readingTimeoutLabel')}</label>
              <span className="flex items-center gap-1.5">
                <SavedTick show={readingTimeoutSaved} />
                <CommitInput id="st-conn-reading-timeout" className="w-20 text-right" inputMode="numeric"
                  value={String(savedReadingTimeout)}
                  validate={(text) => {
                    const issue = validateReadingTimeoutSeconds(text === '' ? Number.NaN : Number(text));
                    return issue === null ? null : issueText(locale, issue);
                  }}
                  onCommit={(text) => {
                    const seconds = Number(text);
                    writeSettings({ readingTimeoutSeconds: seconds });
                    setSavedReadingTimeout(seconds);
                    pingReadingTimeoutSaved();
                  }} />
              </span>
            </div>
          </div>

          <div id="st-card-conn-disconnect" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pt-3">
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
        </div>
      </SectionCard>

      <ConnectionLogCard />

      {/* The browser cannot restart the desktop's own server, so the card is
          simply absent there rather than a "desktop only" shell. */}
      {!isSsh && isDesktop ? (
        <SectionCard id="st-card-conn-owned" title={t('st.conn.ownedTitle')}>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <p className="text-[12.5px] text-ink-soft">
                {t('st.conn.ownedBody')}
                {busySessions !== undefined && busySessions > 0 ? (
                  <span className="ml-2 text-ink" data-conn-busy-sessions>
                    {t('st.conn.busySessions', { count: busySessions })}
                  </span>
                ) : null}
              </p>
              <button type="button" className={SECONDARY_BUTTON} disabled={restarting} onClick={() => { setConfirmRestart(true); }}>
                {restarting ? t('st.conn.restarting') : t('st.conn.restart')}
              </button>
            </div>
            <FeedbackLine feedback={feedback} />
          </div>
        </SectionCard>
      ) : null}

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
    <SectionCard id="st-card-conn-log" title={t('st.conn.logTitle')} scope="app" aside={t('st.conn.logBody')}>
      <div className="space-y-2" data-conn-log>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <p className="text-[12.5px] tabular-nums text-ink" data-conn-log-summary>
            {closes === 0 ? t('st.conn.logEmpty') : t('st.conn.logSummary', { closes, gaps, total: log.length })}
          </p>
          <button type="button" className={SECONDARY_BUTTON} data-conn-log-copy disabled={log.length === 0} onClick={() => { void copy(); }}>
            {t('st.conn.logCopy')}
          </button>
        </div>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
