import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { Icon } from '../icons';
import { FeedbackLine, Toggle, type Feedback } from '../controls';
import { OAuthDeviceCard } from '../OAuthDeviceCard';
import { useOAuthFlow } from '../useOAuthFlow';
import {
  formatWindowPeriod, isSourceLocked, isSourceRefreshable, meterToneClass, meterUtilization, normalizeQuotaSources,
  statusBadgeInfo, useProviderQuotas,
  type ProviderQuotaMeter, type ProviderQuotaSource,
} from '../../lib/providerQuota';

export function ProviderQuotaPanel() {
  const { t, time, locale } = useI18n();
  const { snapshot, loading, isError, stale, refetch, isRefetching, refreshSource, refreshingSourceId, setSourceEnabled } = useProviderQuotas();
  const sources = normalizeQuotaSources(snapshot);
  const asOfTime = snapshot?.generated_at;
  const [sourceFeedbacks, setSourceFeedbacks] = useState<Record<string, Feedback>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [activeRefreshSourceIds, setActiveRefreshSourceIds] = useState<readonly string[]>([]);

  const handleHeaderRefresh = async () => {
    if (loading || isRefetching || refreshingAll) return;
    const targets = sources.filter((source) => isSourceRefreshable(source));
    if (targets.length === 0) {
      await refetch();
      return;
    }
    setRefreshingAll(true);
    setActiveRefreshSourceIds(targets.map((s) => s.id));
    setSourceFeedbacks((prev) => {
      const next = { ...prev };
      for (const target of targets) {
        delete next[target.id];
      }
      return next;
    });
    try {
      await Promise.all(
        targets.map(async (target) => {
          try {
            await refreshSource(target.id);
          } catch (error) {
            setSourceFeedbacks((prev) => ({
              ...prev,
              [target.id]: { tone: 'error', text: errorText(locale, error) },
            }));
          }
        }),
      );
    } finally {
      setRefreshingAll(false);
      setActiveRefreshSourceIds([]);
    }
  };

  return (
    <div className="space-y-4" data-provider-quota-panel>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">{t('usage.quota.title')}</h2>
          {asOfTime ? <p className="mt-0.5 text-[11.5px] text-ink-faint">{t('usage.quota.asOf', { time: time.relativeTime(asOfTime) })}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {stale ? (
            <span className="text-[11.5px] text-amber-ink" data-quota-stale>
              {t('usage.governance.stale', { time: asOfTime ? time.relativeTime(asOfTime) : '' })}
            </span>
          ) : null}
          <button type="button" data-quota-refresh-button onClick={() => void handleHeaderRefresh()} disabled={loading || isRefetching || refreshingAll}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-paper px-3 text-[12.5px] font-medium text-ink transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] disabled:opacity-50">
            <Icon name="refresh" size={13} className={isRefetching || refreshingAll ? 'animate-spin' : undefined} />
            {t(isRefetching || refreshingAll ? 'usage.quota.refreshing' : 'usage.quota.refresh')}
          </button>
        </div>
      </div>
      {loading ? (
        <div role="status" className="flex items-center justify-center gap-2 rounded-xl border border-hairline bg-panel px-4 py-12 text-[13px] text-ink-faint">
          <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />{t('usage.quota.refreshing')}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-[12.5px] text-danger">
          <p className="font-medium">{t('usage.quota.status.error')}</p>
        </div>
      ) : sources.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-panel px-4 py-12 text-center text-[13px] text-ink-faint" data-quota-empty>
          <p>{t('usage.quota.emptyTitle')}</p>
          <p className="mt-1 text-[11.5px] text-ink-soft">{t('usage.quota.emptyBody')}</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2" data-quota-items>
          {sources.map((source) => (
            <ProviderQuotaCard key={source.id} source={source}
              isRefreshing={refreshingSourceId === source.id || source.refreshing || activeRefreshSourceIds.includes(source.id)}
              feedback={sourceFeedbacks[source.id]}
              onClearExternalFeedback={() => setSourceFeedbacks((prev) => {
                if (!prev[source.id]) return prev;
                const next = { ...prev };
                delete next[source.id];
                return next;
              })}
              onRefresh={() => refreshSource(source.id)}
              onToggleEnabled={(enabled) => setSourceEnabled(source.id, enabled)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderQuotaCard({ source, isRefreshing, feedback: externalFeedback, onClearExternalFeedback, onRefresh, onToggleEnabled }: {
  readonly source: ProviderQuotaSource;
  readonly isRefreshing: boolean;
  readonly feedback?: Feedback;
  readonly onClearExternalFeedback?: () => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly onToggleEnabled: (enabled: boolean) => Promise<unknown>;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const navigate = useNavigate();
  const flow = useOAuthFlow();
  const [authBusy, setAuthBusy] = useState(false);
  const [localFeedback, setLocalFeedback] = useState<Feedback>(null);
  const feedback = localFeedback ?? externalFeedback ?? null;
  const badge = statusBadgeInfo(source.status);
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
          navigate('/settings/ai#st-card-providers');
          return;
        }
        await flow.start(method);
      } catch (error) {
        setLocalFeedback({ tone: 'error', text: errorText(locale, error) });
      } finally {
        setAuthBusy(false);
      }
    } else if (source.auth.action === 'provider_settings') {
      navigate('/settings/ai#st-card-providers');
    } else if (source.auth.action === 'external_service_settings') {
      navigate('/settings/search#st-card-search-providers');
    } else if (source.auth.action === 'executor_login') {
      navigate('/settings/ai#st-card-engines');
    }
  };
  const runAction = async (action: () => Promise<unknown>) => {
    setLocalFeedback(null);
    onClearExternalFeedback?.();
    try { await action(); }
    catch (error) { setLocalFeedback({ tone: 'error', text: errorText(locale, error) }); }
  };

  return (
    <section data-quota-item={source.id} className="flex flex-col justify-between rounded-xl border border-hairline bg-panel p-4">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h3 className="truncate font-display text-[15px] font-semibold text-ink">{source.label}</h3>
              {source.kind !== 'provider' ? (
                <span className="shrink-0 rounded bg-ink/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">{t(`usage.quota.kind.${source.kind}` as I18nKey)}</span>
              ) : null}
            </div>
            {source.account_label ? <p className="mt-0.5 truncate text-[11px] text-ink-faint" title={source.account_label}>{t('usage.quota.source', { source: source.account_label })}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className={`rounded border px-1.5 py-0.5 text-[10.5px] font-medium ${badge.toneClass}`} data-quota-status={source.status}>{t(badge.labelKey as I18nKey)}</span>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-2 text-[12px]">
          <div className="flex items-center gap-2">
            {source.status === 'auth_required' ? (
              <button type="button" data-quota-auth-action={source.id} onClick={() => { void handleAuthAction(); }}
                disabled={authBusy || flow.busy !== null || (flow.showing && flow.snapshot?.status === 'pending')}
                className="inline-flex h-7 items-center gap-1 rounded border border-hairline bg-paper px-2 text-[11px] font-medium text-ink transition-colors hover:bg-ink/[0.05] disabled:opacity-50">
                {t(source.auth.action === 'oauth_login' || source.auth.action === 'executor_login' ? 'usage.quota.action.login' : 'usage.quota.action.settings')}
              </button>
            ) : null}
            {source.supported && source.enabled ? (
              <button type="button" data-quota-source-refresh={source.id} onClick={() => { void runAction(onRefresh); }}
                disabled={isRefreshing || isLocked} title={isLocked ? t('usage.quota.refreshAfter', { seconds: secondsLeft }) : undefined}
                className="inline-flex h-7 items-center gap-1 rounded border border-hairline bg-paper px-2 text-[11px] font-medium text-ink transition-colors hover:bg-ink/[0.05] disabled:opacity-50">
                <Icon name="refresh" size={11} className={isRefreshing ? 'animate-spin' : undefined} />
                {isLocked ? `${secondsLeft}s` : t('usage.quota.refresh')}
              </button>
            ) : null}
          </div>
          <div className="ml-auto"><Toggle layout="bare" label={t('usage.quota.toggleEnable', { name: source.label })} checked={source.enabled} onChange={(enabled) => { void runAction(() => onToggleEnabled(enabled)); }} /></div>
        </div>
        {flow.showing && flow.snapshot !== null ? (
          <OAuthDeviceCard snapshot={flow.snapshot} label={source.label} cancelling={flow.cancelling}
            onCancel={() => { void flow.cancel(); }} onDismiss={() => { flow.dismiss(flow.snapshot!.flow_id); }} />
        ) : null}
        <FeedbackLine feedback={flow.feedback?.value ?? null} />
        <FeedbackLine feedback={feedback} />
        {source.meters.length > 0 ? (
          <div className="mt-3 space-y-2.5 border-t border-hairline pt-3">
            {source.meters.map((meter) => <QuotaMeterRow key={meter.id} meter={meter} sourceStatus={source.status} />)}
          </div>
        ) : null}
        {source.message ? <p className="mt-3 text-[11.5px] text-ink-soft">{source.message}</p> : null}
        {source.reason && !source.message ? <p className="mt-2 text-[11px] text-ink-faint">{source.reason}</p> : null}
      </div>
    </section>
  );
}

function QuotaMeterRow({ meter, sourceStatus }: { readonly meter: ProviderQuotaMeter; readonly sourceStatus: ProviderQuotaSource['status'] }) {
  const { t, time } = useI18n();
  const periodLabel = meter.window?.label ?? formatWindowPeriod(meter.window?.duration_seconds);
  const status = meter.status ?? sourceStatus;
  const badge = statusBadgeInfo(status);
  const util = meterUtilization(meter);
  const tone = util !== undefined ? meterToneClass(util) : 'bg-ink/[0.2] text-ink-faint';
  const { used, limit, remaining } = meter;
  let valueText = t('usage.quota.status.unknown');
  if (meter.unit === 'percent') {
    if (used !== null) valueText = `${Math.round(used)}%`;
    else if (remaining !== null) valueText = `${Math.round(remaining)}%`;
  } else if (meter.unit === 'money') {
    const curr = meter.currency ?? meter.unit_label;
    if (remaining !== null) valueText = `${remaining.toFixed(2)} ${curr}`;
    else if (used !== null) valueText = `${used.toFixed(2)} ${curr}`;
  } else if (used !== null && limit !== null) {
    const pct = util !== undefined ? ` · ${Math.round(util)}%` : '';
    valueText = `${used}/${limit}${pct} ${meter.unit_label}`.trim();
  } else if (remaining !== null) {
    valueText = `${remaining} ${meter.unit_label}`.trim();
  } else if (used !== null) {
    valueText = `${used} ${meter.unit_label}`.trim();
  }
  const resetTime = meter.window?.reset_at;
  return (
    <div className="space-y-1 text-[12px]" data-quota-meter={meter.id}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-ink-soft">{meter.label}</span>
          {meter.scope === 'team' ? <span className="shrink-0 rounded bg-ink/[0.06] px-1 py-px font-mono text-[9.5px] text-ink-faint">Team</span> : null}
          {periodLabel ? <span className="shrink-0 rounded bg-ink/[0.05] px-1 py-px font-mono text-[10px] text-ink-faint">{periodLabel}</span> : null}
          {status !== 'ready' ? (
            <span className={`shrink-0 rounded border px-1 py-px text-[9.5px] font-medium ${badge.toneClass}`} data-meter-status={status}>{t(badge.labelKey as I18nKey)}</span>
          ) : null}
        </span>
        <span className="shrink-0 font-mono text-[11.5px] text-ink tabular-nums">{valueText}</span>
      </div>
      {util !== undefined ? (
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.07]" data-quota-progress>
          <div className={`h-full rounded-full transition-all duration-300 ${tone.split(' ')[0]}`} style={{ width: `${Math.min(100, Math.max(0, util))}%` }} />
        </div>
      ) : null}
      {resetTime ? <div className="flex justify-end text-[10.5px] text-ink-faint"><span>{t('usage.quota.resets', { time: time.timeUntil(resetTime) })}</span></div> : null}
      {meter.message ? <p className="text-[11px] text-danger">{meter.message}</p> : null}
    </div>
  );
}
