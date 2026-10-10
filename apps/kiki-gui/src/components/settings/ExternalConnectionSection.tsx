import { useCallback, useEffect, useState } from 'react';

import {
  createCloudflareConnection,
  CLOUDFLARE_PLUGIN_ID,
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
import { SectionCard } from './SectionCard';

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
      const source = snapshot.catalog?.downloadUrl ?? CLOUDFLARE_PLUGIN_ID;
      const plan = await connection.previewInstall(source);
      setInstallPlan(plan);
      setInstallSource(source);
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
      await connection.install({ source: installSource, plan: installPlan, consent: true });
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
            <p className="text-[12px] text-ink-faint">{t('selection.loading')}</p>
          ) : readError ? (
            <div className="space-y-2 rounded-lg border border-hairline bg-paper px-3 py-2.5">
              <p className="text-[12.5px] text-danger">{readError}</p>
              <button
                type="button"
                onClick={() => { void loadSnapshot(); }}
                className={SECONDARY_BUTTON}
              >
                {t('st.conn.ext.retry')}
              </button>
            </div>
          ) : snapshot?.state === 'not-installed' ? (
            <div className="space-y-3 rounded-lg border border-hairline bg-paper px-3 py-2.5">
              <p className="text-[12.5px] text-ink-soft">{t('st.conn.ext.notInstalled')}</p>
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
          ) : snapshot?.state === 'disabled' || snapshot?.state === 'invalid' ? (
            <div className="space-y-3 rounded-lg border border-hairline bg-paper px-3 py-2.5">
              <p className="text-[12.5px] text-ink-soft">{t('st.conn.ext.disabled')}</p>
              {snapshot.errors.length > 0 ? (
                <ul className="list-disc pl-4 text-[12px] text-danger">
                  {snapshot.errors.map((msg, i) => (
                    <li key={i}>{msg}</li>
                  ))}
                </ul>
              ) : null}
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
          ) : snapshot?.state === 'available' ? (
            <AvailableTunnelContent
              status={snapshot.status}
              version={snapshot.version}
              busy={busy}
              loadingTunnels={loadingTunnels}
              tunnelsList={tunnelsList}
              onRefresh={() => { void refreshStatus(); }}
              onInstallDep={() => { void handleInstallDependency(); }}
              onToggleService={handleToggleService}
              onToggleAutoStart={handleToggleAutoStart}
              onLogin={() => { void handleLogin(); }}
              onCancelLogin={() => { void handleCancelLogin(); }}
              onLoadTunnels={() => { void handleLoadTunnels(); }}
              onSelectTunnel={handleSelectTunnel}
              onCopyUrl={copyUrl}
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
            ? `${installPlan.name} (${installPlan.version})\n${t('st.conn.ext.installConfirmBody', { id: installPlan.id, fingerprint: installPlan.fingerprint.slice(0, 16) })}`
            : t('st.conn.ext.installPlugin')
        }
        confirmLabel={t('st.conn.ext.installPlugin')}
        tone="primary"
        onConfirm={() => { void handleConfirmInstall(); }}
        onCancel={() => { setConfirmInstall(false); setInstallPlan(null); }}
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

  return (
    <div className="space-y-4" data-conn-ext-available>
      {/* Dependency check */}
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

      {/* Service status & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-hairline bg-paper px-3 py-2 text-[12px]">
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`inline-block h-2 w-2 rounded-full ${
                serviceRunning ? 'bg-success' : status.service.state === 'starting' ? 'bg-amber-ink' : 'bg-ink-faint'
              }`}
            />
            <dt className="text-ink-faint">{t('st.conn.ext.service')}</dt>
            <dd className={`font-medium ${serviceRunning ? 'text-success' : 'text-ink'}`}>
              {t(`st.conn.ext.state.${status.service.state}` as any) || status.service.state}
            </dd>
          </div>
          {version ? (
            <div className="flex items-center gap-1.5">
              <dt className="text-ink-faint">{t('st.conn.version')}</dt>
              <dd className="font-mono text-ink">{version}</dd>
            </div>
          ) : null}
          {status.service.pid ? (
            <div className="flex items-center gap-1.5">
              <dt className="text-ink-faint">PID</dt>
              <dd className="font-mono text-ink">{status.service.pid}</dd>
            </div>
          ) : null}
        </dl>
        <div className="flex items-center gap-2">
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
            className={SECONDARY_BUTTON}
            title={t('st.conn.ext.refresh')}
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </div>

      {/* Auto Start */}
      <div className="flex items-center justify-between gap-4 rounded-lg border border-hairline bg-paper px-3 py-2">
        <div>
          <span className="text-[13px] font-medium text-ink">{t('st.conn.ext.autoStart')}</span>
          <p className="text-[11.5px] text-ink-soft">{t('st.conn.ext.autoStartHint')}</p>
        </div>
        <Toggle
          label={t('st.conn.ext.autoStart')}
          checked={status.configuration.autoStart}
          onChange={() => onToggleAutoStart(status.configuration.autoStart)}
        />
      </div>

      {/* Cloudflare Login state */}
      <div className="space-y-2 rounded-lg border border-hairline bg-paper px-3 py-2.5">
        <span className="text-[13px] font-medium text-ink">{t('st.conn.ext.loginTitle')}</span>
        {status.login.state === 'pending' ? (
          <div className="space-y-2">
            <p className="text-[12px] text-amber-ink font-medium">{t('st.conn.ext.loginPending')}</p>
            {status.login.url ? (
              <a
                href={status.login.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[12px] underline text-ink break-all"
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
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-ink-soft">
              {status.account.certificate ? t('st.conn.ext.loggedIn') : t('st.conn.ext.notLoggedIn')}
            </p>
            <button
              type="button"
              onClick={onLogin}
              disabled={busy !== null || depMissing}
              className={SECONDARY_BUTTON}
              data-conn-ext-login
            >
              {busy === 'login' ? t('st.conn.ext.loggingIn') : t('st.conn.ext.login')}
            </button>
          </div>
        )}
      </div>

      {/* Public URL (no token, reachability unverified) */}
      {status.configuration.publicUrl ? (
        <div className="space-y-1.5 rounded-lg border border-hairline bg-paper px-3 py-2.5" data-conn-ext-url>
          <span className="text-[13px] font-medium text-ink">{t('st.conn.ext.publicUrl')}</span>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={status.configuration.publicUrl}
              className="flex-1 rounded-md border border-hairline bg-paper px-2 py-1 font-mono text-[12px] text-ink outline-none"
            />
            <button
              type="button"
              onClick={() => onCopyUrl(status.configuration.publicUrl)}
              className={SECONDARY_BUTTON}
            >
              {t('connect.copyLink')}
            </button>
          </div>
          <Hint>{t('st.conn.ext.unverified')}</Hint>
        </div>
      ) : null}

      {/* Tunnels selection */}
      <div className="space-y-2 rounded-lg border border-hairline bg-paper px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="text-[13px] font-medium text-ink">{t('st.conn.ext.selectTunnel')}</span>
            <p className="text-[11.5px] text-ink-soft">
              {status.configuration.tunnelId
                ? `${t('st.conn.ext.currentTunnel')}: ${status.configuration.tunnelId}`
                : t('st.conn.ext.noTunnelSelected')}
            </p>
          </div>
          <button
            type="button"
            onClick={onLoadTunnels}
            disabled={loadingTunnels}
            className={SECONDARY_BUTTON}
          >
            {loadingTunnels ? t('selection.loading') : t('st.conn.ext.listTunnels')}
          </button>
        </div>

        {tunnelsList && tunnelsList.length > 0 ? (
          <div className="mt-2 space-y-1 divide-y divide-hairline">
            {tunnelsList.map((tun) => (
              <div key={tun.id} className="flex items-center justify-between pt-1.5 text-[12px]">
                <div className="min-w-0 pr-2">
                  <p className="font-medium text-ink truncate">{tun.name}</p>
                  <p className="font-mono text-[11px] text-ink-faint truncate">{tun.id}</p>
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
          <p className="text-[12px] text-ink-faint">{t('st.conn.ext.tunnelsEmpty')}</p>
        ) : null}
      </div>
    </div>
  );
}
