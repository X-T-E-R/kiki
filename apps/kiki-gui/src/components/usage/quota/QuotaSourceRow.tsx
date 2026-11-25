import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import { compactIdentifier } from '../../../lib/compactIdentifier';
import {
  isSourceLocked,
  statusBadgeInfo,
  type ProviderQuotaSource,
  type ProviderQuotaStatus,
} from '../../../lib/providerQuota';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { MiniContextMenu, type MiniMenuEntry } from '../../MiniContextMenu';
import { OAuthDeviceCard } from '../../OAuthDeviceCard';
import { useOAuthFlow } from '../../useOAuthFlow';
import { QuotaWindowMeter } from './QuotaWindowMeter';

export const QUOTA_ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 md:grid-cols-[minmax(176px,216px)_minmax(0,1fr)_auto]';
export const QUOTA_SMALL_BUTTON =
  'inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-paper px-2.5 text-[11.5px] font-medium text-ink transition-colors hover:bg-ink/[0.05] focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-3';
export const QUOTA_ICON_BUTTON =
  'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11';

export function KindTag({ kind }: { readonly kind: ProviderQuotaSource['kind'] }) {
  const { t } = useI18n();
  if (kind === 'provider' || kind === 'executor') return null;
  return <span className="shrink-0 text-[11px] text-ink-faint">{t(`usage.quota.kind.${kind}` as I18nKey)}</span>;
}

export function SourceAccountSubtitle({
  source,
  settingsHref,
  showSettingsLink,
}: {
  readonly source: ProviderQuotaSource;
  readonly settingsHref: string;
  readonly showSettingsLink?: boolean;
}) {
  const { t } = useI18n();
  const accountDisplay = source.account_label ? compactIdentifier(source.account_label) : undefined;
  const rawTitle = [source.account_label, source.source.label].filter(Boolean).join(' · ');
  if (accountDisplay === undefined && !showSettingsLink) return null;
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-sans tracking-normal text-[11.5px] text-[var(--kiki-chart-muted)]">
      {accountDisplay !== undefined ? (
        <span className="min-w-0 truncate" title={rawTitle}>{accountDisplay}</span>
      ) : null}
      {accountDisplay !== undefined && showSettingsLink ? <span aria-hidden>·</span> : null}
      {showSettingsLink ? (
        <Link
          to={settingsHref}
          data-quota-settings-link={source.id}
          className="inline-flex shrink-0 items-center rounded text-ink-soft hover:text-ink hover:underline pointer-coarse:min-h-11 pointer-coarse:px-2"
        >
          {t('usage.quota.action.settings')}
        </Link>
      ) : null}
    </p>
  );
}

export function RowActionsMenu({
  source,
  settingsHref,
  localUsageHref,
  onRefresh,
  onDisable,
  onOpenChange,
}: {
  readonly source: ProviderQuotaSource;
  readonly settingsHref: string;
  readonly localUsageHref?: string;
  readonly onRefresh?: () => Promise<void>;
  readonly onDisable: () => Promise<void>;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => {
    setMenuPos(null);
    onOpenChange?.(false);
  }, [onOpenChange]);
  const entries = useMemo<readonly MiniMenuEntry[]>(() => [
    ...(onRefresh !== undefined ? [{
      key: 'refresh',
      label: t('usage.quota.refresh'),
      run: () => onRefresh(),
    }] : []),
    {
      key: 'settings',
      label: t('usage.quota.action.settings'),
      run: () => { void navigate(settingsHref); },
    },
    ...(localUsageHref !== undefined ? [{
      key: 'local-usage',
      label: t('usage.quota.action.localUsage'),
      run: () => { void navigate(localUsageHref); },
    }] : []),
    { separator: true as const },
    {
      key: 'disable',
      label: t('usage.quota.action.disable'),
      danger: true,
      run: () => onDisable(),
    },
  ], [localUsageHref, navigate, onDisable, onRefresh, settingsHref, t]);

  return (
    <>
      <button
        type="button"
        data-quota-menu-trigger={source.id}
        aria-label={t('st.spaces.menuAria', { name: source.label })}
        aria-expanded={menuPos !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuPos((prev) => {
            const next = prev === null ? { x: rect.left, y: rect.bottom + 4 } : null;
            onOpenChange?.(next !== null);
            return next;
          });
        }}
        className={QUOTA_ICON_BUTTON}
      >
        <Icon name="more" size={14} />
      </button>
      {menuPos !== null ? (
        <MiniContextMenu
          x={menuPos.x}
          y={menuPos.y}
          entries={entries}
          onClose={close}
          ariaLabel={source.label}
          overlayId={`quota-row-menu-${source.id}`}
          dataAttribute="data-quota-row-menu"
        />
      ) : null}
    </>
  );
}

export function AttentionQuotaRow({
  source,
  status,
  signedOut,
  settingsHref,
  localUsageHref,
  isRefreshing,
  feedback: externalFeedback,
  onClearExternalFeedback,
  onRefresh,
  onToggleEnabled,
}: {
  readonly source: ProviderQuotaSource;
  readonly status: ProviderQuotaStatus;
  readonly signedOut: boolean;
  readonly settingsHref: string;
  readonly localUsageHref?: string;
  readonly isRefreshing: boolean;
  readonly feedback?: Feedback;
  readonly onClearExternalFeedback?: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onToggleEnabled: (enabled: boolean) => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const onSignedIn = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['provider-quotas'] }),
    ]);
  }, [queryClient]);
  const flow = useOAuthFlow(onSignedIn);
  const [authBusy, setAuthBusy] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const feedback = localFeedback ?? externalFeedback ?? null;
  const badge = statusBadgeInfo(status);
  const isLocked = isSourceLocked(source);
  const refreshAfterMs = source.refresh_after ? new Date(source.refresh_after).getTime() : 0;
  const secondsLeft = isLocked ? Math.ceil((refreshAfterMs - Date.now()) / 1000) : 0;

  const handleAuthAction = async () => {
    setLocalFeedback(null);
    onClearExternalFeedback?.();
    if (source.auth.action === 'oauth_login') {
      setAuthBusy(true);
      try {
        const methods = await client.listOAuthMethods();
        const method = methods.find((entry) => entry.provider === source.auth.provider || entry.id === source.auth.provider);
        if (method === undefined) {
          void navigate(settingsHref);
          return;
        }
        await flow.start(method);
      } catch (error) {
        setLocalFeedback({ tone: 'error', text: errorText(locale, error) });
      } finally {
        setAuthBusy(false);
      }
    } else {
      void navigate(settingsHref);
    }
  };
  const runAction = async (action: () => Promise<unknown>) => {
    setLocalFeedback(null);
    onClearExternalFeedback?.();
    try { await action(); }
    catch (error) { setLocalFeedback({ tone: 'error', text: errorText(locale, error) }); }
  };

  const message = signedOut ? t('usage.quota.signedOut') : source.message ?? source.reason;
  const canRefresh = source.supported && source.enabled && !signedOut;
  const statusTextTone = status === 'auth_required'
    ? 'text-[var(--kiki-chart-warn-text)]'
    : 'text-[var(--kiki-chart-danger-text)]';

  return (
    <section
      data-quota-item={source.id}
      className={`space-y-2 border-l-2 pl-4 pr-3 py-3 ${
        status === 'auth_required'
          ? 'border-[var(--kiki-chart-3)] bg-attention/[0.05]'
          : 'border-[var(--kiki-chart-danger)] bg-danger/[0.045]'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                status === 'auth_required' ? 'bg-[var(--kiki-chart-3)]' : 'bg-[var(--kiki-chart-danger)]'
              }`}
            />
            <h3 className="truncate font-sans text-[13px] font-[510] text-ink">{source.label}</h3>
            <KindTag kind={source.kind} />
            <span className={`shrink-0 text-[11.5px] font-medium ${statusTextTone}`} data-quota-status={status}>
              {t(badge.labelKey as I18nKey)}
            </span>
          </div>
          <SourceAccountSubtitle source={source} settingsHref={settingsHref} showSettingsLink />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {status === 'auth_required' ? (
            <button
              type="button"
              data-quota-auth-action={source.id}
              onClick={() => { void handleAuthAction(); }}
              disabled={authBusy || flow.busy !== null || (flow.showing && flow.snapshot?.status === 'pending')}
              className={QUOTA_SMALL_BUTTON}
            >
              {t(source.auth.action === 'oauth_login' || source.auth.action === 'executor_login' || source.auth.action === 'open_plugin_panel' ? 'usage.quota.action.login' : 'usage.quota.action.settings')}
            </button>
          ) : canRefresh ? (
            <button
              type="button"
              data-quota-source-refresh={source.id}
              onClick={() => { void runAction(onRefresh); }}
              disabled={isRefreshing || isLocked}
              title={isLocked ? t('usage.quota.refreshAfter', { seconds: secondsLeft }) : undefined}
              className={QUOTA_SMALL_BUTTON}
            >
              <Icon name="refresh" size={12} className={isRefreshing ? 'animate-spin' : undefined} />
              {isLocked ? `${secondsLeft}s` : t('st.im.retry')}
            </button>
          ) : null}
          <RowActionsMenu
            source={source}
            settingsHref={settingsHref}
            localUsageHref={localUsageHref}
            onRefresh={status === 'auth_required' && canRefresh ? () => runAction(onRefresh) : undefined}
            onDisable={() => runAction(() => onToggleEnabled(false))}
          />
        </div>
      </div>
      {message ? <p className="truncate text-[12px] text-ink-soft" title={message}>{message}</p> : null}
      {source.meters.length > 0 ? (
        <div className="space-y-2 border-t border-hairline/70 pt-2 opacity-85">
          {source.meters.map((meter) => <QuotaWindowMeter key={meter.id} meter={meter} sourceStatus={status} />)}
        </div>
      ) : null}
      {flow.showing && flow.snapshot !== null ? (
        <OAuthDeviceCard
          snapshot={flow.snapshot}
          label={source.label}
          cancelling={flow.cancelling}
          onCancel={() => { void flow.cancel(); }}
          onDismiss={() => { flow.dismiss(flow.snapshot!.flow_id); }}
        />
      ) : null}
      <FeedbackLine feedback={flow.feedback?.value ?? null} />
      <FeedbackLine feedback={feedback} />
    </section>
  );
}

export function LedgerQuotaRow({
  source,
  status,
  signedOut,
  settingsHref,
  localUsageHref,
  isRefreshing,
  feedback: externalFeedback,
  onClearExternalFeedback,
  onRefresh,
  onToggleEnabled,
}: {
  readonly source: ProviderQuotaSource;
  readonly status: ProviderQuotaStatus;
  readonly signedOut: boolean;
  readonly settingsHref: string;
  readonly localUsageHref?: string;
  readonly isRefreshing: boolean;
  readonly feedback?: Feedback;
  readonly onClearExternalFeedback?: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onToggleEnabled: (enabled: boolean) => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const feedback = localFeedback ?? externalFeedback ?? null;
  const badge = statusBadgeInfo(status);
  const isLocked = isSourceLocked(source);
  const refreshAfterMs = source.refresh_after ? new Date(source.refresh_after).getTime() : 0;
  const secondsLeft = isLocked ? Math.ceil((refreshAfterMs - Date.now()) / 1000) : 0;

  const runAction = async (action: () => Promise<unknown>) => {
    setLocalFeedback(null);
    onClearExternalFeedback?.();
    try { await action(); }
    catch (error) { setLocalFeedback({ tone: 'error', text: errorText(locale, error) }); }
  };

  const canRefresh = source.supported && source.enabled && !signedOut;
  const hasBeenQueried = status !== 'ready' ? (status !== 'unknown' || source.checked_at !== undefined || source.data_as_of !== undefined) : true;
  const unqueried = !hasBeenQueried && source.meters.length === 0;
  const emptyStatusMessage = source.message ?? source.reason;
  const keepActionsVisible = isRefreshing || isLocked || menuOpen;

  return (
    <section data-quota-item={source.id} className="group space-y-2 py-3.5">
      <div className={QUOTA_ROW_GRID}>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate font-sans text-[13px] font-[510] text-ink">{source.label}</h3>
            <KindTag kind={source.kind} />
            {status !== 'ready' && !unqueried ? (
              <span
                className="shrink-0 text-[11px] font-medium text-amber-ink"
                data-quota-status={status}
                title={[t(badge.labelKey as I18nKey), source.message, source.reason].filter(Boolean).join(' · ')}
              >
                {status === 'stale' ? '◷' : t(badge.labelKey as I18nKey)}
              </span>
            ) : (
              <span className="sr-only" data-quota-status={status}>{t(badge.labelKey as I18nKey)}</span>
            )}
          </div>
          <SourceAccountSubtitle source={source} settingsHref={settingsHref} />
        </div>

        <div className="min-w-0 max-md:col-span-2 max-md:order-3">
          {source.meters.length > 0 ? (
            <div className="space-y-2.5">
              {source.meters.map((meter) => <QuotaWindowMeter key={meter.id} meter={meter} sourceStatus={status} />)}
            </div>
          ) : unqueried ? (
            <div className="flex flex-wrap items-center gap-2 py-0.5 text-[12px] text-ink-soft" data-quota-not-queried={source.id}>
              <span>{t('usage.quota.notQueried')}</span>
              {canRefresh ? (
                <>
                  <span aria-hidden className="text-ink-faint">·</span>
                  <button
                    type="button"
                    data-quota-query-now={source.id}
                    disabled={isRefreshing || isLocked}
                    onClick={() => { void runAction(onRefresh); }}
                    className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-2"
                  >
                    {t('usage.quota.queryNow')}
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            <p className="py-0.5 text-[12px] text-ink-soft" data-quota-no-meters={source.id}>
              {emptyStatusMessage ?? t(status === 'ready' || status === 'stale' ? 'st.quota.none' : 'usage.quota.status.unknown')}
            </p>
          )}
          {status !== 'stale' && source.message && source.meters.length > 0 ? <p className="mt-1 text-[11.5px] text-ink-soft">{source.message}</p> : null}
          {status !== 'stale' && source.reason && !source.message && source.meters.length > 0 ? <p className="mt-1 text-[11px] text-ink-faint">{source.reason}</p> : null}
        </div>

        <div
          className={`flex shrink-0 items-center justify-end gap-0.5 max-md:order-2 transition-opacity ${
            keepActionsVisible
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
          }`}
        >
          {canRefresh ? (
            <button
              type="button"
              data-quota-source-refresh={source.id}
              onClick={() => { void runAction(onRefresh); }}
              disabled={isRefreshing || isLocked}
              aria-label={t('usage.quota.refresh')}
              title={isLocked ? t('usage.quota.refreshAfter', { seconds: secondsLeft }) : t('usage.quota.refresh')}
              className={QUOTA_ICON_BUTTON}
            >
              <Icon name="refresh" size={14} className={isRefreshing ? 'animate-spin' : undefined} />
              {isLocked ? <span className="font-mono text-[10.5px]">{secondsLeft}s</span> : null}
            </button>
          ) : null}
          <RowActionsMenu
            source={source}
            settingsHref={settingsHref}
            localUsageHref={localUsageHref}
            onDisable={() => runAction(() => onToggleEnabled(false))}
            onOpenChange={setMenuOpen}
          />
        </div>
      </div>
      <FeedbackLine feedback={feedback} />
    </section>
  );
}
