import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '#/tui/daemon/client';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = 0;
  readonly url: string;
  readonly protocols: string[];
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url);
    this.protocols = typeof protocols === 'string' ? [protocols] : protocols ?? [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.readyState = 3; this.emit('close', {}); }
  message(frame: unknown): void { this.emit('message', { data: JSON.stringify(frame) }); }
  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('daemon Klient session socket', () => {
  it('shares the facade socket, resumes independent cursors, and routes ordered transcript signals', async () => {
    FakeWebSocket.instances = [];
    const client = new DaemonClient({ url: 'http://127.0.0.1:57580', token: 'secret', WebSocket: FakeWebSocket as never });
    const signal = vi.fn();
    const handle = client.klient.session('session-1').view.subscribe({
      sessionCursor: { seq: 7, epoch: 'session-epoch' },
      transcriptGrades: { '*': 'turn', main: 'delta' },
      transcriptSince: { main: { seq: 3, epoch: 'transcript-epoch' } },
    }, signal);
    try {
      await Promise.resolve();
      const wire = FakeWebSocket.instances[0]!;
      expect(wire.url).toBe('ws://127.0.0.1:57580/api/klient/events');
      expect(wire.protocols).toEqual(['kimi-code.bearer.secret']);
      const attach = wire.sent.find((frame) => frame['type'] === 'view_attach')!;
      expect(attach['data']).toMatchObject({ input: { sessionCursor: { seq: 7 }, transcriptSince: { main: { seq: 3 } } } });
      wire.message({ type: 'view_signal', id: attach['id'], data: {
        type: 'transcript', generation: 1,
        event: { type: 'transcript.ops', session_id: 'session-1', agent_id: 'main', ops: [], cursor: { seq: 4, epoch: 'transcript-epoch' }, through_seq: 4 },
      } });
      expect(signal).toHaveBeenCalledWith(expect.objectContaining({ type: 'transcript', generation: 1 }));
      handle.updateSessionCursor({ seq: 9, epoch: 'session-epoch' });
      handle.updateTranscriptCursor('main', { seq: 4, epoch: 'transcript-epoch' });
      handle.restart();
      await Promise.resolve();
      const recovered = FakeWebSocket.instances[1]!.sent.find((frame) => frame['type'] === 'view_attach')!;
      expect(recovered['data']).toMatchObject({ generation: 2, reconnected: true, input: {
        sessionCursor: { seq: 9, epoch: 'session-epoch' }, transcriptSince: { main: { seq: 4, epoch: 'transcript-epoch' } },
      } });
    } finally {
      handle.close();
      await client.close();
    }
  });
});
