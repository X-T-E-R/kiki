/**
 * Settings → 电脑. The same shape as the browser section above it: the
 * capability header first (one sentence about what the Agent can reach, the
 * master 启用 switch, the new-session default under it, and — while the
 * executor is missing — the single 安装执行器 action next to the verdict),
 * then the connection list, then one 高级 fold for everything the list does
 * not need on a normal pass: the machine facts, the executor's own checks,
 * and the model usage preference.
 *
 * "Installed" means the pinned executor files verified; it is not a claim
 * that the desktop is being controlled or that it is idle. The connections
 * read and write the same global MCP plane the MCP page uses, so an entry
 * registered by the install appears here without a second path.
 */

import { useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import {
  windowsMcpEnvironmentResponseSchema,
  windowsMcpRegisterResponseSchema,
} from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import {
  computerControlConnection,
  computerControlConnectionPatch,
  computerControlVerdict,
  isComputerControlEnabled,
  isComputerToolPolicyDenied,
  isComputerToolPolicyPartiallyDenied,
  type ComputerControlVerdictKind,
} from '@kiki/session-core/settings';

import { optionalCapabilityState } from '../capabilities/optionalCapabilityUi';
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
import { useInstantSave } from './useInstantSave';
import { CapabilityHeader } from './CapabilityHeader';
import { ComputerConnectionCard } from './computerControl/ComputerConnectionCard';
import { useComputerPreference } from './computerControl/useComputerPreference';
import {
  commandSummary,
  computerExecutorKind,
  computerMcpQueryKey,
  isBundledCuaCommand,
  isComputerConnection,
  isComputerMcpConfig,
  platformDisplay,
  windowsMcpServeReadiness,
} from './computerControl/computerMcp';

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
  const { hash, search } = useLocation();
  const rawTab = new URLSearchParams(search).get('tab');
  const queryClient = useQueryClient();
  const onCardMount = useContext(SettingsCardMountContext);
  useEffect(() => {
    onCardMount?.('st-card-computer-machine');
    onCardMount?.('st-card-computer-setup');
  }, [onCardMount]);

  // `?tab=computer` (and a `#st-card-computer-*` hash) addresses this section,
  // not a view to swap: both sections render, and the tab only says where the
  // scroll lands. The browser tab is handled the same way inside
  // BrowserControlSection.
  useEffect(() => {
    if (rawTab !== 'computer') return;
    const target = hash !== '' ? document.querySelector(hash) : document.querySelector('[data-settings-computer-control]');
    target?.scrollIntoView({ block: 'start' });
  }, [rawTab, hash]);

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
  const defaultSave = useInstantSave();

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

  const cuaEntries = useMemo(
    () => mcpEntries.filter((entry) => computerExecutorKind(entry.config) === 'cua'),
    [mcpEntries],
  );
  const enabledCuaEntries = useMemo(
    () => cuaEntries.filter((entry) => entry.config.enabled !== false),
    [cuaEntries],
  );
  const activeEntry = useMemo(() => {
    if (selectedConnection !== undefined) {
      return mcpEntries.find((entry) => entry.name === selectedConnection);
    }
    return enabledCuaEntries[0] ?? cuaEntries[0];
  }, [cuaEntries, enabledCuaEntries, mcpEntries, selectedConnection]);
  const activeKind = activeEntry !== undefined ? computerExecutorKind(activeEntry.config) : undefined;
  const activeWindowsReadiness = activeKind === 'windows-mcp' && activeEntry !== undefined
    ? windowsMcpServeReadiness(activeEntry.config)
    : undefined;
  const activeWindowsNotReady = activeWindowsReadiness !== undefined && activeWindowsReadiness !== 'ready';
  const activeWindowsUnverified = activeWindowsReadiness === 'unverified';
  const activeEntryEnabled = activeEntry !== undefined && activeEntry.config.enabled !== false;
  const activeConnectionReady = activeEntry !== undefined
    && activeEntryEnabled
    && (activeKind === 'cua' || activeWindowsReadiness === 'ready');

  const planBinary = capabilityQuery.data?.plan?.destination;
  const activeUsesCustomExecutor = useMemo(() => {
    if (selectedConnection !== undefined) {
      if (activeKind === 'windows-mcp') return true;
      if (activeKind === 'cua' && activeEntry?.config.transport === 'stdio') {
        return !isBundledCuaCommand(activeEntry.config.command, planBinary);
      }
      return true;
    }
    const candidates = enabledCuaEntries.length > 0 ? enabledCuaEntries : cuaEntries;
    return candidates.some((entry) => entry.config.transport === 'stdio' && !isBundledCuaCommand(entry.config.command, planBinary));
  }, [activeEntry, activeKind, cuaEntries, enabledCuaEntries, planBinary, selectedConnection]);

  const activeUsesBundledCua = useMemo(() => {
    if (selectedConnection !== undefined) {
      return activeKind === 'cua' && activeEntry?.config.transport === 'stdio' && isBundledCuaCommand(activeEntry.config.command, planBinary);
    }
    const candidates = enabledCuaEntries.length > 0 ? enabledCuaEntries : cuaEntries;
    return candidates.length === 0 || candidates.some((entry) => entry.config.transport === 'stdio' && isBundledCuaCommand(entry.config.command, planBinary));
  }, [activeEntry, activeKind, cuaEntries, enabledCuaEntries, planBinary, selectedConnection]);

  const preference = useComputerPreference(configQuery);

  const preferenceChoices: readonly SettingsChoice<'avoid' | 'prefer'>[] = [
    { value: 'avoid', label: t('st.computer.preference.avoid') },
    { value: 'prefer', label: t('st.computer.preference.prefer') },
  ];

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
      await Promise.all([
        configQuery.refetch(),
        capabilityQuery.refetch(),
        mcpQuery.refetch(),
      ]);
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
    if ((configQuery.isError && configQuery.data === undefined) || mcpQuery.isError) return 'unknown';
    if (activeKind === 'windows-mcp' || (selectedConnection !== undefined && activeKind !== 'cua')) {
      return 'external';
    }
    if (activeUsesCustomExecutor && !activeUsesBundledCua) {
      return 'external';
    }
    if (capabilityQuery.isPending) return 'checking';
    if (capabilityQuery.isError || capability === undefined) return 'unknown';
    if (capability.state !== 'ready' && !capability.install.running && !installing && activeUsesCustomExecutor) {
      return 'external';
    }
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
  const verdictText = ((): string => {
    if (verdict.kind === 'ready') {
      const configuredOnly = verdictExecutor === 'external'
        || capability?.state !== 'ready'
        || (selectedConnection === undefined && enabledCuaEntries.some((entry) => entry.config.transport === 'stdio' && !isBundledCuaCommand(entry.config.command, planBinary)));
      if (selectedConnection === undefined && enabledCuaEntries.length > 1) {
        return t(configuredOnly ? 'st.computer.verdict.readyConfiguredSet' : 'st.computer.verdict.readySet', {
          names: enabledCuaEntries.map((entry) => entry.name).join(', '),
        });
      }
      const name = selectedConnection ?? activeEntry?.name ?? t('st.computer.activeConnectionDefault');
      return t(configuredOnly ? 'st.computer.verdict.readyConfigured' : 'st.computer.verdict.ready', { name });
    }
    if (verdict.kind === 'connection_not_ready' && activeWindowsUnverified) {
      return t('st.computer.verdict.connectionUnverified', {
        name: selectedConnection ?? activeEntry?.name ?? 'kiki-windows-mcp',
      });
    }
    return t(VERDICT_KEYS[verdict.kind]);
  })();

  // The executor not installed is the one state the header's status sentence
  // leads with and the one action it offers: a single accent 安装 button,
  // nothing else red.
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
        {/* The 来源 tag names the layer only when it overrode the default; a
            plain stored choice earns no tag. */}
        {isConnectionOverridden ? (
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
          {t(activeWindowsUnverified ? 'st.computer.windowsMcp.unverified' : 'st.computer.windowsMcp.notServeReady')}
        </p>
      ) : null}
      <FeedbackLine feedback={connectionSave.error} />
    </div>
  ) : null;

  return (
    <div className="space-y-6" data-settings-computer-control>
      <SectionCard id="st-card-computer-enabled" title={t('st.computer.title')}>
        <CapabilityHeader
          title={t('st.computer.title')}
          verdict={{ kind: verdict.kind, tone: verdict.tone, text: verdictText, action: verdictAction ?? undefined }}
          enabled={isComputerEnabled}
          onEnabledChange={handleToggleEnabled}
          enabledLockedReason={computerHostLocked ? t('st.computer.verdict.hostLocked') : undefined}
          saving={enabledSave.saving}
          saved={enabledSave.saved}
          defaultOn={computerCapability === undefined ? undefined : {
            checked: computerCapability.default_on,
            locked: computerCapability.unresolved || computerCapability.host_locked,
          }}
          onDefaultOnChange={(next) => {
            void defaultSave.run(async () => {
              await client.patchConfig({ optional_capabilities: { defaults: { computer: next } } });
              await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
            });
          }}
          defaultOnSaving={defaultSave.saving}
          attrs={{
            enabled: 'data-computer-control-enabled',
            verdict: 'data-computer-verdict',
            enabledSwitch: 'data-computer-enabled-switch',
            defaultOn: 'data-capability-default-computer',
          }}
        >
          {isToolPolicyPartiallyDenied ? (
            <p className="text-[12px] text-amber-ink" data-computer-toolpolicy-partial>
              {t('st.computer.toolPolicyPartial')}
            </p>
          ) : null}
          <FeedbackLine feedback={enabledSave.error ?? defaultSave.error} />
        </CapabilityHeader>
      </SectionCard>

      <SectionCard id="st-card-computer-mcp" title={t('st.computer.connectionsTitle')}>
        <ComputerConnectionCard
          platform={platform}
          planBinary={capability?.plan?.destination}
          summary={connectionSummary}
          footer={platform === 'win32' ? <WindowsMcpRegistrationFold scopeId={scopeId} /> : null}
        />

        <AdvancedDetails summary={t('st.computer.advanced')} data-computer-advanced-fold>
          <div className="space-y-6 pt-1">
            {/* The machine facts and the executor's own checks, off the standing
                page: they matter when something fails, not every visit. */}
            <div className="space-y-2" id="st-card-computer-machine" data-settings-card="st-card-computer-machine">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px]" id="st-card-computer-setup" data-settings-card="st-card-computer-setup">
                <span className="text-ink-soft" id="computer-machine-label">{sshLabel ?? t('st.computer.machineLabel')}</span>
                <span className="font-mono text-ink" data-computer-platform aria-labelledby="computer-machine-label">{machineLine}</span>
                <span className="text-ink-faint" data-computer-bundled-executor-label>{t('st.computer.bundledExecutorLabel')}</span>
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

            {/* The model's own pull toward the computer tools: a policy, not a
                connection, so it lives in the fold with the other policy. */}
            <div className="space-y-3" id="st-card-computer-preference" data-settings-card="st-card-computer-preference">
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
                        value={preference.activePreference}
                        onChange={preference.choosePreference}
                        disabled={preference.isOverriddenByHigherSource || preference.preferenceSaving}
                        ariaLabelledBy="computer-preference-label"
                        dataAttr="data-computer-preference-choice"
                      />
                      {/* The 来源 tag names the layer the value came from only
                          when it is not the factory default; a plain stored
                          choice earns no tag. */}
                      {preference.preferenceSource !== 'default' ? (
                        <span
                          className="inline-flex items-center rounded bg-ink/[0.05] px-1.5 py-0.5 text-[11px] text-ink-soft"
                          data-computer-preference-source={preference.preferenceSource}
                        >
                          {t('st.computer.sourceTag', {
                            source: t(PREFERENCE_SOURCE_KEYS[preference.preferenceSource] ?? 'st.computer.source.default'),
                          })}
                        </span>
                      ) : null}
                      {preference.preferenceSource === 'home' && !preference.isOverriddenByHigherSource ? (
                        <button
                          type="button"
                          className={SECONDARY_BUTTON}
                          data-computer-preference-reset
                          disabled={preference.preferenceSaving}
                          onClick={() => { void preference.resetToInherited(); }}
                        >
                          {t('st.computer.restoreInherit')}
                        </button>
                      ) : null}
                      <SaveStatus saving={preference.preferenceSaving} saved={preference.isPreferenceSaved} />
                    </div>
                  </SettingField>

                  {preference.isOverriddenByHigherSource ? (
                    <p className="text-[12px] text-ink-soft" data-computer-preference-override-notice>
                      {t('st.computer.sourceOverridden', {
                        source: t(PREFERENCE_SOURCE_KEYS[preference.preferenceSource] ?? 'st.computer.source.default'),
                      })}
                    </p>
                  ) : null}

                  {configQuery.isError && configQuery.data !== undefined ? (
                    <InlineError error={configQuery.error} />
                  ) : null}

                  <FeedbackLine feedback={preference.preferenceFeedback} />
                </>
              )}
            </div>
          </div>
        </AdvancedDetails>
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
    <details className="text-[11px] text-ink-soft" data-computer-windows-mcp-register open={opened || undefined}>
      {/* Explicit state, not the DOM's own toggle: jsdom never fires the
          event, so a controlled `open` would always swallow the click. */}
      <summary
        className="cursor-pointer select-none font-medium text-ink-soft hover:text-ink"
        onClick={(event) => { event.preventDefault(); setOpened((current) => !current); }}
      >
        {t('st.computer.windowsMcp.registerSummary')}
      </summary>
      <div className="mt-1.5 space-y-1.5 leading-relaxed">
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
      </div>
    </details>
  );
}
