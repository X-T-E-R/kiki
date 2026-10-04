/**
 * Add a second service instance of a provider the engine already ships.
 *
 * The common path asks for two things a person can answer — which service, and
 * what to call this instance — and takes care of the rest: the credential slot,
 * the environment binding and the activation flags are derived by
 * `createNbSearchProviderInstance`, so a second Tavily account never inherits
 * the first one's key. The environment variable is a normal field, not a
 * prerequisite; it only moves into "Environment variable" and ships with a
 * working suggestion.
 *
 * Keys are not edited here. Once the instance exists it joins the services
 * list, where the same editing surface as every other service manages its keys.
 */

import { useMemo, useState } from 'react';
import type { NbSearchCapabilities } from '@kiki/protocol';
import { createNbSearchProviderInstance, type NbSearchDraft } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { Hint } from '../../controls';
import { Icon } from '../../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { ListEmpty, ListToolbar, useListView } from '../list';
import { AdvancedDetails } from '../fields';
import { FieldIssue, FORM_LABEL } from '../SettingsPrimitives';
import { providerLabelKey } from './types';
import { nbSearchProviderLabel } from './advancedSupport';

const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `tavily.collab` → `NB_SEARCH_TAVILY_COLLAB_API_KEY`, so two instances of one provider never share a key. */
export function suggestedCredentialEnv(instanceId: string): string {
  const stem = instanceId.replaceAll(/[^A-Za-z0-9]+/g, '_').replaceAll(/^_+|_+$/g, '').toUpperCase();
  return stem === '' ? '' : `NB_SEARCH_${stem}_API_KEY`;
}

function suggestedInstanceId(providerId: string, draft: NbSearchDraft): string {
  const base = `${providerId}.custom`;
  if (draft.providers[base] === undefined) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${providerId}.custom-${suffix}`;
    if (draft.providers[candidate] === undefined) return candidate;
  }
  return `${providerId}.custom`;
}

type Descriptor = NbSearchCapabilities['providers']['descriptors'][number];

export function NbSearchInstanceEditor({
  capabilities,
  draft,
  saving = false,
  onCancel,
  onCreated,
}: {
  capabilities: NbSearchCapabilities;
  draft: NbSearchDraft;
  saving?: boolean;
  onCancel: () => void;
  /** Hands back the draft `createNbSearchProviderInstance` built, plus the new id. */
  onCreated: (next: NbSearchDraft, instanceId: string) => void;
}) {
  const { t } = useI18n();
  const [providerId, setProviderId] = useState<string | null>(null);
  const [instanceIdText, setInstanceIdText] = useState('');
  const [credentialEnv, setCredentialEnv] = useState('');
  const [submitIssue, setSubmitIssue] = useState<string | null>(null);

  const descriptors = useMemo(
    () => capabilities.providers.descriptors.map((descriptor) => ({
      descriptor,
      label: nbSearchProviderLabel(t, descriptor.provider_id),
    })),
    [capabilities.providers.descriptors, t],
  );

  const view = useListView({
    listId: 'nb-search-provider-types',
    items: descriptors,
    keyOf: (entry) => entry.descriptor.provider_id,
    textOf: (entry) => [entry.label, entry.descriptor.provider_id],
  });

  const select = (descriptor: Descriptor) => {
    const next = suggestedInstanceId(descriptor.provider_id, draft);
    setProviderId(descriptor.provider_id);
    setInstanceIdText(next);
    setCredentialEnv(descriptor.activation.credential === 'required' ? suggestedCredentialEnv(next) : '');
    setSubmitIssue(null);
  };

  const selected = descriptors.find((entry) => entry.descriptor.provider_id === providerId)?.descriptor;
  const requiresKey = selected?.activation.credential === 'required';

  const idText = instanceIdText;
  const instanceId = instanceIdText.trim();
  const idIssue = (() => {
    if (selected === undefined) return null;
    if (instanceId === '') return t('st.nbSearch.custom.instance.idEmpty');
    if (instanceId !== idText || instanceId.length > 256) return t('st.nbSearch.custom.instance.idInvalid');
    if (draft.providers[instanceId] !== undefined) return t('st.nbSearch.custom.instance.idTaken');
    return null;
  })();

  const env = credentialEnv.trim();
  const envIssue = !requiresKey
    ? null
    : env === '' ? t('st.nbSearch.custom.instance.envRequired')
      : !ENV_PATTERN.test(env) ? t('st.nbSearch.service.credentialEnvInvalid')
        : null;

  const blocked = idIssue !== null || envIssue !== null || selected === undefined;

  const submit = () => {
    if (selected === undefined || blocked) return;
    try {
      const next = createNbSearchProviderInstance(
        draft,
        capabilities,
        selected.provider_id,
        instanceId,
        env === '' ? undefined : env,
      );
      onCreated(next, instanceId);
    } catch (error) {
      setSubmitIssue(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-3" data-nb-search-instance-editor>
      {selected === undefined ? (
        <>
          <Hint>{t('st.nbSearch.custom.instance.pickHint')}</Hint>
          <ListToolbar
            view={view}
            total={descriptors.length}
            searchLabel={t('st.nbSearch.custom.instance.pickLabel')}
            searchPlaceholder={t('st.nbSearch.custom.instance.pickPlaceholder')}
            showDensity={false}
          />
          {descriptors.length === 0 ? (
            <ListEmpty kind="none" title={t('st.nbSearch.custom.instance.noProviders')} />
          ) : view.visible.length === 0 ? (
            <ListEmpty
              kind="no-match"
              title={t('st.nbSearch.services.noMatch', { query: view.query.trim() })}
              onClear={view.clear}
            />
          ) : (
            <ul className="space-y-0.5" data-nb-search-provider-options>
              {view.visible.map((entry) => (
                <li key={entry.descriptor.provider_id}>
                  <button
                    type="button"
                    data-nb-search-provider-option={entry.descriptor.provider_id}
                    disabled={saving}
                    onClick={() => {
                      select(entry.descriptor);
                    }}
                    className="row-interactive flex w-full min-w-0 flex-col items-start gap-0.5 py-1.5 pl-3 pr-2 text-left"
                  >
                    <span className="flex w-full min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.label}</span>
                      <span className="shrink-0 text-[12px] text-ink-faint">
                        {entry.descriptor.activation.credential === 'none'
                          ? t('st.nbSearch.services.keyless')
                          : t('st.nbSearch.services.needsKey')}
                      </span>
                    </span>
                    <span className="max-w-full truncate font-mono text-[11px] text-ink-faint">
                      {entry.descriptor.provider_id}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <button type="button" className={SECONDARY_BUTTON} onClick={onCancel}>
              {t('st.nbSearch.custom.cancel')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[13px] text-ink">
              {providerLabelKey(selected.provider_id) === undefined
                ? selected.provider_id
                : nbSearchProviderLabel(t, selected.provider_id)}
            </span>
            <span className="font-mono text-[11px] text-ink-faint">{selected.provider_id}</span>
            <button
              type="button"
              className="ml-auto text-[12px] text-ink-soft transition-colors hover:text-ink"
              disabled={saving}
              data-nb-search-instance-change-provider
              onClick={() => {
                setProviderId(null);
                setSubmitIssue(null);
              }}
            >
              {t('st.nbSearch.custom.instance.changeProvider')}
            </button>
          </div>

          <label className={FORM_LABEL}>
            {t('st.nbSearch.custom.instance.idLabel')}
            <input
              className={`${INPUT} mt-1 font-mono`}
              value={instanceIdText}
              disabled={saving}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('st.nbSearch.custom.instance.idLabel')}
              data-nb-search-instance-id
              onChange={(event) => {
                const value = event.target.value;
                setInstanceIdText(value);
                setSubmitIssue(null);
                if (requiresKey && credentialEnv === suggestedCredentialEnv(instanceIdText)) {
                  setCredentialEnv(suggestedCredentialEnv(value));
                }
              }}
            />
            <FieldIssue id="nb-search-instance-id-issue" text={idIssue} />
            {idIssue === null ? (
              <span className="mt-1 block font-normal text-[11px] leading-relaxed text-ink-faint">
                {t('st.nbSearch.custom.instance.idHint')}
              </span>
            ) : null}
          </label>

          {requiresKey ? (
            <AdvancedDetails summary={t('st.nbSearch.custom.instance.envSection')}>
              <label className="block">
                <span className="text-[12px] text-ink-soft">{t('st.nbSearch.custom.instance.envLabel')}</span>
                <input
                  className={`${INPUT} mt-1 font-mono`}
                  value={credentialEnv}
                  disabled={saving}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t('st.nbSearch.custom.instance.envLabel')}
                  data-nb-search-instance-env
                  onChange={(event) => {
                    setCredentialEnv(event.target.value);
                    setSubmitIssue(null);
                  }}
                />
              </label>
              <FieldIssue id="nb-search-instance-env-issue" text={envIssue} />
              <p className="text-[12px] leading-snug text-ink-faint">
                {t('st.nbSearch.custom.instance.envHint')}
              </p>
            </AdvancedDetails>
          ) : null}

          {submitIssue !== null ? (
            <p role="alert" data-nb-search-instance-issue className="text-[12px] leading-4 text-danger">
              {t('st.nbSearch.custom.instance.failed')}
              <span className="ml-1 font-mono text-[11px] text-ink-faint">{submitIssue}</span>
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={saving || blocked}
              data-nb-search-instance-create
              onClick={submit}
            >
              {t('st.nbSearch.custom.instance.create')}
            </button>
            <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={onCancel}>
              {t('st.nbSearch.custom.cancel')}
            </button>
            <span className="inline-flex items-center gap-1 text-[12px] text-ink-faint">
              <Icon name="settings" size={12} />
              {t('st.nbSearch.custom.instance.keysLater')}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
