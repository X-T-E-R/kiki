import type { TerminalAttachResult, TerminalConnectionStatus, TerminalSignal } from '../../core/facade/terminal.js';
import type { KlientFrame } from '../codec.js';

interface TerminalSocket {
  nextId(): string;
  connect(): void;
  isOpen(): boolean;
  send(frame: KlientFrame): void;
  nudge(): void;
}
interface TrackedTerminal { sessionId: string; terminalId: string; lastSeq: number }
interface PendingAttach extends TrackedTerminal {
  resolve(value: TerminalAttachResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const keyOf = (sessionId: string, terminalId: string): string => JSON.stringify([sessionId, terminalId]);

/** PTY attachment state only; connection, reconnect and liveness belong to HttpEventSocket. */
export class HttpTerminals {
  private readonly tracked = new Map<string, TrackedTerminal>();
  private readonly pending = new Map<string, PendingAttach>();
  private readonly listeners = new Set<(signal: TerminalSignal) => void>();
  private readonly statuses = new Set<(status: TerminalConnectionStatus) => void>();
  private status: TerminalConnectionStatus = 'connecting';
  private closed = false;
  constructor(private readonly socket: TerminalSocket) {}
  get hasDemand(): boolean { return this.tracked.size > 0 || this.statuses.size > 0; }
  onStatus = (listener: (status: TerminalConnectionStatus) => void): (() => void) => {
    if (this.closed) throw new Error('http closed');
    this.statuses.add(listener);
    listener(this.status);
    this.socket.connect();
    return () => { this.statuses.delete(listener); };
  };
  onTerminalSignal = (listener: (signal: TerminalSignal) => void): (() => void) => {
    if (this.closed) throw new Error('http closed');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  nudge = (): void => { this.socket.nudge(); };
  terminalAttach = (sessionId: string, terminalId: string): Promise<TerminalAttachResult> => {
    if (this.closed) return Promise.reject(new Error('http closed'));
    const key = keyOf(sessionId, terminalId);
    let tracked = this.tracked.get(key);
    if (tracked === undefined) {
      tracked = { sessionId, terminalId, lastSeq: 0 };
      this.tracked.set(key, tracked);
    }
    this.socket.connect();
    if (!this.socket.isOpen()) return Promise.reject(new Error('socket is not connected'));
    return this.attach(tracked);
  };
  terminalDetach = (sessionId: string, terminalId: string): void => {
    this.tracked.delete(keyOf(sessionId, terminalId));
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId || pending.terminalId !== terminalId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error('terminal detached before the attach ack arrived'));
    }
    this.send('terminal_detach', { session_id: sessionId, terminal_id: terminalId });
  };
  terminalInput = (sessionId: string, terminalId: string, data: string): void => {
    this.send('terminal_input', { session_id: sessionId, terminal_id: terminalId, data });
  };
  terminalResize = (sessionId: string, terminalId: string, cols: number, rows: number): void => {
    this.send('terminal_resize', { session_id: sessionId, terminal_id: terminalId, cols, rows });
  };
  private send(type: string, data: unknown): void {
    if (!this.closed && this.socket.isOpen()) this.socket.send({ type, id: this.socket.nextId(), data });
  }
  private attach(tracked: TrackedTerminal): Promise<TerminalAttachResult> {
    const id = this.socket.nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('terminal attach timed out — the server does not answer terminal frames'));
      }, 8_000);
      this.pending.set(id, { ...tracked, resolve, reject, timer });
      this.socket.send({ type: 'terminal_attach', id, data: {
        session_id: tracked.sessionId, terminal_id: tracked.terminalId,
        since_seq: tracked.lastSeq > 0 ? tracked.lastSeq : undefined,
      } });
    });
  }
  opened(): void {
    this.setStatus('open');
    for (const tracked of this.tracked.values()) {
      void this.attach(tracked).catch(() => {
        if (!this.socket.isOpen() || !this.tracked.has(keyOf(tracked.sessionId, tracked.terminalId))) return;
        this.emit({ kind: 'unavailable', sessionId: tracked.sessionId, terminalId: tracked.terminalId });
      });
    }
  }
  connecting(): void { this.setStatus('connecting'); }
  disconnected(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.setStatus('closed');
  }
  close(): void {
    this.closed = true;
    this.disconnected(new Error('http event socket closed before the terminal attach ack arrived'));
    this.tracked.clear();
    this.listeners.clear();
    this.statuses.clear();
  }
  private setStatus(status: TerminalConnectionStatus): void {
    this.status = status;
    for (const listener of this.statuses) listener(status);
  }
  private emit(signal: TerminalSignal): void {
    for (const listener of this.listeners) {
      try { listener(signal); } catch { /* Isolate renderers from the shared frame pump. */ }
    }
  }
  receive(frame: KlientFrame): boolean {
    if (!frame.type.startsWith('terminal_')) return false;
    if (frame.type === 'terminal_ack') {
      const pending = this.pending.get(frame.id ?? '');
      if (pending === undefined) return true;
      this.pending.delete(frame.id!);
      clearTimeout(pending.timer);
      if (frame.code !== 0) {
        pending.reject(new Error(`terminal attach rejected: ${frame.msg ?? 'unknown error'} (code ${String(frame.code)})`));
        return true;
      }
      const data = frame.data as { replayed?: unknown; earliest_seq?: unknown; truncated?: unknown } | undefined;
      const result = {
        replayed: typeof data?.replayed === 'number' ? data.replayed : 0,
        earliestSeq: typeof data?.earliest_seq === 'number' ? data.earliest_seq : null,
        truncated: data?.truncated === true,
      };
      pending.resolve(result);
      this.emit({ kind: 'attached', sessionId: pending.sessionId, terminalId: pending.terminalId, ...result });
      return true;
    }
    const data = frame.data as { session_id?: unknown; terminal_id?: unknown; seq?: unknown; payload?: { data?: unknown; exit_code?: unknown } } | undefined;
    if (typeof data?.session_id !== 'string' || typeof data.terminal_id !== 'string') return true;
    const sessionId = data.session_id;
    const terminalId = data.terminal_id;
    const key = keyOf(sessionId, terminalId);
    const tracked = this.tracked.get(key);
    if (tracked === undefined) return true;
    if (frame.type === 'terminal_output' && typeof data.seq === 'number' && Number.isSafeInteger(data.seq) && data.seq > tracked.lastSeq) {
      tracked.lastSeq = data.seq;
      this.emit({ kind: 'output', sessionId, terminalId, seq: data.seq, data: typeof data.payload?.data === 'string' ? data.payload.data : '' });
    } else if (frame.type === 'terminal_exit') {
      this.tracked.delete(key);
      this.emit({ kind: 'exit', sessionId, terminalId, exitCode: typeof data.payload?.exit_code === 'number' ? data.payload.exit_code : null });
    }
    return true;
  }
}
