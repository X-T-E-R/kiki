import type { SessionCursor } from '@kiki/protocol';
import type { SessionViewSignal } from '@kiki/klient';
import type { TranscriptEvent } from '@kiki/transcript';

import type { BroadcastDelivery, BroadcastTarget } from '../ws/v1/sessionEventBroadcaster';
import type { EventEnvelope } from '../ws/v1/sessionEventJournal';

export class SessionViewTarget implements BroadcastTarget {
  private generation = 0;
  private attaching = false;
  private replaySignals: SessionViewSignal[] = [];
  private liveSignals: SessionViewSignal[] = [];
  private latestSessionCursor: SessionCursor | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly emitSignal: (signal: SessionViewSignal) => void,
  ) {}

  sendDurableCursor(cursor: SessionCursor): void {
    this.latestSessionCursor = cursor;
    const signal: SessionViewSignal = { type: 'sessionCursorAdvanced', cursor, generation: this.generation };
    if (this.attaching) this.liveSignals.push(signal);
    else this.emitSignal(signal);
  }

  begin(generation: number): void {
    this.generation = generation;
    this.attaching = true;
    this.replaySignals = [];
    this.liveSignals = [];
    this.latestSessionCursor = undefined;
  }

  replay(envelope: EventEnvelope): void {
    const signal = this.fromEnvelope(envelope);
    if (signal !== undefined) this.replaySignals.push(signal);
  }

  finish(currentSessionCursor: SessionCursor, reconnected: boolean): void {
    const durableSeen = new Set<string>();
    const signals = [...this.replaySignals, ...this.liveSignals].filter((signal) => {
      if (signal.type !== 'sessionCursorAdvanced' && signal.type !== 'historyRewritten') return true;
      const key = `${signal.cursor.epoch ?? ''}:${signal.cursor.seq}`;
      if (durableSeen.has(key)) return false;
      durableSeen.add(key);
      return true;
    });
    const latest = this.latestSessionCursor;
    const readyCursor = latest !== undefined && latest.epoch === currentSessionCursor.epoch && latest.seq > currentSessionCursor.seq
      ? latest : currentSessionCursor;
    this.replaySignals = [];
    this.liveSignals = [];
    this.latestSessionCursor = undefined;
    this.attaching = false;
    for (const signal of signals) this.emitSignal(signal);
    this.emitSignal({ type: 'ready', currentSessionCursor: readyCursor, reconnected, generation: this.generation });
  }

  send(envelope: EventEnvelope, _delivery?: BroadcastDelivery): void {
    const signal = this.fromEnvelope(envelope);
    if (signal === undefined) return;
    if (this.attaching) this.liveSignals.push(signal);
    else this.emitSignal(signal);
  }

  sendControl(frame: unknown): void {
    if (frame === null || typeof frame !== 'object') return;
    const record = frame as { type?: unknown; payload?: unknown };
    if (record.type !== 'resync_required' || record.payload === null || typeof record.payload !== 'object') return;
    const payload = record.payload as { reason?: unknown; current_seq?: unknown; epoch?: unknown };
    if (payload.reason !== 'buffer_overflow' && payload.reason !== 'session_recreated' && payload.reason !== 'epoch_changed' && payload.reason !== 'history_rewritten') return;
    if (typeof payload.current_seq !== 'number') return;
    const signal: SessionViewSignal = {
      type: 'resyncRequired', reason: payload.reason,
      currentSessionCursor: { seq: payload.current_seq, epoch: typeof payload.epoch === 'string' ? payload.epoch : undefined },
      generation: this.generation,
    };
    if (this.attaching) this.liveSignals.push(signal);
    else this.emitSignal(signal);
  }

  private fromEnvelope(envelope: EventEnvelope): SessionViewSignal | undefined {
    if (envelope.session_id !== this.sessionId) return undefined;
    if (envelope.type === 'transcript.reset' || envelope.type === 'transcript.ops') {
      return { type: 'transcript', event: envelope.payload as TranscriptEvent, generation: this.generation };
    }
    if (envelope.volatile === true) return undefined;
    const cursor = { seq: envelope.seq, epoch: envelope.epoch };
    if (this.latestSessionCursor === undefined || this.latestSessionCursor.epoch !== cursor.epoch || cursor.seq > this.latestSessionCursor.seq) this.latestSessionCursor = cursor;
    const payload = envelope.payload;
    if (payload !== null && typeof payload === 'object') {
      const event = payload as { type?: unknown; agentId?: unknown; reason?: unknown; target_message_id?: unknown };
      if (event.type === 'agent.created' && typeof event.agentId === 'string' && event.agentId !== '') {
        return { type: 'sessionCursorAdvanced', cursor, generation: this.generation, rosterAgentId: event.agentId };
      }
      if (event.type === 'event.session.history_rewritten' && (event.reason === 'edit_resend' || event.reason === 'regenerate') && typeof event.target_message_id === 'string') {
        return { type: 'historyRewritten', reason: event.reason, targetMessageId: event.target_message_id, cursor, generation: this.generation };
      }
    }
    return { type: 'sessionCursorAdvanced', cursor, generation: this.generation };
  }
}
