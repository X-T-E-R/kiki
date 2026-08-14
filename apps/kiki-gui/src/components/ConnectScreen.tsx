/**
 * Connect screen — a single centered card on the paper background with a thin
 * accent rule. Browser mode offers one-click local detection (dev middleware
 * reads the instance registry + home token) plus manual URL/token entry.
 * Desktop builds never show that form (the shell-owned backend uses a random
 * port and a process-owned token nobody could type); they get a boot card
 * with phase/elapsed/cancel and a failure card with retry + diagnostics.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { useI18n } from '../i18n';
import { detectLocalConnection, isDesktopRuntime } from '../lib/localServer';
import type { DesktopBootStatus, DesktopFailureInfo } from '../state/connection';
import type { ConnectionConfig } from '../state/connectionConfig';
import { Wordmark } from './Wordmark';

declare const __KIKI_PROXY_TARGET__: string;

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
}) {
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
    <div className="flex h-full items-center justify-center bg-paper px-4">
      <div className="anim-enter w-full max-w-[420px]">
        <div className="rounded-2xl border border-hairline bg-panel shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_32px_-16px_rgba(28,25,23,0.12)]">
          <div className="h-[3px] rounded-t-2xl bg-accent" />
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
        className="mt-5 w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent"
      >
        {t('connect.desktopCancel')}
      </button>
    </div>
  );
}

function DesktopFailureCard({
  failure,
  onRetry,
}: {
  failure: DesktopFailureInfo;
  onRetry: () => void;
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
        {t('connect.desktopFailedTitle')}
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
          onClick={onRetry}
          className="flex-1 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-accent-deep"
        >
          {t('connect.desktopRetry')}
        </button>
        <button
          type="button"
          onClick={() => { void copyDiagnostics(); }}
          className="flex-1 rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent"
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
  const { t } = useI18n();
  const [url, setUrl] = useState(initial.url);
  const [token, setToken] = useState(initial.token);
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
      const connection = await detectLocalConnection();
      if (connection === null) {
        setDetectNote(t('connect.noneFound'));
        return;
      }
      onConnect(connection.config, connection.persist);
    } catch (error) {
      setDetectNote(
        isDesktopRuntime()
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
      <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
        {t('connect.tagline')}
      </p>

      <form onSubmit={submit} className="mt-6">
        <button
          type="button"
          onClick={() => { void detect(); }}
          disabled={detecting || connecting}
          className="mb-5 w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {detecting ? t('connect.detecting') : t('connect.detect')}
        </button>
        {detectNote !== null ? (
          <p className="mb-4 -mt-2 text-[12px] text-ink-soft">{detectNote}</p>
        ) : null}

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

        <label htmlFor="connect-token" className="mb-1 block text-[12px] font-medium text-ink-soft">
          {t('connect.token')}
        </label>
        <input
          id="connect-token"
          className="mb-5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
          placeholder="~/.kimi-code/server.token"
          value={token}
          onChange={(event) => { setToken(event.target.value); }}
          spellCheck={false}
          type="password"
        />

        {error !== null ? (
          <div className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[12px] text-danger">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={connecting}
          className="w-full rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
        >
          {connecting ? t('connect.connecting') : t('connect.connect')}
        </button>
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

      <p className="mt-5 border-t border-hairline pt-4 text-[11px] leading-relaxed text-ink-faint">
        {t('connect.deepLinkBefore')}
        <span className="font-mono">?server=…&token=…</span>
        {t('connect.deepLinkOr')}
        <span className="font-mono">#token=…</span>
        {t('connect.deepLinkAfter')}
      </p>
    </div>
  );
}
