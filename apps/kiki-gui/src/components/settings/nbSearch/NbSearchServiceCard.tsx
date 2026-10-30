/**
 * One service, one row. The collapsed row answers "is this working and is it
 * the default" — name, 默认 tag, facts line, a status word with a dot, the
 * enable switch and the chevron. The body answers "paste the key, make it the
 * default": keys first, then one 高级 fold (read source, key status, order and
 * cache, options), and a quiet footer line with 设为默认 / 移除此服务.
 *
 * The row never picks the default by being clicked — the click model the
 * settings pass settled on: row opens, an explicit 设为默认 button defaults.
 * Everything the card writes lands in the page's single draft and commits
 * with the page save; nothing here talks to the server except the on-demand
 * credential reads the key editor already owns.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { NbSearchCapabilities, NbSearchKeyUsageView, NbSearchManagedCredentialView } from '@kiki/protocol';
import { setNbSearchCredentialEnv, type NbSearchDraft } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Hint, Toggle } from '../../controls';
import { SECONDARY_BUTTON } from '../../ui';
import { ConfirmDialog } from '../../ConfirmDialog';
import { ExternalLink } from '../../../host/ExternalLink';
import { AdvancedDetails, SettingField } from '../fields';
import { FieldIssue, SettingsSelect } from '../SettingsPrimitives';
import { RowFrame } from '../RowFrame';
import { Tag } from '../../capabilities/primitives';
import { NbSearchMultiKeyEditor, type KeyDraft } from './NbSearchMultiKeyEditor';
import { NbSearchKeyUsagePanel } from './NbSearchKeyUsagePanel';
import { costLabelKey, latencyLabelKey, providerKeyUrl, type ServiceCard } from './types';
import {
  balanceTtlIssue,
  baseUrlIssue,
  optionsIssue,
} from './fieldIssues';
import {
  cardProviderInfo,
  laneProfiles,
  setServiceEnabled,
  type CardProviderInfo,
} from './serviceCards';

/** Card facts for a provider instance the user configured directly (no lane needed). */
function instanceInfo(
  capabilities: NbSearchCapabilities,
  draft: NbSearchDraft,
  instanceId: string,
): CardProviderInfo | null {
  const instance = capabilities.providers.instances.find((candidate) => candidate.id === instanceId);
  if (instance !== undefined) {
    const descriptor = capabilities.providers.descriptors.find((candidate) => candidate.provider_id === instance.provider_id);
    const draftProvider = draft.providers[instanceId];
    return {
      providerId: instance.provider_id,
      instanceId,
      enabled: draftProvider?.enabled ?? instance.enabled,
      credentialRequirement: (descriptor?.activation.credential ?? instance.credential.requirement) as CardProviderInfo['credentialRequirement'],
      needsEndpoint: (descriptor?.activation.endpoint ?? instance.endpoint.requirement) !== 'none',
      hasOptions: (descriptor?.option_keys.length ?? 0) > 0,
    };
  }
  // An instance this draft created: the server has not reported it yet, so
  // the descriptor answers the provider questions and the draft the rest.
  const draftProvider = draft.providers[instanceId];
  if (draftProvider === undefined || draftProvider.isDeleted === true || draftProvider.providerId === undefined) return null;
  const descriptor = capabilities.providers.descriptors.find((candidate) => candidate.provider_id === draftProvider.providerId);
  return {
    providerId: draftProvider.providerId,
    instanceId,
    enabled: draftProvider.enabled,
    credentialRequirement: (descriptor?.activation.credential ?? 'required') as CardProviderInfo['credentialRequirement'],
    needsEndpoint: (descriptor?.activation.endpoint ?? 'none') !== 'none',
    hasOptions: (descriptor?.option_keys.length ?? 0) > 0,
  };
}

type ProviderInstance = NbSearchCapabilities['providers']['instances'][number];
type ReadCredential = (instanceId: string, reveal: boolean) => Promise<NbSearchManagedCredentialView>;
type ReadKeyUsage = (instanceId: string, refresh: boolean) => Promise<NbSearchKeyUsageView>;
type KeyStrategyChoice = 'default' | 'round-robin' | 'priority';

export interface NbSearchServiceCardProps {
  card: ServiceCard;
  /** `lane` for a search method, `pipeline` for a fetch step, `instance` for a provider the user configured without a lane. */
  kind: 'lane' | 'pipeline' | 'instance';
  /** The provider instance this card edits; required for `kind === 'instance'`. */
  instanceId?: string;
  capabilities: NbSearchCapabilities;
  draft: NbSearchDraft;
  onChange: (next: NbSearchDraft) => void;
  keyDraft: KeyDraft;
  onKeyDraftChange: (draft: KeyDraft) => void;
  readCredential: ReadCredential;
  readKeyUsage: ReadKeyUsage;
  saving: boolean;
  /** Whether this card's lane is the default search method, when applicable. */
  defaultState?: 'default' | 'inherit' | 'none';
  onMakeDefault?: () => void;
  /** Chain position controls, on the fetch tab. */
  chain?: {
    readonly position: number;
    readonly length: number;
    readonly onMove: (delta: -1 | 1) => void;
    readonly onRemove: () => void;
  };
  /** 移除 service, when the page offers it for this card. */
  onRemoveService?: () => void;
  removeTitle?: string;
  /** Extra body content (advanced method editors on the search tab). */
  children?: ReactNode;
  /** Open from the start — a card that needs attention opens itself. */
  defaultOpen?: boolean;
  /** Controlled open state for a single-open list: when set, the parent decides which row is open. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function serviceCardState(
  info: CardProviderInfo | null,
  instance: ProviderInstance | undefined,
): { key: 'ready' | 'needsKey' | 'off' | 'unavailable'; className: string } {
  if (info !== null && !info.enabled) return { key: 'off', className: 'text-ink-faint' };
  // An instance the server has not reported yet (this draft created it) has no
  // credential state either — a required key is by definition not configured.
  if (info !== null && info.credentialRequirement !== 'none' && (instance === undefined || !instance.credential.configured)) {
    return { key: 'needsKey', className: 'text-amber-ink' };
  }
  if (instance !== undefined && instance.availability !== 'ready') return { key: 'unavailable', className: 'text-ink-faint' };
  return { key: 'ready', className: 'text-ink-soft' };
}

export function NbSearchServiceCard({
  card,
  kind,
  instanceId,
  capabilities,
  draft,
  onChange,
  keyDraft,
  onKeyDraftChange,
  readCredential,
  readKeyUsage,
  saving,
  defaultState = 'none',
  onMakeDefault,
  chain,
  onRemoveService,
  removeTitle,
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
}: NbSearchServiceCardProps) {
  const { t } = useI18n();
  const profiles = useMemo(() => laneProfiles(capabilities, draft), [capabilities, draft]);
  const info = useMemo(
    () => kind === 'instance'
      ? instanceInfo(capabilities, draft, instanceId ?? '')
      : cardProviderInfo(capabilities, draft, profiles, kind, card.id),
    [capabilities, draft, profiles, kind, card.id, instanceId],
  );
  const instance = capabilities.providers.instances.find((candidate) => candidate.id === info?.instanceId);

  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  // A row opens only on click (or a deep link the parent maps to `open`); a
  // missing key shows as the amber 缺少密钥 word on the collapsed row, never
  // as an auto-opened form. Single-open lives in the list.
  const open = controlledOpen ?? uncontrolledOpen;

  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next;
    setUncontrolledOpen(value);
    onOpenChange?.(value);
  };

  const editableInstanceId = info?.instanceId;
  const providerDraft = editableInstanceId === undefined ? undefined : draft.providers[editableInstanceId];
  const credentialSlots = (draft.credentialSlots ?? {}) as Record<string, { env?: string } | null>;
  const credentialEnv = providerDraft === undefined
    ? ''
    : credentialSlots[providerDraft.credentialSlotId]?.env ?? '';

  // The key editor reads its own slot for the source line; the card must not
  // guess "managed" from availability flags.
  const [credentialSource, setCredentialSource] = useState<{ source: import('@kiki/protocol').SecretSource; envName?: string }>({ source: 'none' });
  const credentialInstanceId = editableInstanceId;
  useEffect(() => {
    if (credentialInstanceId === undefined || info?.credentialRequirement === 'none') return undefined;
    let live = true;
    setCredentialSource({ source: 'none' });
    void readCredential(credentialInstanceId, false).then((view) => {
      if (live) {
        setCredentialSource({
          source: view.source === 'managed' ? 'kiki' : view.source,
          envName: view.env_name,
        });
      }
    }, () => undefined);
    return () => { live = false; };
  }, [credentialInstanceId, info?.credentialRequirement, readCredential]);

  const state = serviceCardState(info, instance);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [envTouched, setEnvTouched] = useState(false);

  const baseUrlProblem = useMemo(
    () => baseUrlIssue(t, providerDraft?.baseUrl ?? ''),
    [t, providerDraft?.baseUrl],
  );
  const ttlProblem = useMemo(
    () => balanceTtlIssue(t, providerDraft?.balanceTtlMs ?? ''),
    [t, providerDraft?.balanceTtlMs],
  );
  const optionsProblem = useMemo(
    () => optionsIssue(t, providerDraft?.optionsJson ?? ''),
    [t, providerDraft?.optionsJson],
  );
  const envTrimmed = credentialEnv.trim();
  const envProblem = envTouched && envTrimmed !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envTrimmed)
    ? t('st.nbSearch.service.credentialEnvInvalid')
    : null;
  const credentialPlaceholder = info === null
    ? ''
    : `NB_SEARCH_${info.providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

  const patchProvider = (patch: Partial<NonNullable<typeof providerDraft>>) => {
    if (editableInstanceId === undefined || info === null) return;
    const current = draft.providers[editableInstanceId] ?? {
      providerId: info.providerId,
      enabled: true,
      baseUrl: '',
      credentialSlotId: editableInstanceId,
      credentialSlotExplicit: false,
      optionsJson: '',
      isNew: true,
      isDeleted: false,
    };
    onChange({
      ...draft,
      providers: { ...draft.providers, [editableInstanceId]: { ...current, ...patch, isDeleted: false } },
    });
  };

  const strategyValue: KeyStrategyChoice = providerDraft?.keyStrategy ?? 'default';
  const latencyKey = card.latency === undefined ? undefined : latencyLabelKey(card.latency);
  const costKey = card.cost === undefined ? undefined : costLabelKey(card.cost);
  const tiers = [
    latencyKey === undefined ? card.latency : t(latencyKey),
    costKey === undefined ? card.cost : t(costKey),
  ].filter((part): part is string => part !== undefined);

  const showMakeDefault = onMakeDefault !== undefined && defaultState === 'none';
  const footer = showMakeDefault || onRemoveService !== undefined ? (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1" data-nb-search-service-footer>
      {showMakeDefault ? (
        <button
          type="button"
          className="text-[12px] font-medium text-selected-ink transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          disabled={saving}
          data-nb-search-service-make-default={card.id}
          onClick={onMakeDefault}
        >
          {t('st.nbSearch.services.makeDefault')}
        </button>
      ) : null}
      {onRemoveService !== undefined ? (
        <button
          type="button"
          className="text-[12px] font-medium text-danger transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          disabled={saving}
          data-nb-search-service-remove
          onClick={() => { setConfirmRemove(true); }}
        >
          {t('st.nbSearch.services.removeService')}
        </button>
      ) : null}
    </div>
  ) : null;

  const keyUrl = info !== null && info.credentialRequirement !== 'none'
    ? providerKeyUrl(info.providerId)
    : undefined;

  const body = open ? (
    <div className="space-y-3" data-nb-search-service-body={card.id}>
      {keyUrl !== undefined ? (
        <p className="text-[12px] leading-snug text-ink-soft" data-nb-search-key-guide>
          {t('st.nbSearch.service.keyGuide')}{' '}
          <ExternalLink href={keyUrl} className="font-medium text-selected-ink hover:underline">
            {t('st.nbSearch.service.keyGuideLink')}
          </ExternalLink>
        </p>
      ) : null}
      {info !== null && editableInstanceId !== undefined && info.credentialRequirement !== 'none' ? (
        <div className="space-y-2">
          <NbSearchMultiKeyEditor
            instanceId={editableInstanceId}
            source={credentialSource.source}
            envName={envTrimmed === '' ? credentialSource.envName : envTrimmed}
            draft={keyDraft}
            onChange={onKeyDraftChange}
            read={readCredential}
            disabled={saving}
          />
        </div>
      ) : null}

      {info !== null && editableInstanceId !== undefined ? (
        <AdvancedDetails summary={t('st.nbSearch.service.advancedSummary')} data-nb-search-service-advanced>
          <div className="space-y-3">
            {info.credentialRequirement !== 'none' ? (
              <div data-nb-search-credential-env-section>
                <SettingField
                  layout="stack"
                  label={t('st.nbSearch.credentialEnvLabel')}
                  htmlFor={`${editableInstanceId}-cred-env`}
                  help={t('st.nbSearch.service.credentialEnvHint')}
                >
                  <input
                    id={`${editableInstanceId}-cred-env`}
                    className="w-full rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-selected-ink disabled:cursor-not-allowed disabled:opacity-50"
                    value={credentialEnv}
                    placeholder={credentialPlaceholder}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={saving}
                    data-nb-search-credential-env
                    aria-invalid={envProblem !== null}
                    onChange={(event) => {
                      setEnvTouched(true);
                      onChange(setNbSearchCredentialEnv(draft, editableInstanceId!, info.providerId, event.target.value));
                    }}
                  />
                  <FieldIssue id={`${editableInstanceId}-cred-env-issue`} text={envProblem} />
                </SettingField>
              </div>
            ) : null}

            {info.credentialRequirement !== 'none' ? (
              <NbSearchKeyUsagePanel
                instanceId={editableInstanceId}
                readUsage={(refresh) => readKeyUsage(editableInstanceId!, refresh)}
              />
            ) : null}

            {info.needsEndpoint ? (
              <SettingField
                layout="stack"
                label={t('st.nbSearch.baseUrlLabel')}
                htmlFor={`${editableInstanceId}-base-url`}
                help={baseUrlProblem === null ? t('st.nbSearch.service.baseUrlHint') : undefined}
              >
                <input
                  id={`${editableInstanceId}-base-url`}
                  className="w-full rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-selected-ink disabled:cursor-not-allowed disabled:opacity-50"
                  value={providerDraft?.baseUrl ?? ''}
                  placeholder={t('st.nbSearch.service.baseUrlDefault')}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving}
                  data-nb-search-base-url
                  aria-invalid={baseUrlProblem !== null}
                  onChange={(event) => { patchProvider({ baseUrl: event.target.value }); }}
                />
                <FieldIssue id={`${editableInstanceId}-base-url-issue`} text={baseUrlProblem} />
              </SettingField>
            ) : null}

            <SettingField label={t('st.nbSearch.service.keyStrategy')} layout="row" help={t('st.nbSearch.service.keyStrategyHint')}>
              <SettingsSelect<KeyStrategyChoice>
                ariaLabel={t('st.nbSearch.service.keyStrategy')}
                dataAttr="data-nb-search-key-strategy"
                value={strategyValue}
                disabled={saving}
                choices={[
                  { value: 'default', label: t('st.nbSearch.service.keyStrategyInherit') },
                  { value: 'round-robin', label: t('st.nbSearch.service.keyStrategyRoundRobin') },
                  { value: 'priority', label: t('st.nbSearch.service.keyStrategyPriority') },
                ]}
                onChange={(next) => {
                  patchProvider({ keyStrategy: next === 'default' ? undefined : next });
                }}
              />
            </SettingField>

            <SettingField
              label={t('st.nbSearch.service.balanceTtl')}
              htmlFor={`${editableInstanceId}-balance-ttl`}
              help={t('st.nbSearch.service.balanceTtlHint')}
            >
              <input
                id={`${editableInstanceId}-balance-ttl`}
                className="w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-selected-ink disabled:cursor-not-allowed disabled:opacity-50"
                inputMode="numeric"
                value={providerDraft?.balanceTtlMs ?? ''}
                placeholder="60000"
                spellCheck={false}
                autoComplete="off"
                disabled={saving}
                data-nb-search-balance-ttl
                aria-invalid={ttlProblem !== null}
                onChange={(event) => { patchProvider({ balanceTtlMs: event.target.value }); }}
              />
              <FieldIssue id={`${editableInstanceId}-balance-ttl-issue`} text={ttlProblem} />
            </SettingField>

            {info.hasOptions ? (
              <label className="block text-[12px] font-medium text-ink-soft" data-nb-search-options>
                {t('st.nbSearch.optionsLabel')}
                <textarea
                  className="mt-1 min-h-16 w-full rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-faint focus:border-selected-ink disabled:cursor-not-allowed disabled:opacity-50"
                  value={providerDraft?.optionsJson ?? ''}
                  placeholder="{}"
                  spellCheck={false}
                  disabled={saving}
                  data-nb-search-options-json
                  onChange={(event) => { patchProvider({ optionsJson: event.target.value }); }}
                />
                <FieldIssue id={`${editableInstanceId}-options-issue`} text={optionsProblem} />
              </label>
            ) : null}
          </div>
        </AdvancedDetails>
      ) : null}

      {info !== null && info.credentialRequirement === 'none' ? (
        <Hint>{t('st.nbSearch.service.keylessHint')}</Hint>
      ) : null}

      {children}

      {footer}
    </div>
  ) : null;

  const cardBodyId = `nb-search-service-body-${card.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`;

  return (
    <>
      <RowFrame
        data={{
          'data-nb-search-service-card': card.id,
          'data-nb-search-service-kind': kind,
        }}
        open={open}
        onToggle={() => { setOpen((current) => !current); }}
        bodyId={cardBodyId}
        expandLabel={open ? t('st.nbSearch.custom.close') : t('st.nbSearch.services.openService', { name: card.title })}
        name={card.title}
        marks={(
          <span className="flex shrink-0 items-center gap-2">
            {defaultState === 'default' ? (
              <span data-nb-search-service-default><Tag tone="accent">{t('st.nbSearch.services.defaultBadge')}</Tag></span>
            ) : null}
            {defaultState === 'inherit' ? (
              <span className="text-[11px] text-ink-faint" data-nb-search-service-inherit>
                {t('st.nbSearch.services.inheritBadge')}
              </span>
            ) : null}
          </span>
        )}
        subtitle={(
          <>
            <span className="shrink-0">{card.subtitle}</span>
            {tiers.map((tier) => (
              <span key={tier} className="shrink-0">
                <span aria-hidden>· </span>{tier}
              </span>
            ))}
            <span className={`inline-flex shrink-0 items-center gap-1.5 ${state.className}`} data-nb-search-service-state={state.key}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${
                state.key === 'needsKey' ? 'bg-amber-rule'
                  : state.key === 'ready' ? 'bg-ink-soft'
                    : 'bg-hairline-strong'
              }`} />
              {t(state.key === 'ready'
                ? 'st.nbSearch.services.stateReady'
                : state.key === 'needsKey'
                  ? 'st.nbSearch.services.stateNeedsKey'
                  : 'st.nbSearch.services.stateUnavailable')}
            </span>
          </>
        )}
        control={(
          <>
            {chain !== undefined ? (
              <span className="flex items-center gap-0.5">
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={t('st.nbSearch.movePipelineUp', { n: chain.position + 1 })}
                  title={t('st.nbSearch.movePipelineUp', { n: chain.position + 1 })}
                  disabled={saving || chain.position === 0}
                  data-nb-search-fetch-up
                  onClick={() => { chain.onMove(-1); }}
                >
                  <span aria-hidden className="text-[11px]">↑</span>
                </button>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={t('st.nbSearch.movePipelineDown', { n: chain.position + 1 })}
                  title={t('st.nbSearch.movePipelineDown', { n: chain.position + 1 })}
                  disabled={saving || chain.position === chain.length - 1}
                  data-nb-search-fetch-down
                  onClick={() => { chain.onMove(1); }}
                >
                  <span aria-hidden className="text-[11px]">↓</span>
                </button>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={t('st.nbSearch.removePipeline', { n: chain.position + 1 })}
                  title={t('st.nbSearch.removePipeline', { n: chain.position + 1 })}
                  disabled={saving || chain.length === 1}
                  data-nb-search-fetch-remove
                  onClick={chain.onRemove}
                >
                  <span aria-hidden className="text-[12px]">×</span>
                </button>
              </span>
            ) : null}
            {info !== null && editableInstanceId !== undefined ? (
              <span data-nb-search-service-enabled={card.id} className="contents">
                <Toggle
                  layout="bare"
                  label={t('st.nbSearch.service.enabledLabel')}
                  checked={info.enabled}
                  disabled={saving}
                  onChange={(enabled) => {
                    onChange(setServiceEnabled(draft, editableInstanceId!, info.providerId, enabled));
                  }}
                />
              </span>
            ) : null}
          </>
        )}
      >
        {body}
      </RowFrame>

      {onRemoveService !== undefined ? (
        <ConfirmDialog
          open={confirmRemove}
          overlayId={`nb-search-remove-${card.id}`}
          title={removeTitle ?? t('st.nbSearch.services.removeServiceTitle', { name: card.title })}
          body={t('st.nbSearch.services.removeServiceBody')}
          confirmLabel={t('st.nbSearch.services.removeService')}
          onCancel={() => { setConfirmRemove(false); }}
          onConfirm={() => { setConfirmRemove(false); onRemoveService(); }}
        />
      ) : null}
    </>
  );
}
