/**
 * Connect screen — a single centered card on the paper background with a thin
 * accent rule. Offers one-click local detection (dev middleware reads the
 * instance registry + home token), plus manual URL/token entry.
 */

import { useState, type FormEvent } from 'react';

import { detectLocalConnection, isDesktopRuntime } from '../lib/localServer';
import type { ConnectionConfig } from '../state/connectionConfig';
import { Wordmark } from './Wordmark';

declare const __KIKI_PROXY_TARGET__: string;

export function ConnectScreen({
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
        setDetectNote('No local kap-server found on this machine.');
        return;
      }
      onConnect(connection.config, connection.persist);
    } catch (error) {
      setDetectNote(
        isDesktopRuntime()
          ? `Kiki's local backend could not start: ${error instanceof Error ? error.message : String(error)}`
          : 'Detection needs the kiki dev server (vite dev). Enter the server URL and token manually.',
      );
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-paper px-4">
      <div className="anim-enter w-full max-w-[420px]">
        <div className="rounded-2xl border border-hairline bg-panel shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_32px_-16px_rgba(28,25,23,0.12)]">
          <div className="h-[3px] rounded-t-2xl bg-accent" />
          <div className="px-7 pt-6 pb-7">
            <Wordmark size="lg" />
            <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
              A workshop desk for your agent. Connect to a running kap-server to begin.
            </p>

            <form onSubmit={submit} className="mt-6">
              <button
                type="button"
                onClick={() => void detect()}
                disabled={detecting || connecting}
                className="mb-5 w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {detecting ? 'Detecting…' : 'Detect local server'}
              </button>
              {detectNote !== null ? (
                <p className="mb-4 -mt-2 text-[12px] text-ink-soft">{detectNote}</p>
              ) : null}

              <label className="mb-1 block text-[12px] font-medium text-ink-soft">
                Server URL
              </label>
              <input
                className="mb-4 w-full rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
                placeholder={`http://127.0.0.1:58627 (empty = proxy ${__KIKI_PROXY_TARGET__})`}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                spellCheck={false}
              />

              <label className="mb-1 block text-[12px] font-medium text-ink-soft">
                Bearer token
              </label>
              <input
                className="mb-5 w-full rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent"
                placeholder="~/.kimi-code/server.token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
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
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
              {onBack !== undefined ? (
                <button
                  type="button"
                  onClick={onBack}
                  className="mt-2 w-full rounded-lg px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:text-ink"
                >
                  Back
                </button>
              ) : null}
            </form>

            <p className="mt-5 border-t border-hairline pt-4 text-[11px] leading-relaxed text-ink-faint">
              Deep links supported: <span className="font-mono">?server=…&token=…</span> or{' '}
              <span className="font-mono">#token=…</span>. The connection is remembered in this
              browser only.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
