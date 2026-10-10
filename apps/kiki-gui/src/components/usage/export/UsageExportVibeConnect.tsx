import { useEffect, useRef, useState } from 'react';
import type { UsageExportVibeAuth } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { useHost } from '../../../host';
import { openExternalUrl, reserveExternalBrowserTab, type ExternalBrowserTab } from '../../../host/external';
import { useI18n } from '../../../i18n';
import { shortId, type UsageExportApi } from '../../../lib/usageExport';
import { InlineError } from '../../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';

const FAILURE_KEYS: Record<string, I18nKey> = {
  'vibe-auth-network': 'usage.export.vibeAuth.error.network',
  'vibe-auth-start-failed': 'usage.export.vibeAuth.error.network',
  'vibe-auth-storage-failed': 'usage.export.vibeAuth.error.storage',
  'keyring-unavailable': 'usage.export.vibeAuth.error.storage',
  'private-file-storage-requires-consent': 'usage.export.vibeAuth.error.storage',
  'vibe-auth-destination-changed': 'usage.export.vibeAuth.error.changed',
  'identity-change-requires-new-destination': 'usage.export.vibeAuth.error.newDestination',
};

export function UsageExportVibeConnect({
  api,
  begin,
  credentialStored,
  accountFingerprint,
  disabled,
  onActivity,
  onConnected,
  onDisconnect,
}: {
  readonly api: UsageExportApi | undefined;
  readonly begin: () => Promise<UsageExportVibeAuth | undefined>;
  readonly credentialStored: boolean;
  readonly accountFingerprint?: string | undefined;
  readonly disabled: boolean;
  readonly onActivity: (active: boolean) => void;
  readonly onConnected: () => void;
  readonly onDisconnect?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const host = useHost();
  const [flow, setFlow] = useState<UsageExportVibeAuth | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef<UsageExportVibeAuth | null>(null);
  const generation = useRef(0);
  const reservedTab = useRef<ExternalBrowserTab | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const activity = useRef(onActivity);
  activity.current = onActivity;

  useEffect(() => () => {
    generation.current++;
    reservedTab.current?.close(); reservedTab.current = null;
    if (active.current?.state === 'pending') void api?.cancelVibeAuth(active.current.flow_id).catch(() => {});
    activity.current(false);
  }, [api]);

  const accept = (next: UsageExportVibeAuth) => {
    active.current = next;
    setFlow(next);
    if (next.state !== 'pending') activity.current(false);
    if (next.state === 'connected') connected.current();
  };

  useEffect(() => {
    if (flow?.state !== 'pending' || api === undefined || cancelling) return;
    const current = generation.current;
    const timer = window.setTimeout(() => {
      void api.pollVibeAuth(flow.flow_id).then((next) => {
        if (generation.current === current && active.current?.state === 'pending') { setError(null); accept(next); }
      }).catch((failure: unknown) => {
        if (generation.current !== current || active.current?.state !== 'pending') return;
        setError(failure);
        setFlow((value) => value === null ? null : { ...value, poll_after_ms: 5000 });
      });
    }, Math.max(250, flow.poll_after_ms));
    return () => window.clearTimeout(timer);
  }, [api, flow, cancelling]);

  const open = async (url: string) => {
    try { await openExternalUrl(host, url, t('common.popupBlocked')); }
    catch (error) { setError(error); }
  };
  const start = async () => {
    const current = ++generation.current;
    let tab: ExternalBrowserTab | null = null;
    let popupError: unknown = null;
    if (host.openUrl === undefined) {
      try { tab = reserveExternalBrowserTab(t('common.popupBlocked')); }
      catch (error) { popupError = error; }
    }
    reservedTab.current = tab;
    setStarting(true); setError(null); activity.current(true);
    try {
      const next = await begin();
      if (generation.current !== current) {
        tab?.close();
        if (next?.state === 'pending') await api?.cancelVibeAuth(next.flow_id);
        return;
      }
      if (next === undefined) { tab?.close(); activity.current(false); return; }
      accept(next);
      if (next.state === 'pending') {
        if (tab !== null) tab.navigate(next.verification_uri);
        else if (host.openUrl !== undefined) await open(next.verification_uri);
        else setError(popupError);
      } else tab?.close();
    } catch (error) {
      tab?.close();
      if (generation.current === current) { setError(error); if (active.current?.state !== 'pending') activity.current(false); }
    } finally {
      if (reservedTab.current === tab) reservedTab.current = null;
      if (generation.current === current) setStarting(false);
    }
  };
  const cancel = async () => {
    if (flow === null || api === undefined) return;
    setCancelling(true); setError(null);
    try { accept(await api.cancelVibeAuth(flow.flow_id)); }
    catch (failure) { setError(failure); }
    finally { setCancelling(false); }
  };
  const disconnect = async () => {
    if (onDisconnect === undefined) return;
    setDisconnecting(true); setError(null);
    try {
      await onDisconnect();
      setFlow(null);
    } catch (failure) {
      setError(failure);
    } finally {
      setDisconnecting(false);
    }
  };
  const pending = flow?.state === 'pending';
  const isConnected = flow?.state === 'connected' || (flow === null && credentialStored);
  const isError = flow?.state === 'error' || flow?.state === 'denied' || flow?.state === 'expired';

  return (
    <section data-usage-export-vibe-connect={flow?.state ?? (credentialStored ? 'connected' : 'idle')} className="space-y-3 rounded-xl border border-hairline bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink">VibeCafe</p>
        <span className="text-[11.5px] text-ink-faint">vibecafe.ai</span>
      </div>
      <p className="text-[12px] leading-relaxed text-ink-soft">{t('usage.export.vibeAuth.hint')}</p>
      {pending ? (
        <>
          <p className="text-[11.5px] text-ink-soft">{t('st.oauth.codeLabel')}</p>
          <code data-usage-export-vibe-code className="inline-block rounded-md bg-paper px-3 py-2 font-mono text-[20px] font-semibold tracking-[0.15em] text-ink">{flow.user_code}</code>
          <p role="status" className="text-[12px] text-ink-soft">{t(flow.error_category === 'vibe-auth-network' ? 'usage.export.vibeAuth.network' : 'usage.export.vibeAuth.pending')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-usage-export-vibe-open className={SECONDARY_BUTTON} onClick={() => void open(flow.verification_uri)}>{t('st.oauth.openPage')}</button>
            <button type="button" data-usage-export-vibe-cancel className={SECONDARY_BUTTON} disabled={cancelling} onClick={() => void cancel()}>{t(cancelling ? 'st.oauth.cancelling' : 'st.oauth.cancel')}</button>
          </div>
          <a href={flow.verification_uri} target="_blank" rel="noopener noreferrer" className="block break-all text-[11px] text-ink-faint underline">{flow.verification_uri}</a>
        </>
      ) : isConnected ? (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-2 w-2 rounded-full bg-success" />
            <p role="status" className="text-[12.5px] font-medium text-ink">
              {t(flow?.state === 'connected' ? 'usage.export.vibeAuth.connected' : 'usage.export.vibeAuth.stored')}
            </p>
          </div>
          {accountFingerprint ? (
            <p data-usage-export-vibe-account className="font-mono text-[11.5px] text-ink-soft">
              {t('usage.export.detail.identity', { fingerprint: shortId(accountFingerprint) })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              data-usage-export-vibe-login
              className={SECONDARY_BUTTON}
              disabled={disabled || starting || disconnecting || api === undefined}
              onClick={() => void start()}
            >
              {t(starting ? 'usage.export.vibeAuth.starting' : 'usage.export.vibeAuth.reconnect')}
            </button>
            {onDisconnect ? (
              <button
                type="button"
                data-usage-export-vibe-disconnect
                className={SECONDARY_BUTTON}
                disabled={disabled || starting || disconnecting || api === undefined}
                onClick={() => void disconnect()}
              >
                {t('usage.export.vibeAuth.disconnect')}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {flow !== null ? (
            <p role="status" className={`text-[12px] ${isError ? 'text-danger' : 'text-ink-soft'}`}>
              {t(flow.state === 'error' ? FAILURE_KEYS[flow.error_category ?? ''] ?? 'usage.export.vibeAuth.error' : `usage.export.vibeAuth.${flow.state}` as 'usage.export.vibeAuth.connected')}
            </p>
          ) : null}
          <button
            type="button"
            data-usage-export-vibe-login
            className={PRIMARY_BUTTON}
            disabled={disabled || starting || api === undefined}
            onClick={() => void start()}
          >
            {t(starting ? 'usage.export.vibeAuth.starting' : flow === null ? 'usage.export.vibeAuth.login' : 'usage.export.vibeAuth.retry')}
          </button>
        </>
      )}
      {error !== null ? <InlineError error={error} /> : null}
    </section>
  );
}
