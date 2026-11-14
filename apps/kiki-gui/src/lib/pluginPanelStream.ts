export interface PluginPanelStream {
  readonly result: unknown;
  sendBinary(chunk: ArrayBuffer | ArrayBufferView): boolean;
  sendText(text: string): boolean;
  close(): void;
  onBinary(listener: (chunk: ArrayBuffer) => void): () => void;
  onText(listener: (text: string) => void): () => void;
  onClose(listener: (code: number, reason: string) => void): () => void;
}

export interface PluginPanelStreamOptions {
  readonly stream: string;
  readonly args?: unknown;
  readonly session_id?: string;
  readonly workspace_id?: string;
}

export function openPluginPanelStream(connection: { baseUrl: string; token?: string; signal: AbortController }, pluginId: string, panelId: string, options: PluginPanelStreamOptions): Promise<PluginPanelStream> {
  const url = new URL(`${connection.baseUrl.replace(/\/+$/, '')}/api/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}/stream`, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, connection.token === undefined ? [] : [`kimi-code.bearer.${connection.token}`]);
  ws.binaryType = 'arraybuffer';
  const binary = new Set<(chunk: ArrayBuffer) => void>();
  const text = new Set<(text: string) => void>();
  const closed = new Set<(code: number, reason: string) => void>();
  let closeEvent: CloseEvent | undefined;
  let ready = false;
  const close = () => { ws.close(1000); };
  const send = (chunk: string | ArrayBuffer | ArrayBufferView): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength;
    if (bytes > 16 * 1024 * 1024 || ws.bufferedAmount + bytes > 16 * 1024 * 1024) { ws.close(1009, 'Stream buffer limit exceeded'); return false; }
    ws.send(chunk as string | ArrayBuffer | ArrayBufferView<ArrayBuffer>);
    return ws.bufferedAmount === 0;
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('Plugin stream open timed out')); close(); }, 15_000);
    const abort = () => { reject(new Error('Connection changed')); close(); };
    connection.signal.signal.addEventListener('abort', abort, { once: true });
    ws.onopen = () => {
      if (connection.signal.signal.aborted) { abort(); return; }
      ws.send(JSON.stringify({ type: 'open', ...options }));
    };
    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (!ready) {
        try {
          if (typeof event.data !== 'string') throw new Error('Expected plugin stream ready frame');
          const frame = JSON.parse(event.data) as { type: string; ok: boolean; result?: unknown; error?: string };
          if (frame.type !== 'ready' || frame.ok !== true) throw new Error(frame.error ?? 'Plugin stream open failed');
          ready = true;
          clearTimeout(timer);
          resolve({ result: frame.result, sendBinary: send, sendText: send, close,
            onBinary: (listener) => { binary.add(listener); return () => { binary.delete(listener); }; },
            onText: (listener) => { text.add(listener); return () => { text.delete(listener); }; },
            onClose: (listener) => {
              if (closeEvent !== undefined) listener(closeEvent.code, closeEvent.reason);
              else closed.add(listener);
              return () => { closed.delete(listener); };
            },
          });
        } catch (error) { clearTimeout(timer); reject(error); close(); }
        return;
      }
      if (typeof event.data === 'string') { for (const listener of text) listener(event.data); }
      else { for (const listener of binary) listener(event.data); }
    };
    ws.onerror = () => { if (!ready) reject(new Error('Plugin stream connection failed')); };
    ws.onclose = (event) => {
      clearTimeout(timer);
      connection.signal.signal.removeEventListener('abort', abort);
      closeEvent = event;
      if (!ready) reject(new Error(event.reason || 'Plugin stream closed before opening'));
      for (const listener of closed) listener(event.code, event.reason);
      binary.clear(); text.clear(); closed.clear();
    };
  });
}
