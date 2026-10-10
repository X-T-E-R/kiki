import { resyncRequiredReasonSchema, sessionCursorSchema, type SessionCursor } from '@kiki/protocol';
import type { SessionViewSignal } from '@kiki/klient';
import type { TranscriptEvent } from '@kiki/transcript';

import type { BroadcastDelivery, BroadcastTarget } from '../ws/v1/sessionEventBroadcaster';
import type { EventEnvelope } from '../ws/v1/sessionEventJournal';

export class SessionViewTarget implements BroadcastTarget {
  private generation = 0;
  private attaching = false;
  private streaming = false;
  private recoveryRequired = false;
  private replaySignals: SessionViewSignal[] = [];
  private liveSignals: SessionViewSignal[] = [];
  private latestSessionCursor: SessionCursor | undefined;
  private readonly rosterActivity = new Map<string, string>();
  private readonly durableSeen = new Set<string>();

  constructor(
    private readonly sessionId: string,
    private readonly emitSignal: (signal: SessionViewSignal) => void,
  ) {}

  sendDurableCursor(cursor: SessionCursor): void {
    if (this.recoveryRequired) return;
    this.latestSessionCursor = cursor;
    const signal: SessionViewSignal = { type: 'sessionCursorAdvanced', cursor, generation: this.generation };
    if (this.attaching && !this.streaming) this.liveSignals.push(signal);
    else this.publishSignal(signal);
  }

  begin(generation: number): void {
    this.generation = generation;
    this.attaching = true;
    this.streaming = false;
    this.recoveryRequired = false;
    this.replaySignals = [];
    this.liveSignals = [];
    this.latestSessionCursor = undefined;
    this.rosterActivity.clear();
    this.durableSeen.clear();
  }

  replay(envelope: EventEnvelope): void {
    const signal = this.fromEnvelope(envelope);
    if (signal !== undefined) this.replaySignals.push(signal);
  }

  async drain(): Promise<void> {
    this.flushSignals();
    this.streaming = true;
  }

  private publishSignal(signal: SessionViewSignal): void {
    if (signal.type === 'sessionCursorAdvanced' || signal.type === 'historyRewritten') {
      if (this.recoveryRequired) return;
      if (this.attaching && (signal.type === 'historyRewritten' || signal.rosterAgentId === undefined)) {
        const key = `${signal.type}:${signal.cursor.epoch ?? ''}:${signal.cursor.seq}`;
        if (this.durableSeen.has(key)) return;
        this.durableSeen.add(key);
      }
    }
    this.emitSignal(signal);
  }

  private flushSignals(): void {
    const signals = [...this.replaySignals, ...this.liveSignals];
    this.replaySignals = [];
    this.liveSignals = [];
    for (const signal of signals) this.publishSignal(signal);
  }

  finish(currentSessionCursor: SessionCursor, reconnected: boolean): void {
    const latest = this.latestSessionCursor;
    const readyCursor = latest !== undefined && latest.epoch === currentSessionCursor.epoch && latest.seq > currentSessionCursor.seq
      ? latest : currentSessionCursor;
    this.latestSessionCursor = undefined;
    this.flushSignals();
    this.attaching = false;
    this.durableSeen.clear();
    if (!this.recoveryRequired) this.emitSignal({ type: 'ready', currentSessionCursor: readyCursor, reconnected, generation: this.generation });
  }

  send(envelope: EventEnvelope, _delivery?: BroadcastDelivery): void {
    const signal = this.fromEnvelope(envelope);
    if (signal === undefined) return;
    if (this.attaching && !this.streaming) this.liveSignals.push(signal);
    else this.publishSignal(signal);
  }

  sendControl(frame: unknown): void {
    if (frame === null || typeof frame !== 'object') return;
    const record = frame as { type?: unknown; payload?: unknown };
    if (record.type !== 'resync_required') return;
    this.recoveryRequired = true;
    const payload = record.payload as { reason?: unknown; current_seq?: unknown; epoch?: unknown } | null | undefined;
    const reason = resyncRequiredReasonSchema.safeParse(payload?.reason);
    const cursor = sessionCursorSchema.safeParse({ seq: payload?.current_seq, epoch: payload?.epoch });
    const signal: SessionViewSignal = reason.success && cursor.success ? {
      type: 'resyncRequired', reason: reason.data, currentSessionCursor: cursor.data, generation: this.generation,
    } : { type: 'protocolError', detail: 'Invalid session recovery signal', recoverable: true, generation: this.generation };
    if (this.attaching && !this.streaming) this.liveSignals.push(signal);
    else this.publishSignal(signal);
  }

  private fromEnvelope(envelope: EventEnvelope): SessionViewSignal | undefined {
    if (envelope.session_id !== this.sessionId) return undefined;
    if (envelope.type === 'transcript.reset' || envelope.type === 'transcript.ops') {
      return { type: 'transcript', event: envelope.payload as TranscriptEvent, generation: this.generation };
    }
    if (this.recoveryRequired) return undefined;
    if (envelope.volatile === true) {
      if (envelope.type !== 'agent.status.updated' || envelope.payload === null || typeof envelope.payload !== 'object') return undefined;
      const event = envelope.payload as { agentId?: unknown; model?: unknown; thinkingEffort?: unknown; phase?: { kind?: unknown; turnId?: unknown } };
      if (typeof event.agentId !== 'string' || event.agentId === '' || event.agentId === 'main' || typeof event.phase?.kind !== 'string') return undefined;
      const kind = event.phase.kind;
      const status = kind === 'idle' || kind === 'ended' || kind === 'awaiting_approval' ? kind : 'active';
      const turnId = typeof event.phase.turnId === 'string' || typeof event.phase.turnId === 'number'
        ? String(event.phase.turnId)
        : '';
      const key = JSON.stringify([status, turnId,
        typeof event.model === 'string' ? event.model : undefined,
        typeof event.thinkingEffort === 'string' ? event.thinkingEffort : undefined]);
      if (this.rosterActivity.get(event.agentId) === key) return undefined;
      this.rosterActivity.set(event.agentId, key);
      return { type: 'sessionCursorAdvanced', cursor: { seq: envelope.seq, epoch: envelope.epoch }, generation: this.generation, rosterAgentId: event.agentId };
    }
    const cursor = { seq: envelope.seq, epoch: envelope.epoch };
    if (this.latestSessionCursor === undefined || this.latestSessionCursor.epoch !== cursor.epoch || cursor.seq > this.latestSessionCursor.seq) this.latestSessionCursor = cursor;
    const payload = envelope.payload;
    if (payload !== null && typeof payload === 'object') {
      const event = payload as { type?: unknown; agentId?: unknown; reason?: unknown; target_message_id?: unknown; title?: unknown; patch?: { title?: unknown } };
      if (event.type === 'session.meta.updated') {
        const title = event.patch?.title ?? event.title;
        if (typeof title === 'string') return { type: 'sessionCursorAdvanced', cursor, title, generation: this.generation };
      }
      if ((event.type === 'agent.created' || event.type === 'agent.disposed') && typeof event.agentId === 'string' && event.agentId !== '') {
        return { type: 'sessionCursorAdvanced', cursor, generation: this.generation, rosterAgentId: event.agentId };
      }
      if (event.type === 'event.session.history_rewritten' && (event.reason === 'edit_resend' || event.reason === 'regenerate') && typeof event.target_message_id === 'string') {
        return { type: 'historyRewritten', reason: event.reason, targetMessageId: event.target_message_id, cursor, generation: this.generation };
      }
    }
    return { type: 'sessionCursorAdvanced', cursor, generation: this.generation };
  }
}
