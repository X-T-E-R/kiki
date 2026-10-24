/**
 * Settings → 电脑控制. Four flat sections in the order a person decides:
 *
 *   0  whether the Agent may drive a desktop at all (switch, default, policy)
 *   A+B  which server this drives (its real platform/arch), whether the
 *        open-source executor is installed, and a re-check — one fact table
 *   C  the existing computer MCP connections — active selector, list, editor,
 *      and external Windows-MCP 0.8.8 registration on Windows
 *   D  model usage preference (avoid vs prefer)
 *
 * Nothing here is predicted: the machine line is the connected server's own
 * `platform`/`arch`, the readiness line is the capability service's state, and
 * the configuration block reads and writes the same global MCP plane the MCP
 * page uses. "Installed" means the pinned executor files verified — it is not
 * a claim that the desktop is being controlled or that it is idle.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  windowsMcpEnvironmentResponseSchema,
  windowsMcpRegisterResponseSchema,
} from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  computerControlConnection,
  computerControlConnectionPatch,
  computerControlPreference,
  computerControlPreferencePatch,
  isComputerControlEnabled,
  isComputerToolPolicyDenied,
  isComputerToolPolicyPartiallyDenied,
} from '@kiki/session-core/settings';

import { DefaultOnSwitch, optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import type { CapabilityStatus, KikiConfigPatch } from '../../lib/client';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import {
  FORM_LABEL,
  SettingsDraftFooter,
  SettingsSegmented,
  SettingsSelect,
  type SettingsChoice,
} from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';
import { useInstantSave } from './useInstantSave';
import { ComputerConnectionCard } from './computerControl/ComputerConnectionCard';
import {
  commandSummary,
  computerExecutorKind,
  computerMcpQueryKey,
  isComputerConnection,
  isComputerMcpConfig,
  isWindowsMcpServeReady,
  platformDisplay,
} from './computerControl/computerMcp';

type ComputerUsagePreference = ReturnType<typeof computerControlPreference>;

const CAPABILITY_ID = 'kiki-computer';

interface MemoryRequestClient {
  memoryRequest?<T>(method: 'GET' | 'POST', path: string, options?: { body?: unknown }): Promise<T>;
}

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
  const mcpQuery = useQuery({
    queryKey: computerMcpQueryKey(scopeId),
    queryFn: () => klient.global.mcp.list(),
    staleTime: 30_000,
  });

  const effectivePreference = configQuery.data !== undefined
    ? computerControlPreference(configQuery.data)
    : 'avoid';
  const preferenceSource = configQuery.data?.computer_control?.usagePreferenceSource ?? 'default';
  const isOverriddenByHigherSource = preferenceSource === 'env' || preferenceSource === 'memory';

  const selectedConnection = configQuery.data !== undefined
    ? computerControlConnection(configQuery.data)
    : undefined;
  const connectionSource = configQuery.data?.computer_control?.connectionSource ?? 'default';
  const isConnectionOverridden = connectionSource === 'env' || connectionSource === 'memory';
  const connectionSave = useInstantSave();

  const computerCapability = optionalCapabilityState(configQuery.data, 'computer');
  const isComputerEnabled = computerCapability?.allowed ?? isComputerControlEnabled(configQuery.data);
  const computerHostLocked = computerCapability?.host_locked === true;
  const isToolPolicyDenied = isComputerToolPolicyDenied(configQuery.data, selectedConnection ?? null);
  const isToolPolicyPartiallyDenied = isComputerToolPolicyPartiallyDenied(configQuery.data, selectedConnection ?? null);
  const enabledSave = useInstantSave();

  const handleToggleEnabled = (next: boolean) => {
    void enabledSave.run(async () => {
      await client.setComputerControlEnabled(next ? null : false);
      await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
    });
  };

  const handleSelectConnection = (next: string) => {
    void connectionSave.run(async () => {
      const echoed = await client.patchConfig(computerControlConnectionPatch(next === '' ? null : next) as KikiConfigPatch);
      queryClient.setQueryData(['config', scopeId], echoed);
    });
  };

  const mcpEntries = useMemo(
    () => (mcpQuery.data ?? []).filter((entry) => isComputerConnection(entry)),
    [mcpQuery.data],
  );

  const connectionChoices = useMemo(() => {
    const base: { value: string; label: string; hint?: string }[] = [
      {
        value: '',
        label: t('st.computer.activeConnectionDefault'),
        hint: t('st.computer.activeConnectionDefaultHint'),
      },
    ];
    const seen = new Set<string>(['']);
    for (const entry of mcpEntries) {
      if (!isComputerMcpConfig(entry.config) && entry.name !== selectedConnection) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const kind = computerExecutorKind(entry.config);
      const kindLabel = kind === 'windows-mcp'
        ? t('st.computer.kind.windowsMcp')
        : kind === 'cua'
          ? t('st.computer.kind.cua')
          : undefined;
      base.push({
        value: entry.name,
        label: kindLabel === undefined ? entry.name : `${entry.name} · ${kindLabel}`,
        hint: commandSummary(entry.config),
      });
    }
    if (selectedConnection !== undefined && !seen.has(selectedConnection)) {
      base.push({
        value: selectedConnection,
        label: selectedConnection,
      });
    }
    return base;
  }, [mcpEntries, selectedConnection, t]);

  const activeEntry = mcpEntries.find((entry) =>
    selectedConnection !== undefined ? entry.name === selectedConnection : computerExecutorKind(entry.config) === 'cua',
  );
  const activeKind = activeEntry !== undefined ? computerExecutorKind(activeEntry.config) : undefined;
  const activeWindowsNotReady = activeKind === 'windows-mcp' && activeEntry !== undefined && !isWindowsMcpServeReady(activeEntry.config);

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
  // "No platform" is a settled empty report. Until env data arrives the line stays blank.
  const machineLine = envQuery.isSuccess
    ? (serverFacts === '' ? t('st.computer.machineUnknown') : serverFacts)
    : '';

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

  const showConnectionSelect = mcpEntries.length > 0 || selectedConnection !== undefined;

  const connectionSummary = showConnectionSelect ? (
    <div className="space-y-1.5" data-computer-active-connection-row>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-ink-soft">
        <span id="computer-active-connection-label" className="text-[13px] text-ink">
          {t('st.computer.activeConnectionLabel')}
        </span>
        <SettingsSelect
          id="computer-active-connection"
          ariaLabel={t('st.computer.activeConnectionLabel')}
          dataAttr="data-computer-active-connection"
          value={selectedConnection ?? ''}
          choices={connectionChoices}
          disabled={connectionSave.saving || configQuery.isLoading || isConnectionOverridden}
          onChange={handleSelectConnection}
          variant="row"
          mono
        />
        {selectedConnection !== undefined ? (
          <span
            className="inline-flex items-center rounded bg-ink/[0.05] px-1.5 py-0.5 text-[11px] text-ink-soft"
            data-computer-connection-source={connectionSource}
          >
            {t('st.computer.sourceTag', {
              source: t(PREFERENCE_SOURCE_KEYS[connectionSource] ?? 'st.computer.source.default'),
            })}
          </span>
        ) : null}
        <SaveStatus saving={connectionSave.saving} saved={connectionSave.saved} />
      </div>
      <Hint>{t('st.computer.activeConnectionHint')}</Hint>
      {activeKind === 'windows-mcp' ? (
        <p className="text-[12px] text-ink-soft" data-computer-active-windows-mcp-hint>
          {t('st.computer.windowsMcp.foregroundHint')}
        </p>
      ) : null}
      {activeWindowsNotReady ? (
        <p className="text-[12px] text-amber-ink" data-computer-active-windows-mcp-not-ready>
          {t('st.computer.windowsMcp.notServeReady')}
        </p>
      ) : null}
      <FeedbackLine feedback={connectionSave.error} />
    </div>
  ) : null;

  return (
    <div className="space-y-6" data-settings-computer-control>
      {/* 0 — may the Agent drive this desktop at all */}
      <SectionCard id="st-card-computer-enabled" title={t('st.computer.title')}>
        <div className="space-y-3" data-computer-control-enabled={isComputerEnabled ? 'true' : 'false'}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <label htmlFor="computer-master-switch" className="cursor-pointer text-[13px] font-medium text-ink">
                {t('st.computer.enabledLabel')}
              </label>
              <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">
                {t('st.computer.enabledHint')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <SaveStatus saving={enabledSave.saving} saved={enabledSave.saved} />
              <button
                type="button"
                id="computer-master-switch"
                role="switch"
                aria-checked={isComputerEnabled}
                data-computer-enabled-switch
                disabled={enabledSave.saving || configQuery.isLoading || computerHostLocked}
                onClick={() => { handleToggleEnabled(!isComputerEnabled); }}
                className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors duration-[var(--kiki-motion-quick)] ${
                  isComputerEnabled ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
                } ${enabledSave.saving || configQuery.isLoading || computerHostLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
                    isComputerEnabled ? 'translate-x-[16px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
                  }`}
                />
              </button>
            </div>
          </div>
          <DefaultOnSwitch
            id="computer"
            state={computerCapability}
            disabled={enabledSave.saving}
            onChange={(next) => {
              void enabledSave.run(async () => {
                await client.patchConfig({ optional_capabilities: { defaults: { computer: next } } });
                await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
              });
            }}
          />

          {isToolPolicyDenied ? (
            <p className="text-[12px] text-danger" data-computer-toolpolicy-denied>
              {t('st.computer.toolPolicyDenied')}
            </p>
          ) : isToolPolicyPartiallyDenied ? (
            <p className="text-[12px] text-amber-ink" data-computer-toolpolicy-partial>
              {t('st.computer.toolPolicyPartial')}
            </p>
          ) : null}

          <FeedbackLine feedback={enabledSave.error} />
        </div>
      </SectionCard>

      {/* A+B — the machine this drives, and whether its executor is in place */}
      <SectionCard id="st-card-computer-machine" title={t('st.computer.machineTitle')}>
        <div className="space-y-3">
          <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] items-center gap-x-6 gap-y-3 text-[13px]">
            <dt className="text-ink-soft" id="computer-machine-label">{t('st.computer.machineLabel')}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <span className="font-mono text-[12px] text-ink" data-computer-platform aria-labelledby="computer-machine-label">
                {machineLine}
              </span>
              <button type="button" className={`${SECONDARY_BUTTON} ml-auto`} data-computer-check-btn
                disabled={checking}
                onClick={() => { void check(); }}>
                {checking ? t('st.computer.checking') : t('st.computer.recheckButton')}
              </button>
            </dd>

            <dt className="text-ink-soft" id="computer-state-label">{t('st.computer.statusLabel')}</dt>
            <dd className="min-w-0" id="st-card-computer-setup">
              {capabilityQuery.isPending ? (
                <p className="flex items-center gap-2 text-[12px] leading-4 text-ink-faint" role="status" data-computer-state="detecting">
                  <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
                  {t('st.computer.state.detecting')}
                </p>
              ) : capabilityQuery.isError || capability === undefined ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-computer-state="failed">
                  <p className="text-[12px] text-danger" role="alert">{t('st.computer.state.failed')}</p>
                  <button type="button" className={`${SECONDARY_BUTTON} ml-auto`} data-computer-retry
                    onClick={() => { void check(); }}>
                    {t('common.retry')}
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="inline-flex items-center gap-1.5 text-ink" data-computer-state={capability.state} aria-labelledby="computer-state-label">
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${capability.state === 'ready' ? 'bg-success' : capability.state === 'partial' ? 'bg-amber-rule' : 'bg-hairline-strong'}`} />
                    {t(STATE_KEYS[capability.state])}
                  </span>
                  {capability.version !== undefined ? (
                    <span className="font-mono text-[11px] text-ink-faint" data-computer-version>v{capability.version}</span>
                  ) : null}
                  {capability.state !== 'ready' && !capability.install.running && capability.plan !== undefined ? (
                    <button type="button" className={`${PRIMARY_BUTTON} ml-auto`} data-computer-install-btn
                      disabled={installing}
                      onClick={() => { setConfirmingInstall(true); }}>
                      {installing ? t('st.computer.installing') : installError === undefined ? t('st.computer.installButton') : t('st.computer.retryInstall')}
                    </button>
                  ) : null}
                </div>
              )}
            </dd>
          </dl>

          {capabilityQuery.isError ? <InlineError error={capabilityQuery.error} /> : null}
          {envQuery.isError ? <InlineError error={envQuery.error} /> : null}

          {capability !== undefined && capability.install.running ? (
            <p className="flex items-center gap-2 text-[12px] leading-4 text-ink-faint" role="status" data-computer-installing>
              <span className="status-dot-busy inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-soft" />
              {capability.install.step ?? t('st.computer.installing')}
              {capability.install.percent === undefined ? null : ` · ${Math.round(capability.install.percent)}%`}
            </p>
          ) : null}
          {installError !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: installError }} /> : null}
          {capability?.install.note !== undefined ? (
            <p className="text-[11px] text-ink-soft" data-computer-install-note>{capability.install.note}</p>
          ) : null}

          <Hint>
            {sshLabel === null
              ? t('st.computer.machineHint')
              : t('st.computer.machineHintSsh', { label: sshLabel })}
          </Hint>
          {capability?.state === 'ready' ? <Hint>{t('st.computer.installedHint')}</Hint> : null}
          {capability?.state === 'ready' && optionalUnchecked ? <Hint>{t('st.computer.optionalUnverified')}</Hint> : null}
          {capability?.state === 'ready' && platform === 'darwin' ? <Hint>{t('st.computer.macPermissions')}</Hint> : null}

          <FeedbackLine feedback={feedback} />

          {capability !== undefined && capability.steps.length > 0 ? (
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
        </div>
      </SectionCard>

      {/* C — the connections themselves */}
      <SectionCard id="st-card-computer-mcp" title={t('st.computer.connectionsTitle')}>
        <div className="space-y-3">
          <ComputerConnectionCard
            platform={platform}
            planBinary={capability?.plan?.destination}
            summary={connectionSummary}
            footer={platform === 'win32' ? <WindowsMcpRegistrationFold scopeId={scopeId} /> : null}
          />
          <Hint>{t('st.computer.connectionsHint')}</Hint>
        </div>
      </SectionCard>

      {/* D — model usage guidance preference */}
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

/**
 * Folded registration form for an already installed Windows-MCP 0.8.8
 * environment on a Windows server. Records the interpreter and `--config` file
 * into the server's global MCP configuration without running `uv`, `install`,
 * `auth`, or `serve`, and without automatically switching the active connection.
 */
function WindowsMcpRegistrationFold({ scopeId }: { readonly scopeId: string }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const reqClient = client as unknown as MemoryRequestClient;

  const [opened, setOpened] = useState(false);
  const [pythonPath, setPythonPath] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [registering, setRegistering] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const planQuery = useQuery({
    queryKey: ['computer-windows-mcp', scopeId],
    queryFn: async () => windowsMcpEnvironmentResponseSchema.parse(
      await reqClient.memoryRequest!('GET', '/computer/windows-mcp'),
    ),
    enabled: opened && typeof reqClient.memoryRequest === 'function',
    staleTime: 60_000,
  });

  const register = async () => {
    if (typeof reqClient.memoryRequest !== 'function') return;
    const python = pythonPath.trim();
    const cfg = configPath.trim();
    if (python === '' || cfg === '' || registering) return;
    setRegistering(true);
    setFeedback(null);
    try {
      const response = windowsMcpRegisterResponseSchema.parse(
        await reqClient.memoryRequest('POST', '/computer/windows-mcp/register', {
          body: { python, configPath: cfg, version: '0.8.8' },
        }),
      );
      await queryClient.invalidateQueries({ queryKey: computerMcpQueryKey(scopeId) });
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      setFeedback({
        tone: 'success',
        text: t(
          response.result === 'existing-mcp-config-reused'
            ? 'st.computer.windowsMcp.reused'
            : 'st.computer.windowsMcp.registered',
          { name: response.name },
        ),
      });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRegistering(false);
    }
  };

  return (
    <AdvancedDetails
      summary={t('st.computer.windowsMcp.registerSummary')}
      data-computer-windows-mcp-register
      open={opened || undefined}
      onToggle={(event) => { setOpened((event.currentTarget as HTMLDetailsElement).open); }}
    >
      <div className="space-y-3 pt-1">
        <Hint>{t('st.computer.windowsMcp.registerHint')}</Hint>
        {planQuery.data !== undefined ? (
          <p className="font-mono text-[11px] text-ink-faint" data-computer-windows-mcp-plan>
            Windows-MCP v{planQuery.data.version} · Python {planQuery.data.python} · {planQuery.data.licenses.map((item) => `${item.name} (${item.license})`).join(', ')}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className={FORM_LABEL} htmlFor="computer-windows-mcp-python">
              {t('st.computer.windowsMcp.pythonLabel')}
            </label>
            <input
              id="computer-windows-mcp-python"
              className={`${INPUT} font-mono`}
              data-computer-windows-mcp-python
              value={pythonPath}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('st.computer.windowsMcp.pythonPlaceholder')}
              disabled={registering}
              onChange={(event) => { setPythonPath(event.target.value); }}
            />
          </div>
          <div className="space-y-1.5">
            <label className={FORM_LABEL} htmlFor="computer-windows-mcp-config">
              {t('st.computer.windowsMcp.configLabel')}
            </label>
            <input
              id="computer-windows-mcp-config"
              className={`${INPUT} font-mono`}
              data-computer-windows-mcp-config
              value={configPath}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('st.computer.windowsMcp.configPlaceholder')}
              disabled={registering}
              onChange={(event) => { setConfigPath(event.target.value); }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-computer-windows-mcp-submit
            disabled={registering || pythonPath.trim() === '' || configPath.trim() === ''}
            onClick={() => { void register(); }}
          >
            {registering ? t('st.computer.windowsMcp.registering') : t('st.computer.windowsMcp.registerButton')}
          </button>
        </div>
        <FeedbackLine feedback={feedback} />
      </div>
    </AdvancedDetails>
  );
}
