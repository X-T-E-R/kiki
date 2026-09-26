import { useMemo, useState } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import { nbSearchIssueCodes, type NbSearchProviderDraft } from '@kiki/session-core/settings';
import { SectionCard } from '../SectionCard';
import { Hint, Toggle } from '../../controls';
import { useI18n } from '../../../i18n';
import { NbSearchIssues } from './NbSearchIssues';
import { INPUT } from '../../ui';

function AvailabilityBadge({ availability }: { availability: 'ready' | 'unavailable' }) {
  const { t } = useI18n();
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide shrink-0 ${
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
  return <p role="alert" className="mt-1 text-[11px] text-danger">{text}</p>;
}

function ProviderInstanceCard({
  instance,
  descriptor,
  providerDraft,
  credentialEnv,
  onChange,
  onCredentialEnvChange,
}: {
  instance: NbSearchCapabilities['providers']['instances'][number];
  descriptor: NbSearchCapabilities['providers']['descriptors'][number] | undefined;
  providerDraft: NbSearchProviderDraft;
  credentialEnv: string;
  onChange: (patch: Partial<NbSearchProviderDraft>) => void;
  onCredentialEnvChange: (credentialEnv: string) => void;
}) {
  const { t } = useI18n();
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
      className={`rounded-lg border bg-paper px-3.5 py-2.5 transition-colors ${
        attention ? 'border-amber-rule/40' : 'border-hairline'
      }`}
    >
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 select-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12.5px] font-semibold text-ink">{instance.id}</span>
          <AvailabilityBadge availability={instance.availability} />
          {!providerDraft.enabled ? (
            <span className="rounded bg-hairline/40 px-1.5 py-0.5 text-[9.5px] font-medium text-ink-soft">
              {t('st.nbSearch.providers.disabledBadge')}
            </span>
          ) : null}
          {attention ? (
            <span className="rounded bg-amber-card border border-amber-rule/40 px-1.5 py-0.5 text-[9.5px] font-medium text-amber-ink">
              {t('st.nbSearch.providers.attentionBadge')}
            </span>
          ) : null}
        </div>

        <span className="text-[10.5px]">
          <span className={credentialSummaryClass}>{t(credentialSummaryKey)}</span>
          <span className="text-ink-faint">{' · '}</span>
          <span className={endpointSummaryClass}>{t(endpointSummaryKey)}</span>
        </span>
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
          <label className="block text-[11px] font-medium text-ink-soft">
            {t('st.nbSearch.credentialEnvLabel')}
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={credentialEnv}
              placeholder={credentialPlaceholder}
              onChange={(event) => {
                onCredentialEnvChange(event.target.value);
              }}
            />
            <Hint>{t('st.nbSearch.credentialEnvHint')}</Hint>
          </label>
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
  saving = false,
}: {
  capabilities: NbSearchCapabilities;
  draftProviders: Record<string, NbSearchProviderDraft>;
  credentialSlots: unknown;
  onUpdateProvider: (id: string, patch: Partial<NbSearchProviderDraft>) => void;
  onUpdateCredentialEnv: (instanceId: string, providerId: string, credentialEnv: string) => void;
  saving?: boolean;
}) {
  const { t } = useI18n();
  const [filterQuery, setFilterQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'attention' | 'configured'>('all');

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

  const totalCount = instances.length;
  const attentionCount = instances.filter(
    (i) => i.availability === 'unavailable' || i.issues.length > 0,
  ).length;
  const configuredCount = totalCount - attentionCount;

  const filteredInstances = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return instances.filter((instance) => {
      if (q && !instance.id.toLowerCase().includes(q) && !instance.provider_id.toLowerCase().includes(q)) {
        return false;
      }
      const needsAttention = instance.availability === 'unavailable' || instance.issues.length > 0;
      if (filterStatus === 'attention' && !needsAttention) return false;
      if (filterStatus === 'configured' && needsAttention) return false;
      return true;
    });
  }, [instances, filterQuery, filterStatus]);

  const getCredentialEnv = (instanceId: string) => {
    const pDraft = draftProviders[instanceId];
    if (!pDraft) return '';
    const slots = (credentialSlots as Record<string, { env?: string } | null>) ?? {};
    return slots[pDraft.credentialSlotId]?.env ?? '';
  };

  return (
    <SectionCard id="st-card-search-providers" title={t('st.nbSearch.providersTitle')}>
      <div className="space-y-4">
        <Hint>{t('st.nbSearch.providersHint')}</Hint>

        {/* Filter bar: text input & status pills */}
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="min-w-48 flex-1">
            <input
              type="search"
              value={filterQuery}
              onChange={(event) => {
                setFilterQuery(event.target.value);
              }}
              placeholder={t('st.nbSearch.providers.filterPlaceholder')}
              className={`${INPUT} py-1.5 text-[11.5px]`}
            />
          </div>

          <div className="flex items-center gap-1 text-[11px]">
            <button
              type="button"
              onClick={() => {
                setFilterStatus('all');
              }}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                filterStatus === 'all'
                  ? 'bg-ink text-paper font-semibold'
                  : 'bg-paper border border-hairline text-ink-soft hover:text-ink'
              }`}
            >
              {t('st.nbSearch.providers.filterAll', { count: totalCount })}
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterStatus('attention');
              }}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                filterStatus === 'attention'
                  ? 'bg-amber-ink text-paper font-semibold'
                  : 'bg-paper border border-hairline text-ink-soft hover:text-ink'
              }`}
            >
              {t('st.nbSearch.providers.filterNeedsAttention', { count: attentionCount })}
            </button>
            <button
              type="button"
              onClick={() => {
                setFilterStatus('configured');
              }}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                filterStatus === 'configured'
                  ? 'bg-ink text-paper font-semibold'
                  : 'bg-paper border border-hairline text-ink-soft hover:text-ink'
              }`}
            >
              {t('st.nbSearch.providers.filterConfigured', { count: configuredCount })}
            </button>
          </div>
        </div>

        <fieldset disabled={saving} className="space-y-2.5 disabled:opacity-60">
          {filteredInstances.map((instance) => (
            <ProviderInstanceCard
              key={instance.id}
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
            />
          ))}

          {filteredInstances.length === 0 ? (
            <p className="text-center text-[12px] text-ink-faint py-6 border border-dashed border-hairline rounded-lg">
              {t('st.nbSearch.providers.emptyFilter')}
            </p>
          ) : null}
        </fieldset>
      </div>
    </SectionCard>
  );
}
