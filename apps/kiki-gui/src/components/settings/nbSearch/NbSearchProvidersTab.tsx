import { useMemo, useState } from 'react';
import type { NbSearchCapabilities, NbSearchManagedCredentialView } from '@kiki/protocol';
import { NbSearchCredentialEditor } from './NbSearchCredentialEditor';
import { nbSearchIssueCodes, type NbSearchProviderDraft } from '@kiki/session-core/settings';
import { SectionCard } from '../SectionCard';
import { Hint, Toggle } from '../../controls';
import { useI18n } from '../../../i18n';
import { NbSearchIssues } from './NbSearchIssues';
import { INPUT } from '../../ui';
import { LIST_ROW_HEIGHT, ListBody, ListEmpty, ListToolbar, useListView, type ListDensity, type ListFilterSpec, type ListSortSpec } from '../list';

type ProviderInstance = NbSearchCapabilities['providers']['instances'][number];

function AvailabilityBadge({ availability }: { availability: 'ready' | 'unavailable' }) {
  const { t } = useI18n();
  return (
    <span
      className={`rounded-full border px-1.5 py-px text-[11px] font-medium shrink-0 ${
        availability === 'ready'
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-danger/40 bg-danger/5 text-danger'
      }`}
    >
      {availability === 'ready'
        ? t('st.nbSearch.availabilityReady')
        : t('st.nbSearch.availabilityUnavailable')}
    </span>
  );
}

function FieldError({ text }: { text: string | null }) {
  if (text === null) return null;
  return <p role="alert" data-field-issue className="mt-1 text-[12px] leading-4 text-danger">{text}</p>;
}

function ProviderInstanceCard({
  instance,
  descriptor,
  providerDraft,
  credentialEnv,
  onChange,
  onCredentialEnvChange,
  readCredential,
  writeCredential,
  credentialDisabled,
  density,
}: {
  instance: NbSearchCapabilities['providers']['instances'][number];
  descriptor: NbSearchCapabilities['providers']['descriptors'][number] | undefined;
  providerDraft: NbSearchProviderDraft;
  credentialEnv: string;
  onChange: (patch: Partial<NbSearchProviderDraft>) => void;
  onCredentialEnvChange: (credentialEnv: string) => void;
  readCredential: (id: string, reveal: boolean) => Promise<NbSearchManagedCredentialView>;
  writeCredential: (id: string, value: string | null, version: string, binding: string) => Promise<NbSearchManagedCredentialView>;
  credentialDisabled: boolean;
  density: ListDensity;
}) {
  const { t } = useI18n();
  const compact = density === 'compact';
  const attention = instance.availability === 'unavailable' || instance.issues.length > 0;
  const [open, setOpen] = useState(attention);
  const needsCredential = instance.credential.requirement !== 'none';
  const needsEndpoint =
    instance.endpoint.requirement === 'required' || instance.endpoint.requirement === 'optional';
  const showOptions = (descriptor?.option_keys.length ?? 0) > 0;
  const credentialPlaceholder = `NB_SEARCH_${instance.provider_id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

  // Field-level validation mirrors the save-time checks so mistakes surface
  // next to the field instead of only in the sticky bar after a failed save.
  const baseUrlTrimmed = providerDraft.baseUrl.trim();
  const baseUrlError =
    baseUrlTrimmed !== '' && !/^https?:\/\//i.test(baseUrlTrimmed)
      ? t('st.nbSearch.providers.baseUrlInvalid')
      : null;
  const optionsText = providerDraft.optionsJson.trim();
  const optionsError = useMemo(() => {
    if (optionsText === '') return null;
    try {
      const parsed: unknown = JSON.parse(optionsText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return t('st.nbSearch.providers.optionsInvalid');
      }
      return null;
    } catch {
      return t('st.nbSearch.providers.optionsInvalid');
    }
  }, [optionsText, t]);

  const credentialSummaryKey =
    instance.credential.requirement === 'none'
      ? 'st.nbSearch.credentialNone'
      : instance.credential.configured
        ? 'st.nbSearch.credentialConfigured'
        : instance.credential.requirement === 'unknown'
          ? 'st.nbSearch.credentialRequired'
          : 'st.nbSearch.credentialMissing';
  const credentialSummaryClass =
    instance.credential.requirement === 'none'
      ? 'text-ink-faint'
      : instance.credential.configured
        ? 'text-success'
        : 'text-amber-ink';
  const endpointSummaryKey =
    instance.endpoint.requirement === 'none'
      ? 'st.nbSearch.endpointNone'
      : instance.endpoint.configured
        ? 'st.nbSearch.endpointConfigured'
        : instance.endpoint.requirement === 'required'
          ? 'st.nbSearch.endpointMissing'
          : 'st.nbSearch.endpointOptional';
  const endpointSummaryClass =
    instance.endpoint.requirement === 'none'
      ? 'text-ink-faint'
      : instance.endpoint.configured
        ? 'text-success'
        : instance.endpoint.requirement === 'required'
          ? 'text-amber-ink'
          : 'text-ink-faint';

  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
      className="group/nb px-3"
    >
      <summary style={{ minHeight: LIST_ROW_HEIGHT[density] }}
        className={`flex cursor-pointer flex-wrap items-center justify-between gap-2 select-none ${compact ? 'py-1' : 'py-2'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12.5px] font-semibold text-ink">{instance.id}</span>
          <AvailabilityBadge availability={instance.availability} />
          {!providerDraft.enabled ? (
            <span className="rounded bg-hairline/40 px-1.5 py-0.5 text-[11px] font-medium text-ink-soft">
              {t('st.nbSearch.providers.disabledBadge')}
            </span>
          ) : null}
          {attention ? (
            <span className="rounded bg-amber-card border border-amber-rule/40 px-1.5 py-0.5 text-[11px] font-medium text-amber-ink">
              {t('st.nbSearch.providers.attentionBadge')}
            </span>
          ) : null}
        </div>

        {compact ? null : (
          <span className="text-[12px]">
            <span className={credentialSummaryClass}>{t(credentialSummaryKey)}</span>
            <span className="text-ink-faint">{' · '}</span>
            <span className={endpointSummaryClass}>{t(endpointSummaryKey)}</span>
          </span>
        )}
      </summary>

      <div className="mt-3 space-y-3 border-t border-hairline pt-3">
        <Toggle
          label={t('st.nbSearch.enabled')}
          checked={providerDraft.enabled}
          onChange={(enabled) => {
            onChange({ enabled });
          }}
        />

        <NbSearchIssues issues={nbSearchIssueCodes(instance.issues)} />

        {needsCredential ? (
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-ink-soft">
              {t('st.nbSearch.credentialEnvLabel')}
              <input
                className={`${INPUT} mt-1 font-mono`}
                value={credentialEnv}
                placeholder={credentialPlaceholder}
                onChange={(event) => { onCredentialEnvChange(event.target.value); }}
              />
              <Hint>{t('st.nbSearch.credentialEnvHint')}</Hint>
            </label>
            <NbSearchCredentialEditor instanceId={instance.id} disabled={credentialDisabled} read={readCredential} write={writeCredential} />
          </div>
        ) : null}

        {needsEndpoint ? (
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.nbSearch.baseUrlLabel')}
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={providerDraft.baseUrl}
              placeholder="https://"
              onChange={(event) => {
                onChange({ baseUrl: event.target.value });
              }}
            />
            <FieldError text={baseUrlError} />
          </label>
        ) : null}

        {showOptions ? (
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.nbSearch.optionsLabel')}
            <textarea
              className={`${INPUT} mt-1 min-h-16 font-mono text-[11.5px]`}
              value={providerDraft.optionsJson}
              placeholder="{}"
              onChange={(event) => {
                onChange({ optionsJson: event.target.value });
              }}
            />
            <FieldError text={optionsError} />
            {optionsError === null ? (
              <Hint>{t('st.nbSearch.optionsHint', { keys: descriptor?.option_keys.join(', ') ?? '' })}</Hint>
            ) : null}
          </label>
        ) : null}
      </div>
    </details>
  );
}

export function NbSearchProvidersTab({
  capabilities,
  draftProviders,
  credentialSlots,
  onUpdateProvider,
  onUpdateCredentialEnv,
  readCredential,
  writeCredential,
  credentialDisabled,
  saving = false,
}: {
  capabilities: NbSearchCapabilities;
  draftProviders: Record<string, NbSearchProviderDraft>;
  credentialSlots: unknown;
  onUpdateProvider: (id: string, patch: Partial<NbSearchProviderDraft>) => void;
  onUpdateCredentialEnv: (instanceId: string, providerId: string, credentialEnv: string) => void;
  readCredential: (id: string, reveal: boolean) => Promise<NbSearchManagedCredentialView>;
  writeCredential: (id: string, value: string | null, version: string, binding: string) => Promise<NbSearchManagedCredentialView>;
  credentialDisabled: boolean;
  saving?: boolean;
}) {
  const { t } = useI18n();

  const descriptorByProvider = useMemo(
    () => new Map(capabilities.providers.descriptors.map((d) => [d.provider_id, d])),
    [capabilities.providers.descriptors],
  );

  const instances = useMemo(() => {
    return capabilities.providers.instances.toSorted((a, b) => {
      if (a.availability === b.availability) {
        return a.id.localeCompare(b.id);
      }
      return a.availability === 'ready' ? 1 : -1;
    });
  }, [capabilities.providers.instances]);

  const needsAttention = (instance: ProviderInstance) => instance.availability === 'unavailable' || instance.issues.length > 0;
  const keyOf = (instance: ProviderInstance) => instance.id;
  const textOf = (instance: ProviderInstance) => [instance.id, instance.provider_id];
  const filters = useMemo<readonly ListFilterSpec<ProviderInstance>[]>(() => [
    { id: 'attention', label: t('st.nbSearch.filter.attention'), tone: 'attention', test: needsAttention },
    { id: 'ready', label: t('st.nbSearch.filter.ready'), test: (instance) => !needsAttention(instance) },
  ], [t]);
  const sorts = useMemo<readonly ListSortSpec<ProviderInstance>[]>(() => [
    { id: 'order', label: t('st.list.sort.order'), compare: () => 0 },
    { id: 'name', label: t('st.list.sort.name'), compare: (a, b) => a.id.localeCompare(b.id) },
  ], [t]);
  const view = useListView({ listId: 'nbsearch-providers', items: instances, keyOf, textOf, filters, sorts });

  const getCredentialEnv = (instanceId: string) => {
    const pDraft = draftProviders[instanceId];
    if (!pDraft) return '';
    const slots = (credentialSlots as Record<string, { env?: string } | null>) ?? {};
    return slots[pDraft.credentialSlotId]?.env ?? '';
  };

  return (
    <SectionCard id="st-card-search-providers" title={t('st.nbSearch.providersTitle')}>
      <div className="space-y-3">
        <Hint>{t('st.nbSearch.providersHint')}</Hint>

        <ListToolbar view={view} total={instances.length} filters={filters} sorts={sorts}
          searchLabel={t('st.nbSearch.providers.search')} searchPlaceholder={t('st.nbSearch.providers.filterPlaceholder')} />

        <fieldset disabled={saving} className="disabled:opacity-60">
          {view.visible.length === 0 ? (
            <ListEmpty kind="no-match" title={t('st.nbSearch.providers.noMatchTitle')} body={t('st.nbSearch.providers.emptyFilter')}
              onClear={view.clear} />
          ) : (
            <ListBody items={view.visible} keyOf={keyOf} density={view.density} label={t('st.nbSearch.providersTitle')}
              virtualizeAfter={Number.POSITIVE_INFINITY}
              renderRow={(instance) => (
                <ProviderInstanceCard
                  instance={instance}
                  descriptor={descriptorByProvider.get(instance.provider_id)}
                  providerDraft={draftProviders[instance.id]!}
                  credentialEnv={getCredentialEnv(instance.id)}
                  onChange={(patch) => {
                    onUpdateProvider(instance.id, patch);
                  }}
                  onCredentialEnvChange={(env) => {
                    onUpdateCredentialEnv(instance.id, instance.provider_id, env);
                  }}
                  readCredential={readCredential}
                  writeCredential={writeCredential}
                  credentialDisabled={credentialDisabled}
                  density={view.density}
                />
              )} />
          )}
        </fieldset>
      </div>
    </SectionCard>
  );
}
