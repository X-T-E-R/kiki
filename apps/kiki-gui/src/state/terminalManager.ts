/**
 * TerminalManager — per-session terminal lifecycle store for the bottom
 * terminal panel.
 *
 * Owns the tab list and per-tab wire state; the panel (`TerminalPanel`) owns
 * the xterm.js renderers. Split mirrors SessionController/SessionView: this
 * store is React-free and testable, output flows to renderers through
 * `bindOutput` callbacks (never through React state), and tab/status changes
 * publish through the `useSyncExternalStore` pair.
 *
 * Lifecycle honesty:
 *   - `open()` lists the server's terminals, so a page reload reattaches the
 *     PTYs that are still running (attach replays the server's scrollback
 *     buffer into fresh xterms).
 *   - a shell that exits on its own leaves its tab behind as a dead state
 *     with the exit code and a restart affordance (`restart` spawns a
 *     replacement PTY with the same shell/cwd and swaps the tab's binding);
 *   - `kill` (user-confirmed in the UI) closes over REST and only then removes
 *     the tab; a failed close keeps the tab with an error so it can be retried
 *     (no server-side PTY left running with no UI to reach it);
 *   - an attach the server never answers flips the tab to `unavailable`
 *     instead of hanging, with a retry path.
 *
 * Input typed while an attach is in flight buffers per tab and flushes on
 * the `attached` signal; a resize that lands before/without a live stream is
 * remembered as the desired size and pushed once attached.
 */

import type {
  CreateTerminalRequest,
  ListTerminalsResponse,
  Terminal,
} from '@moonshot-ai/protocol';

import { appendPlainTail } from '@kiki/session-core/util';
import { API_CODES, ApiError } from '../lib/client';
import type { TerminalSignal } from '../lib/ws';

/** The socket surface the manager needs (KikiSocket satisfies it). */
export interface TerminalTransport {
  terminalAttach(
    sessionId: string,
    terminalId: string,
  ): Promise<{ replayed: number; earliestSeq: number | null; truncated: boolean }>;
  terminalDetach(sessionId: string, terminalId: string): void;
  terminalInput(sessionId: string, terminalId: string, data: string): void;
  terminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void;
  onTerminalSignal(listener: (signal: TerminalSignal) => void): () => void;
}

/** The REST surface the manager needs (KikiClient satisfies it). */
export interface TerminalRestClient {
  listTerminals(sessionId: string): Promise<ListTerminalsResponse>;
  createTerminal(sessionId: string, body?: CreateTerminalRequest): Promise<Terminal>;
  closeTerminal(sessionId: string, terminalId: string): Promise<unknown>;
}

export type TerminalTabStatus = 'attaching' | 'live' | 'exited' | 'unavailable';

export interface TerminalTab {
  readonly id: string;
  /** 1-based display number, stable for the tab's lifetime. */
  readonly index: number;
  readonly shell: string;
  /** Basename of the shell (`/bin/sh` → `sh`) for tab labels. */
  readonly shellName: string;
  readonly cwd: string;
  readonly status: TerminalTabStatus;
  readonly exitCode: number | null;
  readonly cols: number;
  readonly rows: number;
  /** The server could replay only a suffix; earlier scrollback is unavailable. */
  readonly scrollbackIncomplete: boolean;
}

export interface TerminalManagerState {
  /** undefined until the first `open()` attempt settles. */
  readonly loaded: boolean;
  readonly tabs: readonly TerminalTab[];
  readonly activeId: string | undefined;
  /** Panel-level failure detail (list/create/restart threw). */
  readonly error: string | undefined;
  /** Which i18n key renders `error` — the panel looks it up. */
  readonly errorKey: 'term.loadFailed' | 'term.createFailed' | 'term.closeFailed';
}

interface TabRecord {
  tab: TerminalTab;
  /** Raw trailing output replayed whenever a fresh xterm renderer binds. */
  outputBuffer: Array<{ seq: number; data: string }>;
  /** Keystrokes typed while `attaching`; flushed on `attached`. */
  pendingInput: string[];
  /** Last size the renderer reported; pushed on attach when it differs. */
  desiredSize: { cols: number; rows: number } | undefined;
  outputListener: ((data: string) => void) | undefined;
  /** Resets a mounted renderer's scrollback + ANSI state, then writes a suffix. */
  resetOutputListener: ((data: string) => void) | undefined;
  /** ANSI-stripped trailing lines — the panel's screen-reader mirror. */
  plainTail: string;
  /**
   * Highest output seq applied — replay after a re-attach starts at
   * `lastSeq`, so a concurrent double-attach can never duplicate output.
   */
  lastSeq: number;
}

const EMPTY_STATE: TerminalManagerState = {
  loaded: false,
  tabs: [],
  activeId: undefined,
  error: undefined,
  errorKey: 'term.loadFailed',
};

/** Match the server's bounded scrollback window for renderer remounts. */
const MAX_OUTPUT_BUFFER_CHUNKS = 2000;

export function shellDisplayName(shell: string): string {
  const normalized = shell.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === '' ? shell : base;
}

export function terminalCapabilityAvailable(capabilities: {
  readonly terminal?: true;
}): boolean {
  return capabilities.terminal === true;
}

/** Synchronous route/capability guard for terminal rendering and actions. */
export function activeTerminalManager(
  manager: TerminalManager | null,
  sessionId: string,
  terminalAvailable: boolean,
): TerminalManager | null {
  return terminalAvailable && manager?.sessionId === sessionId ? manager : null;
}

export class TerminalManager {
  readonly sessionId: string;
  private readonly client: TerminalRestClient;
  private readonly transport: TerminalTransport;
  private readonly records = new Map<string, TabRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeSignals: () => void;
  private state: TerminalManagerState = EMPTY_STATE;
  private nextIndex = 1;
  private opened = false;
  private disposed = false;

  constructor(options: {
    sessionId: string;
    client: TerminalRestClient;
    transport: TerminalTransport;
  }) {
    this.sessionId = options.sessionId;
    this.client = options.client;
    this.transport = options.transport;
    this.unsubscribeSignals = this.transport.onTerminalSignal((signal) => {
      this.handleSignal(signal);
    });
  }

  // ── external-store plumbing ─────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): TerminalManagerState => this.state;

  private publish(patch: Partial<TerminalManagerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private publishTabs(): void {
    const tabs = [...this.records.values()].map((record) => record.tab);
    const activeId =
      this.state.activeId !== undefined && this.records.has(this.state.activeId)
        ? this.state.activeId
        : tabs[0]?.id;
    this.publish({ tabs, activeId });
  }

  private patchTab(id: string, patch: Partial<TerminalTab>): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    record.tab = { ...record.tab, ...patch };
    this.publishTabs();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** List the server's terminals and attach the running ones. Idempotent. */
  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    let items: readonly Terminal[];
    try {
      const response = await this.client.listTerminals(this.sessionId);
      items = response.items;
    } catch (error) {
      this.opened = false; // allow retry
      this.publish({
        loaded: true,
        error: error instanceof Error ? error.message : String(error),
        errorKey: 'term.loadFailed',
      });
      return;
    }
    if (this.disposed) return;
    for (const terminal of items) {
      this.addTab(terminal);
    }
    // Land on a live tab: a reloaded session may list exited terminals first.
    const firstRunning = items.find((terminal) => terminal.status === 'running');
    this.publish({
      loaded: true,
      error: undefined,
      activeId: firstRunning?.id ?? items[0]?.id,
    });
    this.publishTabs();
    for (const terminal of items) {
      if (terminal.status === 'running') this.attach(terminal.id);
    }
  }

  /** Spawn a new PTY (server default shell, session workspace cwd). */
  async create(): Promise<void> {
    let terminal: Terminal;
    try {
      terminal = await this.client.createTerminal(this.sessionId, {});
    } catch (error) {
      this.publish({
        error: error instanceof Error ? error.message : String(error),
        errorKey: 'term.createFailed',
      });
      return;
    }
    if (this.disposed) return;
    this.addTab(terminal);
    this.publish({ error: undefined, activeId: terminal.id });
    this.publishTabs();
    this.attach(terminal.id);
  }

  /**
   * Kill the PTY over REST. The tab is only dropped once the server confirms
   * the close — removing it first and swallowing a network failure left the
   * PTY running server-side with no UI left to reach it. A failed close keeps
   * the tab, surfaces the error, and lets the user retry this same call.
   * Resolves false when the close failed (the tab stays).
   */
  async kill(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (record === undefined) return true;
    try {
      await this.client.closeTerminal(this.sessionId, id);
    } catch (error) {
      if (error instanceof ApiError && error.code === API_CODES.TERMINAL_NOT_FOUND) {
        // Already gone server-side — removing the tab is safe.
      } else {
        this.publish({
          error: error instanceof Error ? error.message : String(error),
          errorKey: 'term.closeFailed',
        });
        return false;
      }
    }
    if (this.disposed) return true;
    this.transport.terminalDetach(this.sessionId, id);
    this.records.delete(id);
    record.outputListener = undefined;
    this.publish({ error: undefined });
    this.publishTabs();
    return true;
  }

  /** Replace a dead tab's PTY with a fresh one (same shell + cwd). */
  async restart(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined || record.tab.status !== 'exited') return;
    const { shell, cwd } = record.tab;
    let terminal: Terminal;
    try {
      terminal = await this.client.createTerminal(this.sessionId, {
        shell,
        // The wire wants a workspace-relative cwd; the record holds what the
        // server returned, which for our own creates is the session root —
        // omit it and let the server default apply when it is not relative.
        cwd: isRelativeCwd(cwd) ? cwd : undefined,
      });
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (this.disposed) return;
    // Retire the dead binding behind the tab's display slot.
    this.transport.terminalDetach(this.sessionId, id);
    const desiredSize = record.desiredSize;
    const pendingInput = record.pendingInput;
    this.records.delete(id);
    const next: TabRecord = {
      tab: {
        id: terminal.id,
        index: record.tab.index,
        shell: terminal.shell,
        shellName: shellDisplayName(terminal.shell),
        cwd: terminal.cwd,
        status: 'attaching',
        exitCode: null,
        cols: terminal.cols,
        rows: terminal.rows,
        scrollbackIncomplete: false,
      },
      outputBuffer: [],
      pendingInput,
      desiredSize,
      outputListener: undefined,
      resetOutputListener: undefined,
      plainTail: '',
      lastSeq: 0,
    };
    this.records.set(terminal.id, next);
    this.publish({ activeId: terminal.id });
    this.publishTabs();
    this.attach(terminal.id);
  }

  activate(id: string): void {
    if (!this.records.has(id)) return;
    this.publish({ activeId: id });
  }

  /** Re-attach a tab whose stream went unavailable (server never answered). */
  retryAttach(id: string): void {
    const record = this.records.get(id);
    if (record === undefined || record.tab.status !== 'unavailable') return;
    this.attach(id);
  }

  /**
   * Tell the manager the shared socket dropped. Live tabs become attaching so
   * keystrokes and the latest fitted size are held until the socket's automatic
   * terminal re-attach ack arrives.
   */
  setTransportConnected(connected: boolean): void {
    if (connected || this.disposed) return;
    let changed = false;
    for (const record of this.records.values()) {
      if (record.tab.status !== 'live') continue;
      record.tab = { ...record.tab, status: 'attaching' };
      changed = true;
    }
    if (changed) this.publishTabs();
  }

  /** Keystrokes from the renderer. Buffers while the attach is in flight. */
  input(id: string, data: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    if (record.tab.status === 'live') {
      this.transport.terminalInput(this.sessionId, id, data);
    } else if (record.tab.status === 'attaching') {
      record.pendingInput.push(data);
    }
    // exited/unavailable tabs swallow input (the overlay owns the focus)
  }

  /** The renderer's fitted size. Propagates when live, else on attach. */
  resize(id: string, cols: number, rows: number): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    record.desiredSize = { cols, rows };
    if (record.tab.status === 'live' && (record.tab.cols !== cols || record.tab.rows !== rows)) {
      record.tab = { ...record.tab, cols, rows };
      this.transport.terminalResize(this.sessionId, id, cols, rows);
    }
  }

  /**
   * Register the renderer's output sink for a tab. A fresh xterm receives the
   * bounded raw output buffer first, preserving ANSI state and scrollback when
   * the panel or route remounts. Returns the unbind.
   */
  bindOutput(
    id: string,
    listener: (data: string) => void,
    resetListener?: (data: string) => void,
  ): () => void {
    const record = this.records.get(id);
    if (record === undefined) return () => {};
    record.outputListener = listener;
    record.resetOutputListener = resetListener;
    if (record.outputBuffer.length > 0) {
      listener(record.outputBuffer.map((chunk) => chunk.data).join(''));
    }
    return () => {
      if (record.outputListener === listener) record.outputListener = undefined;
      if (record.resetOutputListener === resetListener) record.resetOutputListener = undefined;
    };
  }

  /** ANSI-stripped trailing output for a tab — the a11y mirror's content. */
  getPlainTail(id: string): string {
    return this.records.get(id)?.plainTail ?? '';
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeSignals();
    for (const id of this.records.keys()) {
      this.transport.terminalDetach(this.sessionId, id);
    }
    this.records.clear();
    this.listeners.clear();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private addTab(terminal: Terminal): void {
    if (this.records.has(terminal.id)) return;
    const record: TabRecord = {
      tab: {
        id: terminal.id,
        index: this.nextIndex,
        shell: terminal.shell,
        shellName: shellDisplayName(terminal.shell),
        cwd: terminal.cwd,
        status: terminal.status === 'running' ? 'attaching' : 'exited',
        exitCode: terminal.exit_code ?? null,
        cols: terminal.cols,
        rows: terminal.rows,
        scrollbackIncomplete: false,
      },
      outputBuffer: [],
      pendingInput: [],
      desiredSize: undefined,
      outputListener: undefined,
      resetOutputListener: undefined,
      plainTail: '',
      lastSeq: 0,
    };
    this.nextIndex += 1;
    this.records.set(terminal.id, record);
  }

  private attach(id: string): void {
    const record = this.records.get(id);
    if (record === undefined) return;
    record.tab = { ...record.tab, status: 'attaching' };
    this.publishTabs();
    this.transport.terminalAttach(this.sessionId, id).catch(() => {
      // The 'attached' signal is the success path; here only failures land.
      this.patchTab(id, { status: 'unavailable' });
    });
  }

  private handleSignal(signal: TerminalSignal): void {
    if (signal.sessionId !== this.sessionId || this.disposed) return;
    const record = this.records.get(signal.terminalId);
    if (record === undefined) return;
    switch (signal.kind) {
      case 'attached': {
        if (signal.truncated) {
          // Replay frames arrive before the attach ack. Discard any older local
          // prefix, reset the mounted xterm (including ANSI parser state), and
          // redraw only the retained suffix so it cannot look continuous.
          const earliestSeq = signal.earliestSeq;
          if (earliestSeq !== null) {
            record.outputBuffer = record.outputBuffer.filter((chunk) => chunk.seq >= earliestSeq);
          } else {
            record.outputBuffer = [];
          }
          record.plainTail = '';
          for (const chunk of record.outputBuffer) {
            record.plainTail = appendPlainTail(record.plainTail, chunk.data);
          }
          record.resetOutputListener?.(
            record.outputBuffer.map((chunk) => chunk.data).join(''),
          );
          record.tab = { ...record.tab, scrollbackIncomplete: true };
        }
        // An exited terminal can be replayed immediately before its attach ack.
        // Apply continuity metadata above, but never let the later ack
        // resurrect the dead tab as live.
        if (record.tab.status === 'exited') {
          if (signal.truncated) this.publishTabs();
          return;
        }
        const wasAttaching = record.tab.status === 'attaching' || record.tab.status === 'unavailable';
        record.tab = { ...record.tab, status: 'live' };
        // Push the renderer's size when it disagrees with the PTY's.
        const desired = record.desiredSize;
        if (desired !== undefined && (desired.cols !== record.tab.cols || desired.rows !== record.tab.rows)) {
          record.tab = { ...record.tab, cols: desired.cols, rows: desired.rows };
          this.transport.terminalResize(this.sessionId, signal.terminalId, desired.cols, desired.rows);
        }
        if (wasAttaching && record.pendingInput.length > 0) {
          for (const data of record.pendingInput.splice(0)) {
            this.transport.terminalInput(this.sessionId, signal.terminalId, data);
          }
        }
        this.publishTabs();
        return;
      }
      case 'output': {
        // Replay overlap guard: a re-attach starts at lastSeq, so concurrent
        // or repeated attaches can never write the same chunk twice.
        if (signal.seq <= record.lastSeq) return;
        record.lastSeq = signal.seq;
        record.plainTail = appendPlainTail(record.plainTail, signal.data);
        record.outputBuffer.push({ seq: signal.seq, data: signal.data });
        if (record.outputBuffer.length > MAX_OUTPUT_BUFFER_CHUNKS) {
          record.outputBuffer.splice(0, record.outputBuffer.length - MAX_OUTPUT_BUFFER_CHUNKS);
        }
        record.outputListener?.(signal.data);
        return;
      }
      case 'exit': {
        record.tab = { ...record.tab, status: 'exited', exitCode: signal.exitCode };
        this.publishTabs();
        return;
      }
      case 'unavailable': {
        if (record.tab.status !== 'exited') this.patchTab(signal.terminalId, { status: 'unavailable' });
        return;
      }
    }
  }
}

function isRelativeCwd(cwd: string): boolean {
  return (
    cwd !== '' &&
    !cwd.startsWith('/') &&
    !cwd.startsWith('\\') &&
    !/^[A-Za-z]:[\\/]/.test(cwd)
  );
}
