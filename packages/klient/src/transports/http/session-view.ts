import type { SessionViewChannelSubscription } from '../../core/channel.js';
import type { SessionViewSignal, SessionViewSubscribeInput } from '../../contract/session/view.js';
import type { KlientFrame } from '../codec.js';

interface ActiveView {
  readonly id: string;
  readonly sessionId: string;
  input: SessionViewSubscribeInput;
  readonly handler: (signal: SessionViewSignal) => void;
  attachCount: number;
}

export class HttpSessionViews {
  private readonly views = new Map<string, ActiveView>();
  private generation = 0;

  constructor(private readonly host: {
    nextId(): string;
    connect(): void;
    isOpen(): boolean;
    send(frame: KlientFrame): void;
    restart(): void;
    nudge(): void;
  }) {}

  get hasDemand(): boolean { return this.views.size > 0; }

  subscribe(sessionId: string, input: SessionViewSubscribeInput, handler: (signal: SessionViewSignal) => void): SessionViewChannelSubscription {
    const id = this.host.nextId();
    const view: ActiveView = { id, sessionId, input, handler, attachCount: 0 };
    this.views.set(id, view);
    try {
      handler({ type: 'status', status: 'connecting', generation: this.generation });
      this.host.connect();
      if (this.host.isOpen()) this.attach(view);
    } catch (error) {
      this.views.delete(id);
      throw error;
    }
    return {
      updateSessionCursor: (cursor) => { view.input = { ...view.input, sessionCursor: cursor }; },
      setTranscriptGrades: (grades) => {
        if (!this.views.has(id)) return;
        view.input = { ...view.input, transcriptGrades: grades };
        if (this.host.isOpen()) this.attach(view);
      },
      updateTranscriptCursor: (agentId, cursor) => {
        view.input = { ...view.input, transcriptSince: { ...view.input.transcriptSince, [agentId]: cursor } };
      },
      restart: () => { if (this.views.has(id)) this.host.restart(); },
      nudge: () => { if (this.views.has(id)) this.host.nudge(); },
      close: () => {
        if (!this.views.delete(id)) return;
        if (this.host.isOpen()) this.host.send({ type: 'view_detach', id });
        handler({ type: 'status', status: 'closed', generation: this.generation });
      },
    };
  }

  opened(): void {
    this.generation += 1;
    for (const view of this.views.values()) {
      view.handler({ type: 'status', status: 'open', generation: this.generation });
      this.attach(view);
    }
  }

  disconnected(error: Error): void {
    for (const view of this.views.values()) {
      view.handler({ type: 'status', status: 'closed', detail: error.message, generation: this.generation });
    }
  }

  connecting(): void {
    for (const view of this.views.values()) {
      view.handler({ type: 'status', status: 'connecting', generation: this.generation });
    }
  }

  close(): void { this.views.clear(); }

  receive(frame: KlientFrame): boolean {
    if (frame.type !== 'view_signal' && frame.type !== 'view_error') return false;
    const view = typeof frame.id === 'string' ? this.views.get(frame.id) : undefined;
    if (view === undefined) return true;
    if (frame.type === 'view_error') {
      this.views.delete(view.id);
      view.handler({ type: 'protocolError', generation: this.generation, recoverable: false, detail: (frame.msg ?? 'Session view subscription failed').slice(0, 512) });
    } else {
      const data = frame.data;
      const generation = data !== null && typeof data === 'object' ? (data as { generation?: unknown }).generation : undefined;
      if (typeof generation === 'number' && generation !== this.generation) return true;
      view.handler(data as SessionViewSignal);
    }
    return true;
  }

  private attach(view: ActiveView): void {
    this.host.send({
      type: 'view_attach', id: view.id, sessionId: view.sessionId,
      data: { input: view.input, generation: this.generation, reconnected: view.attachCount > 0 },
    });
    view.attachCount += 1;
  }
}
