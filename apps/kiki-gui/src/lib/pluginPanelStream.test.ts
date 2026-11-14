// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPluginPanelStream } from './pluginPanelStream';

class StreamSocket {
  static readonly OPEN = 1;
  static latest: StreamSocket;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  readonly sent: unknown[] = [];
  onopen?: () => void;
  onmessage?: (event: MessageEvent) => void;
  onclose?: (event: CloseEvent) => void;
  onerror?: () => void;
  constructor(readonly url: URL, readonly protocols: string[]) { StreamSocket.latest = this; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  frame(data: unknown): void { this.onmessage?.(new MessageEvent('message', { data })); }
  send(value: unknown): void { this.sent.push(value); }
  close(code = 1000, reason = ''): void { this.readyState = 3; this.onclose?.(new CloseEvent('close', { code, reason })); }
}

describe('plugin stream WebSocket client', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('uses bearer admission, ready metadata and raw arraybuffer/text frames', async () => {
    vi.stubGlobal('WebSocket', StreamSocket);
    const connection = { baseUrl: 'https://example.test', token: 'fixture-token', signal: new AbortController() };
    const opening = openPluginPanelStream(connection, 'example', 'screen', { stream: 'video', args: { fps: 60 }, session_id: 'session-a', workspace_id: 'workspace-a' });
    const ws = StreamSocket.latest;
    expect(ws.url.href).toBe('wss://example.test/api/plugins/example/panels/screen/stream');
    expect(ws.protocols).toEqual(['kimi-code.bearer.fixture-token']);
    expect(ws.binaryType).toBe('arraybuffer');
    ws.open();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'open', stream: 'video', args: { fps: 60 }, session_id: 'session-a', workspace_id: 'workspace-a' });
    ws.frame('{"type":"ready","ok":true,"result":{"protocol":"h264"}}');
    const stream = await opening;
    expect(stream.result).toEqual({ protocol: 'h264' });
    const onBinary = vi.fn(); const onText = vi.fn(); const onClose = vi.fn();
    stream.onBinary(onBinary); stream.onText(onText); stream.onClose(onClose);
    const bytes = new Uint8Array([0, 255, 7]).buffer;
    ws.frame(bytes); ws.frame('{"type":"ready","payload":"raw"}');
    expect(onBinary).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(onBinary.mock.calls[0]![0]).toBe(bytes);
    expect(onText).toHaveBeenCalledExactlyOnceWith('{"type":"ready","payload":"raw"}');
    expect(stream.sendBinary(bytes)).toBe(true);
    const view = new Uint8Array(bytes, 1, 1);
    expect(stream.sendBinary(view)).toBe(true);
    expect(stream.sendText('touch')).toBe(true);
    expect(ws.sent.slice(1)).toEqual([bytes, view, 'touch']);
    connection.signal.abort();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(1000, '');
    expect(stream.sendText('late')).toBe(false);
    const late = vi.fn(); stream.onClose(late);
    expect(late).toHaveBeenCalledExactlyOnceWith(1000, '');
  });

  it('uses browser cookies without a bearer protocol and bounds slow consumers', async () => {
    vi.stubGlobal('WebSocket', StreamSocket);
    const opening = openPluginPanelStream({ baseUrl: '', signal: new AbortController() }, 'example', 'settings', { stream: 'video' });
    const ws = StreamSocket.latest;
    expect(ws.protocols).toEqual([]);
    ws.open(); ws.frame('{"type":"ready","ok":true}');
    const stream = await opening;
    const closed = vi.fn(); stream.onClose(closed);
    ws.bufferedAmount = 16 * 1024 * 1024;
    expect(stream.sendBinary(new Uint8Array([1]))).toBe(false);
    expect(closed).toHaveBeenCalledWith(1009, 'Stream buffer limit exceeded');
  });

  it('rejects failed, disconnected and timed-out opens', async () => {
    vi.stubGlobal('WebSocket', StreamSocket);
    for (const failure of ['ready', 'disconnect', 'timeout']) {
      vi.useFakeTimers();
      const opening = openPluginPanelStream({ baseUrl: 'http://example.test', signal: new AbortController() }, 'example', 'screen', { stream: 'video' });
      const rejected = expect(opening).rejects.toThrow();
      const ws = StreamSocket.latest;
      ws.open();
      if (failure === 'ready') ws.frame('{"type":"ready","ok":false,"error":"Denied"}');
      else if (failure === 'disconnect') ws.close(1008, 'Denied');
      else await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(ws.readyState).toBe(3);
      vi.useRealTimers();
    }
  });
});
