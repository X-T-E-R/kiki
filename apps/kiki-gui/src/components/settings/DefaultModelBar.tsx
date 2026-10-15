import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AiSettingsTab } from '@kiki/session-core/settings';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { FeedbackLine, SavedTick, type Feedback } from '../controls';
import { useGuardedNavigate } from '../dirtyGuard';
import { Icon } from '../icons';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { vendorLabelFor } from '../providerPresets';
import { SearchableSelect } from '../SearchableSelect';
import { selectGlobalDefaultModel } from './defaultModelSelection';
import { OriginBadge } from './spaces/OriginBadge';
import { useSavedTick } from './useSavedTick';

const BAR_PICKER =
  'flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-md bg-ink/[0.05] px-2.5 text-left text-[13px] text-ink outline-none transition-colors hover:bg-ink/[0.08] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:text-ink-faint sm:w-[19rem]';

/**
 * The one statement of the new-session default model, above every tab of
 * Models & providers. It applies on pick through the same queue the star in
 * the model list uses, so a pick here and a star there land in order and the
 * screen always shows what the server saved.
 *
 * The second line is a glance at the other jobs' models and a way to them; it
 * is left out on the Defaults tab, where those rows are right underneath.
 */
export function DefaultModelBar({ tab }: { tab: AiSettingsTab }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const methodsQuery = useQuery({
    queryKey: OAUTH_METHODS_QUERY_KEY,
    queryFn: () => client.listOAuthMethods(),
    staleTime: 10_000,
    enabled: typeof client.listOAuthMethods === 'function',
  });

  const models = modelsQuery.data?.items ?? [];
  const config = configQuery.data;
  const defaultModel = config?.default_model ?? '';
  const options = useMemo(() => buildCatalogModelOptions(models, t), [models, t]);
  const current = models.find((item) => item.id === defaultModel);

  const connectionLabel = (providerId: string): string => {
    const account = (methodsQuery.data ?? []).find((method) => method.provider === providerId)?.label;
    const provider = (providersQuery.data?.items ?? []).find((item) => item.id === providerId);
    return account ?? vendorLabelFor(provider?.base_url) ?? providerId;
  };
  const modelName = (id: string | undefined): string | undefined => {
    if (id === undefined || id === '') return undefined;
    const item = models.find((candidate) => candidate.id === id);
    return item?.display_name ?? id;
  };

  const pick = async (modelId: string) => {
    const item = models.find((candidate) => candidate.id === modelId);
    if (item === undefined || item.id === defaultModel) return;
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

  const others = [
    { id: 'title', label: t('st.defaults.row.title'), value: modelName(config?.session_title?.model) },
    { id: 'fast', label: t('st.defaults.row.fast'), value: modelName(config?.fast_model) },
    { id: 'subagent', label: t('st.defaults.row.subagent'), value: modelName(config?.subagent?.defaultModel) },
  ];
  const toDefaults = () => { navigate('/settings/ai?tab=defaults#st-card-global-defaults'); };

  return (
    <div data-default-model-bar data-default-model-line
      className="sticky top-0 z-10 -mt-2 bg-paper/95 pb-3 pt-2 backdrop-blur-[2px] supports-[backdrop-filter]:bg-paper/85">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <label htmlFor="st-default-model" className="shrink-0 text-[13px] text-ink-soft">{t('st.models.newSessionsUse')}</label>
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1 sm:flex-none">
            <SearchableSelect
              id="st-default-model"
              value={defaultModel}
              options={options}
              onChange={(value) => void pick(value)}
              ariaLabel={t('st.defaults.row.newSession')}
              searchPlaceholder={t('st.models.searchPlaceholder')}
              emptyText={t('st.models.noDefault')}
              disabled={busy || models.length === 0}
              buttonClassName={BAR_PICKER}
              triggerIcon={<Icon name={current !== undefined ? 'starFilled' : 'star'} size={12}
                className={current !== undefined ? 'shrink-0 text-ink' : 'shrink-0 text-ink-faint'} />}
              triggerLabel={current !== undefined ? (
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span data-default-model-name className="truncate font-medium">{current.display_name ?? current.id}</span>
                  <span className="truncate text-[12px] text-ink-faint">{connectionLabel(current.provider_id)}</span>
                </span>
              ) : defaultModel !== '' ? defaultModel : undefined}
            />
          </div>
          <SavedTick show={tick} />
        </div>
        {tab === 'defaults' ? null : (
          <button type="button" data-default-model-others onClick={toDefaults}
            className="group -mx-1.5 flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1.5 text-left text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink sm:ml-auto">
            <span className="hidden min-w-0 truncate md:inline">
              {others.map((row, index) => (
                <span key={row.id} data-default-model-other={row.id}>
                  {index > 0 ? <span aria-hidden> · </span> : null}
                  {row.label} <span className={row.value === undefined ? '' : 'text-ink-soft'}>{row.value ?? t('st.defaults.row.fastUnset')}</span>
                </span>
              ))}
            </span>
            <span className="md:hidden">{t('st.ai.tab.defaults')}</span>
            <Icon name="chevron" size={12} className="shrink-0" />
          </button>
        )}
      </div>
      <div className="pt-1 empty:hidden" data-default-origin="new-session">
        <OriginBadge config={config} domain="default_model" keyPath={[]} label={t('st.defaults.row.newSession')} />
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
