import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug } from 'lucide-react';

import type { ModelCatalogItem, ProviderCatalogItem, ProviderPluginInfo } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';
import { formatTokens } from '@kiki/session-core/util';

import { useI18n } from '../../i18n';
import { usePhoneMode } from '../../lib/layoutHooks';
import { useConnection } from '../../state/connection';
import { FeedbackLine, SavedTick, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { CapabilityMarks } from '../ProviderFields';
import { SECONDARY_BUTTON } from '../ui';
import { selectGlobalDefaultModel } from './defaultModelSelection';
import { LIST_ROW_HEIGHT, ListBody, type ListDensity } from './list';
import { useSavedTick } from './useSavedTick';

export function pluginProviderPanelHref(plugin: ProviderPluginInfo): string {
  const base = `/settings/plugins?plugin=${encodeURIComponent(plugin.plugin_id)}`;
  if (plugin.panel_id !== undefined && plugin.panel_id.length > 0) {
    return `${base}&panel=${encodeURIComponent(plugin.panel_id)}`;
  }
  return base;
}

const READINESS_KEY = {
  ready: 'st.connections.plugin.ready',
  auth_required: 'st.connections.plugin.authRequired',
  degraded: 'st.connections.plugin.degraded',
  initializing: 'st.connections.plugin.initializing',
} as const;

function readinessToneClass(readiness: ProviderPluginInfo['readiness']): string {
  switch (readiness) {
    case 'ready':
      return 'text-ink-soft';
    case 'auth_required':
      return 'text-amber-ink';
    case 'degraded':
      return 'text-danger';
    case 'initializing':
      return 'text-ink-faint';
  }
}

function PluginModelRow({
  item,
  density,
  isDefault,
  busy,
  onSetDefault,
}: {
  readonly item: ModelCatalogItem;
  readonly density: ListDensity;
  readonly isDefault: boolean;
  readonly busy: boolean;
  readonly onSetDefault: () => void;
}) {
  const { t } = useI18n();
  const compact = density === 'compact';
  const capabilities = item.effective_capabilities ?? item.capabilities;
  const efforts = item.support_efforts;

  return (
    <div
      data-model-row={item.id}
      data-plugin-model-row={item.id}
      data-default={isDefault ? 'true' : undefined}
      style={{ minHeight: LIST_ROW_HEIGHT[density] }}
      className="flex h-full items-center gap-1 pr-2 pl-1"
    >
      <button
        type="button"
        onClick={onSetDefault}
        disabled={busy || isDefault}
        aria-label={t('st.models.starAria', { model: item.id })}
        title={isDefault ? t('st.models.starredTitle') : t('st.models.unstarredTitle')}
        aria-pressed={isDefault}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-default pointer-coarse:h-11 pointer-coarse:w-11 ${
          isDefault ? 'text-ink' : 'text-ink-faint hover:bg-ink/[0.04] hover:text-ink'
        }`}
      >
        <Icon name={isDefault ? 'starFilled' : 'star'} size={14} />
      </button>
      <div className="flex min-h-8 min-w-0 flex-1 items-center gap-3 pr-1">
        <span className={`min-w-0 flex-1 ${compact ? 'flex items-baseline gap-2' : ''}`}>
          <span className={`flex min-w-0 items-center gap-2 ${compact ? 'shrink' : ''}`}>
            <span className="truncate text-[13px] font-medium text-ink">{item.display_name ?? item.id}</span>
            {isDefault ? (
              <span
                data-default-badge
                className="inline-flex shrink-0 items-center rounded bg-selected-ink/10 px-1.5 py-0.5 text-[11px] font-medium text-selected-ink"
              >
                {t('st.models.default')}
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-faint">
            <span className="truncate font-mono text-[11px]">{item.remote_id ?? item.id}</span>
            {item.max_context_size !== undefined ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums">{formatTokens(item.max_context_size)}</span>
              </>
            ) : null}
            {efforts !== undefined && efforts.length > 0 && !compact ? (
              <span className="hidden min-w-0 truncate font-mono text-[11px] sm:inline">
                · {efforts.join('/')}
              </span>
            ) : null}
          </span>
        </span>
        {capabilities !== undefined && capabilities.length > 0 ? (
          <span className="hidden sm:inline-flex">
            <CapabilityMarks capabilities={capabilities} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function PluginModelList({
  providerId,
  models,
  density,
}: {
  readonly providerId: string;
  readonly models: readonly ModelCatalogItem[];
  readonly density: ListDensity;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const defaultModel = configQuery.data?.default_model;

  const own = useMemo(
    () => models
      .filter((item) => item.provider_id === providerId)
      .toSorted((a, b) => Number(b.id === defaultModel) - Number(a.id === defaultModel)
        || (a.display_name ?? a.id).localeCompare(b.display_name ?? b.id)),
    [models, providerId, defaultModel],
  );

  const selectDefaultModel = async (item: ModelCatalogItem) => {
    setBusy(true);
    setFeedback(null);
    const selection = selectGlobalDefaultModel(client, queryClient, item);
    try {
      if (await selection.completed) ping();
    } catch (error) {
      if (selection.isCurrent()) setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-provider-models={providerId}>
      <ListBody
        items={own}
        keyOf={(item) => item.id}
        density={density}
        label={t('st.providerModels.title')}
        renderRow={(item) => (
          <PluginModelRow
            item={item}
            density={density}
            isDefault={item.id === defaultModel}
            busy={busy}
            onSetDefault={() => void selectDefaultModel(item)}
          />
        )}
      />
      <SavedTick show={tick} />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

export function PluginProviderRow({
  provider,
  plugin,
  models,
  defaultOpen = false,
  density = 'comfortable',
}: {
  readonly provider: ProviderCatalogItem;
  readonly plugin: ProviderPluginInfo;
  readonly models: readonly ModelCatalogItem[];
  readonly defaultOpen?: boolean;
  readonly density?: ListDensity;
}) {
  const { t } = useI18n();
  const phone = usePhoneMode();
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const displayName = provider.label ?? provider.id;
  const effectiveModelCount = models.length > 0 ? models.length : plugin.model_count;
  const statusLine = t(READINESS_KEY[plugin.readiness]);
  const actionLabel = plugin.readiness === 'auth_required'
    ? t('st.connections.plugin.signIn')
    : t('st.connections.plugin.manage');
  const hasPanel = plugin.panel_id !== undefined && plugin.panel_id.length > 0;
  const showDot = plugin.readiness === 'auth_required' || plugin.readiness === 'degraded';

  const statusBadge = (
    <span
      data-plugin-provider-status={plugin.readiness}
      className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${readinessToneClass(plugin.readiness)}`}
    >
      {showDot ? (
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${plugin.readiness === 'degraded' ? 'bg-danger' : 'bg-amber-rule'}`}
        />
      ) : null}
      <span>{statusLine}</span>
    </span>
  );

  const actionLink = hasPanel ? (
    <Link
      to={pluginProviderPanelHref(plugin)}
      data-plugin-provider-action={provider.id}
      onClick={(event) => { event.stopPropagation(); }}
      className={`${SECONDARY_BUTTON} inline-flex h-7 shrink-0 items-center px-2.5 text-[12px] pointer-coarse:min-h-11`}
    >
      {actionLabel}
    </Link>
  ) : null;

  return (
    <details
      open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open); }}
      data-connection-row={provider.id}
      data-connection-kind="plugin"
      data-plugin-provider-row={provider.id}
      data-plugin-provider-readiness={plugin.readiness}
      className="group/provider [&[open]]:bg-paper"
    >
      <summary
        style={{ minHeight: LIST_ROW_HEIGHT[density] }}
        className={`flex cursor-pointer list-none items-center gap-3 px-3 outline-none transition-colors hover:bg-ink/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selected-ink/40 [&::-webkit-details-marker]:hidden ${density === 'compact' ? 'py-1' : 'py-2'}`}
      >
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink/[0.05] text-ink-soft">
          <Plug size={14} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`flex min-w-0 items-baseline ${phone ? 'justify-between gap-2' : 'gap-2'}`}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[13px] font-medium text-ink">{displayName}</span>
              {provider.label !== undefined && provider.label !== provider.id ? (
                <span className="hidden truncate font-mono text-[11px] text-ink-faint sm:inline">{provider.id}</span>
              ) : null}
            </span>
            {phone ? statusBadge : null}
          </span>
          {density === 'compact' ? null : (
            <span className="block truncate text-[12px] text-ink-faint">
              {t('st.connections.kind.plugin')}
              {!phone && plugin.account_summary ? (
                <> · <span data-plugin-provider-account className="text-ink-soft">{plugin.account_summary}</span></>
              ) : null}
              {' · '}<span className="tabular-nums">{t('st.connections.modelCount', { count: effectiveModelCount })}</span>
              {!phone && plugin.status_text ? (
                <> · <span data-plugin-provider-detail>{plugin.status_text}</span></>
              ) : null}
            </span>
          )}
        </span>
        {phone ? null : statusBadge}
        {phone ? null : actionLink}
        <DisclosureChevron open={open} className="shrink-0 text-ink-faint" />
      </summary>
      <div className="space-y-3 px-3 pb-4 pt-1 sm:pl-[3.25rem]">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-faint">
          <span className="min-w-0">
            {t('st.connections.plugin.providedBy')}
            <Link
              to={`/settings/plugins?plugin=${encodeURIComponent(plugin.plugin_id)}`}
              className="font-mono text-ink-soft hover:text-ink hover:underline"
            >
              {plugin.plugin_id}
            </Link>
            {phone && plugin.account_summary ? (
              <> · <span data-plugin-provider-account className="text-ink-soft">{plugin.account_summary}</span></>
            ) : null}
            {phone && plugin.status_text ? (
              <> · <span data-plugin-provider-detail>{plugin.status_text}</span></>
            ) : null}
          </span>
          {phone ? actionLink : null}
        </div>
        {models.length > 0 ? (
          <PluginModelList providerId={provider.id} models={models} density={density} />
        ) : (
          <p className="text-[12px] text-ink-faint">
            {plugin.readiness === 'auth_required'
              ? t('st.connections.plugin.emptyAuthRequired')
              : t('st.connections.plugin.emptyReady')}
          </p>
        )}
      </div>
    </details>
  );
}
