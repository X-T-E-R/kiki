import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { ExecutorCatalogItem } from '@kiki/protocol';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import type { ExecutorCheckResult } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { EXECUTORS_QUERY_KEY, useExecutorCatalogQuery } from './profileEditor/engines';

/** Row health in words: ready, needs attention (warnings / signed out), not found, not checked. */
export type EngineHealth = 'ready' | 'warning' | 'missing' | 'unknown';

type LoginStatus = ExecutorCheckResult['login_status'];

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

const PROTOCOL_LABEL: Record<string, string> = { 'acp-v1': 'ACP v1', acp: 'ACP', 'codex-app-server': 'Codex app-server' };

export function protocolLabel(protocol: string): string {
  return PROTOCOL_LABEL[protocol] ?? protocol;
}

/**
 * External engines as a connection kind. Same list family as the API /
 * account rows above it (one bordered list, a disclosure row per entry,
 * health in words, an explicit test action), but the facts are an engine's:
 * where its program was found, its version, whether it is signed in, and the
 * default arguments Kiki launches it with. Configuration stays in
 * config.toml; this surface reads and checks, it does not edit descriptors.
 */
export function ExternalEnginesList() {
  const { t } = useI18n();
  const query = useExecutorCatalogQuery();
  const engines = (query.data?.items ?? []).filter((item) => item.id !== 'native')
    .toSorted((a, b) => a.label.localeCompare(b.label));
  return (
    <div data-external-engines className="space-y-3">
      <p className="max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.engines.intro')}</p>
      {engines.length > 0 ? (
        <div data-engine-list className="overflow-hidden rounded-lg border border-hairline bg-panel">
          {engines.map((item) => <EngineRow key={item.id} item={item} />)}
        </div>
      ) : null}
      {query.isSuccess && engines.length === 0 ? (
        <div data-engines-empty className="rounded-lg border border-dashed border-hairline-strong px-4 py-4">
          <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.empty')}</p>
        </div>
      ) : null}
      {query.isLoading ? <Hint>{t('st.engines.loading')}</Hint> : null}
      {query.isError ? <InlineError error={query.error} /> : null}
      {engines.length > 0 ? <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.configHint')}</p> : null}
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
        className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-r-md px-1.5 text-[11.5px] text-ink-faint hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
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
 * launched program, then sign-in. Every step shows what was found (version,
 * path); the first unmet step carries the one command that moves it forward.
 * Driven only by `requirements` + `login_status`, so any engine whose
 * descriptor declares dependencies gets the same guide.
 */
function EngineSetup({ check, loginCommand }: { check: ExecutorCheckResult; loginCommand?: string }) {
  const { t } = useI18n();
  const requirements = check.requirements ?? [];
  const stage = engineSetupStage(check);
  const blockedIndex = stage.kind === 'install' ? requirements.indexOf(stage.requirement) : -1;
  const stateOf = (index: number): StepState =>
    blockedIndex === -1 || index < blockedIndex ? 'done' : index === blockedIndex ? 'current' : 'pending';
  const signInState: StepState = blockedIndex !== -1 ? 'pending'
    : check.login_status === 'logged_in' ? 'done' : check.login_status === 'logged_out' ? 'current' : 'unknown';
  return (
    <div data-engine-setup={stage.kind} className="space-y-2">
      <p className="text-[12px] font-medium text-ink-soft">{t('st.engines.setup')}</p>
      <ol className="space-y-2.5">
        {requirements.map((requirement, index) => {
          const state = stateOf(index);
          return (
            <li key={`${requirement.role}:${requirement.id}`} data-engine-step={requirement.role === 'program' ? 'program' : requirement.id}
              data-step-state={state} className="flex min-w-0 gap-2.5">
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
        <li data-engine-step="signin" data-step-state={signInState} className="flex min-w-0 gap-2.5">
          <StepMarker state={signInState} index={requirements.length + 1} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[12.5px] leading-5 text-ink">
              <span className="font-medium">{t('st.engines.login')}</span>
              <span className="text-ink-faint"> · {signInState === 'pending' ? t('st.engines.stepWaiting') : t(`st.engines.login.${check.login_status}`)}</span>
            </p>
            {signInState === 'current' || signInState === 'unknown' ? (
              <div className="space-y-1">
                <p className="text-[12px] leading-4 text-ink-soft">{t(signInState === 'current' ? 'st.engines.loginOut' : 'st.engines.loginUnknownBody')}</p>
                {loginCommand !== undefined ? <CopyCommand command={loginCommand} /> : null}
              </div>
            ) : null}
          </div>
        </li>
      </ol>
    </div>
  );
}

function EngineRow({ item }: { item: ExecutorCatalogItem }) {
  const { client } = useConnection();
  const { t, time, locale } = useI18n();
  const queryClient = useQueryClient();
  const [check, setCheck] = useState<ExecutorCheckResult | undefined>();
  const [checkedAt, setCheckedAt] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const connection = item.connection;
  const health = engineHealth(item, check);
  const healthText = t(HEALTH_KEY[health]);
  const login: LoginStatus = check?.login_status ?? connection?.login_status ?? 'unknown';
  // A check is the freshest fact: once one ran, an empty field means "not found", not "use the catalog".
  const version = check === undefined ? item.version : check.version;
  const programPath = check?.requirements?.find((requirement) => requirement.role === 'program')?.path;
  const program = check === undefined ? connection?.command : programPath ?? (check.command || undefined);
  const source = check === undefined ? connection?.source : check.selected_source;
  const args = check?.resolved_args ?? connection?.default_args ?? [];
  const loginCommand = connection?.login_command?.join(' ');
  const caps = item.capabilities;
  const setup = check?.requirements !== undefined && check.requirements.length > 0;

  const runCheck = async () => {
    if (checking) return;
    setChecking(true);
    setFeedback(null);
    try {
      const result = await client.checkExecutor(item.id);
      setCheck(result);
      setCheckedAt(new Date().toISOString());
      // GET serves the last check's sign-in result for 60s; let the profile
      // editor's engine picker see it too.
      await queryClient.invalidateQueries({ queryKey: EXECUTORS_QUERY_KEY });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setChecking(false);
    }
  };

  const summaryFacts = [
    t('st.engines.kind'),
    protocolLabel(item.protocol),
    version,
    health === 'missing' ? undefined : t(`st.engines.login.${login}`),
  ].filter((part): part is string => part !== undefined);

  return (
    <details data-engine-row={item.id} data-engine-health={health}
      className="group/engine border-b border-hairline last:border-b-0 [&[open]]:bg-paper">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-ink/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden">
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
          <span className="hidden sm:inline">{healthText}</span>
          <span className="sr-only sm:hidden">{healthText}</span>
        </span>
        <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/engine:rotate-90" />
      </summary>
      <div className="space-y-4 px-3 pb-4 pt-1 sm:pl-[3.25rem]">
        {setup ? <EngineSetup check={check!} loginCommand={loginCommand} /> : null}
        {health === 'missing' && !setup ? (
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
            {checking ? t('st.engines.checking') : check === undefined ? t('st.engines.check') : t('st.engines.recheck')}
          </button>
          <p data-engine-last-check={check?.status ?? 'none'} aria-live="polite" className="min-w-0 text-[12px] leading-4 text-ink-faint">
            {checking ? t('st.engines.checkingHint')
              : check === undefined ? t('st.engines.neverChecked')
                : <>
                  <span className={check.status === 'ready' ? 'text-success' : check.status === 'warning' ? 'text-amber-ink' : 'text-danger'}>
                    {t(check.status === 'ready' ? 'st.engines.checkedOk' : check.status === 'warning' ? 'st.engines.checkedWarning' : 'st.engines.checkedFailed')}
                  </span>
                  {checkedAt !== undefined ? <>{' · '}{time.relativeTime(checkedAt)}</> : null}
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
          {health === 'missing' || setup ? null : <Fact label={t('st.engines.login')} dataFact="login">
            <span className={login === 'logged_out' ? 'text-amber-ink' : login === 'unknown' ? 'text-ink-soft' : ''}>{t(`st.engines.login.${login}`)}</span>
            {login === 'unknown' && check === undefined ? <span className="block text-[12px] text-ink-faint">{t('st.engines.loginStale')}</span> : null}
            {login === 'logged_out' ? <span className="block text-[12px] text-ink-faint">{t('st.engines.loginOut')}</span> : null}
            {loginCommand !== undefined && login !== 'logged_in' ? (
              <span className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-ink-faint">{t('st.engines.loginCommand')}</span>
                <CopyCommand command={loginCommand} />
              </span>
            ) : null}
          </Fact>}
          <Fact label={t('st.engines.args')} dataFact="args">
            {args.length === 0 ? <span className="text-ink-faint">{t('st.engines.argsNone')}</span>
              : <code className="break-all font-mono text-[12px] text-ink-soft">{args.join(' ')}</code>}
          </Fact>
        </dl>
        <div data-engine-capabilities className="space-y-2 border-t border-hairline pt-3">
          <p className="text-[12px] font-medium text-ink-soft">{t('st.engines.capabilities')}</p>
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
          </dl>
          <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.capsDeclared')}</p>
        </div>
        {check !== undefined && check.diagnostics.length > 0 ? (
          <div data-engine-diagnostics className="space-y-1 border-t border-hairline pt-3">
            <p className="text-[12px] font-medium text-ink-soft">{t('st.engines.diagnostics')}</p>
            <ul className="space-y-1">
              {check.diagnostics.map((diagnostic, index) => (
                <li key={index} data-engine-diagnostic={diagnostic.severity} className="flex min-w-0 gap-2 text-[12px] leading-4">
                  <Icon name={diagnostic.severity === 'info' ? 'dot' : 'warning'} size={12}
                    className={`mt-0.5 shrink-0 ${diagnostic.severity === 'error' ? 'text-danger' : diagnostic.severity === 'warning' ? 'text-amber-ink' : 'text-ink-faint'}`} />
                  <span className="min-w-0 break-words text-ink-soft">{diagnostic.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div data-engine-integrations className="space-y-1 border-t border-hairline pt-3">
          <p className="text-[12px] font-medium text-ink-soft">{t('st.engines.integrations')}</p>
          <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.integrationsBody')}</p>
          {item.default_profile === true ? <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.defaultProfile')}</p> : null}
        </div>
        <FeedbackLine feedback={feedback} />
      </div>
    </details>
  );
}
