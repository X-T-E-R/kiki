/**
 * TerminalPanel — the session view's bottom-docked embedded terminal.
 *
 * A deliberate dark island on the rice-paper surface (the same ink/cream
 * pairing as the transcript's shell blocks): ink background, warm cream text,
 * persimmon accents. One xterm.js renderer per terminal tab — instances stay
 * mounted (hidden) when their tab is inactive so scrollback survives tab
 * switches; attach replay restores it across page reloads.
 *
 * The panel renders wire state only; all lifecycle logic lives in
 * `state/terminalManager.ts`. Keyboard norms: full input goes straight to the
 * PTY, Ctrl+Shift+C copies the selection, Ctrl+Shift+V pastes from the
 * clipboard, and plain Ctrl+C still sends ETX when nothing is selected.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';

import { useI18n } from '../i18n';
import {
  clampTerminalPanelHeight,
} from '../lib/terminalPrefs';
import type { WsStatus } from '../lib/ws';
import type { TerminalManager, TerminalTab } from '../state/terminalManager';

const XTERM_THEME = {
  background: '#1c1917',
  foreground: '#e8dcc4',
  cursor: '#e8590c',
  cursorAccent: '#1c1917',
  selectionBackground: 'rgba(232, 89, 12, 0.32)',
  selectionInactiveBackground: 'rgba(232, 89, 12, 0.16)',
  brightBlack: '#6b6257',
  brightWhite: '#f3e9d8',
};

function copyText(text: string): void {
  if (navigator.clipboard?.writeText !== undefined) {
    navigator.clipboard.writeText(text).catch(() => {
      legacyCopy(text);
    });
    return;
  }
  legacyCopy(text);
}

/** execCommand fallback for webviews without the async clipboard API. */
function legacyCopy(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    // no clipboard access — copying is best-effort
  }
  area.remove();
}

/**
 * One xterm instance per terminal id. Owns its renderer, fit observer, and
 * the manager bindings (output sink, keystroke source, resize reporter).
 */
function TerminalCanvas({
  manager,
  tabId,
  active,
}: {
  manager: TerminalManager;
  tabId: string;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const term = new XTerm({
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.45,
      scrollback: 2000,
      cursorBlink: true,
      cursorStyle: 'bar',
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        try {
          window.open(uri, '_blank', 'noopener,noreferrer');
        } catch {
          // desktop webviews may block window.open — links stay selectable
        }
      }),
    );
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const unbind = manager.bindOutput(tabId, (data) => {
      term.write(data);
    });
    const dataSub = term.onData((data) => {
      manager.input(tabId, data);
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
        if (event.code === 'KeyC') {
          if (!term.hasSelection()) return true;
          copyText(term.getSelection());
          return false;
        }
        if (event.code === 'KeyV') {
          if (navigator.clipboard?.readText !== undefined) {
            navigator.clipboard
              .readText()
              .then((text) => {
                if (text !== '') manager.input(tabId, text);
              })
              .catch(() => {
                // clipboard permission denied — nothing to paste
              });
          }
          return false;
        }
      }
      return true;
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        if (host.offsetParent === null) return; // hidden tab — fit on activate
        try {
          fit.fit();
        } catch {
          return; // not measurable yet
        }
        manager.resize(tabId, term.cols, term.rows);
      }, 60);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      dataSub.dispose();
      unbind();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [manager, tabId]);

  // Becoming visible (tab switch or panel reopen): fit to the revealed box
  // and take focus so typing lands immediately.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (term === null || fit === null) return;
      try {
        fit.fit();
        manager.resize(tabId, term.cols, term.rows);
      } catch {
        // host not laid out yet — the observer catches the next change
      }
      term.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active, manager, tabId]);

  return (
    <div
      ref={hostRef}
      data-terminal-canvas={tabId}
      className={`kiki-term absolute inset-0 ${active ? '' : 'hidden'}`}
    />
  );
}

function TabStatusDot({ status }: { status: TerminalTab['status'] }) {
  if (status === 'live') {
    return <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />;
  }
  if (status === 'attaching') {
    return <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />;
  }
  if (status === 'unavailable') {
    return <span className="h-1.5 w-1.5 rounded-full bg-amber-rule" aria-hidden />;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-[#6b6257]" aria-hidden />;
}

export function TerminalPanel({
  manager,
  height,
  wsStatus,
  onHeightChange,
  onClose,
}: {
  manager: TerminalManager;
  height: number;
  wsStatus: WsStatus;
  onHeightChange: (height: number, final: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [confirmKillId, setConfirmKillId] = useState<string | undefined>(undefined);
  const [mirror, setMirror] = useState('');
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // The store publishes on tab/status changes; output itself bypasses React
  // via bindOutput, so panel renders stay cheap during a stream.
  const state = useSyncExternalStore(manager.subscribe, manager.getState);
  const { tabs, activeId } = state;
  const activeTab = tabs.find((tab) => tab.id === activeId);

  // Screen-reader mirror of the active terminal: a plain-text trailing log,
  // refreshed on a slow tick (output itself never re-renders the panel).
  useEffect(() => {
    const timer = setInterval(() => {
      if (activeId === undefined) {
        setMirror('');
        return;
      }
      setMirror(manager.getPlainTail(activeId));
    }, 400);
    return () => { clearInterval(timer); };
  }, [manager, activeId]);

  // The two-step kill confirm arms briefly, then disarms itself.
  useEffect(() => {
    if (confirmKillId === undefined) return;
    const timer = setTimeout(() => { setConfirmKillId(undefined); }, 3000);
    return () => { clearTimeout(timer); };
  }, [confirmKillId]);

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: height };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    onHeightChange(clampTerminalPanelHeight(drag.startHeight + (drag.startY - event.clientY)), false);
  };
  const onDragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    onHeightChange(clampTerminalPanelHeight(drag.startHeight + (drag.startY - event.clientY)), true);
  };

  const killTab = (id: string) => {
    if (confirmKillId !== id) {
      setConfirmKillId(id);
      return;
    }
    setConfirmKillId(undefined);
    void manager.kill(id);
  };

  return (
    <section
      data-terminal-panel
      aria-label={t('term.panelAria')}
      className="flex shrink-0 flex-col bg-ink text-[#e8dcc4]"
      style={{ height }}
    >
      {/* resize handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('term.resizeAria')}
        className="group h-1.5 shrink-0 cursor-row-resize"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <div className="mx-auto mt-0.5 h-0.5 w-10 rounded-full bg-white/15 transition-colors group-hover:bg-accent" />
      </div>

      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 pr-2 pl-3">
        <span className="mr-1 font-mono text-[11px] tracking-wide text-[#8a7f6d] select-none">
          &gt;_
        </span>
        <div role="tablist" aria-label={t('term.tabsAria')} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            return (
              <div
                key={tab.id}
                className={`flex shrink-0 items-center gap-1.5 rounded-md py-0.5 pr-1 pl-2 font-mono text-[11.5px] transition-colors ${
                  isActive ? 'bg-white/10 text-[#f3e9d8]' : 'text-[#8a7f6d] hover:text-[#e8dcc4]'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-terminal-tab={tab.id}
                  onClick={() => { manager.activate(tab.id); }}
                  className="flex items-center gap-1.5"
                >
                  <TabStatusDot status={tab.status} />
                  {tab.index}: {tab.shellName}
                </button>
                <button
                  type="button"
                  aria-label={t('term.killAria')}
                  title={t('term.killAria')}
                  data-terminal-kill={tab.id}
                  onClick={() => { killTab(tab.id); }}
                  className={`rounded px-0.5 text-[10px] transition-colors ${
                    confirmKillId === tab.id
                      ? 'bg-danger/80 font-semibold text-white'
                      : 'text-[#8a7f6d] hover:bg-white/10 hover:text-[#f3e9d8]'
                  }`}
                >
                  {confirmKillId === tab.id ? t('term.killConfirm') : '✕'}
                </button>
              </div>
            );
          })}
        </div>
        {wsStatus !== 'open' ? (
          <span className="shrink-0 font-mono text-[10.5px] text-amber-rule">
            {t('term.reconnecting')}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void manager.create()}
          title={t('term.new')}
          aria-label={t('term.new')}
          data-terminal-new
          className="shrink-0 rounded-md border border-white/15 px-2 py-0.5 font-mono text-[11px] text-[#e8dcc4] transition-colors hover:border-accent hover:text-accent"
        >
          +
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t('term.closePanel')}
          aria-label={t('term.closePanel')}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[#8a7f6d] transition-colors hover:bg-white/10 hover:text-[#f3e9d8]"
        >
          ✕
        </button>
      </header>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <TerminalCanvas
            key={tab.id}
            manager={manager}
            tabId={tab.id}
            active={tab.id === activeId}
          />
        ))}

        {!state.loaded ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-[12px] text-[#8a7f6d]">
            {t('term.loading')}
          </div>
        ) : null}

        {state.loaded && state.error !== undefined && tabs.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="font-mono text-[12px] text-[#d9a08a]">
              {t(state.errorKey, { detail: state.error })}
            </p>
            <button
              type="button"
              onClick={() =>
                void (state.errorKey === 'term.loadFailed' ? manager.open() : manager.create())
              }
              className="rounded-md border border-white/15 px-2.5 py-1 font-mono text-[11px] text-[#e8dcc4] transition-colors hover:border-accent hover:text-accent"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : null}

        {state.error !== undefined && tabs.length > 0 ? (
          <div className="absolute right-2 bottom-2 max-w-[70%] rounded bg-black/50 px-2 py-1 font-mono text-[10.5px] text-[#d9a08a]">
            {t(state.errorKey, { detail: state.error })}
          </div>
        ) : null}

        {state.loaded && state.error === undefined && tabs.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center">
            <p className="max-w-[420px] font-mono text-[12px] leading-relaxed text-[#8a7f6d]">
              {t('term.empty')}
            </p>
            <button
              type="button"
              onClick={() => void manager.create()}
              data-terminal-new-empty
              className="rounded-md border border-accent/60 px-3 py-1.5 font-mono text-[11.5px] text-accent transition-colors hover:bg-accent hover:text-white"
            >
              {t('term.new')}
            </button>
          </div>
        ) : null}

        {activeTab?.status === 'attaching' ? (
          <div className="pointer-events-none absolute right-2 bottom-2 rounded bg-black/40 px-2 py-0.5 font-mono text-[10.5px] text-[#e8dcc4]">
            {t('term.attaching')}
          </div>
        ) : null}

        {activeTab?.status === 'exited' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-ink/85">
            <p className="font-mono text-[12px] text-[#8a7f6d]">
              {activeTab.exitCode === null
                ? t('term.exitedNoCode')
                : t('term.exited', { code: activeTab.exitCode })}
            </p>
            <button
              type="button"
              onClick={() => void manager.restart(activeTab.id)}
              data-terminal-restart
              className="rounded-md border border-accent/60 px-3 py-1.5 font-mono text-[11.5px] text-accent transition-colors hover:bg-accent hover:text-white"
            >
              {t('term.restart')}
            </button>
          </div>
        ) : null}

        {activeTab?.status === 'unavailable' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-ink/85 px-6 text-center">
            <p className="max-w-[460px] font-mono text-[12px] leading-relaxed text-[#d9a08a]">
              {t('term.unavailable')}
            </p>
            <button
              type="button"
              onClick={() => { manager.retryAttach(activeTab.id); }}
              data-terminal-retry
              className="rounded-md border border-white/15 px-2.5 py-1 font-mono text-[11px] text-[#e8dcc4] transition-colors hover:border-accent hover:text-accent"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : null}
      </div>

      {/* Screen-reader mirror of the active terminal's recent output. The
          canvas renderer is invisible to assistive tech; this plain-text
          trailing log is the honest text equivalent. */}
      <div
        role="log"
        aria-live="polite"
        aria-label={t('term.screenAria')}
        data-terminal-screen
        className="sr-only"
      >
        {mirror}
      </div>
    </section>
  );
}
