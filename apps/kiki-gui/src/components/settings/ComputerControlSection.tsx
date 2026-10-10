/**
 * Settings → 电脑控制. Four flat blocks in the order a person decides:
 *
 *   A  which server this drives (its real platform/arch) and a re-check
 *   B  whether the open-source executor is installed, with the install plan
 *   C  model usage preference (avoid vs prefer)
 *   D  the existing computer MCP connections — list, then one editor
 *
 * Nothing here is predicted: the machine line is the connected server's own
 * `platform`/`arch`, the readiness line is the capability service's state, and
 * the configuration block reads and writes the same global MCP plane the MCP
 * page uses. "Installed" means the pinned executor files verified — it is not
 * a claim that the desktop is being controlled or that it is idle.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  computerControlPreference,
  computerControlPreferencePatch,
} from '@kiki/session-core/settings';

type ComputerUsagePreference = ReturnType<typeof computerControlPreference>;

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import type { CapabilityStatus } from '../../lib/client';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import {
  SettingsDraftFooter,
  SettingsSegmented,
  type SettingsChoice,
} from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';
import { ComputerConnectionCard } from './computerControl/ComputerConnectionCard';
import { platformDisplay } from './computerControl/computerMcp';

const CAPABILITY_ID = 'kiki-computer';

const PREFERENCE_SOURCE_KEYS: Readonly<Record<string, I18nKey>> = {
  default: 'st.computer.source.default',
  preset: 'st.computer.source.preset',
  base: 'st.computer.source.base',
  home: 'st.computer.source.home',
  env: 'st.computer.source.env',
  memory: 'st.computer.source.memory',
};

/**
 * Step ids the capability reports, in the state words the capability UIs
 * already use (`st.plugins.runtimeStepState.*`). An id this page does not know
 * is printed as the service sent it rather than swallowed.
 */
const STEP_KEYS: Readonly<Record<string, I18nKey>> = {
  binary: 'st.computer.step.binary',
  mcp: 'st.computer.step.mcp',
  'desktop-access': 'st.computer.step.desktopAccess',
  permissions: 'st.computer.step.permissions',
  runtime: 'st.computer.step.runtime',
};

const STATE_KEYS: Readonly<Record<CapabilityStatus['state'], I18nKey>> = {
  not_installed: 'st.computer.state.notInstalled',
  partial: 'st.computer.state.partial',
  ready: 'st.computer.state.installed',
  unsupported: 'st.computer.state.unsupported',
};

export function ComputerControlSection() {
  const { client, klient, scopeId, sshLabel } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();

  const envQuery = useQuery({
    queryKey: ['computer-control-env', scopeId],
    queryFn: () => klient.global.env(),
    staleTime: Infinity,
  });
  const capabilityQuery = useQuery({
    queryKey: ['capability', CAPABILITY_ID, scopeId],
    queryFn: () => client.getCapability(CAPABILITY_ID),
    refetchInterval: (result) => result.state.data?.install.running === true ? 1_000 : false,
  });
  const configQuery = useQuery({
    queryKey: ['config', scopeId],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
  });

  const effectivePreference = configQuery.data !== undefined
    ? computerControlPreference(configQuery.data)
    : 'avoid';
  const preferenceSource = configQuery.data?.computer_control?.usagePreferenceSource ?? 'default';
  const isOverriddenByHigherSource = preferenceSource === 'env' || preferenceSource === 'memory';

  const [draftPreference, setDraftPreference] = useState<ComputerUsagePreference | null>(null);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [preferenceFeedback, setPreferenceFeedback] = useState<Feedback>(null);
  const [preferenceSaved, pingPreferenceSaved] = useSavedTick();
  const [savedGeneration, setSavedGeneration] = useState(0);
  const scopeGenerationRef = useRef(0);
  const nextPreferenceRequestRef = useRef(0);
  const latestPreferenceRequestsRef = useRef(new Map<string, number>());

  useEffect(() => {
    scopeGenerationRef.current += 1;
    setDraftPreference(null);
    setPreferenceSaving(false);
    setPreferenceFeedback(null);
    return () => { scopeGenerationRef.current += 1; };
  }, [scopeId]);

  const isPreferenceSaved = preferenceSaved && savedGeneration === scopeGenerationRef.current;
  const activePreference = draftPreference ?? effectivePreference;
  const isPreferenceDirty = !isOverriddenByHigherSource && draftPreference !== null && draftPreference !== effectivePreference;

  const persistPreference = async (targetPreference: ComputerUsagePreference | null) => {
    const targetScopeId = scopeId;
    const requestGen = scopeGenerationRef.current;
    const requestId = ++nextPreferenceRequestRef.current;
    latestPreferenceRequestsRef.current.set(targetScopeId, requestId);
    const queryKey = ['config', targetScopeId] as const;
    const dataUpdateCount = queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0;
    const isLatestRequest = () => latestPreferenceRequestsRef.current.get(targetScopeId) === requestId;
    const ownsCurrentUi = () => isLatestRequest() && scopeGenerationRef.current === requestGen;

    setPreferenceSaving(true);
    setPreferenceFeedback(null);
    try {
      const echoed = await client.patchConfig(computerControlPreferencePatch(targetPreference));
      if (!isLatestRequest() || (queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0) !== dataUpdateCount) return;
      queryClient.setQueryData(queryKey, echoed);
      if (ownsCurrentUi()) {
        setDraftPreference(null);
        setSavedGeneration(requestGen);
        pingPreferenceSaved();
      }
    } catch (error) {
      if (ownsCurrentUi()) {
        setPreferenceFeedback({ tone: 'error', text: errorText(locale, error) });
      }
    } finally {
      if (ownsCurrentUi()) {
        setPreferenceSaving(false);
      }
    }
  };

  const savePreference = async () => {
    if (draftPreference === null || draftPreference === effectivePreference || isOverriddenByHigherSource || preferenceSaving) return;
    await persistPreference(draftPreference);
  };

  const discardPreference = () => {
    setDraftPreference(null);
    setPreferenceFeedback(null);
  };

  const resetToInherited = async () => {
    if (isOverriddenByHigherSource || preferenceSaving) return;
    await persistPreference(null);
  };

  const preferenceChoices: readonly SettingsChoice<ComputerUsagePreference>[] = [
    { value: 'avoid', label: t('st.computer.preference.avoid') },
    { value: 'prefer', label: t('st.computer.preference.prefer') },
  ];

  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const capability = capabilityQuery.data;
  const platform = envQuery.data?.platform;
  const serverFacts = [platformDisplay(platform), envQuery.data?.arch]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');

  const reportFailure = (error: unknown) => {
    setFeedback({ tone: 'error', text: errorText(locale, error) });
  };

  const check = async () => {
    setChecking(true);
    setFeedback(null);
    try {
      await capabilityQuery.refetch();
    } catch (error) {
      reportFailure(error);
    } finally {
      setChecking(false);
    }
  };

  const install = async (status: CapabilityStatus) => {
    const digest = status.plan?.artifact.sha256;
    setConfirmingInstall(false);
    if (digest === undefined) return;
    setInstalling(true);
    setFeedback(null);
    try {
      const next = await client.installCapability(status.id, digest);
      queryClient.setQueryData(['capability', CAPABILITY_ID, scopeId], next);
      // A completed install registers the global connection itself, so the
      // configuration block below has to re-read rather than keep its list.
      await queryClient.invalidateQueries({ queryKey: ['computer-control-mcp', scopeId] });
      setFeedback({ tone: 'success', text: t('st.computer.installDone', { version: status.plan?.artifact.version ?? '' }) });
    } catch (error) {
      reportFailure(error);
    } finally {
      setInstalling(false);
    }
  };

  const installError = capability?.install.error;
  const optionalUnchecked = capability?.steps.some((step) => step.optional === true && step.state !== 'ok') === true;

  return (
    <div className="space-y-6" data-settings-computer-control>
      {/* A — the machine this drives, and how to re-check it */}
      <SectionCard id="st-card-computer-machine" title={t('st.computer.title')}>
        <div className="space-y-3">
          <SettingField label={t('st.computer.machineLabel')} labelId="computer-machine-label">
            <span className="font-mono text-[12px] text-ink" data-computer-platform>
              {serverFacts === '' ? t('st.computer.machineUnknown') : serverFacts}
            </span>
            <button type="button" className={SECONDARY_BUTTON} data-computer-check-btn
              disabled={checking}
              onClick={() => { void check(); }}>
              {checking ? t('st.computer.checking') : t('st.computer.recheckButton')}
            </button>
          </SettingField>
          <Hint>
            {sshLabel === null
              ? t('st.computer.machineHint')
              : t('st.computer.machineHintSsh', { label: sshLabel })}
          </Hint>
          {envQuery.isError ? <InlineError error={envQuery.error} /> : null}
        </div>
      </SectionCard>

      {/* B — executor installation: one state line, details folded */}
      <SectionCard id="st-card-computer-setup" title={t('st.computer.setupTitle')}>
        <div className="space-y-3">
          {capabilityQuery.isPending ? (
            <p className="flex items-center gap-2 text-[12px] leading-4 text-ink-faint" role="status" data-computer-state="detecting">
              <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
              {t('st.computer.state.detecting')}
            </p>
          ) : capabilityQuery.isError || capability === undefined ? (
            <div className="space-y-2" data-computer-state="failed">
              <p className="text-[12px] text-danger" role="alert">{t('st.computer.state.failed')}</p>
              <InlineError error={capabilityQuery.error} />
              <button type="button" className={SECONDARY_BUTTON} data-computer-retry
                onClick={() => { void check(); }}>
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <>
              <SettingField label={t('st.computer.statusLabel')} labelId="computer-state-label">
                <span className="text-[13px] text-ink" data-computer-state={capability.state}>
                  {t(STATE_KEYS[capability.state])}
                </span>
                {capability.version !== undefined ? (
                  <span className="font-mono text-[11px] text-ink-faint" data-computer-version>v{capability.version}</span>
                ) : null}
                {capability.state !== 'ready' && !capability.install.running && capability.plan !== undefined ? (
                  <button type="button" className={PRIMARY_BUTTON} data-computer-install-btn
                    disabled={installing}
                    onClick={() => { setConfirmingInstall(true); }}>
                    {installing ? t('st.computer.installing') : installError === undefined ? t('st.computer.installButton') : t('st.computer.retryInstall')}
                  </button>
                ) : null}
              </SettingField>

              {capability.state === 'ready' ? <Hint>{t('st.computer.installedHint')}</Hint> : null}
              {capability.state === 'ready' && optionalUnchecked ? <Hint>{t('st.computer.optionalUnverified')}</Hint> : null}
              {capability.state === 'ready' && platform === 'darwin' ? <Hint>{t('st.computer.macPermissions')}</Hint> : null}

              {capability.install.running ? (
                <p className="flex items-center gap-2 text-[12px] leading-4 text-ink-faint" role="status" data-computer-installing>
                  <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
                  {capability.install.step ?? t('st.computer.installing')}
                  {capability.install.percent === undefined ? null : ` · ${Math.round(capability.install.percent)}%`}
                </p>
              ) : null}
              {installError !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: installError }} /> : null}
              {capability.install.note !== undefined ? (
                <p className="text-[11px] text-ink-soft" data-computer-install-note>{capability.install.note}</p>
              ) : null}

              {capability.steps.length > 0 ? (
                <AdvancedDetails summary={t('st.computer.details')} data-computer-steps>
                  <ul className="space-y-1">
                    {capability.steps.map((step) => (
                      <li className="text-[11px] text-ink-soft" key={step.id} data-computer-step={step.id}
                        data-computer-step-kind={step.optional === true ? 'optional' : 'required'}>
                        {(STEP_KEYS[step.id] === undefined ? step.id : t(STEP_KEYS[step.id]!))}
                        {' · '}
                        {step.optional === true ? `${t('st.plugins.optional')} · ` : ''}
                        {t(`st.plugins.runtimeStepState.${step.state}`)}
                        {step.detail === undefined ? '' : ` · ${step.detail}`}
                      </li>
                    ))}
                  </ul>
                </AdvancedDetails>
              ) : null}
            </>
          )}

          <FeedbackLine feedback={feedback} />
        </div>
      </SectionCard>

      {/* C — model usage guidance preference */}
      <SectionCard id="st-card-computer-preference" title={t('st.computer.preferenceTitle')}>
        <div className="space-y-3">
          {configQuery.isPending && configQuery.data === undefined ? (
            <p className="flex items-center gap-2 text-[12px] leading-4 text-ink-faint" role="status" data-computer-preference-state="loading">
              <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
              {t('st.computer.preferenceLoading')}
            </p>
          ) : configQuery.isError && configQuery.data === undefined ? (
            <div className="space-y-2" data-computer-preference-state="failed">
              <p className="text-[12px] text-danger" role="alert">{t('st.computer.preferenceLoadFailed')}</p>
              <InlineError error={configQuery.error} />
              <button type="button" className={SECONDARY_BUTTON} data-computer-preference-retry
                onClick={() => { void configQuery.refetch(); }}>
                {t('common.retry')}
              </button>
            </div>
          ) : (
            <>
              <SettingField
                label={t('st.computer.preferenceLabel')}
                labelId="computer-preference-label"
                help={t('st.computer.preferenceHint')}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <SettingsSegmented
                    choices={preferenceChoices}
                    value={activePreference}
                    onChange={(next) => {
                      setPreferenceFeedback(null);
                      setDraftPreference(next === effectivePreference ? null : next);
                    }}
                    disabled={isOverriddenByHigherSource || preferenceSaving}
                    ariaLabelledBy="computer-preference-label"
                    dataAttr="data-computer-preference-choice"
                  />
                  <span
                    className="inline-flex items-center rounded bg-ink/[0.05] px-1.5 py-0.5 text-[11px] text-ink-soft"
                    data-computer-preference-source={preferenceSource}
                  >
                    {t('st.computer.sourceTag', {
                      source: t(PREFERENCE_SOURCE_KEYS[preferenceSource] ?? 'st.computer.source.default'),
                    })}
                  </span>
                  {preferenceSource === 'home' && !isOverriddenByHigherSource ? (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      data-computer-preference-reset
                      disabled={preferenceSaving}
                      onClick={() => { void resetToInherited(); }}
                    >
                      {t('st.computer.restoreInherit')}
                    </button>
                  ) : null}
                </div>
              </SettingField>

              {isOverriddenByHigherSource ? (
                <p className="text-[12px] text-ink-soft" data-computer-preference-override-notice>
                  {t('st.computer.sourceOverridden', {
                    source: t(PREFERENCE_SOURCE_KEYS[preferenceSource] ?? 'st.computer.source.default'),
                  })}
                </p>
              ) : null}

              {configQuery.isError && configQuery.data !== undefined ? (
                <InlineError error={configQuery.error} />
              ) : null}

              <FeedbackLine feedback={preferenceFeedback} />

              <SettingsDraftFooter
                id="computer-preference"
                dirty={isPreferenceDirty}
                saving={preferenceSaving}
                saved={isPreferenceSaved}
                onSave={() => { void savePreference(); }}
                onDiscard={discardPreference}
              />
            </>
          )}
        </div>
      </SectionCard>

      {/* D — the connections themselves */}
      <SectionCard id="st-card-computer-mcp" title={t('st.computer.connectionsTitle')}>
        <div className="space-y-3">
          <Hint>{t('st.computer.connectionsHint')}</Hint>
          <ComputerConnectionCard
            platform={platform}
            planBinary={capability?.plan?.destination}
          />
        </div>
      </SectionCard>

      {confirmingInstall && capability?.plan !== undefined ? (
        <ConfirmDialog
          open
          overlayId="confirm-computer-install"
          title={t('st.computer.installConfirmTitle')}
          body={t('st.computer.installConfirmBody')}
          consequences={[
            `v${capability.plan.artifact.version} · ${capability.plan.artifact.url}`,
            `SHA-256 ${capability.plan.artifact.sha256}`,
            capability.plan.destination,
            capability.plan.note,
          ]}
          confirmLabel={t('st.computer.installButton')}
          tone="default"
          busy={installing}
          onCancel={() => { setConfirmingInstall(false); }}
          onConfirm={() => { void install(capability); }}
        />
      ) : null}
    </div>
  );
}
