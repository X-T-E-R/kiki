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
import {
  androidBridge,
  hasAndroidBridge,
  subscribeAndroidHostEvents,
  type AndroidCapabilities,
  type AndroidPermissionKind,
} from '../../lib/androidBridge';
import { appShellConnectUrl, isEmbeddedAndroidHost } from '../../lib/appShell';
import { useBusySessionCount } from '../../lib/busySessionsHook';
import { useConnection } from '../../state/connection';
import { connectionLog, formatConnectionLog, subscribeConnectionLog } from '../../state/connectionDiagnostics';
import { copyTextToClipboard } from '../../lib/clipboard';
import { pushUndoToast } from '../../lib/toasts';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, SavedTick, type Feedback } from '../controls';
import { useDirtyReporter, useGuardedNavigate } from '../dirtyGuard';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField, SettingsBox } from './fields';
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
  const { config, meta, wsStatus, socket, scopeId, sshLabel, connectionSource, activateLocal, disconnect, applyConnection } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const isDesktop = host.kind === 'tauri';
  const isSsh = scopeId.startsWith('ssh:');
  const isShellPaired = connectionSource === 'app-shell';
  const shellConnect = appShellConnectUrl();
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
  // A paired `app-shell` peer credential belongs to the native-verified current
  // origin, so KEEP must never inherit it into manual browser storage or send
  // it to an edited address.
  const [urlDraft, setUrlDraft] = useState(config.url);
  const [tokenDraft, setTokenDraft] = useState<SecretDraft>(KEEP_SECRET);
  useEffect(() => {
    setUrlDraft(config.url);
    setTokenDraft(KEEP_SECRET);
    setEditingEndpoint(false);
  }, [config.url, config.token]);
  const inheritedToken = isShellPaired ? '' : config.token.trim();
  const nextToken = tokenDraft.mode === 'set' ? tokenDraft.value.trim()
    : tokenDraft.mode === 'clear' ? '' : inheritedToken;
  const tokenDirty = isShellPaired
    ? (tokenDraft.mode === 'set' && nextToken !== '') || tokenDraft.mode === 'clear'
    : nextToken !== config.token.trim();
  const draftsDirty = urlDraft.trim() !== config.url.trim() || tokenDirty;
  useDirtyReporter('connection-endpoint', draftsDirty && !isSsh);
  const applyDrafts = () => {
    if (!draftsDirty) return;
    const trimmedUrl = urlDraft.trim();
    setEditingEndpoint(false);
    if (isShellPaired && tokenDraft.mode !== 'set') {
      applyConnection({ url: trimmedUrl, token: '' });
      return;
    }
    applyConnection({ url: trimmedUrl, token: nextToken });
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
      >
        {isSsh ? (
          <div className="space-y-1.5 text-[12.5px] text-ink">
            <p className="font-medium">{t('connect.remoteScope')} · {sshLabel}</p>
            <p className="text-ink-soft">{t('connect.sshRemoteSettings')}</p>
            <button type="button" onClick={activateLocal} className={`${SECONDARY_BUTTON} mt-1`}>
              {t('connect.switchLocal')}
            </button>
          </div>
        ) : null}

        <SettingsBox>
          {!editingEndpoint ? (
            <SettingField
              label={
                <span className="flex items-center gap-2" data-conn-ws-status={wsStatus}>
                  <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDotClass}`} />
                  <span className={`font-medium ${statusTextClass}`}>{t(`st.conn.ws.${wsStatus}`)}</span>
                  <span className="break-all font-mono text-ink" data-conn-url>
                    {config.url.trim() || (typeof window !== 'undefined' ? window.location.origin : '')}
                  </span>
                </span>
              }
              help={
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span>{t('st.conn.version')} <span className="font-mono">{meta.server_version}</span></span>
                  <span aria-hidden>·</span>
                  <span>{t('st.conn.backend')} <span className="font-mono">{meta.backend ?? 'v1'}</span></span>
                  <span aria-hidden>·</span>
                  {closes > 0 ? (
                    <a
                      href="#st-card-conn-log"
                      data-conn-drops-link
                      onClick={(event) => {
                        event.preventDefault();
                        document.getElementById('st-card-conn-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      className="underline decoration-hairline underline-offset-2 hover:text-ink"
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
                </span>
              }
            >
              <button
                type="button"
                data-conn-reconnect
                onClick={() => { socket?.nudge(); }}
                className={wsStatus !== 'open' ? PRIMARY_BUTTON : SECONDARY_BUTTON}
              >
                {t('st.conn.reconnect')}
              </button>
              {!isSsh ? (
                <button
                  type="button"
                  data-conn-edit
                  onClick={() => { setEditingEndpoint(true); }}
                  className={SECONDARY_BUTTON}
                >
                  {t('st.secret.edit')}
                </button>
              ) : null}
              {shellConnect !== null ? (
                <a
                  href={shellConnect}
                  data-conn-app-shell
                  className={SECONDARY_BUTTON}
                >
                  {t('connect.switchComputer')}
                </a>
              ) : null}
            </SettingField>
          ) : null}

          {!isSsh && editingEndpoint ? <form
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
              source={config.token === '' || isShellPaired ? 'none' : 'kiki'}
              sourceText={t('st.conn.tokenHint')}
              clearable={false}
              draft={tokenDraft}
              onChange={setTokenDraft}
              reveal={config.token === '' || isShellPaired ? undefined : revealToken}
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
          <div id="st-card-conn-timeout" className="contents">
            <SettingField
              label={t('st.conn.timeoutLabel')}
              htmlFor="st-conn-request-timeout"
              help={t('st.conn.timeoutRowHelp')}
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
              <span className="text-[12px] text-ink-faint">{t('st.conn.timeoutUnit')}</span>
            </SettingField>
            <SettingField
              label={t('st.conn.readingTimeoutLabel')}
              htmlFor="st-conn-reading-timeout"
              help={t('st.conn.readingTimeoutRowHelp')}
            >
              <SavedTick show={readingTimeoutSaved} />
              <CommitInput id="st-conn-reading-timeout" className="w-24 text-right" inputMode="numeric"
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
              <span className="text-[12px] text-ink-faint">{t('st.conn.timeoutUnit')}</span>
            </SettingField>
          </div>

          <div id="st-card-conn-disconnect" className="contents">
            <SettingField
              label={t('sidebar.disconnect')}
              help={isSsh ? t('connect.sshDisconnectBody') : t('st.conn.disconnectBody')}
            >
              <button
                type="button"
                data-conn-disconnect
                className={DANGER_GHOST_BUTTON}
                onClick={() => {
                  // Disconnecting only drops the browser's stored link, so the
                  // inverse is reconnecting with the endpoint it had: run at
                  // once and offer Undo rather than asking first.
                  if (isSsh) { setConfirmDisconnect(true); return; }
                  const prior = { url: config.url, token: config.token };
                  disconnect();
                  pushUndoToast({
                    text: t('st.conn.disconnectedUndo'),
                    undoFailedText: t('toast.undoFailed'),
                    undo: () => { applyConnection(prior); },
                  });
                }}
              >
                {t('sidebar.disconnect')}
              </button>
            </SettingField>
          </div>
        </SettingsBox>
      </SectionCard>

      <ConnectionLogCard />

      {!isSsh && (isEmbeddedAndroidHost() || hasAndroidBridge()) ? <AndroidPermissionsCard /> : null}

      {/* The browser cannot restart the desktop's own server, so the card is
          simply absent there rather than a "desktop only" shell. */}
      {!isSsh && isDesktop ? (
        <SectionCard id="st-card-conn-owned" title={t('st.conn.ownedTitle')}>
          <SettingsBox>
            <SettingField
              label={t('st.conn.restart')}
              help={busySessions !== undefined && busySessions > 0 ? t('st.conn.busySessions', { count: busySessions }) : t('st.conn.ownedBody')}
            >
              <button type="button" className={SECONDARY_BUTTON} disabled={restarting} onClick={() => { setConfirmRestart(true); }}>
                {restarting ? t('st.conn.restarting') : t('st.conn.restart')}
              </button>
            </SettingField>
          </SettingsBox>
          <FeedbackLine feedback={feedback} />
        </SectionCard>
      ) : null}

      <ConfirmDialog
        open={confirmDisconnect}
        overlayId="confirm-conn-disconnect"
        title={t('st.conn.disconnectConfirmTitle')}
        body={t('connect.sshDisconnectBody')}
        confirmLabel={t('connect.switchLocal')}
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
      <div data-conn-log>
        <SettingsBox>
          <SettingField
            label={closes === 0 ? t('st.conn.logEmpty') : t('st.conn.logSummary', { closes, gaps, total: log.length })}
          >
            <button type="button" className={SECONDARY_BUTTON} data-conn-log-copy disabled={log.length === 0} onClick={() => { void copy(); }}>
              {t('st.conn.logCopy')}
            </button>
          </SettingField>
        </SettingsBox>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

function AndroidPermissionsCard() {
  const { t } = useI18n();
  const [caps, setCaps] = useState<AndroidCapabilities | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const refresh = useCallback(async () => {
    const next = await androidBridge.capabilities();
    if (next !== null) setCaps(next);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeAndroidHostEvents((detail) => {
      if (detail.type === 'permissions') {
        setFeedback(null);
        setCaps((prev) =>
          prev === null
            ? {
                permissions: {
                  accessibility: detail.permissions.accessibility === true,
                  overlay: detail.permissions.overlay === true,
                  notifications: detail.permissions.notifications ?? true,
                  battery: detail.permissions.battery === true,
                  oemAutostart: detail.permissions.oemAutostart,
                },
              }
            : { ...prev, permissions: { ...prev.permissions, ...detail.permissions } },
        );
      }
    });
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const runBridgeAction = async (action: () => Promise<void>) => {
    setFeedback(null);
    try {
      await action();
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const rows: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly ready: boolean;
    readonly permission: AndroidPermissionKind;
  }> = [
    {
      id: 'accessibility',
      label: t('st.conn.androidAccessibility'),
      ready: caps?.permissions.accessibility === true,
      permission: 'accessibility',
    },
    {
      id: 'overlay',
      label: t('st.conn.androidOverlay'),
      ready: caps?.permissions.overlay === true,
      permission: 'overlay',
    },
    {
      id: 'battery',
      label: t('st.conn.androidBattery'),
      ready: caps?.permissions.battery === true,
      permission: 'battery',
    },
  ];

  return (
    <SectionCard
      id="st-card-conn-android"
      title={t('st.conn.androidTitle')}
      scope="app"
      actions={
        <button
          type="button"
          className={SECONDARY_BUTTON}
          data-android-open-settings
          onClick={() => {
            void runBridgeAction(() => androidBridge.openPhoneSettings());
          }}
        >
          {t('st.conn.androidMore')}
        </button>
      }
    >
      <div data-android-permissions>
        <SettingsBox>
          {rows.map((row) => (
            <SettingField key={row.id} label={row.label}>
              {row.ready ? (
                <span
                  data-android-perm-ready={row.id}
                  className="inline-flex items-center gap-1.5 text-[12px] text-ink-faint"
                >
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
                  {t('st.conn.androidOn')}
                </span>
              ) : (
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  data-android-perm-enable={row.id}
                  onClick={() => {
                    void runBridgeAction(() => androidBridge.openPermission(row.permission));
                  }}
                >
                  {t('st.conn.androidEnable')}
                </button>
              )}
            </SettingField>
          ))}
        </SettingsBox>
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
