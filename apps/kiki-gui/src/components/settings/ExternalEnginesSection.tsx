import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { ExecutorCatalogItem } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import type { ExecutorCheckResult } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { localSessionEngine } from '../../lib/localSessions';
import { LocalSessionsEntry } from '../localSessions/LocalSessionsEntry';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../ui';
import { SidePanel } from '../SidePanel';
import { SettingsSegmented, type SettingsChoice } from './SettingsPrimitives';
import {
  applyExecutorCheck,
  configuredEngineDescriptors,
  engineDisplayOf,
  engineOverridesOf,
  engineVisibilityOf,
  engineVisibilityPatch,
  executorCatalogQueryKey,
  shouldAutoEnableEngine,
  useExecutorCatalogQuery,
} from './profileEditor/engines';
import { EngineDefaults } from './EngineDefaults';
import { ANTIGRAVITY_ID, AntigravitySetup } from './AntigravitySetup';
import { HARNESS_CAPABILITIES } from '../harness/HarnessMark';

/** Row health in words: ready, needs attention (warnings / signed out), not found, not checked. */
export type EngineHealth = 'ready' | 'warning' | 'missing' | 'unknown';

type LoginStatus = ExecutorCheckResult['login_status'];
type CredentialSource = NonNullable<ExecutorCheckResult['credential_source']>;

/**
 * Health from the freshest fact. An explicit check wins; otherwise the
 * catalog's binary discovery. `ready` from the catalog only means the binary
 * was found (B.1) — a known sign-out still lowers it to "needs attention".
 */
export function engineHealth(item: ExecutorCatalogItem, check: ExecutorCheckResult | undefined): EngineHealth {
  const login: LoginStatus = check?.login_status ?? item.connection?.login_status ?? 'unknown';
  const status = check?.status ?? item.status;
  if (status === 'unavailable' || check?.requirements?.some((requirement) => requirement.status !== 'ok') === true) return 'missing';
  if (status === 'unknown') return 'unknown';
  if (status === 'warning' || login === 'logged_out') return 'warning';
  return 'ready';
}

const HEALTH_KEY: Record<EngineHealth, I18nKey> = {
  ready: 'st.engines.statusReady',
  warning: 'st.engines.statusWarning',
  missing: 'st.engines.statusMissing',
  unknown: 'st.engines.statusUnknown',
};

const CREDENTIAL_KEY: Record<CredentialSource, I18nKey> = {
  oauth_login: 'st.engines.credential.oauth_login',
  api_key_env: 'st.engines.credential.api_key_env',
  auth_token_env: 'st.engines.credential.auth_token_env',
  settings_env: 'st.engines.credential.settings_env',
  api_key_helper: 'st.engines.credential.api_key_helper',
  api_key: 'st.engines.credential.api_key',
  external_backend: 'st.engines.credential.external_backend',
  none: 'st.engines.credential.none',
  unknown: 'st.engines.credential.unknown',
};

/** A named credential is worth stating; `none` and `unknown` carry no news. */
export function credentialLabel(source: CredentialSource | undefined): I18nKey | undefined {
  return source === undefined || source === 'none' || source === 'unknown' ? undefined : CREDENTIAL_KEY[source];
}

const PROTOCOL_LABEL: Record<string, string> = { 'acp-v1': 'ACP v1', acp: 'ACP', 'codex-app-server': 'Codex app-server' };

export function protocolLabel(protocol: string): string {
  return PROTOCOL_LABEL[protocol] ?? protocol;
}

/**
 * Whether one engine is offered in the profile / execution pickers, and the
 * switch that changes it.
 *
 * Display only, and the label says so: hiding an engine removes it from the
 * list a new conversation starts from. It does not uninstall it, does not
 * disable it, and does not stop a session that already runs it — an engine the
 * user stopped wanting to choose is still installed and still runs whatever is
 * bound to it. Stating that here is the point of the row: without it, "hide"
 * reads as "remove", and the recovery (turn it back on) looks unnecessary.
 */
function EngineVisibilityToggle({ item, overrides, display }: {
  item: ExecutorCatalogItem;
  overrides: Readonly<Record<string, unknown>> | undefined;
  display: Readonly<Record<string, unknown>> | undefined;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const prefs = engineVisibilityOf(overrides, display);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const visible = prefs.externalsVisible && prefs.enabled.has(item.id);

  const toggle = async (next: boolean) => {
    const patch = engineVisibilityPatch(prefs, { engine: { id: item.id, visible: next } });
    if (patch === undefined) return;
    setSaving(true);
    setFeedback(null);
    try {
      await client.patchConfig(patch);
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-engine-visible={item.id} data-visible={visible ? 'true' : 'false'}
      className="space-y-1 pt-3">
      <Toggle
        layout="row"
        label={t('st.engines.showInList', { engine: item.label })}
        checked={visible}
        disabled={saving || !prefs.externalsVisible}
        onChange={(next) => { void toggle(next); }}
      />
      <p className="text-[12px] leading-4 text-ink-faint">
        {prefs.externalsVisible ? t('st.engines.showInListHint') : t('st.engines.hiddenByGlobal')}
      </p>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

/**
 * The one switch for every external engine, on the engines section heading.
 * It changes what every row's own "offer in new choices" means at once, so it
 * sits above them; when it is off the list says so in one line.
 */
export function ExternalEnginesVisibilitySwitch() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000, retry: false });
  const prefs = engineVisibilityOf(engineOverridesOf(configQuery.data), engineDisplayOf(configQuery.data));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const toggle = async (next: boolean) => {
    const patch = engineVisibilityPatch(prefs, { externals: next });
    if (patch === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.patchConfig(patch);
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-external-visibility data-visible={prefs.externalsVisible ? 'true' : 'false'} className="flex items-center gap-2">
      {error !== undefined ? <span role="alert" className="max-w-[16rem] truncate text-[12px] text-danger" title={error}>{error}</span> : null}
      <Toggle
        label={t('st.engines.showAllInList')}
        checked={prefs.externalsVisible}
        disabled={saving || !configQuery.isSuccess}
        onChange={(next) => { void toggle(next); }}
      />
    </div>
  );
}

/**
 * External engines as a connection kind. Same list family as the API /
 * account rows above it (one bordered list, a disclosure row per entry,
 * health in words, an explicit test action), but the facts are an engine's:
 * where its program was found, its version, whether it is signed in, and the
 * default arguments Kiki launches it with. Configuration stays in
 * config.toml; this surface reads and checks, it does not edit descriptors.
 */
const discoveryRuns = new Set<string>();

/** Drops the in-memory "this server already started discovery" guard. Tests only. */
export function resetEngineDiscoveryRunsForTests(): void {
  discoveryRuns.clear();
}

export function ExternalEnginesList() {
  const { t, locale } = useI18n();
  const { client, scopeId, meta } = useConnection();
  const queryClient = useQueryClient();
  const catalogKey = executorCatalogQueryKey(scopeId, meta?.server_id);
  const query = useExecutorCatalogQuery();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000, retry: false });
  const overrides = engineOverridesOf(configQuery.data);
  const display = engineDisplayOf(configQuery.data);
  const engines = (query.data?.items ?? []).filter((item) => item.id !== 'native')
    .toSorted((a, b) => a.label.localeCompare(b.label));
  const [faults, setFaults] = useState<Readonly<Record<string, string>>>({});
  const [removalNote, setRemovalNote] = useState<string | undefined>();
  const engineIds = engines.map((item) => item.id).join('\0');
  const discoveryKey = `${scopeId}\0${meta?.server_id ?? ''}`;
  const ran = useRef(false);
  useEffect(() => {
    if (!configQuery.isSuccess || !query.isSuccess || engineIds === '') return;
    if (display?.['discovery_initialized'] === true || ran.current || discoveryRuns.has(discoveryKey)) return;
    ran.current = true;
    discoveryRuns.add(discoveryKey);
    const ids = engineIds.split('\0');
    void (async () => {
      try {
        await client.patchConfig({ agent_executor_display: { discovery_initialized: true } });
        await queryClient.invalidateQueries({ queryKey: ['config'] });
      } catch (error) {
        ran.current = false;
        discoveryRuns.delete(discoveryKey);
        setFaults({ '*': errorText(locale, error) });
        return;
      }
      await Promise.all(ids.map(async (id) => {
        try {
          const result = await client.checkExecutor(id);
          const checkedAt = new Date().toISOString();
          applyExecutorCheck(queryClient, catalogKey, id, result, checkedAt);
          setFaults((current) => {
            if (current[id] === undefined) return current;
            const next = { ...current };
            delete next[id];
            return next;
          });
          if (!shouldAutoEnableEngine(engineOverridesOf(await client.getConfig()), id, result.status)) return;
          await client.patchConfig({ agent_executor_overrides: { [id]: { show_in_profile_list: true } } });
        } catch (error) {
          setFaults((current) => ({ ...current, [id]: errorText(locale, error) }));
        }
      }));
      await queryClient.invalidateQueries({ queryKey: ['config'] });
      await queryClient.invalidateQueries({ queryKey: catalogKey });
    })();
  }, [catalogKey, client, configQuery.isSuccess, discoveryKey, display, engineIds, locale, query.isSuccess, queryClient]);
  const externalsVisible = engineVisibilityOf(overrides, display).externalsVisible;
  return (
    <div data-external-engines className="space-y-3">
      {faults['*'] !== undefined ? <p role="alert" data-engine-discovery-error className="text-[12px] leading-4 text-danger">{faults['*']}</p> : null}
      {engines.length > 0 && configQuery.isSuccess && !externalsVisible ? (
        <p data-engines-hidden-note className="text-[12px] leading-4 text-ink-faint">{t('st.engines.showAllInListOffHint')}</p>
      ) : null}
      {engines.length > 0 ? (
        <div data-engine-list className="overflow-hidden rounded-lg border border-hairline bg-panel">
          {removalNote !== undefined ? <p role="status" data-engine-removal-result className="border-b border-hairline px-3 py-2 text-[12px] leading-4 text-ink-soft">{removalNote}</p> : null}
          {engines.map((item) => <EngineRow key={item.id} item={item} overrides={overrides} display={display} fault={faults[item.id]} onRegistrationRemoved={setRemovalNote} />)}
        </div>
      ) : null}
      {query.isSuccess && engines.length === 0 ? (
        <div data-engines-empty className="space-y-1 rounded-lg border border-dashed border-hairline-strong px-4 py-4">
          <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.empty')}</p>
          <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.engines.intro')}</p>
        </div>
      ) : null}
      {query.isLoading ? <Hint>{t('st.engines.loading')}</Hint> : null}
      {query.isError ? <InlineError error={query.error} /> : null}
    </div>
  );
}

/** `wrap` keeps a long command fully readable (a pinned version at its end); one-liners truncate. */
function CopyCommand({ command, wrap = false }: { command: string; wrap?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-hairline bg-paper pl-2">
      <code className={`min-w-0 font-mono text-[11.5px] text-ink ${wrap ? 'break-all py-1 leading-4' : 'truncate'}`} title={command}>{command}</code>
      <button type="button" data-engine-copy aria-label={t('st.engines.copyCommand', { command })}
        onClick={() => { void copyTextToClipboard(command).then(() => { setCopied(true); setTimeout(() => { setCopied(false); }, 1500); }); }}
        className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-r-md px-1.5 text-[11.5px] text-ink-faint hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink">
        {copied ? t('st.engines.copied') : <Icon name="notes" size={12} />}
      </button>
    </span>
  );
}

/** Label / value line inside an expanded row; labels share one column on desktop. */
function Fact({ label, children, dataFact }: { label: string; children: React.ReactNode; dataFact?: string }) {
  return (
    <div data-engine-fact={dataFact} className="grid min-w-0 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-[12px] text-ink-faint">{label}</dt>
      <dd className="min-w-0 text-[12.5px] leading-5 text-ink">{children}</dd>
    </div>
  );
}

type Requirement = NonNullable<ExecutorCheckResult['requirements']>[number];

/** Where setup stands: the first requirement that is not installed, else sign-in, else ready. */
export type EngineSetupStage =
  | { readonly kind: 'install'; readonly requirement: Requirement }
  | { readonly kind: 'signin' }
  | { readonly kind: 'ready' };

export function engineSetupStage(check: ExecutorCheckResult): EngineSetupStage {
  const blocked = check.requirements?.find((requirement) => requirement.status !== 'ok');
  if (blocked !== undefined) return { kind: 'install', requirement: blocked };
  return check.login_status === 'logged_out' ? { kind: 'signin' } : { kind: 'ready' };
}

type StepState = 'done' | 'current' | 'pending' | 'unknown';

function StepMarker({ state, index }: { state: StepState; index: number }) {
  if (state === 'done') {
    return <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"><Icon name="check" size={12} /></span>;
  }
  return (
    <span aria-hidden className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums ${
      state === 'current' ? 'border-amber-rule bg-amber-rule/10 text-amber-ink' : 'border-hairline-strong text-ink-faint'}`}>
      {index}
    </span>
  );
}

/**
 * Setup as ordered steps from the check: each declared dependency, the
 * launched program, then the credential. Every step shows what was found
 * (version, path); the first unmet step carries the one command that moves it
 * forward. Driven only by `requirements` + `login_status`, so any engine whose
 * descriptor declares dependencies gets the same guide. An engine that accepts
 * an API key instead of a sign-in (`api_key_env`) offers both routes, because
 * Kiki reuses whichever credential the machine already has.
 */
function EngineSetup({ check, loginCommand, apiKeyEnv }: { check: ExecutorCheckResult; loginCommand?: string; apiKeyEnv?: string }) {
  const { t } = useI18n();
  const requirements = check.requirements ?? [];
  const stage = engineSetupStage(check);
  const blockedIndex = stage.kind === 'install' ? requirements.indexOf(stage.requirement) : -1;
  const stateOf = (index: number): StepState =>
    blockedIndex === -1 || index < blockedIndex ? 'done' : index === blockedIndex ? 'current' : 'pending';
  const signInState: StepState = blockedIndex !== -1 ? 'pending'
    : check.login_status === 'logged_in' ? 'done' : check.login_status === 'logged_out' ? 'current' : 'unknown';
  const credentialKey = credentialLabel(check.credential_source);
  const needsCredential = signInState === 'current' || signInState === 'unknown';
  return (
    <div data-engine-setup={stage.kind} className="space-y-2">
      <p className="text-[12px] font-medium text-ink-soft">{t('st.engines.setup')}</p>
      <ol className="space-y-2">
        {requirements.map((requirement, index) => {
          const state = stateOf(index);
          return (
            <li key={`${requirement.role}:${requirement.id}`} data-engine-step={requirement.role === 'program' ? 'program' : requirement.id}
              data-step-state={state} className="flex min-w-0 gap-2">
              <StepMarker state={state} index={index + 1} />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-[12.5px] leading-5 text-ink">
                  <span className="font-medium">{requirement.label}</span>
                  <span className="text-ink-faint"> · {state === 'done' ? requirement.version ?? t('st.engines.stepFound')
                    : state === 'pending' ? t('st.engines.stepWaiting')
                      : requirement.status === 'failed' ? t('st.engines.stepFailed') : t('st.engines.stepMissing')}</span>
                </p>
                {requirement.path !== undefined ? (
                  <p className="break-all font-mono text-[11px] leading-4 text-ink-faint" data-step-path>{requirement.path}</p>
                ) : null}
                {state === 'current' ? (
                  <div className="space-y-1">
                    <p className="text-[12px] leading-4 text-ink-soft">
                      {t(requirement.status === 'failed' ? 'st.engines.stepFailedBody' : 'st.engines.stepMissingBody', { program: requirement.label })}
                    </p>
                    {requirement.install_hint !== undefined ? <CopyCommand command={requirement.install_hint} wrap /> : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
        <li data-engine-step="signin" data-step-state={signInState} className="flex min-w-0 gap-2">
          <StepMarker state={signInState} index={requirements.length + 1} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[12.5px] leading-5 text-ink">
              <span className="font-medium">{t('st.engines.login')}</span>
              <span className="text-ink-faint"> · {signInState === 'pending' ? t('st.engines.stepWaiting')
                : credentialKey !== undefined ? t(credentialKey) : t(`st.engines.login.${check.login_status}`)}</span>
            </p>
            {needsCredential ? (
              <div className="space-y-1.5">
                <p className="text-[12px] leading-4 text-ink-soft">
                  {t(signInState === 'current' ? 'st.engines.loginOrKey' : 'st.engines.loginUnknownBody')}
                </p>
                {loginCommand !== undefined ? (
                  <div data-engine-route="login" className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-ink-faint">{t('st.engines.loginCommand')}</span>
                    <CopyCommand command={loginCommand} />
                  </div>
                ) : null}
                {apiKeyEnv !== undefined ? (
                  <div data-engine-route="api-key" className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-ink-faint">{t('st.engines.apiKeyCommand')}</span>
                    <CopyCommand command={`export ${apiKeyEnv}=YOUR_API_KEY`} />
                  </div>
                ) : null}
                {apiKeyEnv !== undefined ? (
                  <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.apiKeySettings', { env: apiKeyEnv })}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </li>
      </ol>
    </div>
  );
}
type EngineOverride = NonNullable<NonNullable<ExecutorCatalogItem['connection']>['override']>;

interface OverrideForm {
  readonly binPath: string;
  readonly homeDir: string;
  readonly extraArgs: string;
  readonly envText: string;
}

function overrideForm(override: EngineOverride | undefined): OverrideForm {
  return {
    binPath: override?.bin_path ?? '',
    homeDir: override?.home_dir ?? '',
    extraArgs: (override?.args ?? []).join(' '),
    envText: '',
  };
}

/** A path that carries a separator must be absolute; a bare command name is looked up on PATH. */
export function relativeOverridePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const absolute = trimmed.startsWith('/') || trimmed.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('~');
  const pathLike = /[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed) ||
    /%[^%]+%/.test(trimmed) || trimmed.includes('${');
  return pathLike && !absolute;
}

/** `KEY=VALUE` per line; an empty value means "remove this variable". */
export function parseOverrideEnvText(text: string):
  | { readonly ok: true; readonly patch: Record<string, string | null> }
  | { readonly ok: false; readonly line: string } {
  const patch: Record<string, string | null> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) return { ok: false, line };
    const key = line.slice(0, at).trim();
    if (key.length === 0) return { ok: false, line };
    const value = line.slice(at + 1).trim();
    patch[key] = value.length === 0 ? null : value;
  }
  return { ok: true, patch };
}

/**
 * Per-engine launch overrides, collapsed by default. They are stored in
 * `[agent_executor_overrides.<id>]` and used by both the check and the launch,
 * so a user can move a vendor CLI, relocate its configuration directory, add
 * flags or add variables without editing the descriptor.
 */
function overrideCheckFeedback(result: ExecutorCheckResult, t: ReturnType<typeof useI18n>['t']): Feedback {
  const diagnostic = result.diagnostics.find((item) => item.severity === 'error') ??
    result.diagnostics.find((item) => item.severity === 'warning');
  if (diagnostic !== undefined) return {
    tone: diagnostic.severity === 'warning' ? 'info' : 'error',
    text: diagnostic.message,
  };
  const missing = result.requirements?.find((requirement) => requirement.status !== 'ok');
  if (missing !== undefined) return {
    tone: 'error',
    text: `${missing.label}: ${missing.status === 'missing' ? 'not found' : 'check failed'}`,
  };
  return { tone: 'success', text: t('st.engines.checkedOk') };
}

type RunChoice = 'plain' | 'kiki';

/**
 * How one engine runs in new bindings: as is, or with the Kiki MCP bridge.
 *
 * The contract is unchanged — `agent_executor_overrides.<id>.defaults.
 * inject_kiki_mcp` is `true`, `false`, or `null` (follow the engine default).
 * A following engine highlights what that default currently is and says
 * nothing more on the row; a pinned one offers "follow default", which writes
 * `null`. An engine that cannot carry the bridge only states that it runs as
 * is. The row and the detail panel render the same control (`variant`), both
 * reading the shared config query, so they cannot disagree.
 */
const RUN_MODE_COPY = {
  en: {
    title: 'Run mode',
    plain: 'Run as is',
    kiki: 'With Kiki MCP',
    plainOnly: 'Run as is only',
    following: 'Following default',
    restore: 'Follow default',
  },
  zh: {
    title: '运行方式',
    plain: '原样运行',
    kiki: '接入 Kiki MCP',
    plainOnly: '仅原样运行',
    following: '跟随默认',
    restore: '恢复跟随',
  },
} as const;

function runModeCopy(locale: string) {
  return locale === 'zh' ? RUN_MODE_COPY.zh : RUN_MODE_COPY.en;
}

function EngineRunMode({ item, savedDefaults, onSaved, variant }: {
  item: ExecutorCatalogItem;
  savedDefaults: Record<string, unknown> | null | undefined;
  onSaved: () => Promise<void>;
  variant: 'row' | 'panel';
}) {
  const { client, scopeId, meta } = useConnection();
  const { t, locale } = useI18n();
  const copy = runModeCopy(locale);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const mcpInfo = item.kiki_mcp;
  const isUnsupported = mcpInfo?.support?.state === 'unsupported';
  const unsupportedFact = mcpInfo?.support?.fact ?? t('st.engines.mcpInject.unsupportedHint');

  const explicit = typeof savedDefaults?.['inject_kiki_mcp'] === 'boolean'
    ? savedDefaults['inject_kiki_mcp']
    : (mcpInfo?.source === 'harness-settings' && typeof mcpInfo.effective === 'boolean' ? mcpInfo.effective : undefined);
  const following = explicit === undefined;
  const inherited = mcpInfo?.source === 'harness-default' ? mcpInfo.effective : null;
  const effective = explicit ?? inherited;
  const shown: RunChoice | 'unset' = effective === true ? 'kiki' : effective === false ? 'plain' : 'unset';
  const explicitChoice: 'inherit' | 'on' | 'off' = explicit === true ? 'on' : explicit === false ? 'off' : 'inherit';

  const choices: SettingsChoice<RunChoice | 'unset'>[] = [
    { value: 'plain', label: copy.plain },
    { value: 'kiki', label: copy.kiki },
  ];

  const write = async (value: boolean | null) => {
    if (saving || isUnsupported) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.patchConfig({ agent_executor_overrides: { [item.id]: { defaults: { inject_kiki_mcp: value } } } });
      await queryClient.invalidateQueries({ queryKey: ['config'] });
      await queryClient.invalidateQueries({ queryKey: executorCatalogQueryKey(scopeId, meta?.server_id) });
      await onSaved();
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally {
      setSaving(false);
    }
  };

  const restore = following ? null : (
    <button type="button" data-mcp-restore disabled={saving} onClick={() => void write(null)}
      className="rounded px-1 text-[12px] text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink hover:decoration-ink disabled:cursor-not-allowed disabled:text-ink-faint">
      {copy.restore}
    </button>
  );
  const control = isUnsupported ? (
    <span data-mcp-unsupported-badge title={unsupportedFact} className="text-[12px] text-ink-faint">{copy.plainOnly}</span>
  ) : (
    <SettingsSegmented
      ariaLabel={`${copy.title} · ${item.label}`}
      choices={choices}
      value={shown}
      onChange={(next) => { if (next !== 'unset') void write(next === 'kiki'); }}
      disabled={saving}
      dataAttr="data-mcp-option"
    />
  );
  const data = {
    'data-engine-mcp-switch': item.id,
    'data-mcp-choice': explicitChoice,
    'data-mcp-effective': shown,
    'data-mcp-supported': isUnsupported ? 'false' : 'true',
  };

  if (variant === 'row') {
    return (
      <div {...data} className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
        {error !== undefined ? <span role="alert" className="max-w-[14rem] truncate text-[12px] text-danger" title={error}>{error}</span> : null}
        {restore}
        {control}
      </div>
    );
  }
  return (
    <div {...data} className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {control}
        {isUnsupported ? null : following ? <span className="text-[12px] text-ink-faint">{copy.following}</span> : restore}
      </div>
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{isUnsupported ? unsupportedFact : t('st.engines.mcpInject.hint')}</p>
      {error !== undefined ? <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p> : null}
    </div>
  );
}

function EngineOverrides({ item, program, onCheck }: { item: ExecutorCatalogItem; program?: string; onCheck: () => Promise<ExecutorCheckResult | undefined> }) {
  const { client, scopeId, meta } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const override = item.connection?.override;
  const homeEnv = item.connection?.home_env;
  const savedKey = `${override?.bin_path ?? ''}\u0000${override?.home_dir ?? ''}\u0000${(override?.args ?? []).join(' ')}`;
  const [loadedKey, setLoadedKey] = useState(savedKey);
  const [form, setForm] = useState<OverrideForm>(() => overrideForm(override));
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  if (loadedKey !== savedKey) {
    setLoadedKey(savedKey);
    setForm(overrideForm(override));
  }
  const envKeys = override?.env_keys ?? [];

  const save = async () => {
    if (relativeOverridePath(form.binPath) || relativeOverridePath(form.homeDir)) {
      setFeedback({ tone: 'error', text: t('st.engines.override.absolute') });
      return;
    }
    const env = parseOverrideEnvText(form.envText);
    if (!env.ok) {
      setFeedback({ tone: 'error', text: t('st.engines.override.envInvalid', { line: env.line }) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      await client.patchConfig({
        agent_executor_overrides: {
          [item.id]: {
            bin_path: form.binPath.trim().length === 0 ? null : form.binPath.trim(),
            home_dir: form.homeDir.trim().length === 0 ? null : form.homeDir.trim(),
            args: form.extraArgs.trim().length === 0 ? [] : form.extraArgs.trim().split(/\s+/),
            env: Object.keys(env.patch).length === 0 ? undefined : env.patch,
          },
        },
      });
      setForm((current) => ({ ...current, envText: '' }));
      await queryClient.invalidateQueries({ queryKey: executorCatalogQueryKey(scopeId, meta?.server_id) });
      const result = await onCheck();
      if (result !== undefined && shouldAutoEnableEngine(engineOverridesOf(await client.getConfig()), item.id, result.status)) {
        await client.patchConfig({ agent_executor_overrides: { [item.id]: { show_in_profile_list: true } } });
        await queryClient.invalidateQueries({ queryKey: ['config'] });
      }
      if (result !== undefined) setFeedback(overrideCheckFeedback(result, t));
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const validate = async () => {
    if (relativeOverridePath(form.binPath) || relativeOverridePath(form.homeDir)) {
      setFeedback({ tone: 'error', text: t('st.engines.override.absolute') });
      return;
    }
    setValidating(true);
    setFeedback(null);
    try {
      const result = await onCheck();
      if (result !== undefined) setFeedback(overrideCheckFeedback(result, t));
    } finally {
      setValidating(false);
    }
  };

  return (
    <details data-engine-advanced className="pt-3 [&[open]]:space-y-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-ink-soft [&::-webkit-details-marker]:hidden">
        <DisclosureChevron open={false} className="text-ink-faint" />
        {t('st.engines.advanced')}
      </summary>
      <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.override.hint')}</p>
      <div className="space-y-1">
        <label className="text-[12px] text-ink-soft" htmlFor={`${item.id}-bin`}>{t('st.engines.override.binPath')}</label>
        <input id={`${item.id}-bin`} data-engine-override="bin-path" className={`${INPUT} min-w-0 font-mono text-[11.5px]`}
          value={form.binPath} spellCheck={false} disabled={saving}
          placeholder={program === undefined ? t('st.engines.override.binPathPlaceholder') : t('st.engines.override.autoDetected', { value: program })}
          onChange={(event) => { setForm({ ...form, binPath: event.target.value }); }} />
        <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.override.binPathHint')}</p>
      </div>
      {homeEnv === undefined ? null : (
        <div className="space-y-1">
          <label className="text-[12px] text-ink-soft" htmlFor={`${item.id}-home`}>{t('st.engines.override.homeDir', { env: homeEnv })}</label>
          <input id={`${item.id}-home`} data-engine-override="home-dir" className={`${INPUT} min-w-0 font-mono text-[11.5px]`}
            value={form.homeDir} spellCheck={false} disabled={saving} placeholder={t('st.engines.override.homeDirPlaceholder', { env: homeEnv })}
            onChange={(event) => { setForm({ ...form, homeDir: event.target.value }); }} />
          <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.override.homeDirHint', { env: homeEnv })}</p>
        </div>
      )}
      <div className="space-y-1">
        <label className="text-[12px] text-ink-soft" htmlFor={`${item.id}-args`}>{t('st.engines.override.args')}</label>
        <input id={`${item.id}-args`} data-engine-override="args" className={`${INPUT} min-w-0 font-mono text-[11.5px]`}
          value={form.extraArgs} spellCheck={false} disabled={saving}
          onChange={(event) => { setForm({ ...form, extraArgs: event.target.value }); }} />
        <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.override.argsHint')}</p>
      </div>
      <div className="space-y-1">
        <label className="text-[12px] text-ink-soft" htmlFor={`${item.id}-env`}>{t('st.engines.override.env')}</label>
        <textarea id={`${item.id}-env`} data-engine-override="env" rows={3} spellCheck={false} disabled={saving}
          className={`${INPUT} min-w-0 font-mono text-[11.5px]`} placeholder={'KEY=VALUE'}
          value={form.envText} onChange={(event) => { setForm({ ...form, envText: event.target.value }); }} />
        <p className="text-[12px] leading-4 text-ink-faint">
          {t('st.engines.override.envHint', { keys: envKeys.length === 0 ? t('st.engines.override.envNone') : envKeys.join(', ') })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-engine-override-validate className={SECONDARY_BUTTON} disabled={saving || validating} aria-busy={validating}
          onClick={() => void validate()}>
          {validating ? t('st.engines.override.validating') : t('st.engines.override.validate')}
        </button>
        <button type="button" data-engine-override-save className={SECONDARY_BUTTON} disabled={saving || validating} aria-busy={saving}
          onClick={() => void save()}>
          {saving ? t('st.engines.override.saving') : t('st.engines.override.save')}
        </button>
        <span className="text-[12px] text-ink-faint">{t('st.engines.override.recheck')}</span>
      </div>
      <FeedbackLine feedback={feedback} />
    </details>
  );
}


/**
 * One engine's saved `defaults` block, read from the config's raw record.
 * The wire keeps launch keys and defaults under the same executor entry, so
 * only the `defaults` sub-object is this editor's business.
 */
export function engineDefaultsOf(raw: Readonly<Record<string, unknown>> | undefined, executorId: string): Record<string, unknown> | null | undefined {
  const overrides = raw?.['agent_executor_overrides'];
  if (typeof overrides !== 'object' || overrides === null) return undefined;
  const entry = (overrides as Record<string, unknown>)[executorId];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const defaults = (entry as Record<string, unknown>)['defaults'];
  if (defaults === null) return null;
  return typeof defaults === 'object' && !Array.isArray(defaults) ? defaults as Record<string, unknown> : undefined;
}

function catalogCheckOf(item: ExecutorCatalogItem): ExecutorCheckResult | undefined {
  if (item.check_status === undefined || item.checked_at === undefined) return undefined;
  return {
    id: item.id,
    status: item.check_status,
    version: item.version,
    command: item.connection?.command ?? '',
    selected_source: item.connection?.source,
    resolved_args: item.connection?.default_args ?? [],
    login_status: item.connection?.login_status ?? 'unknown',
    credential_source: item.connection?.credential_source,
    credential_detail: item.connection?.credential_detail,
    diagnostics: [],
  };
}

function registrationRemovalText(locale: string, result: {
  registration_removed: boolean;
  builtin_retained: boolean;
  resources: 'removed' | 'retained' | 'not_owned';
  reason?: string;
}): string {
  const zh = locale === 'zh';
  const registration = result.registration_removed
    ? (zh ? '自定义注册已移除。' : 'Custom registration removed.')
    : (zh ? '没有可移除的自定义注册。' : 'No custom registration was stored.');
  const builtin = result.builtin_retained
    ? (zh ? '内置引擎仍保留。' : 'The built-in engine stays.')
    : undefined;
  const resources = result.resources === 'removed'
    ? (zh ? '所拥有的适配器文件已移除。' : 'Owned adapter files were removed.')
    : undefined;
  return [registration, builtin, resources, result.reason].filter((part): part is string => part !== undefined && part !== '').join(' ');
}

function EngineRow({ item, overrides, display, fault, onRegistrationRemoved }: {
  item: ExecutorCatalogItem;
  /** The config's `agent_executor_overrides` record, for the per-engine display choice. */
  overrides: Readonly<Record<string, unknown>> | undefined;
  /** The config's `agent_executor_display` record, for the global switch. */
  display: Readonly<Record<string, unknown>> | undefined;
  /** This engine's own check failure. It never changes another row. */
  fault?: string;
  onRegistrationRemoved?: (text: string) => void;
}) {
  const { client, scopeId, meta } = useConnection();
  const { t, time, locale } = useI18n();
  const queryClient = useQueryClient();
  const [check, setCheck] = useState<ExecutorCheckResult | undefined>();
  const [checkedAt, setCheckedAt] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [localFault, setLocalFault] = useState<string | undefined>();
  // The saved per-engine defaults live in the config's raw record, keyed by
  // executor id. A config that does not echo the section simply has none.
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => client.getConfig(),
    staleTime: 60_000,
    retry: false,
  });
  const refetchConfig = useCallback(async () => { await configQuery.refetch(); }, [configQuery]);
  const connection = item.connection;
  const config = configQuery.data;
  const customRegistration = Object.hasOwn(configuredEngineDescriptors(config) ?? {}, item.id);
  const [removing, setRemoving] = useState(false);
  const shown = check ?? catalogCheckOf(item);
  const faultText = localFault ?? (shown === undefined ? fault : undefined);
  const health = faultText !== undefined && shown === undefined ? 'warning' : engineHealth(item, shown);
  const healthText = t(HEALTH_KEY[health]);
  const login: LoginStatus = shown?.login_status ?? connection?.login_status ?? 'unknown';
  const credential = shown?.credential_source ?? connection?.credential_source;
  const credentialDetail = shown?.credential_detail ?? connection?.credential_detail;
  const credentialKey = credentialLabel(credential);
  const apiKeyEnv = connection?.api_key_env;
  // A check is the freshest fact: once one ran, an empty field means "not found", not "use the catalog".
  const version = shown === undefined ? item.version : shown.version;
  const programPath = shown?.requirements?.find((requirement) => requirement.role === 'program')?.path;
  const program = shown === undefined ? connection?.command : programPath ?? (shown.command || undefined);
  const source = shown === undefined ? connection?.source : shown.selected_source;
  const args = shown?.resolved_args ?? connection?.default_args ?? [];
  const loginCommand = connection?.login_command?.join(' ');
  const caps = item.capabilities;
  const setup = shown?.requirements !== undefined && shown.requirements.length > 0;
  // Kiki installs and signs in Antigravity's ACP CLI itself; the generic
  // "copy this command" guide would show a sentence as a command.
  const antigravity = item.id === ANTIGRAVITY_ID;

  const runCheck = async (): Promise<ExecutorCheckResult | undefined> => {
    if (checking) return undefined;
    setChecking(true);
    setFeedback(null);
    setLocalFault(undefined);
    try {
      const result = await client.checkExecutor(item.id);
      const at = new Date().toISOString();
      setCheck(result);
      setCheckedAt(at);
      applyExecutorCheck(queryClient, executorCatalogQueryKey(scopeId, meta?.server_id), item.id, result, at);
      await queryClient.invalidateQueries({ queryKey: executorCatalogQueryKey(scopeId, meta?.server_id) });
      return result;
    } catch (error) {
      const text = errorText(locale, error);
      setLocalFault(text);
      setFeedback({ tone: 'error', text });
      return undefined;
    } finally {
      setChecking(false);
    }
  };

  const removeRegistration = async () => {
    if (removing || !customRegistration) return;
    setRemoving(true);
    setFeedback(null);
    try {
      const result = await client.removeExecutorRegistration(item.id);
      const text = registrationRemovalText(locale, result);
      setFeedback({ tone: result.resources === 'removed' ? 'success' : 'info', text });
      onRegistrationRemoved?.(text);
      await queryClient.invalidateQueries({ queryKey: ['config'] });
      await queryClient.invalidateQueries({ queryKey: executorCatalogQueryKey(scopeId, meta?.server_id) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRemoving(false);
    }
  };

  const summaryFacts = [
    t('st.engines.kind'),
    protocolLabel(item.protocol),
    version,
    health === 'missing' ? undefined : credentialKey === undefined ? t(`st.engines.login.${login}`) : t(credentialKey),
  ].filter((part): part is string => part !== undefined);
  const savedDefaults = engineDefaultsOf(config?.raw, item.id);
  const [open, setOpen] = useState(false);

  // One row per engine: what it is and whether it works on the left, how it
  // runs on the right — the one choice people make here every day. The rest
  // (setup, checks, parameters, diagnostics) opens beside the list, so the
  // list stays a list. The row itself opens the panel; the run-mode control
  // keeps its clicks to itself.
  return (
    <>
    <div data-engine-row={item.id} data-engine-health={health} data-engine-open-state={open ? 'open' : 'closed'}
      onClick={() => { setOpen(true); }}
      className="group/engine flex min-h-14 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-3 py-2 transition-colors last:border-b-0 hover:bg-ink/[0.03]">
      <button type="button" data-engine-open aria-haspopup="dialog"
        onClick={(event) => { event.stopPropagation(); setOpen(true); }}
        className="-my-1 flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40">
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink/[0.05] text-ink-soft">
          <Icon name="terminal" size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{item.label}</span>
            <span className="hidden truncate font-mono text-[11px] text-ink-faint sm:inline">{item.id}</span>
          </span>
          <span data-engine-summary className="block truncate text-[12px] text-ink-faint">{summaryFacts.join(' · ')}</span>
        </span>
        <span data-engine-status={health}
          className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${
            health === 'missing' ? 'text-danger' : health === 'warning' ? 'text-amber-ink' : 'text-ink-faint'}`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${
            health === 'missing' ? 'bg-danger' : health === 'warning' ? 'bg-amber-rule' : health === 'unknown' ? 'bg-ink-faint' : 'bg-success'}`} />
          <span className="hidden md:inline">{healthText}</span>
          <span className="sr-only md:hidden">{healthText}</span>
        </span>
      </button>
      <div data-engine-row-run className="order-last w-full pl-10 sm:order-none sm:w-auto sm:pl-0"
        onClick={(event) => { event.stopPropagation(); }}>
        <EngineRunMode item={item} savedDefaults={savedDefaults} onSaved={refetchConfig} variant="row" />
      </div>
      <Icon name="chevron" size={12} className="shrink-0 text-ink-faint transition-colors group-hover/engine:text-ink-soft" />
    </div>
      {open ? (
        <SidePanel
          title={item.label}
          description={summaryFacts.join(' · ')}
          overlayId="settings-engine-detail"
          onClose={() => { setOpen(false); }}
          width="lg"
          data={{ 'data-engine-panel-overlay': item.id }}
        >
          <div data-engine-panel={item.id} className="space-y-6">
            <div className="space-y-4">
              {antigravity ? <AntigravitySetup login={login} onChanged={() => void runCheck()}
                ideDetected={shown?.diagnostics.some((diagnostic) => diagnostic.code === 'antigravity_ide_not_acp') === true} /> : null}
              {setup && !antigravity && shown !== undefined ? <EngineSetup check={shown} loginCommand={loginCommand} apiKeyEnv={apiKeyEnv} /> : null}
              {health === 'missing' && !setup && !antigravity ? (
                <div role="alert" data-engine-missing className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
                  <p className="text-[12px] leading-4 text-ink-soft">{t('st.engines.notFoundBody', { program: program ?? item.label })}</p>
                  {connection?.install_hint !== undefined ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="text-[12px] text-ink-faint">{t('st.engines.install')}</span>
                      <CopyCommand command={connection.install_hint} />
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div data-engine-check className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <button type="button" data-engine-check-button className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                  disabled={checking} aria-busy={checking} onClick={() => void runCheck()}>
                  {checking ? <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" /> : null}
                  {checking ? t('st.engines.checking') : shown === undefined ? t('st.engines.check') : t('st.engines.recheck')}
                </button>
                <p data-engine-last-check={faultText !== undefined && shown === undefined ? 'failed' : shown?.status ?? 'none'}
                  data-engine-check-stale={item.check_stale === true && check === undefined ? 'true' : undefined}
                  aria-live="polite" className="min-w-0 text-[12px] leading-4 text-ink-faint">
                  {checking ? t('st.engines.checkingHint')
                    : faultText !== undefined && shown === undefined ? <span className="text-danger">{faultText}</span>
                      : shown === undefined ? t('st.engines.neverChecked')
                      : <>
                        <span className={shown.status === 'ready' ? 'text-success' : shown.status === 'warning' ? 'text-amber-ink' : 'text-danger'}>
                          {t(shown.status === 'ready' ? 'st.engines.checkedOk' : shown.status === 'warning' ? 'st.engines.checkedWarning' : 'st.engines.checkedFailed')}
                        </span>
                        {(checkedAt ?? item.checked_at) !== undefined ? <>{' · '}{time.relativeTime(checkedAt ?? item.checked_at!)}</> : null}
                      </>}
                </p>
              </div>
              <dl className="space-y-2">
                <Fact label={t('st.engines.program')} dataFact="program">
                  {program !== undefined ? <span className="break-all font-mono text-[12px]">{program}</span> : <span className="text-ink-faint">{t('st.engines.versionUnknown')}</span>}
                  {source !== undefined ? <span className="block text-[12px] text-ink-faint">{t('st.engines.source')} <span className="font-mono text-[11.5px]">{source}</span></span> : null}
                </Fact>
                <Fact label={t('st.engines.version')} dataFact="version">
                  {version ?? <span className="text-ink-faint">{t('st.engines.versionUnknown')}</span>}
                  <span className="text-ink-faint"> · {protocolLabel(item.protocol)}</span>
                </Fact>
                {health === 'missing' || setup || antigravity ? null : <Fact label={t('st.engines.login')} dataFact="login">
                  <span className={login === 'logged_out' ? 'text-amber-ink' : login === 'unknown' ? 'text-ink-soft' : ''}>{t(`st.engines.login.${login}`)}</span>
                  {credentialKey !== undefined ? <span data-engine-credential={credential} className="block text-[12px] text-ink-faint">
                    {t(credentialKey)}
                    {credentialDetail !== undefined ? <span className="font-mono text-[11.5px]"> · {credentialDetail}</span> : null}
                  </span> : null}
                  {login === 'unknown' && shown === undefined ? <span className="block text-[12px] text-ink-faint">{t('st.engines.loginStale')}</span> : null}
                  {login === 'logged_out' ? <span className="block text-[12px] text-ink-faint">{t('st.engines.loginOrKey')}</span> : null}
                  {loginCommand !== undefined && login !== 'logged_in' ? (
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-[12px] text-ink-faint">{t('st.engines.loginCommand')}</span>
                      <CopyCommand command={loginCommand} />
                    </span>
                  ) : null}
                  {apiKeyEnv !== undefined && login !== 'logged_in' ? (
                    <span className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-[12px] text-ink-faint">{t('st.engines.apiKeyCommand')}</span>
                      <CopyCommand command={`export ${apiKeyEnv}=YOUR_API_KEY`} />
                    </span>
                  ) : null}
                </Fact>}
              </dl>
            </div>

            <section data-engine-section="run" className="space-y-3 pt-5">
              <h3 className="text-[13px] font-medium text-ink">{runModeCopy(locale).title}</h3>
              <EngineRunMode item={item} savedDefaults={savedDefaults} onSaved={refetchConfig} variant="panel" />
              <EngineDefaults item={item} saved={savedDefaults} onSaved={refetchConfig} />
            </section>

            <section data-engine-section="offer" className="space-y-3">
              <EngineVisibilityToggle item={item} overrides={overrides} display={display} />
              {item.default_profile === true ? <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.defaultProfile')}</p> : null}
              {localSessionEngine(item.id) !== undefined ? (
                <div data-engine-local-sessions className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-ink-soft">{t('localSessions.settingsTitle')}</p>
                    <p className="text-[12px] leading-4 text-ink-faint">{t('localSessions.settingsHint', { engine: item.label })}</p>
                  </div>
                  <LocalSessionsEntry executorId={item.id} variant="button" />
                </div>
              ) : null}
            </section>

            <section data-engine-section="details" className="space-y-4 pt-5">
              {shown !== undefined && shown.diagnostics.length > 0 ? (
                <div data-engine-diagnostics className="space-y-1">
                  <p className="text-[12px] font-medium text-ink-soft">{t('st.engines.diagnostics')}</p>
                  <ul className="space-y-1">
                    {shown.diagnostics.map((diagnostic, index) => (
                      <li key={index} data-engine-diagnostic={diagnostic.severity} className="flex min-w-0 gap-2 text-[12px] leading-4">
                        <Icon name={diagnostic.severity === 'info' ? 'dot' : 'warning'} size={12}
                          className={`mt-0.5 shrink-0 ${diagnostic.severity === 'error' ? 'text-danger' : diagnostic.severity === 'warning' ? 'text-amber-ink' : 'text-ink-faint'}`} />
                        <span className="min-w-0 break-words text-ink-soft">{diagnostic.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <details data-engine-capabilities className="group/caps [&[open]]:space-y-2">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-ink-soft [&::-webkit-details-marker]:hidden">
                  <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/caps:rotate-90" />
                  {t('st.engines.capabilities')}
                </summary>
                <dl className="space-y-1.5">
                  <Fact label={t('st.engines.cap.prompt')} dataFact="cap-prompt">
                    {caps === undefined ? <span className="text-ink-faint">{t('st.engines.versionUnknown')}</span>
                      : caps.prompt_deliveries.map((delivery) => t(`st.executorPrompt.delivery.${delivery}`)).join(' · ')}
                  </Fact>
                  <Fact label={t('st.engines.cap.steer')} dataFact="cap-steer">
                    {caps === undefined ? <span className="text-ink-faint">{t('st.engines.versionUnknown')}</span> : t(`st.engines.steer.${caps.steer}`)}
                  </Fact>
                  <Fact label={t('st.engines.cap.model')} dataFact="cap-model">
                    {t(item.model_binding === 'mapped' ? 'st.engines.cap.mapped' : 'st.engines.cap.unavailable')}
                  </Fact>
                  <Fact label={t('st.engines.cap.thinking')} dataFact="cap-thinking">
                    {t(item.thinking_binding === 'mapped' ? 'st.engines.cap.mapped' : 'st.engines.cap.unavailable')}
                  </Fact>
                  <Fact label={t('st.engines.cap.permission')} dataFact="cap-permission">
                    {caps === undefined ? <span className="text-ink-faint">{t('st.engines.versionUnknown')}</span> : <>
                      {t(caps.permission.via === undefined ? 'st.engines.permission.none' : `st.engines.permission.${caps.permission.via}`)}
                      {caps.permission.trust_engine_settings ? <span className="text-ink-faint"> · {t('st.engines.permissionTrust')}</span> : null}
                    </>}
                  </Fact>
                  <Fact label={t('st.engines.args')} dataFact="args">
                    {args.length === 0 ? <span className="text-ink-faint">{t('st.engines.argsNone')}</span>
                      : <code className="break-all font-mono text-[12px] text-ink-soft">{args.join(' ')}</code>}
                  </Fact>
                  {caps?.negotiated !== undefined ? (
                    <Fact label={t('st.engines.cap.handshake')} dataFact="cap-handshake">
                      {caps.negotiated.agent_version !== undefined ? <span className="font-mono text-[12px]">{caps.negotiated.agent_version}</span> : null}
                      <span className="block text-[12px] text-ink-soft">
                        {HARNESS_CAPABILITIES.filter(({ key }) => caps.negotiated?.[key] === true).map(({ label }) => t(label)).join(' · ')
                          || t('st.engines.cap.handshakeNone')}
                      </span>
                    </Fact>
                  ) : null}
                </dl>
                <p className="text-[12px] leading-4 text-ink-faint">{t(caps?.negotiated !== undefined ? 'st.engines.capsNegotiated' : 'st.engines.capsDeclared')}</p>
              </details>
              <EngineOverrides item={item} program={program} onCheck={runCheck} />
              <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.configHint')}</p>
            </section>

            {customRegistration ? (
              <section data-engine-registration={item.id} className="space-y-1.5 pt-5">
                <button type="button" data-engine-remove-registration className={DANGER_GHOST_BUTTON}
                  disabled={removing} aria-busy={removing} onClick={() => { void removeRegistration(); }}>
                  {t('common.remove')}
                </button>
                <p className="text-[12px] leading-4 text-ink-faint">
                  {locale === 'zh'
                    ? '只移出这项自定义注册。活动或可恢复的绑定会留下适配器文件，原因显示在这里。内置引擎不会被删除。'
                    : 'Removes this custom registration only. A live or recoverable binding keeps its adapter files, and the reason is shown here. A built-in engine is not deleted.'}
                </p>
              </section>
            ) : null}
            <FeedbackLine feedback={feedback} />
          </div>
        </SidePanel>
      ) : null}
    </>
  );
}
