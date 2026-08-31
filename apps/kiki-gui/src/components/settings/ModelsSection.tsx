import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ModelCatalogItem } from '@moonshot-ai/protocol';

import { useI18n } from '../../i18n';
import { errorText } from '../../i18n/locale';
import {
  requestIdentityLayerDraftFromPolicy,
  requestIdentityPolicyFromDraft,
  writeSettings,
  type RequestIdentityLayerDraft,
} from '../../lib/settings';
import { formatTokens } from '../../lib/time';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, SavedTick, Toggle, type Feedback } from '../controls';
import { useDirtyReporter } from '../dirtyGuard';
import { RequestIdentityLayerEditor } from '../RequestIdentityLayerEditor';
import { INPUT, PRIMARY_BUTTON, SMALL_INPUT } from '../ui';
import { SectionCard } from './SectionCard';
import { useSavedTick } from './useSavedTick';

function requestIdentityDraftsEqual(
  a: RequestIdentityLayerDraft,
  b: RequestIdentityLayerDraft,
): boolean {
  return a.requestIdentityChoice === b.requestIdentityChoice
    && a.requestIdentityOverridesJson === b.requestIdentityOverridesJson;
}

function GlobalRequestIdentityCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RequestIdentityLayerDraft>(() =>
    requestIdentityLayerDraftFromPolicy(undefined));
  const [baseline, setBaseline] = useState<RequestIdentityLayerDraft>(() =>
    requestIdentityLayerDraftFromPolicy(undefined));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const dirty = !requestIdentityDraftsEqual(draft, baseline);

  useEffect(() => {
    if (configQuery.data === undefined || dirty) return;
    const next = requestIdentityLayerDraftFromPolicy(configQuery.data.request_identity);
    setDraft(next);
    setBaseline(next);
  }, [configQuery.data, dirty]);

  useDirtyReporter('global-request-identity', dirty);

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const requestIdentity = requestIdentityPolicyFromDraft(draft);
      const echoed = await client.patchConfig({ request_identity: requestIdentity ?? null });
      queryClient.setQueryData(['config'], echoed);
      const next = requestIdentityLayerDraftFromPolicy(echoed.request_identity);
      setDraft(next);
      setBaseline(next);
      setFeedback({ tone: 'success', text: t('st.requestIdentity.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-request-identity" title={t('st.requestIdentity.defaultTitle')}>
      <div className="space-y-3">
        <RequestIdentityLayerEditor
          value={draft}
          onChange={setDraft}
          label={t('st.requestIdentity.defaultLabel')}
          inheritLabel={t('st.requestIdentity.inheritBuiltin')}
          hint={t('st.requestIdentity.defaultHint')}
        />
        <button type="button" className={PRIMARY_BUTTON} disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

export function ModelsSection() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [effort, setEffort] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tick, ping] = useSavedTick();
  const [modelQuery, setModelQuery] = useState('');

  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const items = modelsQuery.data?.items ?? [];
  const defaultModel = configQuery.data?.default_model;
  const defaultProvider = configQuery.data?.default_provider ?? '';
  const defaultItem = items.find((item) => item.model === defaultModel);
  const thinking = asRecord(configQuery.data?.thinking);

  const syncThinking = useCallback(() => {
    const configured = thinking?.['effort'];
    setThinkingEnabled(thinking?.['enabled'] !== false);
    setEffort(typeof configured === 'string' ? configured : (defaultItem?.default_effort ?? ''));
  }, [defaultItem?.default_effort, thinking]);

  useEffect(() => { syncThinking(); }, [syncThinking]);

  // Provider grouping: default provider's group first, default model first
  // inside its group; the search box filters by id, name, provider, or chip.
  const groups = useMemo(() => {
    const needle = modelQuery.trim().toLowerCase();
    const matched = needle === ''
      ? items
      : items.filter((item) =>
          item.model.toLowerCase().includes(needle)
          || (item.display_name ?? '').toLowerCase().includes(needle)
          || item.provider.toLowerCase().includes(needle)
          || (item.capabilities ?? []).some((capability) => capability.toLowerCase().includes(needle)));
    const byProvider = new Map<string, ModelCatalogItem[]>();
    for (const item of matched) {
      const list = byProvider.get(item.provider) ?? [];
      list.push(item);
      byProvider.set(item.provider, list);
    }
    return [...byProvider.entries()]
      .map(([provider, models]) => ({
        provider,
        models: models.toSorted((a, b) =>
          Number(b.model === defaultModel) - Number(a.model === defaultModel)
          || (a.display_name ?? a.model).localeCompare(b.display_name ?? b.model)),
      }))
      .toSorted((a, b) =>
        Number(b.provider === defaultProvider) - Number(a.provider === defaultProvider)
        || a.provider.localeCompare(b.provider));
  }, [items, modelQuery, defaultModel, defaultProvider]);

  const selectDefaultProvider = async (providerId: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ default_provider: providerId });
      queryClient.setQueryData(['config'], echoed);
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };

  // Starring a model carries its provider along as the default provider.
  const selectDefaultModel = async (item: ModelCatalogItem) => {
    setBusy(true);
    setFeedback(null);
    try {
      const echoed = await client.setDefaultModel(item.model);
      queryClient.setQueryData(['config'], (current: Record<string, unknown> | undefined) => ({
        ...current,
        default_model: echoed.default_model,
      }));
      writeSettings({ defaultModel: echoed.default_model });
      if (item.provider !== defaultProvider) {
        const echoedConfig = await client.patchConfig({ default_provider: item.provider });
        queryClient.setQueryData(['config'], echoedConfig);
      }
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(false);
    }
  };

  const saveThinking = async (enabled: boolean, nextEffort: string) => {
    setThinkingEnabled(enabled);
    setEffort(nextEffort);
    if (enabled && nextEffort.trim() === '') {
      setFeedback({ tone: 'error', text: t('st.thinking.emptyError') });
      syncThinking();
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ thinking: { enabled, effort: nextEffort.trim() || undefined } });
      queryClient.setQueryData(['config'], echoed);
      const echoedThinking = asRecord(echoed.thinking);
      const echoedEnabled = echoedThinking?.['enabled'] !== false;
      const echoedEffort = typeof echoedThinking?.['effort'] === 'string' ? echoedThinking['effort'] : nextEffort.trim();
      setThinkingEnabled(echoedEnabled);
      setEffort(echoedEffort);
      writeSettings({ defaultEffort: echoedEffort || undefined });
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      syncThinking();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard id="st-card-models" title={t('st.models.defaultTitle')}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] font-medium text-ink-soft">{t('st.models.providerLabel')}
              <select
                className={`${SMALL_INPUT} ml-2`}
                value={defaultProvider}
                disabled={busy}
                onChange={(event) => void selectDefaultProvider(event.target.value)}
              >
                {(providersQuery.data?.items ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
              </select>
            </label>
            <SavedTick show={tick} />
          </div>
          <input
            type="search"
            aria-label={t('st.models.searchAria')}
            placeholder={t('st.models.searchPlaceholder')}
            className={INPUT}
            value={modelQuery}
            onChange={(event) => { setModelQuery(event.target.value); }}
          />
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.provider}>
                <div className="mb-1.5 flex items-center gap-2">
                  <p className="font-mono text-[11px] font-semibold text-ink-soft">{group.provider}</p>
                  {group.provider === defaultProvider ? (
                    <span className="rounded-full border border-success/30 bg-success/10 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-success">{t('st.models.default')}</span>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  {group.models.map((item) => (
                    <ModelRow
                      key={item.model}
                      item={item}
                      isDefault={item.model === defaultModel}
                      busy={busy}
                      onSetDefault={() => void selectDefaultModel(item)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          {modelQuery.trim() !== '' && groups.length === 0 ? (
            <Hint>{t('st.models.searchEmpty', { query: modelQuery.trim() })}</Hint>
          ) : null}
          {modelsQuery.isLoading ? <Hint>{t('st.models.loading')}</Hint> : null}
          {modelsQuery.isError ? <InlineError error={modelsQuery.error} /> : null}
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      <GlobalRequestIdentityCard />

      <SectionCard id="st-card-thinking" title={t('st.thinking.title')}>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Toggle label={t('st.thinking.enable')} checked={thinkingEnabled} disabled={busy} onChange={(checked) => void saveThinking(checked, effort)} />
            <SavedTick show={tick} />
          </div>
          {defaultItem?.support_efforts !== undefined && defaultItem.support_efforts.length > 0 ? (
            <select
              className={SMALL_INPUT}
              value={effort}
              disabled={!thinkingEnabled || busy}
              onChange={(event) => void saveThinking(thinkingEnabled, event.target.value)}
            >
              {defaultItem.support_efforts.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          ) : (
            <input
              className={INPUT}
              value={effort}
              disabled={!thinkingEnabled || busy}
              onChange={(event) => { setEffort(event.target.value); }}
              onBlur={() => void saveThinking(thinkingEnabled, effort)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveThinking(thinkingEnabled, effort);
              }}
              placeholder={t('st.thinking.placeholder')}
            />
          )}
          <Hint>{t('st.thinking.hint')}</Hint>
          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>
    </div>
  );
}

function ModelRow({
  item,
  isDefault,
  busy,
  onSetDefault,
}: {
  item: ModelCatalogItem;
  isDefault: boolean;
  busy: boolean;
  onSetDefault: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
      <button
        type="button"
        onClick={onSetDefault}
        disabled={busy || isDefault}
        aria-label={t('st.models.starAria', { model: item.model })}
        title={isDefault ? t('st.models.starredTitle') : t('st.models.unstarredTitle')}
        className={`shrink-0 text-[15px] leading-none transition-colors disabled:cursor-default ${
          isDefault ? 'text-accent' : 'text-hairline-strong hover:text-accent'
        }`}
      >
        {isDefault ? '★' : '☆'}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">
          {item.display_name ?? item.model}
          {isDefault ? (
            <span className="ml-2 rounded-full border border-success/30 bg-success/10 px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-success">{t('st.models.default')}</span>
          ) : null}
        </p>
        <p className="truncate font-mono text-[10.5px] text-ink-faint">
          {item.model} · {formatTokens(item.max_context_size)} {t('st.models.context')}
        </p>
      </div>
      {item.capabilities !== undefined && item.capabilities.length > 0 ? (
        <div className="hidden shrink-0 flex-wrap justify-end gap-1 sm:flex">
          {item.capabilities.map((capability) => (
            <span key={capability} className="rounded-full border border-hairline bg-panel px-1.5 py-px text-[9.5px] text-ink-faint">{capability}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
