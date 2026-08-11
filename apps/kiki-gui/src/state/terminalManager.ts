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
 *   - `kill` (user-confirmed in the UI) closes over REST and removes the tab;
 *   - an attach the server never answers flips the tab to `unavailable`
 *     (kap-server's WS currently ignores terminal frames — the panel says so
 *     instead of hanging), with a retry path.
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

import { appendPlainTail } from '../lib/ansi';
import type { TerminalSignal } from '../lib/ws';

/** The socket surface the manager needs (KikiSocket satisfies it). */
export interface TerminalTransport {
  terminalAttach(sessionId: string, terminalId: string): Promise<{ replayed: number }>;
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
}

export interface TerminalManagerState {
  /** undefined until the first `open()` attempt settles. */
  readonly loaded: boolean;
  readonly tabs: readonly TerminalTab[];
  readonly activeId: string | undefined;
  /** Panel-level failure detail (list/create/restart threw). */
  readonly error: string | undefined;
  /** Which i18n key renders `error` — the panel looks it up. */
  readonly errorKey: 'term.loadFailed' | 'term.createFailed';
}

interface TabRecord {
  tab: TerminalTab;
  /** Chunks received before a renderer bound; flushed by `bindOutput`. */
  pendingOutput: string[];
  /** Keystrokes typed while `attaching`; flushed on `attached`. */
  pendingInput: string[];
  /** Last size the renderer reported; pushed on attach when it differs. */
  desiredSize: { cols: number; rows: number } | undefined;
  outputListener: ((data: string) => void) | undefined;
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

/** Cap on buffered output while no renderer is bound (panel closed). */
const MAX_PENDING_OUTPUT_CHUNKS = 2000;

export function shellDisplayName(shell: string): string {
  const normalized = shell.replaceAll('\\', '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === '' ? shell : base;
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

  /** Kill the PTY over REST and drop its tab. */
  async kill(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) return;
    this.transport.terminalDetach(this.sessionId, id);
    this.records.delete(id);
    this.publishTabs();
    try {
      await this.client.closeTerminal(this.sessionId, id);
    } catch {
      // already gone server-side — the tab is removed either way
    }
    record.outputListener = undefined;
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
      },
      pendingOutput: [],
      pendingInput,
      desiredSize,
      outputListener: undefined,
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
   * Register the renderer's output sink for a tab. Chunks that arrived while
   * no renderer was bound (attach replay racing the React mount) flush first.
   * Returns the unbind.
   */
  bindOutput(id: string, listener: (data: string) => void): () => void {
    const record = this.records.get(id);
    if (record === undefined) return () => {};
    record.outputListener = listener;
    if (record.pendingOutput.length > 0) {
      const backlog = record.pendingOutput.join('');
      record.pendingOutput = [];
      listener(backlog);
    }
    return () => {
      if (record.outputListener === listener) record.outputListener = undefined;
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
      },
      pendingOutput: [],
      pendingInput: [],
      desiredSize: undefined,
      outputListener: undefined,
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
        if (record.outputListener !== undefined) {
          record.outputListener(signal.data);
        } else {
          // No renderer bound (panel closed / mount race): buffer, capped
          // like the server-side scrollback — the excess is gone either way.
          record.pendingOutput.push(signal.data);
          if (record.pendingOutput.length > MAX_PENDING_OUTPUT_CHUNKS) {
            record.pendingOutput.splice(0, record.pendingOutput.length - MAX_PENDING_OUTPUT_CHUNKS);
          }
        }
        return;
      }
      case 'exit': {
        record.tab = { ...record.tab, status: 'exited', exitCode: signal.exitCode };
        this.publishTabs();
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
