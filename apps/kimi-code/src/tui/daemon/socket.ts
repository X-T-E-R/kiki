import type { SessionCursor } from '@moonshot-ai/protocol';
import {
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  type TranscriptCursor,
  type TranscriptEvent,
  type TranscriptGradeSpec,
} from '@moonshot-ai/transcript';

import { DEFAULT_TRANSCRIPT_GRADES, type SessionSocket } from '@kiki/session-core/transport';
import type { ResyncRequiredPayload, SessionEventFrame } from '@kiki/session-core/wire';

interface DesiredSubscription {
  readonly cursor: SessionCursor;
  readonly grades: TranscriptGradeSpec;
  readonly transcriptSince: Readonly<Record<string, TranscriptCursor>>;
}

interface WireMessage {
  readonly type?: string;
  readonly id?: string;
  readonly payload?: unknown;
}

export interface DaemonSocketEvents {
  readonly onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
  readonly onFrame: (frame: SessionEventFrame, generation: number) => void;
  readonly onTranscript: (event: TranscriptEvent, generation: number) => void;
  readonly onResyncRequired: (payload: ResyncRequiredPayload, generation: number) => void;
  readonly onSubscribeAck: (
    accepted: readonly string[],
    resyncRequired: readonly string[],
    reconnected: boolean,
    generation: number,
  ) => void;
}

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
let clientCounter = 0;

export class DaemonSocket implements SessionSocket {
  private readonly url: string;
  private readonly token: string;
  private readonly events: DaemonSocketEvents;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly desired = new Map<string, DesiredSubscription>();
  private readonly clientId = `kimi-tui-${Date.now().toString(36)}-${(clientCounter += 1)}`;
  private ws: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private helloCount = 0;
  private helloReceived = false;
  private manuallyClosed = false;
  private idCounter = 0;
  private generation = 0;

  constructor(options: {
    readonly url: string;
    readonly token: string;
    readonly events: DaemonSocketEvents;
    readonly WebSocket?: typeof WebSocket;
  }) {
    this.url = `${options.url.replace(/^http/u, 'ws').replace(/\/$/u, '')}/api/v1/ws`;
    this.token = options.token;
    this.events = options.events;
    this.WebSocketCtor = options.WebSocket ?? WebSocket;
  }

  get connectionGeneration(): number {
    return this.generation;
  }

  connect(): void {
    this.manuallyClosed = false;
    this.open();
  }

  close(): void {
    this.manuallyClosed = true;
    this.helloReceived = false;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.ws?.close();
    this.ws = undefined;
    this.events.onStatus?.('closed');
  }

  subscribe(sessionId: string, cursor: SessionCursor, grades?: TranscriptGradeSpec): void {
    const current = this.desired.get(sessionId);
    this.desired.set(sessionId, {
      cursor,
      grades: grades ?? current?.grades ?? DEFAULT_TRANSCRIPT_GRADES,
      transcriptSince: current?.transcriptSince ?? {},
    });
    if (this.ready()) this.sendSubscriptions([sessionId]);
  }

  unsubscribe(sessionId: string): void {
    this.desired.delete(sessionId);
    if (!this.ready()) return;
    this.send({ type: 'unsubscribe', id: this.nextId(), payload: { session_ids: [sessionId] } });
    this.send({ type: 'unsubscribe_v2', id: this.nextId(), payload: { session_id: sessionId } });
  }

  restartGeneration(): void {
    this.ws?.close();
  }

  updateCursor(sessionId: string, cursor: SessionCursor): void {
    const current = this.desired.get(sessionId);
    if (current === undefined) return;
    this.desired.set(sessionId, { ...current, cursor });
  }

  setTranscriptGrades(sessionId: string, grades: TranscriptGradeSpec): void {
    const current = this.desired.get(sessionId);
    if (current === undefined) return;
    this.desired.set(sessionId, { ...current, grades });
    if (this.ready()) this.sendTranscriptSubscription(sessionId, grades, current.transcriptSince);
  }

  clearTranscriptSince(sessionId: string): void {
    const current = this.desired.get(sessionId);
    if (current === undefined) return;
    this.desired.set(sessionId, { ...current, transcriptSince: {} });
  }

  updateTranscriptSince(sessionId: string, agentId: string, cursor: TranscriptCursor): void {
    const current = this.desired.get(sessionId);
    if (current === undefined) return;
    this.desired.set(sessionId, {
      ...current,
      transcriptSince: { ...current.transcriptSince, [agentId]: cursor },
    });
  }

  abort(sessionId: string, promptId: string): void {
    if (!this.ready()) return;
    this.send({
      type: 'abort',
      id: this.nextId(),
      payload: { session_id: sessionId, prompt_id: promptId },
    });
  }

  private open(): void {
    if (this.manuallyClosed || this.ws !== undefined) return;
    this.generation += 1;
    const generation = this.generation;
    this.events.onStatus?.('connecting');
    const ws = new this.WebSocketCtor(this.url, [`kimi-code.bearer.${this.token}`]);
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      this.handleMessage(event.data, generation);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.helloReceived = false;
      this.events.onStatus?.('closed');
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: string, generation: number): void {
    const message = JSON.parse(raw) as WireMessage;
    switch (message.type) {
      case 'server_hello':
        this.reconnectAttempt = 0;
        this.helloCount += 1;
        this.helloReceived = true;
        this.send({
          type: 'client_hello',
          id: this.nextId(),
          payload: { client_id: this.clientId },
        });
        this.events.onStatus?.('open');
        this.sendSubscriptions([...this.desired.keys()]);
        return;
      case 'ack': {
        const payload = message.payload as
          | { accepted?: string[]; accepted_subscriptions?: string[]; resync_required?: string[] }
          | undefined;
        if (payload === undefined) return;
        const accepted = payload.accepted ?? payload.accepted_subscriptions ?? [];
        const resyncRequired = payload.resync_required ?? [];
        this.events.onSubscribeAck(
          accepted,
          resyncRequired,
          this.helloCount > 1,
          generation,
        );
        return;
      }
      case 'transcript.reset':
      case 'transcript.ops': {
        const parsed =
          message.type === 'transcript.reset'
            ? transcriptResetEventSchema.parse(message.payload)
            : transcriptOpsEventSchema.parse(message.payload);
        this.events.onTranscript(parsed, generation);
        return;
      }
      case 'resync_required':
        this.events.onResyncRequired(message.payload as ResyncRequiredPayload, generation);
        return;
      default: {
        const frame = message as unknown as SessionEventFrame;
        if (typeof frame.seq === 'number' && frame.payload !== undefined) {
          this.events.onFrame(frame, generation);
        }
      }
    }
  }

  private sendSubscriptions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    const cursors: Record<string, SessionCursor> = {};
    for (const sessionId of sessionIds) {
      const desired = this.desired.get(sessionId);
      if (desired !== undefined) cursors[sessionId] = desired.cursor;
    }
    this.send({
      type: 'subscribe',
      id: this.nextId(),
      payload: { session_ids: sessionIds, cursors },
    });
    for (const sessionId of sessionIds) {
      const desired = this.desired.get(sessionId);
      if (desired !== undefined) {
        this.sendTranscriptSubscription(sessionId, desired.grades, desired.transcriptSince);
      }
    }
  }

  private sendTranscriptSubscription(
    sessionId: string,
    grades: TranscriptGradeSpec,
    transcriptSince: Readonly<Record<string, TranscriptCursor>>,
  ): void {
    this.send({
      type: 'subscribe_v2',
      id: this.nextId(),
      payload: {
        session_id: sessionId,
        transcript: grades,
        transcript_since: Object.keys(transcriptSince).length > 0 ? transcriptSince : undefined,
      },
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.ready()) return;
    this.ws?.send(JSON.stringify(frame));
  }

  private ready(): boolean {
    return this.helloReceived && this.ws?.readyState === this.WebSocketCtor.OPEN;
  }

  private nextId(): string {
    this.idCounter += 1;
    return `${this.clientId}-${this.idCounter}`;
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer !== undefined) return;
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }
}
