/**
 * Settings → 电脑控制. Three flat sections in the order a person decides:
 *
 *   1  the verdict: may the Agent drive a desktop on this server, and the first
 *      gate to fix — with the switch, its new-session default, the connected
 *      server's own platform/arch, the executor's install state and its check
 *   2  the connections: which one runs (the active selector), the list, adding
 *      one by hand, and the external Windows-MCP 0.8.8 registration on Windows
 *   3  model usage preference (avoid vs prefer), saved as it is picked
 *
 * Nothing here is predicted: the machine line is the connected server's own
 * `platform`/`arch`, the install state is the capability service's state, and
 * the connections read and write the same global MCP plane the MCP page uses.
 * "Installed" means the pinned executor files verified — it is not a claim that
 * the desktop is being controlled or that it is idle.
 */

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  computerControlVerdict,
  isComputerControlEnabled,
  isComputerToolPolicyDenied,
  isComputerToolPolicyPartiallyDenied,
  type ComputerControlVerdictKind,
} from '@kiki/session-core/settings';

import { DefaultOnSwitch, optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import type { CapabilityStatus, KikiConfigPatch } from '../../lib/client';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SaveStatus, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard, SettingsCardMountContext } from './SectionCard';
import { AdvancedDetails, SettingField } from './fields';
import {
  FORM_LABEL,
  SettingsSegmented,
  SettingsSelect,
  type SettingsChoice,
} from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';
import { useInstantSave } from './useInstantSave';
import { CapabilitySwitch, ControlVerdictLine } from './browserControl/ControlVerdict';
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

const VERDICT_KEYS: Readonly<Record<Exclude<ComputerControlVerdictKind, 'ready'>, I18nKey>> = {
  unresolved: 'st.computer.verdict.unresolved',
  host_locked: 'st.computer.verdict.hostLocked',
  off: 'st.computer.verdict.off',
  tool_denied: 'st.computer.toolPolicyDenied',
  checking: 'st.computer.state.detecting',
  unknown: 'st.computer.verdict.unknown',
  unsupported: 'st.computer.verdict.unsupported',
  installing: 'st.computer.installing',
  not_installed: 'st.computer.verdict.notInstalled',
  partial: 'st.computer.verdict.partial',
  no_connection: 'st.computer.verdict.noConnection',
  connection_not_ready: 'st.computer.verdict.connectionNotReady',
};

export function ComputerControlSection() {
  const { client, klient, scopeId, sshLabel } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const onCardMount = useContext(SettingsCardMountContext);
  useEffect(() => {
    onCardMount?.('st-card-computer-machine');
    onCardMount?.('st-card-computer-setup');
  }, [onCardMount]);

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

  const activeEntry = useMemo(() => {
    if (selectedConnection !== undefined) {
      return mcpEntries.find((entry) => entry.name === selectedConnection);
    }
    const cuaEntries = mcpEntries.filter((entry) => computerExecutorKind(entry.config) === 'cua');
    return cuaEntries.find((entry) => entry.config.enabled !== false) ?? cuaEntries[0];
  }, [mcpEntries, selectedConnection]);
  const activeKind = activeEntry !== undefined ? computerExecutorKind(activeEntry.config) : undefined;
  const activeWindowsNotReady = activeKind === 'windows-mcp' && activeEntry !== undefined && !isWindowsMcpServeReady(activeEntry.config);
  const activeEntryEnabled = activeEntry !== undefined && activeEntry.config.enabled !== false;
  const activeConnectionReady = activeEntry !== undefined
    && activeEntryEnabled
    && (activeKind === 'cua' || (activeKind === 'windows-mcp' && !activeWindowsNotReady));

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
  /** The pick shows at once while it is written; a refused write falls back to the stored value. */
  const activePreference = draftPreference ?? effectivePreference;

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
        setDraftPreference(null);
        setPreferenceFeedback({ tone: 'error', text: errorText(locale, error) });
      }
    } finally {
      if (ownsCurrentUi()) {
        setPreferenceSaving(false);
      }
    }
  };

  const choosePreference = (next: ComputerUsagePreference) => {
    if (isOverriddenByHigherSource || preferenceSaving || next === activePreference) return;
    setDraftPreference(next);
    void persistPreference(next);
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
      await mcpQuery.refetch();
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
      // connections below have to re-read rather than keep their list.
      await queryClient.invalidateQueries({ queryKey: computerMcpQueryKey(scopeId) });
      setFeedback({ tone: 'success', text: t('st.computer.installDone', { version: status.plan?.artifact.version ?? '' }) });
    } catch (error) {
      reportFailure(error);
    } finally {
      setInstalling(false);
    }
  };

  const installError = capability?.install.error;
  const optionalUnchecked = capability?.steps.some((step) => step.optional === true && step.state !== 'ok') === true;
  const canInstall = capability !== undefined && capability.state !== 'ready' && !capability.install.running && capability.plan !== undefined;

  const verdictExecutor = ((): Parameters<typeof computerControlVerdict>[0]['executor'] => {
    if (configQuery.isPending || mcpQuery.isPending) return 'checking';
    if (mcpQuery.isError) return 'unknown';
    if (activeKind === 'windows-mcp' || (selectedConnection !== undefined && activeKind !== 'cua')) {
      return 'external';
    }
    if (capabilityQuery.isPending) return 'checking';
    if (capabilityQuery.isError || capability === undefined) return 'unknown';
    return { state: capability.state, installing: capability.install.running || installing };
  })();

  const verdict = computerControlVerdict({
    enabled: isComputerEnabled,
    hostLocked: computerHostLocked,
    unresolved: computerCapability?.unresolved,
    toolPolicyDenied: isToolPolicyDenied,
    executor: verdictExecutor,
    hasConnection: activeEntry !== undefined,
    activeConnectionReady,
  });
  const verdictText = verdict.kind === 'ready'
    ? t('st.computer.verdict.ready', { name: selectedConnection ?? activeEntry?.name ?? t('st.computer.activeConnectionDefault') })
    : t(VERDICT_KEYS[verdict.kind]);
  const verdictAction = verdict.kind === 'unknown' ? (
    <button type="button" className={SECONDARY_BUTTON} data-computer-retry onClick={() => { void check(); }}>
      {t('common.retry')}
    </button>
  ) : (verdict.kind === 'not_installed' || verdict.kind === 'partial') && canInstall ? (
    <button type="button" className={PRIMARY_BUTTON} data-computer-install-btn
      disabled={installing}
      onClick={() => { setConfirmingInstall(true); }}>
      {installing ? t('st.computer.installing') : installError === undefined ? t('st.computer.installButton') : t('st.computer.retryInstall')}
    </button>
  ) : null;

  const showConnectionSelect = mcpEntries.length > 0 || selectedConnection !== undefined;

  const connectionSummary = showConnectionSelect ? (
    <div className="space-y-1.5" data-computer-active-connection-row>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[12px] text-ink-soft">
        <span id="computer-active-connection-label">
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
      <SectionCard id="st-card-computer-enabled" title={t('st.computer.title')}>
        <div className="space-y-3" data-computer-control-enabled={isComputerEnabled ? 'true' : 'false'}>
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <ControlVerdictLine
              attr="data-computer-verdict"
              kind={verdict.kind}
              tone={verdict.tone}
              text={verdictText}
              action={verdictAction}
            />
            <CapabilitySwitch
              id="computer-master-switch"
              attr="data-computer-enabled-switch"
              label={t('st.computer.enabledLabel')}
              checked={isComputerEnabled}
              disabled={enabledSave.saving || configQuery.isLoading || computerHostLocked}
              saving={enabledSave.saving}
              saved={enabledSave.saved}
              onChange={handleToggleEnabled}
            />
          </div>
          {isToolPolicyPartiallyDenied ? (
            <p className="text-[12px] text-amber-ink" data-computer-toolpolicy-partial>
              {t('st.computer.toolPolicyPartial')}
            </p>
          ) : null}
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
          <FeedbackLine feedback={enabledSave.error} />

          <div className="space-y-2 border-t border-hairline pt-3" id="st-card-computer-machine" data-settings-card="st-card-computer-machine">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px]" id="st-card-computer-setup" data-settings-card="st-card-computer-setup">
              <span className="text-ink-soft" id="computer-machine-label">{sshLabel ?? t('st.computer.machineLabel')}</span>
              <span className="font-mono text-ink" data-computer-platform aria-labelledby="computer-machine-label">{machineLine}</span>
              {capabilityQuery.isPending ? (
                <span className="text-ink-faint" role="status" data-computer-state="detecting">{t('st.computer.state.detecting')}</span>
              ) : capabilityQuery.isError || capability === undefined ? (
                <span className="text-danger" data-computer-state="failed">{t('st.computer.state.failed')}</span>
              ) : (
                <span className="text-ink-soft" data-computer-state={capability.state}>
                  {t(STATE_KEYS[capability.state])}
                  {capability.version === undefined ? null : <span className="font-mono text-ink-faint" data-computer-version>{` v${capability.version}`}</span>}
                </span>
              )}
              <button type="button" className={`${SECONDARY_BUTTON} ml-auto`} data-computer-check-btn
                disabled={checking}
                onClick={() => { void check(); }}>
                {checking ? t('st.computer.checking') : t('st.computer.recheckButton')}
              </button>
            </div>

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
            <FeedbackLine feedback={feedback} />
            {capability?.state === 'ready' && platform === 'darwin' ? <Hint>{t('st.computer.macPermissions')}</Hint> : null}

            {capability !== undefined ? (
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
                {capability.install.note === undefined ? null : (
                  <p className="text-[11px] text-ink-soft" data-computer-install-note>{capability.install.note}</p>
                )}
                {capability.state === 'ready' ? <p>{t('st.computer.installedHint')}</p> : null}
                {capability.state === 'ready' && optionalUnchecked ? <p>{t('st.computer.optionalUnverified')}</p> : null}
                <p>{sshLabel === null ? t('st.computer.machineHint') : t('st.computer.machineHintSsh', { label: sshLabel })}</p>
              </AdvancedDetails>
            ) : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard id="st-card-computer-mcp" title={t('st.computer.connectionsTitle')}>
        <ComputerConnectionCard
          platform={platform}
          planBinary={capability?.plan?.destination}
          summary={connectionSummary}
          footer={platform === 'win32' ? <WindowsMcpRegistrationFold scopeId={scopeId} /> : null}
        />
      </SectionCard>

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
                    onChange={choosePreference}
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
                  <SaveStatus saving={preferenceSaving} saved={isPreferenceSaved} />
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
