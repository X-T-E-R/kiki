import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProviderCatalogItem } from '@kiki/protocol';
import type { OAuthMethodStatus } from '@kiki/klient';
import { isDecisionConnection, type AiSettingsTab } from '@kiki/session-core/settings';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { FeedbackLine, SavedTick, type Feedback } from '../controls';
import { ModelPicker } from '../ModelPicker';
import { isLocalBaseUrl } from '../providerPresets';
import { selectGlobalDefaultModel } from './defaultModelSelection';
import { LOADING_DELAY_MS, TEXT_BUTTON } from './SettingsPrimitives';
import { OriginBadge } from './spaces/OriginBadge';
import { useSavedTick } from './useSavedTick';

export function connectionNeedsAttention(
  provider: ProviderCatalogItem,
  method: OAuthMethodStatus | undefined,
): boolean {
  const needsKey = method === undefined && !isLocalBaseUrl(provider.base_url)
    && !provider.has_api_key && provider.api_key_env === undefined;
  return provider.status === 'error'
    || provider.status === 'unconfigured'
    || needsKey
    || (method !== undefined && method.signed_in && method.connection_state === 'reconnect_required');
}

/**
 * The status card above every tab of Models: states which model new
 * conversations use (with Change opening the shared ModelPicker) and how many
 * connections exist / need attention.
 */
export function DefaultModelBar({ tab: _tab }: { tab?: AiSettingsTab } = {}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();
  const [delayedLoading, setDelayedLoading] = useState(false);

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const providersQuery = useQuery({
    queryKey: ['providers'],
    queryFn: () => client.listProviders(),
    staleTime: 60_000,
    enabled: typeof client.listProviders === 'function',
  });
  const methodsQuery = useQuery({
    queryKey: OAUTH_METHODS_QUERY_KEY,
    queryFn: () => client.listOAuthMethods(),
    staleTime: 10_000,
    enabled: typeof client.listOAuthMethods === 'function',
  });

  const providersLoading = providersQuery.isLoading && typeof client.listProviders === 'function';
  useEffect(() => {
    if (!providersLoading) {
      setDelayedLoading(false);
      return;
    }
    const timer = setTimeout(() => { setDelayedLoading(true); }, LOADING_DELAY_MS);
    return () => { clearTimeout(timer); };
  }, [providersLoading]);

  const models = modelsQuery.data?.items ?? [];
  const config = configQuery.data;
  const defaultModel = config?.default_model ?? '';
  const current = models.find((item) => item.id === defaultModel);
  const methods = methodsQuery.data ?? [];

  const chatConnections = useMemo(
    () => (providersQuery.data?.items ?? []).filter((provider) => !isDecisionConnection(provider)),
    [providersQuery.data],
  );
  const attentionCount = useMemo(
    () => chatConnections.filter((provider) =>
      connectionNeedsAttention(provider, methods.find((method) => method.provider === provider.id))).length,
    [chatConnections, methods],
  );

  const pick = async (modelId: string) => {
    const item = models.find((candidate) => candidate.id === modelId);
    if (item === undefined) return;
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

  const providersLoaded = providersQuery.isSuccess;
  const emptyConnections = providersLoaded && chatConnections.length === 0 && models.length === 0;
  const modelLabel = current !== undefined
    ? (current.display_name ?? current.id)
    : defaultModel !== ''
      ? defaultModel
      : t('common.defaultUnknown');
  const defaultSentence = t('st.ai.status.default', { model: modelLabel });
  const comma = locale.startsWith('zh') ? '，' : ', ';
  const countLine = providersLoaded && chatConnections.length > 0
    ? `${tp('st.ai.status.count', chatConnections.length)}${attentionCount > 0 ? `${comma}${tp('st.ai.status.attention', attentionCount)}` : ''}`
    : null;

  return (
    <div
      data-default-model-bar
      data-default-model-line
      data-ai-status-card
      className="rounded-lg border border-hairline bg-panel px-4 py-3"
    >
      {emptyConnections ? (
        <p data-ai-status-empty className="text-[13px] leading-5 text-ink-soft">
          {t('st.ai.status.empty')}
        </p>
      ) : (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            <p className="min-w-0 text-[13.5px] font-medium text-ink" data-default-model-name>
              {defaultSentence}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <SavedTick show={tick} />
              <ModelPicker
                id="st-default-model"
                models={models}
                value={defaultModel}
                allowCustomValue={false}
                missing={false}
                disabled={busy || models.length === 0}
                onChange={(value) => { void pick(value); }}
                ariaLabel={`${t('st.decision.change')} · ${defaultSentence}`}
                searchPlaceholder={t('st.models.searchPlaceholder')}
                emptyText={t('st.models.noDefault')}
                align="end"
                hideChevron
                triggerLabel={t('st.decision.change')}
                buttonClassName={`inline-flex min-h-7 items-center px-1 pointer-coarse:min-h-11 ${TEXT_BUTTON}`}
              />
            </div>
          </div>
          {providersLoading && delayedLoading ? (
            <p role="status" data-ai-status-loading className="text-[12.5px] text-ink-faint">
              {t('st.ai.status.loading')}
            </p>
          ) : countLine !== null ? (
            <p data-ai-status-connections className={`text-[12.5px] ${attentionCount > 0 ? 'text-amber-ink' : 'text-ink-soft'}`}>
              {countLine}
            </p>
          ) : null}
        </div>
      )}
      <div className="pt-1 empty:hidden" data-default-origin="new-session">
        <OriginBadge config={config} domain="default_model" keyPath={[]} label={t('st.defaults.row.newSession')} />
      </div>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
