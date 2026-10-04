/**
 * Connect screen — a single centered card on the paper background with a thin
 * accent rule. Browser mode offers one-click local detection (dev middleware
 * reads the instance registry + home token) plus manual URL/token entry.
 * Desktop builds never show that form (the shell-owned backend uses a random
 * port and a process-owned token nobody could type); they get a boot card
 * with phase/elapsed/cancel and a failure card with retry + diagnostics.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { useHost } from '../host';
import { useI18n } from '../i18n';
import { DisclosureChevron } from './icons';
import type { ConnectionConfig, SshProfile } from '../state/connectionConfig';
import type { DesktopBootStatus, DesktopFailureInfo } from '../state/desktopConnection';
import { Wordmark } from './Wordmark';
import { SshProfilesPanel } from './SshProfilesPanel';

declare const __KIKI_PROXY_TARGET__: string;

import type { WebEntryProblem as WebLinkProblem } from '../lib/webAccess';

// The vocabulary is shared with the bootstrap that decides it, so the connect
// screen and the code that sent it here cannot drift into two different stories.
export type { WebEntryProblem as WebLinkProblem } from '../lib/webAccess';

/**
 * A browser that opened a link and did not get in.
 *
 * This is the state a person reaches when a link has expired or was already
 * used, and it is the one state where the connect form is the wrong answer: a
 * token box would be asking them to do something that is not theirs to do. The
 * recovery is the thing they can actually do — ask for a new link — plus, for
 * the case where they simply are not on the right machine, the ordinary connect
 * form underneath.
 */
function WebLinkProblemCard({ problem, onRetry }: { problem: WebLinkProblem; onRetry?: () => void }) {
  const { t } = useI18n();
  const [showConnect, setShowConnect] = useState(false);
  return (
    <div className="px-7 pt-6 pb-7" data-web-link-problem={problem}>
      <Wordmark size="lg" />
      <p className="mt-3 text-[14px] font-medium text-ink">
        {t(problem === 'retargeted' ? 'connect.webLinkRetargeted' : 'connect.webLinkRefused')}
      </p>
      <p className="mt-1.5 max-w-[46ch] text-[13px] leading-relaxed text-ink-soft">
        {t(problem === 'retargeted' ? 'connect.webLinkRetargetedBody' : 'connect.webLinkRefusedBody')}
      </p>
      {onRetry !== undefined ? (
        <button type="button" data-web-link-retry onClick={onRetry}
          className="mt-5 w-full rounded-md bg-accent px-3 py-2 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-deep focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none">
          {t('connect.webLinkRetry')}
        </button>
      ) : null}
      <button type="button" data-web-link-connect aria-expanded={showConnect}
        onClick={() => { setShowConnect((open) => !open); }}
        className="mt-3 w-full rounded-md px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:text-ink">
        {t(showConnect ? 'connect.webLinkHideConnect' : 'connect.webLinkUseConnect')}
      </button>
    </div>
  );
}

export function ConnectScreen({
  initial,
  connecting,
  error,
  onConnect,
  onBack,
  desktopBoot,
  desktopFailure,
  onRetryDesktop,
  onCancelDesktopBoot,
  onConnectSsh,
  onSwitchLocal,
  sshProfile,
  webLink,
  onRetryWebLink,
}: {
  initial: ConnectionConfig;
  connecting: boolean;
  error: string | null;
  onConnect: (config: ConnectionConfig, persist?: boolean) => void;
  onBack: (() => void) | undefined;
  desktopBoot: DesktopBootStatus | null;
  desktopFailure: DesktopFailureInfo | null;
  onRetryDesktop: () => void;
  onCancelDesktopBoot: () => void;
  onConnectSsh: (id: string, token: string) => Promise<void>;
  onSwitchLocal?: () => void;
  sshProfile?: SshProfile;
  /** Set when this browser arrived with a web entry link it could not use. */
  webLink?: WebLinkProblem;
  onRetryWebLink?: () => void;
}) {
  if (onSwitchLocal !== undefined) {
    return (
      <Card>
        {desktopFailure !== null ? (
          <>
            <DesktopFailureCard failure={desktopFailure} onRetry={onRetryDesktop} onSwitchLocal={onSwitchLocal} />
            <div className="px-7 pb-7"><SshProfilesPanel onConnect={onConnectSsh} selectedProfile={sshProfile} /></div>
          </>
        ) : <SshCheckingCard onSwitchLocal={onSwitchLocal} />}
      </Card>
    );
  }
  if (desktopBoot !== null) {
    return (
      <Card>
        <DesktopBootCard boot={desktopBoot} onCancel={onCancelDesktopBoot} />
      </Card>
    );
  }
  if (desktopFailure !== null) {
    return (
      <Card>
        <DesktopFailureCard failure={desktopFailure} onRetry={onRetryDesktop} />
        <div className="px-7 pb-7"><SshProfilesPanel onConnect={onConnectSsh} /></div>
      </Card>
    );
  }
  if (webLink !== undefined) {
    return (
      <Card>
        <WebLinkProblemCard problem={webLink} onRetry={onRetryWebLink} />
      </Card>
    );
  }
  return (
    <Card>
      <BrowserConnectForm
        initial={initial}
        connecting={connecting}
        error={error}
        onConnect={onConnect}
        onBack={onBack}
      />
    </Card>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-paper px-4 py-4">
      <div className="anim-enter w-full max-w-[420px]">
        <div className="rounded-2xl border border-hairline bg-panel shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_32px_-16px_rgba(28,25,23,0.12)]">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Seconds since `startedAtMs`, ticking once per second. */
function useElapsedSeconds(startedAtMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [startedAtMs]);
  return Math.max(0, Math.floor((now - startedAtMs) / 1000));
}

function SshCheckingCard({ onSwitchLocal }: { onSwitchLocal: () => void }) {
  const { t } = useI18n();
  return (
    <div className="px-7 pt-6 pb-7">
      <Wordmark size="lg" />
      <p className="mt-2 text-[13px] text-ink-soft">{t('connect.sshChecking')}</p>
      <button type="button" onClick={onSwitchLocal}
        className="mt-5 w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-ink">
        {t('connect.switchLocal')}
      </button>
    </div>
  );
}

function DesktopBootCard({ boot, onCancel }: { boot: DesktopBootStatus; onCancel: () => void }) {
  const { t } = useI18n();
  const elapsed = useElapsedSeconds(boot.startedAtMs);
  return (
    <div className="px-7 pt-6 pb-7">
      <Wordmark size="lg" />
      <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
        {boot.stage === 'spawning'
          ? t('connect.desktopBootingSpawning')
          : t('connect.desktopBootingWaiting')}
      </p>
      <p className="mt-1 font-mono text-[12px] text-ink-faint" aria-live="polite">
        {t('connect.desktopElapsed', { seconds: elapsed })}
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="mt-5 w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-ink"
      >
        {t('connect.desktopCancel')}
      </button>
    </div>
  );
}

function DesktopFailureCard({
  failure,
  onRetry,
  onSwitchLocal,
}: {
  failure: DesktopFailureInfo;
  onRetry: () => void;
  onSwitchLocal?: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => { setCopied(false); }, 1500);
    return () => { window.clearTimeout(timer); };
  }, [copied]);

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(failure.message);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the message stays visible for manual copy.
    }
  };

  return (
    <div className="px-7 pt-6 pb-7">
      <Wordmark size="lg" />
      <p className="mt-2 text-[13px] font-semibold text-danger">
        {t(onSwitchLocal === undefined ? 'connect.desktopFailedTitle' : 'connect.sshFailedTitle')}
      </p>
      <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[12px] leading-relaxed text-danger">
        {failure.message}
      </pre>
      {failure.logPath !== null ? (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
          {t('connect.desktopLogPathLabel')}{' '}
          <span className="font-mono">{failure.logPath}</span>
        </p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onSwitchLocal ?? onRetry}
          className="flex-1 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-deep"
        >
          {t(onSwitchLocal === undefined ? 'connect.desktopRetry' : 'connect.switchLocal')}
        </button>
        <button
          type="button"
          onClick={() => { void copyDiagnostics(); }}
          className="flex-1 rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-ink"
        >
          {copied ? t('connect.desktopCopied') : t('connect.desktopCopyDiagnostics')}
        </button>
      </div>
    </div>
  );
}

function BrowserConnectForm({
  initial,
  connecting,
  error,
  onConnect,
  onBack,
}: {
  initial: ConnectionConfig;
  connecting: boolean;
  error: string | null;
  onConnect: (config: ConnectionConfig, persist?: boolean) => void;
  onBack: (() => void) | undefined;
}) {
  const host = useHost();
  const { t } = useI18n();
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState(initial.token);
  const [showToken, setShowToken] = useState(false);
  // Manual URL + token are for connecting elsewhere; a saved manual
  // connection (or a failed attempt) keeps the fields open.
  const [manualOpen, setManualOpen] = useState(
    initial.url !== '' || initial.token !== '' || error !== null,
  );
  useEffect(() => { if (error !== null) setManualOpen(true); }, [error]);
  const [detecting, setDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConnect({ url: url.trim(), token: token.trim() });
  };

  const detect = async () => {
    setDetecting(true);
    setDetectNote(null);
    try {
      const connection = await host.connection.discover();
      if (connection === null) {
        setDetectNote(t('connect.noneFound'));
        return;
      }
      onConnect(connection.config, connection.persist);
    } catch (error) {
      setDetectNote(
        host.kind === 'tauri'
          ? t('connect.desktopStartFailed', {
              detail: error instanceof Error ? error.message : String(error),
            })
          : t('connect.detectNeedsDev'),
      );
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="px-7 pt-6 pb-7">
      <Wordmark size="lg" />
      <p className="mt-3 font-display text-[18px] leading-snug text-ink-soft">
        {t('connect.tagline')}
      </p>

      <form onSubmit={submit} className="mt-6">
        <button
          type="button"
          onClick={() => { void detect(); }}
          disabled={detecting || connecting}
          className="w-full rounded-md bg-accent px-3 py-2 text-[14px] font-medium text-on-accent transition-colors hover:bg-accent-deep focus-visible:ring-2 focus-visible:ring-selected-ink/50 focus-visible:outline-none disabled:opacity-60"
        >
          {detecting ? t('connect.detecting') : t('connect.detect')}
        </button>
        {detectNote !== null ? (
          <p role="status" className="mt-2 text-[13px] leading-relaxed text-ink-soft">{detectNote}</p>
        ) : null}

        <button
          type="button"
          aria-expanded={manualOpen}
          aria-controls="connect-manual"
          onClick={() => { setManualOpen((open) => !open); }}
          className="mt-5 flex items-center gap-1.5 rounded-md py-1 text-[13px] text-ink-soft transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
        >
          <DisclosureChevron open={manualOpen} className="text-current" />
          {t('connect.otherMachine')}
        </button>
        <div id="connect-manual" hidden={!manualOpen} className="mt-3">

        <label htmlFor="connect-server-url" className="mb-1 block text-[12px] font-medium text-ink-soft">
          {t('connect.serverUrl')}
        </label>
        <input
          id="connect-server-url"
          className="mb-4 w-full rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
          placeholder={t('connect.urlPlaceholder', { target: __KIKI_PROXY_TARGET__ })}
          value={url}
          onChange={(event) => { setUrl(event.target.value); }}
          spellCheck={false}
        />

        <label htmlFor="connect-token" className="mb-1 flex items-baseline justify-between gap-2 text-[12px] font-medium text-ink-soft">
          {t('connect.accessToken')}
          <span title={t('connect.accessTokenHelp')} className="cursor-help text-[12px] font-normal text-ink-faint underline decoration-dotted underline-offset-2">
            {t('connect.accessTokenWhere')}
          </span>
        </label>
        <div className="mb-5 flex gap-2">
          <input
            id="connect-token"
            className="min-w-0 flex-1 rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
            aria-describedby="connect-token-help"
            value={token}
            onChange={(event) => { setToken(event.target.value); }}
            spellCheck={false}
            type={showToken ? 'text' : 'password'}
          />
          <button
            type="button"
            className="rounded-lg border border-hairline px-3 text-[12px] text-ink-soft transition-colors hover:border-accent hover:text-ink"
            aria-label={`${t(showToken ? 'st.providers.hideKey' : 'st.providers.showKey')} ${t('connect.token')}`}
            onClick={() => { setShowToken((value) => !value); }}
          >
            {t(showToken ? 'st.providers.hideKey' : 'st.providers.showKey')}
          </button>
        </div>
        <p id="connect-token-help" className="sr-only">{t('connect.accessTokenHelp')}</p>

        {error !== null ? (
          <div role="alert" className="mb-4 rounded-md border-l-2 border-danger bg-danger/5 px-3 py-2 text-[13px] text-danger">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={connecting}
          className="w-full rounded-md border border-hairline-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-ink-faint focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:opacity-60"
        >
          {connecting ? t('connect.connecting') : t('connect.connect')}
        </button>
        </div>
        {onBack !== undefined ? (
          <button
            type="button"
            onClick={onBack}
            className="mt-2 w-full rounded-lg px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:text-ink"
          >
            {t('connect.back')}
          </button>
        ) : null}
      </form>

    </div>
  );
}
