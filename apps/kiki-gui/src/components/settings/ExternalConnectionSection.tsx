import { useCallback, useEffect, useState } from 'react';

import {
  createCloudflareConnection,
  type CloudflareConnection,
  type CloudflareConnectionSnapshot,
} from '@kiki/session-core/settings';
import type { CloudflareStatus, CloudflareTunnels, PluginInstallPlan } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, Toggle, type Feedback } from '../controls';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { SettingField, SettingsBox } from './fields';
import { SectionCard } from './SectionCard';

/** Same rhythm as the settings row actions, sized for a glyph that sits on a text line. */
const ROW_ACTION =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent pointer-coarse:h-10';

const ICON_BUTTON =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10';

export function ExternalConnectionSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();

  const [connection, setConnection] = useState<CloudflareConnection | null>(null);
  const [snapshot, setSnapshot] = useState<CloudflareConnectionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // Install plan preview & confirm dialog
  const [installPlan, setInstallPlan] = useState<PluginInstallPlan | null>(null);
  const [installSource, setInstallSource] = useState<string>('');
  const [installSha256, setInstallSha256] = useState<string | undefined>();
  const [confirmInstall, setConfirmInstall] = useState(false);

  // Available existing tunnels
  const [tunnelsList, setTunnelsList] = useState<CloudflareTunnels['items'] | null>(null);
  const [loadingTunnels, setLoadingTunnels] = useState(false);

  // Initialize client helper once
  useEffect(() => {
    try {
      const conn = createCloudflareConnection(client.klient);
      setConnection(conn);
    } catch (err) {
      setReadError(errorText(locale, err));
      setLoading(false);
    }
  }, [client, locale]);

  // Initial read — only read on mount, never auto-install or auto-start
  const loadSnapshot = useCallback(async () => {
    if (!connection) return;
    setLoading(true);
    setReadError(null);
    try {
      const snap = await connection.read();
      setSnapshot(snap);
    } catch (err) {
      // Network failure is NOT 'not-installed', surface as recoverable error
      setReadError(errorText(locale, err));
    } finally {
      setLoading(false);
    }
  }, [connection, locale]);

  useEffect(() => {
    if (connection) {
      void loadSnapshot();
    }
  }, [connection, loadSnapshot]);

  // Refresh status only for available connection
  const refreshStatus = async () => {
    if (!connection) return;
    setBusy('refresh');
    setFeedback(null);
    try {
      const status = await connection.status();
      setSnapshot((prev) => (prev && prev.state === 'available' ? { ...prev, status } : prev));
      setFeedback({ tone: 'success', text: t('st.conn.ext.refreshed') });
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  // Preview install plan before confirming
  const handleStartInstall = async () => {
    if (!connection || !snapshot || snapshot.state !== 'not-installed') return;
    setBusy('preview');
    setFeedback(null);
    try {
      const source = snapshot.catalog?.source?.trim() ?? '';
      if (source.length === 0) throw new Error(t('st.conn.ext.catalogMissing'));
      const sha256 = snapshot.catalog?.sha256;
      const plan = await connection.previewInstall({ source, sha256 });
      setInstallPlan(plan);
      setInstallSource(source);
      setInstallSha256(sha256);
      setConfirmInstall(true);
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  // User confirms install after inspecting plan
  const handleConfirmInstall = async () => {
    if (!connection || !installPlan) return;
    setConfirmInstall(false);
    setBusy('install');
    setFeedback(null);
    try {
      await connection.install({ source: installSource, sha256: installSha256, plan: installPlan, consent: true });
      setFeedback({ tone: 'success', text: t('st.conn.ext.installed') });
      await loadSnapshot();
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
      setInstallPlan(null);
    }
  };

  // Enable plugin
  const handleEnable = async () => {
    if (!connection) return;
    setBusy('enable');
    setFeedback(null);
    try {
      await connection.enable();
      await loadSnapshot();
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  // Install cloudflared prerequisite
  const handleInstallDependency = async () => {
    if (!connection) return;
    setBusy('dep');
    setFeedback(null);
    try {
      const status = await connection.installDependency(true);
      setSnapshot((prev) => (prev && prev.state === 'available' ? { ...prev, status } : prev));
      setFeedback({ tone: 'success', text: t('st.conn.ext.depInstalled') });
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  // Service start / stop
  const handleToggleService = async (running: boolean) => {
    if (!connection) return;
    setBusy('service');
    setFeedback(null);
    try {
      const status = running ? await connection.stop() : await connection.start();
      setSnapshot((prev) => (prev && prev.state === 'available' ? { ...prev, status } : prev));
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  // Auto-start toggle
  const handleToggleAutoStart = async (current: boolean) => {
    if (!connection) return;
    setBusy('autoStart');
    setFeedback(null);
    try {
      const status = await connection.setAutoStart(!current);
      setSnapshot((prev) => (prev && prev.state === 'available' ? { ...prev, status } : prev));
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  // Login / Cancel login
  const handleLogin = async () => {
    if (!connection) return;
    setBusy('login');
    setFeedback(null);
    try {
      const status = await connection.login();
      setSnapshot((prev) => (prev && prev.state === 'available' ? { ...prev, status } : prev));
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  const handleCancelLogin = async () => {
    if (!connection) return;
    setBusy('cancelLogin');
    setFeedback(null);
    try {
      const status = await connection.cancelLogin();
      setSnapshot((prev) => (prev && prev.state === 'available' ? { ...prev, status } : prev));
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  // Load existing tunnels
  const handleLoadTunnels = async () => {
    if (!connection) return;
    setLoadingTunnels(true);
    try {
      const res = await connection.tunnels();
      setTunnelsList(res.items);
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setLoadingTunnels(false);
    }
  };

  // Select tunnel
  const handleSelectTunnel = async (id: string) => {
    if (!connection) return;
    setBusy(`select-${id}`);
    setFeedback(null);
    try {
      const status = await connection.selectTunnel(id);
      setSnapshot((prev) => (prev && prev.state === 'available' ? { ...prev, status } : prev));
      setFeedback({ tone: 'success', text: t('st.conn.ext.tunnelSelected') });
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    } finally {
      setBusy(null);
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await copyTextToClipboard(url);
      setFeedback({ tone: 'success', text: t('st.conn.ext.copied') });
    } catch (err) {
      setFeedback({ tone: 'error', text: errorText(locale, err) });
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard id="st-card-conn-external" title={t('st.conn.ext.title')}>
        <div className="space-y-4" data-conn-external>
          <p className="text-[12.5px] text-ink-soft">{t('st.conn.ext.intro')}</p>

          {loading ? (
            <Hint>{t('st.spaces.loading')}</Hint>
          ) : readError ? (
            // A read failure is one quiet line plus its retry, not a standing alert.
            <div className="space-y-1">
              <p role="alert" className="max-w-[62ch] text-[12.5px] leading-snug text-danger">{readError}</p>
              <div>
                <button
                  type="button"
                  onClick={() => { void loadSnapshot(); }}
                  className={ROW_ACTION}
                >
                  {t('st.conn.ext.retry')}
                </button>
              </div>
            </div>
          ) : snapshot?.state === 'not-installed' ? (
            <div className="space-y-2">
              <p className="max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">{t('st.conn.ext.notInstalled')}</p>
              <div>
                <button
                  type="button"
                  onClick={() => { void handleStartInstall(); }}
                  disabled={busy !== null}
                  className={SECONDARY_BUTTON}
                  data-conn-ext-install
                >
                  {busy === 'preview' ? t('st.conn.ext.installing') : t('st.conn.ext.installPlugin')}
                </button>
              </div>
            </div>
          ) : snapshot?.state === 'disabled' || snapshot?.state === 'invalid' ? (
            <div className="space-y-2">
              <p className="max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">{t('st.conn.ext.disabled')}</p>
              {snapshot.errors.length > 0 ? (
                <ul className="list-disc pl-4 text-[12px] text-danger">
                  {snapshot.errors.map((msg, i) => (
                    <li key={i}>{msg}</li>
                  ))}
                </ul>
              ) : null}
              <div>
                <button
                  type="button"
                  onClick={() => { void handleEnable(); }}
                  disabled={busy !== null}
                  className={SECONDARY_BUTTON}
                  data-conn-ext-enable
                >
                  {t('st.conn.ext.enablePlugin')}
                </button>
              </div>
            </div>
          ) : snapshot?.state === 'available' ? (
            <AvailableTunnelContent
              status={snapshot.status}
              version={snapshot.version}
              busy={busy}
              loadingTunnels={loadingTunnels}
              tunnelsList={tunnelsList}
              onRefresh={() => { void refreshStatus(); }}
              onInstallDep={() => { void handleInstallDependency(); }}
              onToggleService={(running) => { void handleToggleService(running); }}
              onToggleAutoStart={(current) => { void handleToggleAutoStart(current); }}
              onLogin={() => { void handleLogin(); }}
              onCancelLogin={() => { void handleCancelLogin(); }}
              onLoadTunnels={() => { void handleLoadTunnels(); }}
              onSelectTunnel={(id) => { void handleSelectTunnel(id); }}
              onCopyUrl={(url) => { void copyUrl(url); }}
            />
          ) : null}

          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <ConfirmDialog
        open={confirmInstall}
        overlayId="confirm-conn-ext-install"
        title={t('st.conn.ext.installConfirmTitle')}
        body={
          installPlan
            ? `${installPlan.id}${installPlan.version === undefined ? '' : ` (${installPlan.version})`}\n${t('st.conn.ext.installConfirmBody', { id: installPlan.id, fingerprint: installPlan.fingerprint.slice(0, 16) })}`
            : t('st.conn.ext.installPlugin')
        }
        confirmLabel={t('st.conn.ext.installPlugin')}
        tone="default"
        onConfirm={() => { void handleConfirmInstall(); }}
        onCancel={() => { setConfirmInstall(false); setInstallPlan(null); setInstallSha256(undefined); }}
      />
    </div>
  );
}

function AvailableTunnelContent({
  status,
  version,
  busy,
  loadingTunnels,
  tunnelsList,
  onRefresh,
  onInstallDep,
  onToggleService,
  onToggleAutoStart,
  onLogin,
  onCancelLogin,
  onLoadTunnels,
  onSelectTunnel,
  onCopyUrl,
}: {
  status: CloudflareStatus;
  version?: string;
  busy: string | null;
  loadingTunnels: boolean;
  tunnelsList: CloudflareTunnels['items'] | null;
  onRefresh: () => void;
  onInstallDep: () => void;
  onToggleService: (running: boolean) => void;
  onToggleAutoStart: (current: boolean) => void;
  onLogin: () => void;
  onCancelLogin: () => void;
  onLoadTunnels: () => void;
  onSelectTunnel: (id: string) => void;
  onCopyUrl: (url: string) => void;
}) {
  const { t } = useI18n();
  const serviceRunning = status.service.state === 'running';
  const depMissing = status.dependency.state === 'missing';
  const publicUrl = status.configuration.publicUrl;

  return (
    <div className="space-y-4" data-conn-ext-available>
      {/* The one actionable state keeps its amber row; everything else is one
          SettingsBox of rows — no frames inside the card. */}
      {depMissing ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-ink/20 bg-amber-ink/[0.04] px-3 py-2 text-[12.5px]">
          <div>
            <p className="font-medium text-amber-ink">{t('st.conn.ext.depMissing')}</p>
            <p className="text-[12px] text-ink-soft">{t('st.conn.ext.depMissingHint')}</p>
          </div>
          <button
            type="button"
            onClick={onInstallDep}
            disabled={busy !== null}
            className={SECONDARY_BUTTON}
            data-conn-ext-dep-install
          >
            {busy === 'dep' ? t('st.conn.ext.installing') : t('st.conn.ext.installDep')}
          </button>
        </div>
      ) : null}

      <SettingsBox>
        <div>
          <SettingField label={t('st.conn.ext.service')} help={version !== undefined ? t('st.conn.ext.versionLine', { version }) : undefined}>
            <span className="inline-flex items-center gap-1.5 text-[13px]">
              <span
                aria-hidden
                className={`inline-block h-2 w-2 rounded-full ${
                  serviceRunning ? 'bg-success' : status.service.state === 'starting' ? 'bg-amber-ink' : 'bg-ink-faint'
                }`}
              />
              <span className={serviceRunning ? 'font-medium text-success' : 'text-ink'} data-conn-ext-service-state>
                {t(`st.conn.ext.state.${status.service.state}` as any) || status.service.state}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onToggleService(serviceRunning)}
              disabled={busy !== null || depMissing}
              className={SECONDARY_BUTTON}
              data-conn-ext-service-toggle
            >
              {busy === 'service'
                ? serviceRunning ? t('st.conn.ext.stopping') : t('st.conn.ext.starting')
                : serviceRunning ? t('st.conn.ext.stop') : t('st.conn.ext.start')}
            </button>
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy !== null}
              className={ICON_BUTTON}
              title={t('st.conn.ext.refresh')}
              aria-label={t('st.conn.ext.refresh')}
              data-conn-ext-refresh
            >
              <Icon name="refresh" size={14} />
            </button>
          </SettingField>
        </div>
        <div>
          <SettingField label={t('st.conn.ext.autoStart')} help={t('st.conn.ext.autoStartHint')} htmlFor="conn-ext-auto-start">
            <Toggle
              id="conn-ext-auto-start"
              layout="bare"
              label={t('st.conn.ext.autoStart')}
              checked={status.configuration.autoStart}
              disabled={busy !== null}
              onChange={() => onToggleAutoStart(status.configuration.autoStart)}
            />
          </SettingField>
        </div>
        <div>
          {status.login.state === 'pending' ? (
            <SettingField label={t('st.conn.ext.loginTitle')} layout="stack">
              <div className="space-y-2" data-conn-ext-login-pending>
                <p className="text-[12px] font-medium text-amber-ink">{t('st.conn.ext.loginPending')}</p>
                {status.login.url ? (
                  <a
                    href={status.login.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block break-all text-[12px] text-ink underline"
                  >
                    {status.login.url}
                  </a>
                ) : null}
                <div>
                  <button
                    type="button"
                    onClick={onCancelLogin}
                    disabled={busy !== null}
                    className={SECONDARY_BUTTON}
                  >
                    {t('st.conn.ext.cancelLogin')}
                  </button>
                </div>
              </div>
            </SettingField>
          ) : (
            <SettingField label={t('st.conn.ext.loginTitle')} help={status.account.certificate ? t('st.conn.ext.loggedIn') : t('st.conn.ext.notLoggedIn')}>
              <button
                type="button"
                onClick={onLogin}
                disabled={busy !== null || depMissing}
                className={SECONDARY_BUTTON}
                data-conn-ext-login
              >
                {busy === 'login' ? t('st.conn.ext.loggingIn') : t('st.conn.ext.login')}
              </button>
            </SettingField>
          )}
        </div>
        {publicUrl !== undefined && publicUrl !== '' ? (
          <div>
            <SettingField label={t('st.conn.ext.publicUrl')} layout="stack">
              <div className="flex min-w-0 items-center gap-2" data-conn-ext-url>
                <code className="min-w-0 flex-1 break-all rounded-md bg-ink/[0.04] px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] text-ink-soft">
                  {publicUrl}
                </code>
                <button
                  type="button"
                  onClick={() => onCopyUrl(publicUrl)}
                  className={SECONDARY_BUTTON}
                  data-conn-ext-copy-url
                >
                  {t('connect.copyLink')}
                </button>
              </div>
            </SettingField>
          </div>
        ) : null}
        <div>
          <SettingField label={t('st.conn.ext.tunnel')}>
            <span className="min-w-0 truncate text-[13px] text-ink-soft" data-conn-ext-current-tunnel>
              {status.configuration.tunnelId ?? t('st.conn.ext.noTunnelSelected')}
            </span>
            <button
              type="button"
              onClick={onLoadTunnels}
              disabled={loadingTunnels}
              className={SECONDARY_BUTTON}
              data-conn-ext-list-tunnels
            >
              {loadingTunnels ? t('selection.loading') : t('st.conn.ext.listTunnels')}
            </button>
          </SettingField>
          {tunnelsList && tunnelsList.length > 0 ? (
            <div className="mt-1 divide-y divide-hairline" data-conn-ext-tunnels>
              {tunnelsList.map((tun) => (
                <div key={tun.id} className="flex items-center justify-between gap-2 py-1.5 text-[12px]">
                  <div className="min-w-0 pr-2">
                    <p className="truncate font-medium text-ink">{tun.name}</p>
                    <p className="truncate font-mono text-[11px] text-ink-faint">{tun.id}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSelectTunnel(tun.id)}
                    disabled={busy !== null || tun.id === status.configuration.tunnelId}
                    className={SECONDARY_BUTTON}
                  >
                    {tun.id === status.configuration.tunnelId
                      ? t('st.conn.ext.selected')
                      : t('st.conn.ext.useTunnel')}
                  </button>
                </div>
              ))}
            </div>
          ) : tunnelsList && tunnelsList.length === 0 ? (
            <p className="mt-1 text-[12px] text-ink-faint">{t('st.conn.ext.tunnelsEmpty')}</p>
          ) : null}
        </div>
      </SettingsBox>
    </div>
  );
}
