import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  AntigravityAuthMethod,
  AntigravityLoginFlowKind,
  AntigravityLoginRequest,
  AntigravityLoginStartResponse,
  AntigravityModelEntry,
  AntigravityProfileStatus,
  AntigravityStatusResponse,
} from '@kiki/protocol';
import type { KlientEventPayloads } from '@kiki/klient';
import { formatBytes } from '@kiki/session-core/composer/media';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useHost } from '../../host';
import { openExternalUrl } from '../../host/external';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SettingsSegmented } from './SettingsPrimitives';
import { EXECUTORS_QUERY_KEY } from './profileEditor/engines';
import { isImeKeyEvent } from '../../lib/shortcuts';

export const ANTIGRAVITY_ID = 'antigravity-acp';

function binariesKey(instanceId?: string) {
  return instanceId === undefined
    ? (['executors', ANTIGRAVITY_ID, 'binaries'] as const)
    : (['executors', ANTIGRAVITY_ID, 'binaries', instanceId] as const);
}

type Pending = Extract<AntigravityLoginStartResponse, { already_signed_in: false }> & { readonly startedAt: number };
export type LoginStatus = 'logged_in' | 'logged_out' | 'unknown';

/** A 1.x release number, the only line Kiki drives (the IDE's 1.107 is not one). */
export function antigravityVersionValid(value: string): boolean {
  return /^1\.\d+\.\d+$/.test(value.trim());
}

export type InstallProgressEvent = KlientEventPayloads['executors.antigravityInstallProgress'];

/** What the install bar shows: the stage in progress and, while downloading, how far. */
export interface InstallProgressView {
  readonly installId: string;
  readonly stage: 'download' | 'extract' | 'activate';
  readonly receivedBytes: number;
  readonly totalBytes?: number;
}

/**
 * Folds pushed install steps into the bar. Only the install this card started
 * (by version) is shown; a step from another install id replaces an older one,
 * and terminal steps clear the bar — the request's own reply reports them.
 */
export function reduceInstallProgress(current: InstallProgressView | null, event: InstallProgressEvent, version: string | null): InstallProgressView | null {
  if (version === null || event.version !== version) return current;
  if (event.stage === 'done' || event.stage === 'failed') return current?.installId === event.installId || current === null ? null : current;
  if (event.stage === 'download') {
    return { installId: event.installId, stage: 'download', receivedBytes: event.receivedBytes, totalBytes: event.totalBytes };
  }
  return {
    installId: event.installId,
    stage: event.stage,
    receivedBytes: current?.installId === event.installId ? current.receivedBytes : 0,
    totalBytes: current?.installId === event.installId ? current.totalBytes : undefined,
  };
}

/** Resolves whether a pending browser flow uses Google's official code-paste page or a local loopback URL. */
export function resolveLoginFlowKind(
  pending: Pick<Extract<AntigravityLoginStartResponse, { already_signed_in: false }>, 'flow_kind' | 'redirect_uri'>,
): AntigravityLoginFlowKind {
  if (pending.flow_kind !== undefined) return pending.flow_kind;
  return pending.redirect_uri.includes('antigravity.google') ? 'code_paste' : 'loopback_url';
}

/** Validates pasted input for either `code_paste` (auth code or callback URL) or `loopback_url`. */
export function isAntigravityPasteValid(value: string, flowKind: AntigravityLoginFlowKind): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (flowKind === 'code_paste') {
    return /^https?:\/\/\S+$/i.test(trimmed) || (trimmed.length >= 4 && !/\s/.test(trimmed));
  }
  return /^https?:\/\/\S+$/i.test(trimmed);
}

/**
 * The sentence for a sign-in that did not complete, chosen by the server's
 * `message_code`; servers that predate the code fall back to `retryable`.
 * The server's own `message` is shown only as the tooltip.
 */
export function loginOutcomeKey(
  outcome: {
    readonly retryable: boolean;
    readonly message_code?: 'callback_mismatch' | 'signin_failed' | 'subscription_required' | 'configuration_invalid';
  },
  flowKind?: AntigravityLoginFlowKind,
) {
  if (outcome.message_code === 'subscription_required') return 'st.antigravity.subscriptionRequired' as const;
  if (outcome.message_code === 'configuration_invalid') return 'st.antigravity.configurationInvalid' as const;
  if (outcome.message_code === 'callback_mismatch') {
    return flowKind === 'code_paste' ? ('st.antigravity.pasteCodeRetry' as const) : ('st.antigravity.pasteRetry' as const);
  }
  if (outcome.message_code === 'signin_failed') return 'st.antigravity.signInRejected' as const;
  return outcome.retryable
    ? (flowKind === 'code_paste' ? ('st.antigravity.pasteCodeRetry' as const) : ('st.antigravity.pasteRetry' as const))
    : ('st.antigravity.flowEnded' as const);
}

/** Formats the sign-in step label and color preserving all three login states. */
export function loginStatusDisplay(loginStatus: LoginStatus, ready: boolean) {
  if (!ready) return { key: 'st.engines.stepWaiting' as const, className: 'text-ink-faint' };
  return {
    key: `st.engines.login.${loginStatus}` as const,
    className: loginStatus === 'logged_out' ? 'text-amber-ink' : loginStatus === 'unknown' ? 'text-ink-soft' : '',
  };
}

/** Seconds left on a sign-in, never negative. */
export function secondsLeft(pending: { startedAt: number; expires_in_secs: number }, now: number): number {
  return Math.max(0, Math.ceil(pending.expires_in_secs - (now - pending.startedAt) / 1000));
}

const AUTH_METHOD_LABEL_KEY: Record<AntigravityAuthMethod, I18nKey> = {
  'oauth-personal': 'st.antigravity.personal',
  'oauth-business': 'st.antigravity.business',
  'gemini-api-key': 'st.antigravity.apiKey',
  'agent-platform': 'st.antigravity.vertex',
};

const AUTH_METHOD_BODY_KEY: Record<AntigravityAuthMethod, I18nKey> = {
  'oauth-personal': 'st.antigravity.signInBody',
  'oauth-business': 'st.antigravity.signInBodyBusiness',
  'gemini-api-key': 'st.antigravity.signInBodyApiKey',
  'agent-platform': 'st.antigravity.signInBodyVertex',
};

export function formatAntigravityModelLabel(entry: AntigravityModelEntry): string {
  if (entry.label !== undefined && entry.label.trim() !== '') return entry.label.trim();
  return entry.id;
}

/** True when a managed CLI version is active OR an external PATH/custom CLI is already detected ready. */
export function isAntigravityProgramReady(activeVersion: string | undefined, ready: boolean): boolean {
  return (activeVersion !== undefined && activeVersion.trim() !== '') || ready;
}

/**
 * Antigravity setup inside its engine row (and every configured multi-account
 * instance): manages Google's official `agy` 1.5+ CLI runtime, live update
 * checks, isolated per-instance authentication across all 4 auth modes, and
 * account-entitled models.
 */
export function AntigravitySetup({ login, ideDetected = false, ready = false, instanceId, onChanged }: {
  login: LoginStatus;
  /** The last check found the Antigravity IDE where the ACP CLI was expected. */
  ideDetected?: boolean;
  /** True when a PATH or custom-path `agy` CLI is detected ready without a Kiki-managed version. */
  ready?: boolean;
  /** Configured Antigravity instance ID, when managing an isolated account instance. */
  instanceId?: string;
  onChanged: () => void;
}) {
  const { client, klient } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const queryKey = binariesKey(instanceId);
  const binaries = useQuery({
    queryKey,
    queryFn: () => client.getAntigravityBinaries({ instance_id: instanceId, check_updates: true }),
    staleTime: 30_000,
    retry: false,
  });
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgressView | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const timedOutRef = useRef(false);
  useEffect(() => {
    if (installing === null) { setProgress(null); return; }
    timedOutRef.current = false;
    const subscription = klient.events.on('executors.antigravityInstallProgress', (event) => {
      if (event.stage === 'failed' && event.version === installing) timedOutRef.current = event.timedOut;
      setProgress((current) => reduceInstallProgress(current, event, installing));
    });
    return () => { subscription.dispose(); };
  }, [klient, installing]);
  const [activating, setActivating] = useState<string | null>(null);
  const [customVersion, setCustomVersion] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [loginStatus, setLoginStatus] = useState<LoginStatus>(login);
  useEffect(() => { setLoginStatus(login); }, [login]);

  const status = binaries.data;
  const profile = status?.profile;
  const effectiveLoginStatus: LoginStatus =
    profile?.signed_in === true ? 'logged_in'
      : profile?.signed_in === false ? 'logged_out'
        : loginStatus;
  const installed = status?.versions ?? [];
  const active = status?.active_version;
  const latestUpdate = status?.latest_release?.update_available === true ? status.latest_release : undefined;
  const busy = installing !== null || activating !== null || status?.phase === 'installing';

  const apply = (next: AntigravityStatusResponse) => {
    queryClient.setQueryData(queryKey, next);
    void queryClient.invalidateQueries({ queryKey: EXECUTORS_QUERY_KEY });
    onChanged();
  };

  const applyProfile = (nextProfile: AntigravityProfileStatus | undefined, signedIn: boolean) => {
    setLoginStatus(signedIn ? 'logged_in' : 'logged_out');
    queryClient.setQueryData<AntigravityStatusResponse | undefined>(queryKey, (current) => {
      if (current === undefined) return current;
      return {
        ...current,
        profile: nextProfile ?? (current.profile !== undefined ? { ...current.profile, signed_in: signedIn } : { signed_in: signedIn }),
      };
    });
    void queryClient.invalidateQueries({ queryKey: EXECUTORS_QUERY_KEY });
    onChanged();
  };

  const install = async (version?: string) => {
    const targetVersion = (version ?? status?.release.version ?? '').trim();
    setInstalling(targetVersion);
    setFeedback(null);
    try {
      const next = await client.installAntigravityBinary(
        version === undefined && instanceId === undefined ? undefined : { version, instance_id: instanceId },
      );
      apply(next);
      setCustomVersion('');
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: timedOutRef.current
          ? t('st.antigravity.installTimedOut')
          : t('st.antigravity.installFailed', { detail: errorText(locale, error) }),
      });
    } finally { setInstalling(null); }
  };

  const activate = async (version: string) => {
    setActivating(version);
    setFeedback(null);
    try {
      apply(await client.activateAntigravityBinary(version, instanceId));
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setActivating(null); }
  };

  const checkUpdates = async () => {
    if (checkingUpdates || busy) return;
    setCheckingUpdates(true);
    setFeedback(null);
    try {
      const next = await client.getAntigravityBinaries({ instance_id: instanceId, check_updates: true });
      queryClient.setQueryData(queryKey, next);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setCheckingUpdates(false); }
  };

  const refreshModels = async () => {
    if (refreshingModels) return;
    setRefreshingModels(true);
    setFeedback(null);
    try {
      const next = await client.getAntigravityBinaries({ instance_id: instanceId, refresh_models: true });
      apply(next);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setRefreshingModels(false); }
  };

  const programDone = isAntigravityProgramReady(active, ready);
  const isExternalCli = programDone && (active === undefined || active === 'external');
  const custom = customVersion.trim();
  const customInvalid = custom !== '' && !antigravityVersionValid(custom);
  const layoutLabel = !isExternalCli && status?.release.layout === 'official-cli'
    ? t('st.antigravity.layoutOfficial')
    : !isExternalCli && status?.release.layout === 'legacy-pair'
      ? t('st.antigravity.layoutLegacy')
      : undefined;
  const siblingPart = status?.release.required_sibling ? ` + ${status.release.required_sibling}` : '';

  return (
    <div data-antigravity data-antigravity-instance={instanceId ?? 'main'} className="space-y-4 border-b border-hairline/70 pb-5">
      <p className="text-[12px] font-medium text-ink-soft">{t('st.engines.setup')}</p>
      <ol className="space-y-4">
        <li data-antigravity-step="program" data-step-state={programDone ? 'done' : 'current'} className="flex min-w-0 gap-2.5">
          <StepDot done={programDone} index={1} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="min-w-0 text-[12.5px] leading-5 text-ink">
                <span className="font-medium">{t('st.antigravity.program')}</span>
                <span className="text-ink-faint">
                  {' · '}
                  {programDone ? (
                    <span data-antigravity-version={isExternalCli ? 'external' : active} data-active="true">
                      {isExternalCli ? t('st.engines.stepFound') : t('st.antigravity.activeVersion', { version: active! })}
                    </span>
                  ) : t('st.engines.stepMissing')}
                </span>
                {programDone && layoutLabel !== undefined ? (
                  <span data-antigravity-layout={status?.release.layout} className="ml-2 inline-flex items-center rounded bg-ink/[0.05] px-1.5 py-0.5 text-[11px] font-normal text-ink-soft">
                    {layoutLabel}
                  </span>
                ) : null}
              </p>
              {programDone && latestUpdate === undefined && installing === null ? (
                <button
                  type="button"
                  data-antigravity-check-updates
                  disabled={checkingUpdates || busy}
                  onClick={() => void checkUpdates()}
                  className="text-[12px] text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
                >
                  {checkingUpdates ? t('st.antigravity.checkingUpdates') : t('st.antigravity.checkUpdates')}
                </button>
              ) : null}
            </div>

            {binaries.isError ? <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, binaries.error) }} /> : null}

            {latestUpdate !== undefined && installing !== latestUpdate.version ? (
              <div data-antigravity-update-bar className="flex flex-wrap items-center justify-between gap-2 border-y border-hairline py-2">
                <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span>{t('st.antigravity.updateAvailable', { version: latestUpdate.version })}</span>
                </span>
                <button
                  type="button"
                  data-antigravity-update
                  disabled={busy}
                  onClick={() => void install(latestUpdate.version)}
                  className={`${PRIMARY_BUTTON} inline-flex items-center gap-1.5`}
                >
                  {installing === latestUpdate.version ? t('st.antigravity.updating') : t('st.antigravity.update', { version: latestUpdate.version })}
                </button>
              </div>
            ) : null}

            {!programDone && status !== undefined ? (
              <p className="max-w-[60ch] text-[12px] leading-4 text-ink-soft">
                {t(ideDetected ? 'st.antigravity.programBodyShort' : 'st.antigravity.programBody', { version: status.release.version })}
              </p>
            ) : null}

            {!programDone && ideDetected && installing === null ? (
              <p role="alert" data-antigravity-ide className="flex max-w-[60ch] gap-1.5 text-[12px] leading-4 text-amber-ink">
                <Icon name="warning" size={12} className="mt-0.5 shrink-0 text-amber-rule" />
                <span>{t('st.antigravity.ideFound')}</span>
              </p>
            ) : null}

            {installing !== null ? <InstallProgressBar version={installing} progress={progress} /> : null}

            {status !== undefined && !installed.includes(status.release.version) && installing !== status.release.version && latestUpdate?.version !== status.release.version ? (
              <button
                type="button"
                data-antigravity-install
                className={`${programDone ? SECONDARY_BUTTON : PRIMARY_BUTTON} inline-flex items-center gap-1.5`}
                disabled={busy}
                onClick={() => void install()}
              >
                {t('st.antigravity.install', { version: status.release.version })}
              </button>
            ) : null}

            {status !== undefined ? (
              <details data-antigravity-other className="group/other [&[open]]:space-y-2">
                <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 text-[12px] font-medium text-ink-soft hover:text-ink [&::-webkit-details-marker]:hidden">
                  <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/other:rotate-90" />
                  <span>{t('st.antigravity.otherVersion')}</span>
                  {installed.length > 1 ? <span className="font-normal tabular-nums text-ink-faint">({installed.length})</span> : null}
                </summary>
                {installed.length > 0 ? (
                  <ul data-antigravity-versions className="divide-y divide-hairline border-y border-hairline">
                    {installed.map((version) => (
                      <li
                        key={version}
                        data-antigravity-version-row={version}
                        data-active={version === active}
                        className="flex min-h-9 items-center gap-3 px-1 text-[12.5px]"
                      >
                        <span className="font-mono text-[12px] text-ink">{version}</span>
                        {version === active ? (
                          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-selected-ink">
                            <Icon name="check" size={12} />{t('st.antigravity.inUse')}
                          </span>
                        ) : null}
                        <span className="flex-1" />
                        {version !== active ? (
                          <button
                            type="button"
                            data-antigravity-activate={version}
                            className={SECONDARY_BUTTON}
                            disabled={busy}
                            aria-busy={activating === version}
                            onClick={() => void activate(version)}
                          >
                            {activating === version ? t('st.antigravity.activating') : t('st.antigravity.activate')}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={t('st.antigravity.versionLabel')}
                    data-antigravity-custom
                    value={customVersion}
                    spellCheck={false}
                    placeholder="1.5.11"
                    disabled={busy}
                    aria-invalid={customInvalid}
                    onChange={(event) => { setCustomVersion(event.target.value); }}
                    className={`${INPUT} !w-28 h-8 py-1 font-mono text-[12px] ${customInvalid ? 'border-danger' : ''}`}
                  />
                  <button
                    type="button"
                    data-antigravity-install-custom
                    className={SECONDARY_BUTTON}
                    disabled={busy || custom === '' || customInvalid || installed.includes(custom)}
                    aria-busy={installing === custom}
                    onClick={() => void install(custom)}
                  >
                    {installing === custom ? t('st.antigravity.installing') : t('st.antigravity.installThis')}
                  </button>
                </div>
                {customInvalid ? <p role="alert" className="text-[12px] text-danger">{t('st.antigravity.versionInvalid')}</p> : null}
                <p className="break-all font-mono text-[11px] leading-4 text-ink-faint" title={status.release.url}>
                  {status.release.platform} · {status.release.entry}{siblingPart}
                </p>
              </details>
            ) : null}

            {status?.phase === 'failed' && status.error !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: status.error }} /> : null}
            <FeedbackLine feedback={feedback} />
          </div>
        </li>

        <li
          data-antigravity-step="signin"
          data-step-state={!programDone ? 'pending' : effectiveLoginStatus === 'logged_in' ? 'done' : 'current'}
          className="flex min-w-0 gap-2.5 border-t border-hairline pt-4"
        >
          <StepDot done={programDone && effectiveLoginStatus === 'logged_in'} index={2} muted={!programDone} />
          <div className="min-w-0 flex-1">
            <AntigravitySignIn
              ready={programDone}
              loginStatus={effectiveLoginStatus}
              profile={profile}
              instanceId={instanceId}
              refreshingModels={refreshingModels}
              onRefreshModels={() => void refreshModels()}
              onProfileChanged={applyProfile}
            />
          </div>
        </li>
      </ol>
    </div>
  );
}

/**
 * Antigravity authentication and account profile: supports all 4 auth modes
 * (Personal, Workspace/Enterprise, API Key, Vertex AI), zero-broken-redirect
 * authorization code paste on `agy` 1.5+, automatic loopback fallback on older
 * flows, eligibility diagnostics, and live entitled model discovery.
 */
function AntigravitySignIn({
  ready,
  loginStatus,
  profile,
  instanceId,
  refreshingModels,
  onRefreshModels,
  onProfileChanged,
}: {
  ready: boolean;
  loginStatus: LoginStatus;
  profile?: AntigravityProfileStatus;
  instanceId?: string;
  refreshingModels: boolean;
  onRefreshModels: () => void;
  onProfileChanged: (profile: AntigravityProfileStatus | undefined, signedIn: boolean) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const host = useHost();
  const fieldPrefix = useId();
  const [method, setMethod] = useState<AntigravityAuthMethod>(profile?.auth_method ?? 'oauth-personal');
  const [gcpProject, setGcpProject] = useState(profile?.gcp_project ?? '');
  const [gcpLocation, setGcpLocation] = useState(profile?.gcp_location ?? '');
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [working, setWorking] = useState<'start' | 'complete' | 'cancel' | 'logout' | null>(null);
  const [error, setErrorText] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const setError = (text: string | null, detail?: string) => { setErrorText(text); setErrorDetail(detail); };
  const [openFailed, setOpenFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (pending === null) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [pending]);

  const left = pending === null ? 0 : secondsLeft(pending, now);
  const expired = pending !== null && left === 0;
  const flowKind = pending === null ? undefined : resolveLoginFlowKind(pending);

  const openPage = async (url: string) => {
    setOpenFailed(false);
    try { await openExternalUrl(host, url, t('common.popupBlocked')); } catch { setOpenFailed(true); }
  };

  const canStart = (() => {
    if (working !== null) return false;
    if (method === 'oauth-business') return gcpProject.trim() !== '' && gcpLocation.trim() !== '';
    if (method === 'gemini-api-key') return apiKey.trim() !== '';
    if (method === 'agent-platform') {
      return apiKey.trim() !== '' || (gcpProject.trim() !== '' && gcpLocation.trim() !== '');
    }
    return true;
  })();

  const start = async () => {
    setWorking('start');
    setError(null);
    try {
      const request: AntigravityLoginRequest = {
        method_id: method,
        ...(instanceId !== undefined ? { instance_id: instanceId } : {}),
        ...(gcpProject.trim() !== '' ? { gcp_project: gcpProject.trim() } : {}),
        ...(gcpLocation.trim() !== '' ? { gcp_location: gcpLocation.trim() } : {}),
        ...(apiKey.trim() !== '' ? { api_key: apiKey.trim() } : {}),
      };
      const result = await client.startAntigravityLogin(request);
      if (result.already_signed_in) {
        setApiKey('');
        onProfileChanged(result.profile, true);
        return;
      }
      setPending({ ...result, startedAt: Date.now() });
      setNow(Date.now());
      setPasteValue('');
      await openPage(result.auth_url);
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally { setWorking(null); }
  };

  const complete = async () => {
    if (pending === null) return;
    const activeFlowKind = resolveLoginFlowKind(pending);
    setWorking('complete');
    setError(null);
    try {
      const outcome = await client.completeAntigravityLogin(
        pending.handle,
        pasteValue.trim(),
        instanceId === undefined ? undefined : { instance_id: instanceId },
      );
      if (outcome.signed_in) {
        setPending(null);
        setPasteValue('');
        onProfileChanged(outcome.profile, true);
        return;
      }
      if (!outcome.retryable) setPending(null);
      setError(t(loginOutcomeKey(outcome, activeFlowKind)), outcome.message);
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally { setWorking(null); }
  };

  const cancel = async () => {
    if (pending === null) return;
    setWorking('cancel');
    await client.cancelAntigravityLogin(pending.handle, instanceId).catch(() => undefined);
    setPending(null);
    setError(null);
    setWorking(null);
  };

  const logout = async () => {
    setWorking('logout');
    setError(null);
    try {
      await client.logoutAntigravity(instanceId);
      onProfileChanged(undefined, false);
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally { setWorking(null); }
  };

  const pasteValid = flowKind !== undefined && isAntigravityPasteValid(pasteValue, flowKind);
  const statusDisplay = loginStatusDisplay(loginStatus, ready);
  const title = (
    <p className="text-[12.5px] leading-5 text-ink">
      <span className="font-medium">{t('st.antigravity.signIn')}</span>
      <span className="text-ink-faint"> · </span>
      <span className={statusDisplay.className || undefined}>{t(statusDisplay.key)}</span>
    </p>
  );

  if (!ready) return title;

  if (loginStatus === 'logged_in') {
    const models = profile?.models ?? [];
    const authBadgeKey = profile?.auth_method !== undefined ? AUTH_METHOD_LABEL_KEY[profile.auth_method] : undefined;
    const gcpDetail = [profile?.gcp_project, profile?.gcp_location].filter(Boolean).join(' · ');
    return (
      <div data-antigravity-signed-in className="space-y-3">
        {title}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
          <span data-antigravity-account-label className="font-medium text-ink">
            {profile?.account_label ?? t('st.antigravity.signedInBody')}
          </span>
          {authBadgeKey !== undefined ? (
            <span data-antigravity-auth-badge={profile?.auth_method} className="rounded bg-ink/[0.05] px-1.5 py-0.5 text-[11px] text-ink-soft">
              {t(authBadgeKey)}
            </span>
          ) : null}
          {profile?.auto_mode_supported === true ? (
            <span data-antigravity-auto-mode className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
              <Icon name="check" size={12} />
              {t('st.antigravity.autoModeAvailable')}
            </span>
          ) : null}
          {gcpDetail !== '' ? (
            <span className="font-mono text-[11.5px] text-ink-faint">{gcpDetail}</span>
          ) : null}
        </div>

        {profile?.eligibility === 'subscription_required' ? (
          <p
            role="alert"
            data-antigravity-eligibility="subscription_required"
            title={profile.eligibility_message}
            className="flex max-w-[62ch] gap-1.5 text-[12px] leading-4 text-amber-ink"
          >
            <Icon name="warning" size={12} className="mt-0.5 shrink-0 text-amber-rule" />
            <span>{t('st.antigravity.subscriptionRequired')}</span>
          </p>
        ) : null}

        {profile?.token_expired === true ? (
          <p role="status" data-antigravity-token-expired className="text-[12px] leading-4 text-amber-ink">
            {t('st.antigravity.tokenExpired')}
          </p>
        ) : null}

        {models.length > 0 ? (
          <div data-antigravity-models className="space-y-1.5">
            <p className="text-[11.5px] font-medium text-ink-faint">{t('st.antigravity.models')}</p>
            <div className="flex flex-wrap gap-1.5">
              {models.map((entry) => {
                const levels = entry.thinking_levels?.filter(Boolean) ?? [];
                const tip = levels.length > 0 ? `${entry.id} · ${levels.join(' / ')}` : entry.id;
                return (
                  <span
                    key={entry.id}
                    data-antigravity-model={entry.id}
                    title={tip}
                    className="inline-flex items-center gap-1 rounded-md bg-ink/[0.04] px-2 py-0.5 text-[12px] text-ink"
                  >
                    <span>{formatAntigravityModelLabel(entry)}</span>
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button
            type="button"
            data-antigravity-refresh-models
            className={SECONDARY_BUTTON}
            disabled={refreshingModels || working !== null}
            aria-busy={refreshingModels}
            onClick={onRefreshModels}
          >
            {refreshingModels ? t('st.antigravity.refreshingModels') : t('st.antigravity.refreshModels')}
          </button>
          <button
            type="button"
            data-antigravity-logout
            className={SECONDARY_BUTTON}
            disabled={working !== null || refreshingModels}
            aria-busy={working === 'logout'}
            onClick={() => void logout()}
          >
            {working === 'logout' ? t('st.antigravity.signingOut') : t('st.antigravity.signOut')}
          </button>
        </div>
        {error !== null ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
      </div>
    );
  }

  if (pending === null) {
    const needsGcp = method === 'oauth-business' || method === 'agent-platform';
    const needsApiKey = method === 'gemini-api-key' || method === 'agent-platform';
    const isDirectConnect = method === 'gemini-api-key' || method === 'agent-platform';
    return (
      <div data-antigravity-login="idle" className="space-y-2.5">
        {title}
        <SettingsSegmented<AntigravityAuthMethod>
          ariaLabel={t('st.antigravity.account')}
          value={method}
          dataAttr="data-antigravity-method"
          onChange={(next) => { setMethod(next); setError(null); }}
          disabled={working !== null}
          choices={[
            { value: 'oauth-personal', label: t('st.antigravity.personal') },
            { value: 'oauth-business', label: t('st.antigravity.business') },
            { value: 'gemini-api-key', label: t('st.antigravity.apiKey') },
            { value: 'agent-platform', label: t('st.antigravity.vertex') },
          ]}
        />
        <p className="max-w-[60ch] text-[12px] leading-4 text-ink-soft">{t(AUTH_METHOD_BODY_KEY[method])}</p>

        {needsGcp ? (
          <div className="grid max-w-[30rem] gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`${fieldPrefix}-gcp-project`} className="block text-[11.5px] font-medium text-ink-soft">
                {t('st.antigravity.gcpProject')}
              </label>
              <input
                id={`${fieldPrefix}-gcp-project`}
                data-antigravity-gcp-project
                value={gcpProject}
                spellCheck={false}
                placeholder="my-gcp-project"
                disabled={working !== null}
                onChange={(event) => { setGcpProject(event.target.value); setError(null); }}
                className={`${INPUT} h-8 py-1 font-mono text-[12px]`}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${fieldPrefix}-gcp-location`} className="block text-[11.5px] font-medium text-ink-soft">
                {t('st.antigravity.gcpLocation')}
              </label>
              <input
                id={`${fieldPrefix}-gcp-location`}
                data-antigravity-gcp-location
                value={gcpLocation}
                spellCheck={false}
                placeholder="us-central1"
                disabled={working !== null}
                onChange={(event) => { setGcpLocation(event.target.value); setError(null); }}
                className={`${INPUT} h-8 py-1 font-mono text-[12px]`}
              />
            </div>
          </div>
        ) : null}

        {needsApiKey ? (
          <div className="max-w-[30rem] space-y-1">
            <label htmlFor={`${fieldPrefix}-api-key`} className="block text-[11.5px] font-medium text-ink-soft">
              {t('st.antigravity.apiKeyLabel')}
            </label>
            <input
              id={`${fieldPrefix}-api-key`}
              data-antigravity-api-key
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder={t('st.antigravity.apiKeyPlaceholder')}
              disabled={working !== null}
              onChange={(event) => { setApiKey(event.target.value); setError(null); }}
              className={`${INPUT} h-8 py-1 font-mono text-[12px]`}
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button
            type="button"
            data-antigravity-signin
            className={`${PRIMARY_BUTTON} inline-flex items-center gap-1.5`}
            disabled={!canStart}
            aria-busy={working === 'start'}
            onClick={() => void start()}
          >
            {working === 'start' ? <Spinner /> : null}
            {working === 'start' && isDirectConnect
              ? t('st.antigravity.connecting')
              : t(isDirectConnect ? 'st.antigravity.connect' : 'st.antigravity.signInWithGoogle')}
          </button>
        </div>

        {profile?.eligibility === 'subscription_required' ? (
          <p role="alert" data-antigravity-eligibility="subscription_required" title={profile.eligibility_message} className="text-[12px] text-amber-ink">
            {t('st.antigravity.subscriptionRequired')}
          </p>
        ) : null}

        {error !== null ? (
          <p role="alert" data-antigravity-login-error title={errorDetail} className="text-[12px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, '0');
  const isCodePaste = flowKind === 'code_paste';
  const inputId = `${fieldPrefix}-redirect`;
  const statusId = `${fieldPrefix}-redirect-status`;

  return (
    <div data-antigravity-login={expired ? 'expired' : 'pending'} data-antigravity-flow={flowKind} className="space-y-2.5">
      {title}
      <ol className="max-w-[62ch] list-decimal space-y-1 pl-4 text-[12px] leading-4 text-ink-soft marker:text-ink-faint">
        <li>
          {t('st.antigravity.stepOpen')}{' '}
          <button
            type="button"
            data-antigravity-open
            className="font-medium text-selected-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
            onClick={() => void openPage(pending.auth_url)}
          >
            {t('st.antigravity.openAgain')}
          </button>
        </li>
        <li>
          {isCodePaste
            ? t('st.antigravity.stepCodePaste')
            : t('st.antigravity.stepPaste', { address: pending.redirect_uri })}
        </li>
      </ol>
      {openFailed ? <p role="alert" className="text-[12px] text-danger">{t('st.antigravity.openFailed')}</p> : null}
      <label htmlFor={inputId} className="block text-[12px] font-medium text-ink-soft">
        {t(isCodePaste ? 'st.antigravity.pasteCodeLabel' : 'st.antigravity.pasteLabel')}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          id={inputId}
          data-antigravity-redirect
          value={pasteValue}
          spellCheck={false}
          autoComplete="off"
          placeholder={isCodePaste ? '4/0A…' : `${pending.redirect_uri}?state=…&code=…`}
          disabled={working !== null || expired}
          aria-invalid={error !== null}
          aria-describedby={statusId}
          onChange={(event) => { setPasteValue(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !isImeKeyEvent(event) && pasteValid && !expired) void complete(); }}
          className={`${INPUT} h-8 min-w-0 flex-1 basis-[20rem] py-1 font-mono text-[11.5px] ${error !== null ? 'border-danger' : ''}`}
        />
        <button
          type="button"
          data-antigravity-complete
          className={PRIMARY_BUTTON}
          disabled={working !== null || !pasteValid || expired}
          aria-busy={working === 'complete'}
          onClick={() => void complete()}
        >
          {working === 'complete' ? t('st.antigravity.finishing') : t('st.antigravity.finish')}
        </button>
        <button
          type="button"
          data-antigravity-cancel
          className={SECONDARY_BUTTON}
          disabled={working !== null}
          onClick={() => void cancel()}
        >
          {t('st.antigravity.cancel')}
        </button>
      </div>
      <p id={statusId} aria-live="polite" className="text-[12px] leading-4">
        {error !== null ? (
          <span role="alert" data-antigravity-login-error title={errorDetail} className="text-danger">{error}</span>
        ) : expired ? (
          <span className="text-danger">{t('st.antigravity.expired')}</span>
        ) : (
          <span className="tabular-nums text-ink-faint">{t('st.antigravity.expiresIn', { time: `${minutes}:${seconds}` })}</span>
        )}
      </p>
      {expired ? (
        <button
          type="button"
          data-antigravity-restart
          className={SECONDARY_BUTTON}
          disabled={working !== null}
          onClick={() => { setPending(null); void start(); }}
        >
          {t('st.antigravity.startAgain')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The running install, drawn from pushed steps: bytes while downloading
 * (indeterminate when the size is unknown), then unpack and verify/activate.
 */
function InstallProgressBar({ version, progress }: { version: string; progress: InstallProgressView | null }) {
  const { t } = useI18n();
  const total = progress?.stage === 'download' ? progress.totalBytes : undefined;
  const received = progress?.receivedBytes ?? 0;
  const percent = progress === null ? undefined : progress.stage !== 'download' ? 100
    : total === undefined ? undefined : Math.min(100, Math.round((received / total) * 100));
  const line = progress === null ? t('st.antigravity.progress.starting', { version })
    : progress.stage === 'download'
      ? total === undefined ? t('st.antigravity.progress.downloadingUnknown', { received: formatBytes(received) })
        : t('st.antigravity.progress.downloading', { received: formatBytes(received), total: formatBytes(total) })
      : t(progress.stage === 'extract' ? 'st.antigravity.progress.extracting' : 'st.antigravity.progress.activating');
  return (
    <div data-antigravity-progress={progress?.stage ?? 'starting'} className="max-w-[28rem] space-y-1">
      <div
        role="progressbar"
        aria-label={t('st.antigravity.progress.label', { version })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={line}
        className="h-1.5 w-full overflow-hidden rounded-full bg-hairline"
      >
        <div
          className={`h-full rounded-full bg-selected-ink transition-[width] duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
            percent === undefined ? 'w-1/3 animate-pulse motion-reduce:animate-none' : ''}`}
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p aria-live="polite" className="flex items-center justify-between gap-3 text-[12px] leading-4 text-ink-soft">
        <span>{line}</span>
        {percent !== undefined && progress?.stage === 'download' ? <span className="tabular-nums text-ink-faint">{percent}%</span> : null}
      </p>
    </div>
  );
}

function StepDot({ done, index, muted = false }: { done: boolean; index: number; muted?: boolean }) {
  if (done) {
    return <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"><Icon name="check" size={12} /></span>;
  }
  return (
    <span
      aria-hidden
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums ${
        muted ? 'border-hairline-strong text-ink-faint' : 'border-amber-rule bg-amber-rule/10 text-amber-ink'}`}
    >
      {index}
    </span>
  );
}

function Spinner() {
  return <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" />;
}
