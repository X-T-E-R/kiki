import { useState } from 'react';

import type { RemoteConnection } from '@kiki/protocol';
import {
  readSettings,
  writeSettings,
  type ThemePreference,
} from '@kiki/session-core/settings';

import { Icon } from '../../components/icons';
import { useI18n } from '../../i18n';
import { isEmbeddedAndroidHost } from '../../lib/appShell';
import {
  completeConnectionEndpoint,
  connectionAddress,
  connectionsApi,
  endpointNetworkKind,
  formatPairingCode,
  parsePairingUri,
  remoteSpaceKey,
  remoteSummaryView,
  spacePlatformLabel,
} from '../../lib/remoteConnections';
import { pushToast } from '../../lib/toasts';
import type { MultiSpaceHealth } from '../../lib/useMultiSpaceSessions';
import { useConnection } from '../../state/connection';

interface SpacesTabProps {
  readonly localSpaceKey: string;
  readonly localSpaceName: string;
  readonly localRunningCount: number;
  readonly remoteConnections: readonly RemoteConnection[];
  readonly healthBySpace: ReadonlyMap<string, MultiSpaceHealth>;
  readonly activeScope: string;
  readonly onSelectScope: (scope: string) => void;
  readonly onRefreshRemotes: () => Promise<void>;
  readonly onOpenWorkbench: () => void;
  readonly onOpenNavDrawer?: () => void;
}

interface CapacitorKikiShellPlugin {
  scanQr?: () => Promise<{ readonly status?: string; readonly value?: string }>;
  readClipboard?: () => Promise<{ readonly text?: string }>;
}

function nativeKikiShell(): CapacitorKikiShellPlugin | undefined {
  const win = window as unknown as {
    Capacitor?: { Plugins?: { KikiShell?: CapacitorKikiShellPlugin } };
  };
  return win.Capacitor?.Plugins?.KikiShell;
}

export function SpacesTab({
  localSpaceKey,
  localSpaceName,
  localRunningCount,
  remoteConnections,
  healthBySpace,
  activeScope,
  onSelectScope,
  onRefreshRemotes,
  onOpenWorkbench,
  onOpenNavDrawer,
}: SpacesTabProps) {
  const { t, locale, setLocale } = useI18n();
  const { client, localClient } = useConnection();
  const controlClient = localClient ?? client;

  const [pairOpen, setPairOpen] = useState(false);
  const [endpointInput, setEndpointInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [fingerprintInput, setFingerprintInput] = useState('');
  const [pairing, setPairing] = useState(false);
  const [diagOpenId, setDiagOpenId] = useState<string | null>(null);
  const [themePref, setThemePref] = useState<ThemePreference>(() => readSettings().theme);

  const embeddedPhone = isEmbeddedAndroidHost();
  const localTitle = embeddedPhone ? t('mobile.space.localPhone') : localSpaceName;
  const localScope = `local:${localSpaceKey}`;

  const applyPairingInput = (raw: string) => {
    const parsed = parsePairingUri(raw.trim());
    if (parsed !== undefined) {
      setEndpointInput(parsed.endpoint);
      setCodeInput(formatPairingCode(parsed.code));
      setFingerprintInput(parsed.fingerprint ?? '');
      setPairOpen(true);
      return true;
    }
    setFingerprintInput('');
    setEndpointInput(raw.trim());
    setPairOpen(true);
    return false;
  };

  const handleScanQr = async () => {
    const plugin = nativeKikiShell();
    if (plugin?.scanQr !== undefined) {
      try {
        const res = await plugin.scanQr();
        if (res.status === 'scanned' && typeof res.value === 'string' && res.value.trim() !== '') {
          applyPairingInput(res.value);
          return;
        }
      } catch {
        // Fall through to manual/paste sheet.
      }
    }
    setPairOpen(true);
  };

  const handlePasteLink = async () => {
    try {
      const plugin = nativeKikiShell();
      const text =
        plugin?.readClipboard !== undefined
          ? (await plugin.readClipboard()).text ?? ''
          : typeof navigator.clipboard?.readText === 'function'
            ? await navigator.clipboard.readText()
            : '';
      if (text.trim() !== '') {
        applyPairingInput(text);
        return;
      }
    } catch {
      // Clipboard may require explicit gesture; reveal form.
    }
    setPairOpen(true);
  };

  const submitPair = async () => {
    const parsed = parsePairingUri(endpointInput.trim());
    const endpoint = parsed?.endpoint ?? completeConnectionEndpoint(endpointInput.trim());
    const code = parsed?.code ?? codeInput.trim();
    const fingerprint = parsed?.fingerprint ?? fingerprintInput;
    if (endpoint === '' || code === '' || pairing) return;
    setPairing(true);
    try {
      const created = await connectionsApi(controlClient).pair({
        endpoint,
        code,
        backgroundSummary: true,
        ...(fingerprint !== '' ? { fingerprint } : {}),
      });
      setEndpointInput('');
      setCodeInput('');
      setFingerprintInput('');
      setPairOpen(false);
      await onRefreshRemotes();
      pushToast({ tone: 'success', text: t('mobile.spaces.pairSuccess', { space: created.label }) });
    } catch {
      pushToast({ tone: 'error', text: t('mobile.spaces.pairFailed') });
    } finally {
      setPairing(false);
    }
  };

  const changeTheme = (next: ThemePreference) => {
    setThemePref(next);
    writeSettings({ theme: next });
  };

  return (
    <div data-mobile-screen="spaces" className="flex min-h-0 flex-1 flex-col">
      <header data-main-header="" className="mx-auto flex h-12 w-full max-w-[572px] shrink-0 items-center justify-between px-2">
        <div className="flex min-w-0 items-center gap-1">
          {onOpenNavDrawer !== undefined ? (
            <button
              type="button"
              data-sidebar-menu=""
              aria-label={t('mobile.tab.nav')}
              onClick={onOpenNavDrawer}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink transition-colors hover:bg-ink/[0.05]"
            >
              <Icon name="menu" size={16} />
            </button>
          ) : null}
          <h1 className="px-1 font-display text-[20px] font-bold text-ink">
            {t('mobile.spaces.title')}
          </h1>
        </div>
        <button
          type="button"
          data-mobile-scan-qr
          onClick={() => { void handleScanQr(); }}
          className="inline-flex h-11 items-center gap-1.5 rounded-full bg-ink px-4 text-[13.5px] font-normal text-paper"
        >
          <Icon name="plus" size={14} />
          <span>{t('mobile.spaces.pairAction')}</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(108px+var(--kiki-safe-bottom-inset))] pt-3">
        <div className="mx-auto flex w-full max-w-[540px] flex-col gap-6">
          {pairOpen ? (
            <section
              data-mobile-pair-panel
              className="space-y-3 rounded-2xl border border-hairline bg-panel p-4 shadow-[0_1px_3px_rgb(var(--kiki-shadow-ink)/0.05)]"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-bold text-ink">{t('mobile.onboarding.title')}</h2>
                <button
                  type="button"
                  aria-label={t('common.close')}
                  onClick={() => { setPairOpen(false); }}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-ink-faint hover:bg-ink/[0.06]"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
              <div className="space-y-2.5">
                <label className="block space-y-1">
                  <span className="text-[12px] font-normal text-ink-soft">{t('mobile.onboarding.endpointLabel')}</span>
                  <input
                    type="text"
                    value={endpointInput}
                    onChange={(event) => {
                      const val = event.target.value;
                      const parsed = parsePairingUri(val.trim());
                      if (parsed !== undefined) {
                        setEndpointInput(parsed.endpoint);
                        setCodeInput(formatPairingCode(parsed.code));
                        setFingerprintInput(parsed.fingerprint ?? '');
                      } else {
                        setEndpointInput(val);
                      }
                    }}
                    placeholder={t('mobile.onboarding.endpointPlaceholder')}
                    className="h-11 w-full rounded-xl border border-hairline bg-paper px-3 text-[16px] text-ink placeholder:text-ink-faint focus:border-selected-ink focus:outline-none"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[12px] font-normal text-ink-soft">{t('mobile.onboarding.codeLabel')}</span>
                  <input
                    type="text"
                    value={codeInput}
                    onChange={(event) => { setCodeInput(formatPairingCode(event.target.value)); }}
                    placeholder={t('mobile.onboarding.codePlaceholder')}
                    className="h-11 w-full rounded-xl border border-hairline bg-paper px-3 font-mono text-[16px] tracking-[0.08em] text-ink placeholder:text-ink-faint focus:border-selected-ink focus:outline-none"
                  />
                </label>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { void handlePasteLink(); }}
                  className="flex h-11 flex-1 items-center justify-center rounded-full border border-hairline bg-paper text-[13.5px] font-normal text-ink-soft"
                >
                  {t('mobile.onboarding.pasteLink')}
                </button>
                <button
                  type="button"
                  disabled={pairing || endpointInput.trim() === '' || codeInput.trim() === ''}
                  onClick={() => { void submitPair(); }}
                  className="flex h-11 flex-1 items-center justify-center rounded-full bg-accent text-[13.5px] font-normal text-primary-foreground disabled:opacity-45"
                >
                  {t('mobile.onboarding.connect')}
                </button>
              </div>
            </section>
          ) : null}

          <section className="space-y-2">
            <h2 className="px-0.5 text-[12px] font-normal uppercase text-ink-faint">
              {t('mobile.spaces.myComputers')}
            </h2>
            <div className="divide-y divide-hairline/70 overflow-hidden rounded-2xl border border-hairline/90 bg-panel">
              <button
                type="button"
                onClick={() => { onSelectScope(localScope); }}
                className="flex min-h-[60px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.02]"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-normal text-ink">{localTitle}</span>
                  <span className="block truncate text-[12.5px] text-ink-faint">
                    {localRunningCount > 0
                      ? t('mobile.space.runningCount', { count: localRunningCount })
                      : t('mobile.space.online')}
                  </span>
                </span>
                {activeScope === localScope ? <Icon name="check" size={16} className="shrink-0 text-ink" /> : null}
              </button>

              {remoteConnections.filter((record) => record.enabled).map((record) => {
                const key = remoteSpaceKey(record.id);
                const health = healthBySpace.get(key);
                const online = health?.state === 'online' || record.state === 'online';
                const summary = remoteSummaryView(record);
                const platform = spacePlatformLabel(summary?.platform);
                const kind = endpointNetworkKind(record.endpoint);
                const netBadge = kind === 'lan' ? 'LAN' : kind === 'tailscale' ? 'VPN' : kind === 'https' ? 'HTTPS' : null;
                const showDiag = !online && diagOpenId === record.id;

                return (
                  <div key={record.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (online) onSelectScope(key);
                        else setDiagOpenId((cur) => (cur === record.id ? null : record.id));
                      }}
                      className="flex min-h-[60px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink/[0.02]"
                    >
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${online ? 'bg-success' : 'border border-ink-faint bg-transparent'}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-normal text-ink">{record.label}</span>
                        <span className="block truncate text-[12.5px] text-ink-faint">
                          {[
                            platform,
                            online
                              ? (summary?.busy ?? 0) > 0
                                ? t('mobile.space.runningCount', { count: summary!.busy })
                                : t('mobile.space.idle')
                              : t('mobile.space.offline'),
                          ]
                            .filter((part): part is string => part !== undefined && part !== '')
                            .join(' · ')}
                        </span>
                      </span>
                      {online && netBadge !== null ? (
                        <span className="shrink-0 rounded-md bg-ink/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] font-normal text-ink-soft">
                          {netBadge}
                        </span>
                      ) : !online ? (
                        <span className="shrink-0 text-[12px] text-ink-faint">{t('mobile.space.diagnostics')}</span>
                      ) : null}
                      {activeScope === key ? <Icon name="check" size={16} className="shrink-0 text-ink" /> : null}
                    </button>

                    {showDiag ? (
                      <div className="space-y-2.5 border-t border-hairline/60 bg-canvas/50 px-4 py-3">
                        <p className="font-mono text-[12px] text-ink-soft">{connectionAddress(record.endpoint)}</p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => { void onRefreshRemotes(); }}
                            className="inline-flex h-11 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-normal text-paper"
                          >
                            <Icon name="refresh" size={12} />
                            <span>{t('mobile.space.retry')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEndpointInput(record.endpoint);
                              setPairOpen(true);
                            }}
                            className="inline-flex h-11 items-center rounded-full border border-hairline bg-panel px-4 text-[13px] font-normal text-ink-soft"
                          >
                            {t('mobile.space.repair')}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="px-0.5 text-[12px] font-normal uppercase text-ink-faint">
              {t('mobile.spaces.preferences')}
            </h2>
            <div className="divide-y divide-hairline/70 overflow-hidden rounded-2xl border border-hairline/90 bg-panel">
              <div className="flex items-center justify-between gap-3 py-1.5 pl-4 pr-1.5">
                <span className="text-[14.5px] font-normal text-ink">{t('mobile.spaces.appearance')}</span>
                <div className="flex items-center rounded-full bg-canvas p-0.5">
                  {(['system', 'light', 'dark'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => { changeTheme(mode); }}
                      className={`h-11 min-w-11 rounded-full px-3 text-[13px] font-normal transition-colors ${
                        themePref === mode ? 'bg-panel text-ink shadow-xs' : 'text-ink-faint'
                      }`}
                    >
                      {t(
                        mode === 'system'
                          ? 'mobile.spaces.themeSystem'
                          : mode === 'light'
                            ? 'mobile.spaces.themeLight'
                            : 'mobile.spaces.themeDark',
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 py-1.5 pl-4 pr-1.5">
                <span className="text-[14.5px] font-normal text-ink">{t('mobile.spaces.language')}</span>
                <div className="flex items-center rounded-full bg-canvas p-0.5">
                  {(['zh', 'en'] as const).map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => { setLocale(lang); }}
                      className={`h-11 min-w-11 rounded-full px-3.5 text-[13px] font-normal transition-colors ${
                        locale === lang ? 'bg-panel text-ink shadow-xs' : 'text-ink-faint'
                      }`}
                    >
                      {lang === 'zh' ? '中文' : 'English'}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={onOpenWorkbench}
                className="flex min-h-[52px] w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-ink/[0.02]"
              >
                <span className="text-[14.5px] font-normal text-ink">{t('mobile.spaces.openWorkbench')}</span>
                <Icon name="external" size={14} className="text-ink-faint" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
