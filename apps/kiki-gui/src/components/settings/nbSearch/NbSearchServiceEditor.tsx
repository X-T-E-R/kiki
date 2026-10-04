/**
 * One search service, one editing surface.
 *
 * Address, keys and the advanced key-order settings belong to the same decision
 * — "point this service somewhere and give it a key" — so they live in one
 * place and commit with the page's single save. Nothing here is disabled
 * because an unrelated field on another tab is dirty. The variable a key may be
 * read from instead is reference for the case where the key is not the one Kiki
 * stores, so it sits behind the group's own disclosure.
 *
 * Layout follows the settings list→detail console: a header that names the
 * service the way a person reads it (id stays secondary), then flat groups
 * separated by hairlines.
 */

import { useEffect, useMemo, useState } from 'react';
import type { NbSearchCapabilities, NbSearchKeyUsageView, NbSearchManagedCredentialView, SecretSource } from '@kiki/protocol';
import type { NbSearchProviderDraft } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { Hint, Toggle } from '../../controls';
import { INPUT, DANGER_GHOST_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { ConfirmDialog } from '../../ConfirmDialog';
import { AdvancedDetails, SettingField, SettingsGroup } from '../fields';
import { FieldIssue, SettingsSelect } from '../SettingsPrimitives';
import { NbSearchMultiKeyEditor, type KeyDraft } from './NbSearchMultiKeyEditor';
import { NbSearchKeyUsagePanel } from './NbSearchKeyUsagePanel';
import { providerLabelKey, serviceState, serviceStateKey, SERVICE_STATE_CLASS, type ServiceState } from './types';

type ProviderInstance = NbSearchCapabilities['providers']['instances'][number];
type ProviderDescriptor = NbSearchCapabilities['providers']['descriptors'][number];
type ReadCredential = (instanceId: string, reveal: boolean) => Promise<NbSearchManagedCredentialView>;
type ReadKeyUsage = (instanceId: string, refresh: boolean) => Promise<NbSearchKeyUsageView>;

const BALANCE_TTL_MIN = 60_000;
const BALANCE_TTL_MAX = 86_400_000;

type KeyStrategyChoice = 'default' | 'round-robin' | 'priority';

/**
 * Where the saved key currently in effect comes from, for the field's source
 * line. When the value lives in the server environment, the server also names
 * the variable it read, which is more accurate than the draft's slot name.
 */
function useCredentialSource(instanceId: string, read: ReadCredential): { source: SecretSource; envName?: string } {
  const [view, setView] = useState<{ source: SecretSource; envName?: string }>({ source: 'none' });
  useEffect(() => {
    let live = true;
    setView({ source: 'none' });
    void read(instanceId, false).then((result) => {
      // The credential view says "managed"; the shared secret field calls that
      // source "kiki" so one line of copy covers the whole app.
      if (live) {
        setView({
          source: result.source === 'managed' ? 'kiki' : result.source,
          envName: result.env_name,
        });
      }
    }, () => {
      // An unreadable slot stays "none"; the field still lets a value be typed.
    });
    return () => { live = false; };
  }, [instanceId, read]);
  return view;
}

export function balanceTtlIssue(t: ReturnType<typeof useI18n>['t'], raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < BALANCE_TTL_MIN || value > BALANCE_TTL_MAX) {
    return t('st.nbSearch.service.balanceTtlInvalid');
  }
  return null;
}

export function baseUrlIssue(t: ReturnType<typeof useI18n>['t'], raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  return /^https?:\/\//i.test(text) ? null : t('st.nbSearch.providers.baseUrlInvalid');
}

export function optionsIssue(t: ReturnType<typeof useI18n>['t'], raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? null
      : t('st.nbSearch.providers.optionsInvalid');
  } catch {
    return t('st.nbSearch.providers.optionsInvalid');
  }
}

export function NbSearchServiceEditor({
  instance,
  descriptor,
  providerDraft,
  credentialEnv,
  keyDraft,
  saving,
  unsaved = false,
  onProviderChange,
  onCredentialEnvChange,
  onKeyDraftChange,
  onRemove,
  onBack,
  readCredential,
  readKeyUsage,
}: {
  instance: ProviderInstance;
  descriptor: ProviderDescriptor | undefined;
  providerDraft: NbSearchProviderDraft;
  credentialEnv: string;
  keyDraft: KeyDraft;
  saving: boolean;
  /** The instance exists only in this draft; the server has not reported it. */
  unsaved?: boolean;
  onProviderChange: (patch: Partial<NbSearchProviderDraft>) => void;
  onCredentialEnvChange: (env: string) => void;
  onKeyDraftChange: (draft: KeyDraft) => void;
  onRemove: () => void;
  onBack: () => void;
  readCredential: ReadCredential;
  /** On-demand key status; the panel asks only when the user does. */
  readKeyUsage?: ReadKeyUsage;
}) {
  const { t } = useI18n();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [envTouched, setEnvTouched] = useState(false);

  const labelKey = providerLabelKey(instance.provider_id);
  const name = labelKey === undefined ? instance.provider_id : t(labelKey);
  const state: ServiceState = serviceState(instance, providerDraft.enabled, { unsaved });
  const credential = useCredentialSource(instance.id, readCredential);

  const needsCredential = instance.credential.requirement !== 'none';
  const needsEndpoint = instance.endpoint.requirement === 'required' || instance.endpoint.requirement === 'optional';
  const optionKeys = descriptor?.option_keys ?? [];
  const hasOptions = optionKeys.length > 0;

  const baseUrlProblem = useMemo(() => baseUrlIssue(t, providerDraft.baseUrl), [t, providerDraft.baseUrl]);
  const ttlProblem = useMemo(() => balanceTtlIssue(t, providerDraft.balanceTtlMs ?? ''), [t, providerDraft.balanceTtlMs]);
  const optionsProblem = useMemo(() => optionsIssue(t, providerDraft.optionsJson), [t, providerDraft.optionsJson]);

  const envTrimmed = credentialEnv.trim();
  const envProblem = envTouched && envTrimmed !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envTrimmed)
    ? t('st.nbSearch.service.credentialEnvInvalid')
    : null;
  const credentialPlaceholder = `NB_SEARCH_${instance.provider_id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

  const strategyValue: KeyStrategyChoice = providerDraft.keyStrategy ?? 'default';

  return (
    <div className="min-w-0 space-y-5" data-nb-search-service={instance.id}>
      <div className="space-y-1.5">
        <button type="button" data-nb-search-service-back className={`${SECONDARY_BUTTON} md:hidden`} onClick={onBack}>
          <span className="inline-flex items-center gap-1">
            <Icon name="arrowLeft" size={12} />
            {t('st.nbSearch.services.backToList')}
          </span>
        </button>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="min-w-0 text-[15px] font-semibold text-ink">{name}</h3>
          <span className="font-mono text-[11px] text-ink-faint">{instance.id}</span>
          <span className={`text-[12px] ${SERVICE_STATE_CLASS[state]}`} data-nb-search-service-state={state}>
            {t(serviceStateKey(state))}
          </span>
        </div>
        <p className="text-[12px] text-ink-soft" data-nb-search-service-role>
          {describeService(t, descriptor, instance)}
        </p>
      </div>

      <SettingsGroup title={t('st.nbSearch.service.addressSection')}>
        <div className="space-y-1">
          <Toggle
            layout="row"
            label={t('st.nbSearch.service.enabledLabel')}
            checked={providerDraft.enabled}
            disabled={saving}
            onChange={(enabled) => { onProviderChange({ enabled }); }}
          />
          <Hint>{t('st.nbSearch.service.enabledHint')}</Hint>
        </div>

        {needsEndpoint ? (
          <SettingField
            layout="stack"
            label={t('st.nbSearch.baseUrlLabel')}
            htmlFor={`${instance.id}-base-url`}
          >
            <input
              id={`${instance.id}-base-url`}
              className={`${INPUT} font-mono`}
              value={providerDraft.baseUrl}
              placeholder={t('st.nbSearch.service.baseUrlDefault')}
              spellCheck={false}
              autoComplete="off"
              data-nb-search-base-url
              aria-invalid={baseUrlProblem !== null}
              onChange={(event) => { onProviderChange({ baseUrl: event.target.value }); }}
            />
            <FieldIssue id={`${instance.id}-base-url-issue`} text={baseUrlProblem} />
            {baseUrlProblem === null ? <Hint>{t('st.nbSearch.service.baseUrlHint')}</Hint> : null}
          </SettingField>
        ) : null}
      </SettingsGroup>

      {needsCredential ? (
        <SettingsGroup title={t('st.nbSearch.service.credentialSection')}>
          {/* Keys come first: pasting a key is the whole point of this group,
              and the rest of it is reference for the case where the key is read
              from somewhere else. */}
          <NbSearchMultiKeyEditor
            instanceId={instance.id}
            source={credential.source}
            envName={envTrimmed === '' ? credential.envName : envTrimmed}
            draft={keyDraft}
            onChange={onKeyDraftChange}
            read={readCredential}
            disabled={saving}
          />

          {/* The variable name only matters when the key is not the one Kiki
              stores, so it stays behind the on-demand disclosure the rest of
              settings uses for a field you read up on rather than fill in. */}
          <AdvancedDetails
            summary={t('st.nbSearch.service.credentialEnvAdvanced')}
            data-nb-search-credential-env-section
          >
            <SettingField
              layout="stack"
              label={t('st.nbSearch.credentialEnvLabel')}
              htmlFor={`${instance.id}-cred-env`}
              help={t('st.nbSearch.service.credentialEnvHint')}
            >
              <input
                id={`${instance.id}-cred-env`}
                className={`${INPUT} font-mono`}
                value={credentialEnv}
                placeholder={credentialPlaceholder}
                spellCheck={false}
                autoComplete="off"
                data-nb-search-credential-env
                aria-invalid={envProblem !== null}
                onChange={(event) => { setEnvTouched(true); onCredentialEnvChange(event.target.value); }}
              />
              <FieldIssue id={`${instance.id}-cred-env-issue`} text={envProblem} />
            </SettingField>
          </AdvancedDetails>
        </SettingsGroup>
      ) : (
        <SettingsGroup title={t('st.nbSearch.service.keysSection')}>
          <Hint>{t('st.nbSearch.service.keylessHint')}</Hint>
        </SettingsGroup>
      )}

      {/* On demand, and only on demand: the panel requests nothing until its
          button is pressed. A service that exists only in this draft has no
          server-side slot to read yet, so the group states that instead of
          offering a button that can only fail. */}
      {readKeyUsage === undefined ? null : (
        <SettingsGroup title={t('st.nbSearch.keyUsage.title')}>
          {unsaved ? (
            <Hint>{t('st.nbSearch.keyUsage.unsavedNote')}</Hint>
          ) : (
            <NbSearchKeyUsagePanel
              instanceId={instance.id}
              readUsage={(refresh) => readKeyUsage(instance.id, refresh)}
            />
          )}
        </SettingsGroup>
      )}

      <SettingsGroup title={t('st.nbSearch.service.advancedSection')} help={needsCredential ? t('st.nbSearch.service.keyStrategyHint') : undefined}>
        <SettingField label={t('st.nbSearch.service.keyStrategy')} layout="row">
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
              onProviderChange({ keyStrategy: next === 'default' ? undefined : next });
            }}
          />
        </SettingField>

        <SettingField
          label={t('st.nbSearch.service.balanceTtl')}
          htmlFor={`${instance.id}-balance-ttl`}
          help={t('st.nbSearch.service.balanceTtlHint')}
        >
          <input
            id={`${instance.id}-balance-ttl`}
            className={INPUT}
            inputMode="numeric"
            value={providerDraft.balanceTtlMs ?? ''}
            placeholder={String(BALANCE_TTL_MIN)}
            spellCheck={false}
            autoComplete="off"
            data-nb-search-balance-ttl
            aria-invalid={ttlProblem !== null}
            onChange={(event) => { onProviderChange({ balanceTtlMs: event.target.value }); }}
          />
        </SettingField>
        <FieldIssue id={`${instance.id}-balance-ttl-issue`} text={ttlProblem} />
      </SettingsGroup>

      {hasOptions ? (
        <AdvancedDetails summary={t('st.nbSearch.service.optionsSection')} data-nb-search-options>
          <label className="block text-[12px] font-medium text-ink-soft">
            {t('st.nbSearch.optionsLabel')}
            <textarea
              className={`${INPUT} mt-1 min-h-16 font-mono`}
              value={providerDraft.optionsJson}
              placeholder="{}"
              spellCheck={false}
              data-nb-search-options-json
              onChange={(event) => { onProviderChange({ optionsJson: event.target.value }); }}
            />
          </label>
          <FieldIssue id={`${instance.id}-options-issue`} text={optionsProblem} />
          {optionsProblem === null ? <Hint>{t('st.nbSearch.optionsHint', { keys: optionKeys.join(', ') })}</Hint> : null}
        </AdvancedDetails>
      ) : null}

      <div className="border-t border-hairline pt-3">
        <button type="button" className={DANGER_GHOST_BUTTON} disabled={saving}
          data-nb-search-service-remove onClick={() => { setConfirmRemove(true); }}>
          {t('st.nbSearch.service.remove')}
        </button>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        overlayId={`nb-search-remove-${instance.id}`}
        title={t('st.nbSearch.service.removeTitle', { name })}
        body={t('st.nbSearch.service.removeBody')}
        confirmLabel={t('st.nbSearch.service.removeConfirm')}
        onCancel={() => { setConfirmRemove(false); }}
        onConfirm={() => { setConfirmRemove(false); onRemove(); }}
      />
    </div>
  );
}

/**
 * One line on what the service can do, written from the descriptor rather than
 * from a hardcoded table, so a provider the engine adds still explains itself.
 * The key half reports the state the user can see, not the engine's
 * requirement: a configured service must never read "needs a key".
 */
function describeService(
  t: ReturnType<typeof useI18n>['t'],
  descriptor: ProviderDescriptor | undefined,
  instance: ProviderInstance,
): string {
  const searchOps = descriptor?.query_operations.length ?? 0;
  const fetchOps = descriptor?.fetch_operations.length ?? 0;
  const roles: string[] = [];
  if (searchOps > 0) roles.push(t('st.nbSearch.services.roleSearch'));
  if (fetchOps > 0) roles.push(t('st.nbSearch.services.roleFetch'));
  if (roles.length === 0) roles.push(t('st.nbSearch.services.roleUnknown'));
  const access = instance.credential.requirement === 'none'
    ? t('st.nbSearch.services.keyless')
    : instance.credential.configured
      ? t('st.nbSearch.services.keySaved')
      : t('st.nbSearch.services.needsKey');
  return `${roles.join(' · ')} · ${access}`;
}
