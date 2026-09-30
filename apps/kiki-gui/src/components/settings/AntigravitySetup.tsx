import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AntigravityLoginStartResponse, AntigravityStatusResponse } from '@kiki/protocol';
import type { KlientEventPayloads } from '@kiki/klient';
import { formatBytes } from '@kiki/session-core/composer/media';
import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../host';
import { openExternalUrl } from '../../host/external';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SettingsSegmented } from './SettingsPrimitives';
import { EXECUTORS_QUERY_KEY } from './profileEditor/engines';

export const ANTIGRAVITY_ID = 'antigravity-acp';
const BINARIES_KEY = ['executors', ANTIGRAVITY_ID, 'binaries'] as const;
type Method = 'oauth-personal' | 'oauth-business';
type Pending = Extract<AntigravityLoginStartResponse, { already_signed_in: false }> & { readonly startedAt: number };
type LoginStatus = 'logged_in' | 'logged_out' | 'unknown';

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
  return { installId: event.installId, stage: event.stage, receivedBytes: current?.installId === event.installId ? current.receivedBytes : 0,
    totalBytes: current?.installId === event.installId ? current.totalBytes : undefined };
}

/** Seconds left on a sign-in, never negative. */
export function secondsLeft(pending: { startedAt: number; expires_in_secs: number }, now: number): number {
  return Math.max(0, Math.ceil(pending.expires_in_secs - (now - pending.startedAt) / 1000));
}

/**
 * Antigravity setup inside its engine row, replacing the generic "run this
 * command" step: Kiki fetches Google's ACP CLI itself, keeps each 1.x
 * release in its cache, and runs the Google sign-in whose redirect lands on
 * a local address the user pastes back. Two steps, one primary action each.
 */
export function AntigravitySetup({ login, ideDetected, onChanged }: {
  login: LoginStatus;
  /** The last check found the Antigravity IDE where the ACP CLI was expected. */
  ideDetected: boolean;
  onChanged: () => void;
}) {
  const { client, klient } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const binaries = useQuery({
    queryKey: BINARIES_KEY,
    queryFn: () => client.getAntigravityBinaries(),
    staleTime: 30_000,
    retry: false,
  });
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgressView | null>(null);
  // The pushed failure says whether the download ran out of time; the HTTP reply does not.
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
  // Sign-in state: the last check's answer until this card changes it.
  const [signedIn, setSignedIn] = useState(login === 'logged_in');
  useEffect(() => { setSignedIn(login === 'logged_in'); }, [login]);
  const status = binaries.data;
  const installed = status?.versions ?? [];
  const active = status?.active_version;
  const busy = installing !== null || activating !== null || status?.phase === 'installing';

  const apply = (next: AntigravityStatusResponse) => {
    queryClient.setQueryData(BINARIES_KEY, next);
    void queryClient.invalidateQueries({ queryKey: EXECUTORS_QUERY_KEY });
    onChanged();
  };
  const install = async (version?: string) => {
    setInstalling((version ?? status?.release.version ?? '').trim());
    setFeedback(null);
    try {
      const next = await client.installAntigravityBinary(version);
      apply(next);
      setCustomVersion('');
    } catch (error) {
      setFeedback({ tone: 'error', text: timedOutRef.current ? t('st.antigravity.installTimedOut')
        : t('st.antigravity.installFailed', { detail: errorText(locale, error) }) });
    } finally { setInstalling(null); }
  };
  const activate = async (version: string) => {
    setActivating(version);
    setFeedback(null);
    try { apply(await client.activateAntigravityBinary(version)); } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setActivating(null); }
  };

  const programDone = active !== undefined;
  const custom = customVersion.trim();
  const customInvalid = custom !== '' && !antigravityVersionValid(custom);
  return (
    <div data-antigravity className="space-y-3">
      <p className="text-[12px] font-medium text-ink-soft">{t('st.engines.setup')}</p>
      <ol className="space-y-3">
        <li data-antigravity-step="program" data-step-state={programDone ? 'done' : 'current'} className="flex min-w-0 gap-2.5">
          <StepDot done={programDone} index={1} />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-[12.5px] leading-5 text-ink">
              <span className="font-medium">{t('st.antigravity.program')}</span>
              <span className="text-ink-faint"> · {programDone ? t('st.antigravity.activeVersion', { version: active }) : t('st.engines.stepMissing')}</span>
            </p>
            {binaries.isError ? <FeedbackLine feedback={{ tone: 'error', text: errorText(locale, binaries.error) }} /> : null}
            {!programDone && status !== undefined ? (
              <p className="max-w-[60ch] text-[12px] leading-4 text-ink-soft">{t(ideDetected ? 'st.antigravity.programBodyShort' : 'st.antigravity.programBody', { version: status.release.version })}</p>
            ) : null}
            {installed.length > 0 ? (
              <ul data-antigravity-versions className="divide-y divide-hairline rounded-md border border-hairline">
                {installed.map((version) => (
                  <li key={version} data-antigravity-version={version} data-active={version === active}
                    className="flex min-h-9 items-center gap-3 px-2.5 text-[12.5px]">
                    <span className="font-mono text-[12px] text-ink">{version}</span>
                    {version === active ? (
                      <span className="inline-flex items-center gap-1 text-[12px] font-medium text-selected-ink">
                        <Icon name="check" size={12} />{t('st.antigravity.inUse')}
                      </span>
                    ) : null}
                    <span className="flex-1" />
                    {version !== active ? (
                      <button type="button" data-antigravity-activate={version} className={SECONDARY_BUTTON} disabled={busy}
                        aria-busy={activating === version} onClick={() => void activate(version)}>
                        {activating === version ? t('st.antigravity.activating') : t('st.antigravity.activate')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {!programDone && ideDetected ? (
              <p role="alert" data-antigravity-ide className="flex max-w-[60ch] gap-1.5 text-[12px] leading-4 text-amber-ink">
                <Icon name="warning" size={12} className="mt-0.5 shrink-0 text-amber-rule" />
                <span>{t('st.antigravity.ideFound')}</span>
              </p>
            ) : null}
            {installing !== null ? <InstallProgressBar version={installing} progress={progress} /> : null}
            {status !== undefined && !installed.includes(status.release.version) && installing !== status.release.version ? (
              <button type="button" data-antigravity-install className={`${programDone ? SECONDARY_BUTTON : PRIMARY_BUTTON} inline-flex items-center gap-1.5`}
                disabled={busy} onClick={() => void install()}>
                {t('st.antigravity.install', { version: status.release.version })}
              </button>
            ) : null}
            {status !== undefined ? (
              <details data-antigravity-other className="group/other [&[open]]:space-y-1.5">
                <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 text-[12px] font-medium text-ink-soft hover:text-ink [&::-webkit-details-marker]:hidden">
                  <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/other:rotate-90" />
                  {t('st.antigravity.otherVersion')}
                </summary>
                <div className="flex flex-wrap items-center gap-2">
                  <input aria-label={t('st.antigravity.versionLabel')} data-antigravity-custom value={customVersion} spellCheck={false}
                    placeholder="1.2.1" disabled={busy} aria-invalid={customInvalid}
                    onChange={(event) => { setCustomVersion(event.target.value); }}
                    className={`${INPUT} !w-28 h-8 py-1 font-mono text-[12px] ${customInvalid ? 'border-danger' : ''}`} />
                  <button type="button" data-antigravity-install-custom className={SECONDARY_BUTTON}
                    disabled={busy || custom === '' || customInvalid || installed.includes(custom)} aria-busy={installing === custom}
                    onClick={() => void install(custom)}>
                    {installing === custom ? t('st.antigravity.installing') : t('st.antigravity.installThis')}
                  </button>
                </div>
              </details>
            ) : null}
            {customInvalid ? <p role="alert" className="text-[12px] text-danger">{t('st.antigravity.versionInvalid')}</p> : null}
            {status !== undefined ? (
              <p className="break-all font-mono text-[11px] leading-4 text-ink-faint" title={status.release.url}>
                {status.release.platform} · {status.release.entry} + {status.release.required_sibling}
              </p>
            ) : null}
            {status?.phase === 'failed' && status.error !== undefined ? <FeedbackLine feedback={{ tone: 'error', text: status.error }} /> : null}
            <FeedbackLine feedback={feedback} />
          </div>
        </li>
        <li data-antigravity-step="signin" data-step-state={!programDone ? 'pending' : signedIn ? 'done' : 'current'} className="flex min-w-0 gap-2.5">
          <StepDot done={programDone && signedIn} index={2} muted={!programDone} />
          <div className="min-w-0 flex-1">
            <AntigravitySignIn ready={programDone} signedIn={signedIn} onSignedIn={setSignedIn} onChanged={onChanged} />
          </div>
        </li>
      </ol>
    </div>
  );
}

/**
 * Google sign-in. Start opens the consent page; Google then sends the browser
 * to a local address that nothing answers, so the user copies that address
 * back here. A wrong paste keeps the flow open (retryable); an expired one
 * starts over. Signed in: one line and a sign-out.
 */
function AntigravitySignIn({ ready, signedIn, onSignedIn: setSignedIn, onChanged }: {
  ready: boolean; signedIn: boolean; onSignedIn: (value: boolean) => void; onChanged: () => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const host = useHost();
  const [method, setMethod] = useState<Method>('oauth-personal');
  const [pending, setPending] = useState<Pending | null>(null);
  const [redirect, setRedirect] = useState('');
  const [working, setWorking] = useState<'start' | 'complete' | 'cancel' | 'logout' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server's own words for a rejected paste, kept for the tooltip.
  const [errorDetail, setErrorDetail] = useState<string | undefined>();
  const [openFailed, setOpenFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending === null) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [pending]);
  const left = pending === null ? 0 : secondsLeft(pending, now);
  const expired = pending !== null && left === 0;

  const openPage = async (url: string) => {
    setOpenFailed(false);
    try { await openExternalUrl(host, url, t('common.popupBlocked')); } catch { setOpenFailed(true); }
  };
  const start = async () => {
    setWorking('start'); setError(null);
    try {
      const result = await client.startAntigravityLogin(method);
      if (result.already_signed_in) { setSignedIn(true); onChanged(); return; }
      setPending({ ...result, startedAt: Date.now() });
      setNow(Date.now());
      setRedirect('');
      await openPage(result.auth_url);
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally { setWorking(null); }
  };
  const complete = async () => {
    if (pending === null) return;
    setWorking('complete'); setError(null);
    try {
      const outcome = await client.completeAntigravityLogin(pending.handle, redirect.trim());
      if (outcome.signed_in) {
        setPending(null); setSignedIn(true); onChanged();
        return;
      }
      if (!outcome.retryable) setPending(null);
      setError(t(outcome.retryable ? 'st.antigravity.pasteRetry' : 'st.antigravity.flowEnded'));
      setErrorDetail(outcome.message);
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally { setWorking(null); }
  };
  const cancel = async () => {
    if (pending === null) return;
    setWorking('cancel');
    // Closing the flow locally is what the user asked for; a failed cancel only leaves a server flow to time out.
    await client.cancelAntigravityLogin(pending.handle).catch(() => undefined);
    setPending(null); setError(null); setWorking(null);
  };
  const logout = async () => {
    setWorking('logout'); setError(null);
    try { await client.logoutAntigravity(); setSignedIn(false); onChanged(); } catch (failure) {
      setError(errorText(locale, failure));
    } finally { setWorking(null); }
  };

  const pasteValid = /^https?:\/\/\S+$/.test(redirect.trim());
  const title = (
    <p className="text-[12.5px] leading-5 text-ink">
      <span className="font-medium">{t('st.antigravity.signIn')}</span>
      <span className="text-ink-faint"> · {!ready ? t('st.engines.stepWaiting') : signedIn ? t('st.engines.login.logged_in') : t('st.engines.login.logged_out')}</span>
    </p>
  );
  if (!ready) return title;
  if (signedIn) {
    return (
      <div data-antigravity-signed-in className="space-y-1.5">
        {title}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-ink-soft">{t('st.antigravity.signedInBody')}</span>
          <button type="button" data-antigravity-logout className={SECONDARY_BUTTON} disabled={working !== null}
            aria-busy={working === 'logout'} onClick={() => void logout()}>
            {working === 'logout' ? t('st.antigravity.signingOut') : t('st.antigravity.signOut')}
          </button>
        </div>
        {error !== null ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
      </div>
    );
  }
  if (pending === null) {
    return (
      <div data-antigravity-login="idle" className="space-y-2">
        {title}
        <p className="max-w-[60ch] text-[12px] leading-4 text-ink-soft">{t('st.antigravity.signInBody')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <SettingsSegmented<Method> ariaLabel={t('st.antigravity.account')} value={method} dataAttr="data-antigravity-method"
            onChange={setMethod} disabled={working !== null}
            choices={[{ value: 'oauth-personal', label: t('st.antigravity.personal') }, { value: 'oauth-business', label: t('st.antigravity.business') }]} />
          <button type="button" data-antigravity-signin className={`${PRIMARY_BUTTON} inline-flex items-center gap-1.5`}
            disabled={working !== null} aria-busy={working === 'start'} onClick={() => void start()}>
            {working === 'start' ? <Spinner /> : null}
            {t('st.antigravity.signInWithGoogle')}
          </button>
        </div>
        {error !== null ? <p role="alert" data-antigravity-login-error className="text-[12px] text-danger">{error}</p> : null}
      </div>
    );
  }
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, '0');
  return (
    <div data-antigravity-login={expired ? 'expired' : 'pending'} className="space-y-2">
      {title}
      <ol className="max-w-[62ch] list-decimal space-y-1 pl-4 text-[12px] leading-4 text-ink-soft marker:text-ink-faint">
        <li>
          {t('st.antigravity.stepOpen')}{' '}
          <button type="button" data-antigravity-open className="font-medium text-selected-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
            onClick={() => void openPage(pending.auth_url)}>{t('st.antigravity.openAgain')}</button>
        </li>
        <li>{t('st.antigravity.stepPaste', { address: pending.redirect_uri })}</li>
      </ol>
      {openFailed ? <p role="alert" className="text-[12px] text-danger">{t('st.antigravity.openFailed')}</p> : null}
      <label htmlFor="antigravity-redirect" className="block text-[12px] font-medium text-ink-soft">{t('st.antigravity.pasteLabel')}</label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input id="antigravity-redirect" data-antigravity-redirect value={redirect} spellCheck={false} autoComplete="off"
          placeholder={`${pending.redirect_uri}?state=…&code=…`} disabled={working !== null || expired}
          aria-invalid={error !== null} aria-describedby="antigravity-redirect-status"
          onChange={(event) => { setRedirect(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && pasteValid && !expired) void complete(); }}
          className={`${INPUT} h-8 min-w-0 flex-1 basis-[20rem] py-1 font-mono text-[11.5px] ${error !== null ? 'border-danger' : ''}`} />
        <button type="button" data-antigravity-complete className={PRIMARY_BUTTON}
          disabled={working !== null || !pasteValid || expired} aria-busy={working === 'complete'} onClick={() => void complete()}>
          {working === 'complete' ? t('st.antigravity.finishing') : t('st.antigravity.finish')}
        </button>
        <button type="button" data-antigravity-cancel className={SECONDARY_BUTTON} disabled={working !== null}
          onClick={() => void cancel()}>{t('st.antigravity.cancel')}</button>
      </div>
      <p id="antigravity-redirect-status" aria-live="polite" className="text-[12px] leading-4">
        {error !== null ? <span role="alert" data-antigravity-login-error title={errorDetail} className="text-danger">{error}</span>
          : expired ? <span className="text-danger">{t('st.antigravity.expired')}</span>
            : <span className="tabular-nums text-ink-faint">{t('st.antigravity.expiresIn', { time: `${minutes}:${seconds}` })}</span>}
      </p>
      {expired ? (
        <button type="button" data-antigravity-restart className={SECONDARY_BUTTON} disabled={working !== null}
          onClick={() => { setPending(null); void start(); }}>{t('st.antigravity.startAgain')}</button>
      ) : null}
    </div>
  );
}

/**
 * The running install, drawn from pushed steps: bytes while downloading
 * (indeterminate when the size is unknown), then unpack and activate. Ink
 * blue marks the current work; nothing here asks the user for anything.
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
      <div role="progressbar" aria-label={t('st.antigravity.progress.label', { version })}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={line}
        className="h-1.5 w-full overflow-hidden rounded-full bg-hairline">
        <div className={`h-full rounded-full bg-selected-ink transition-[width] duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
          percent === undefined ? 'w-1/3 animate-pulse motion-reduce:animate-none' : ''}`}
          style={percent === undefined ? undefined : { width: `${percent}%` }} />
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
    <span aria-hidden className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums ${
      muted ? 'border-hairline-strong text-ink-faint' : 'border-amber-rule bg-amber-rule/10 text-amber-ink'}`}>{index}</span>
  );
}

function Spinner() {
  return <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none" />;
}

