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
  readonly signal?: AbortSignal;
}

type PluginPanelStreamConnection = {
  readonly baseUrl: string;
  readonly token?: string;
  readonly signal: AbortController;
};

export function openPluginPanelStream(
  connection: PluginPanelStreamConnection,
  pluginId: string,
  panelId: string,
  options: PluginPanelStreamOptions,
): Promise<PluginPanelStream> {
  const { signal: callerSignal, ...wireOptions } = options;
  const url = new URL(
    `${connection.baseUrl.replace(/\/+$/, '')}/api/plugins/${encodeURIComponent(pluginId)}/panels/${encodeURIComponent(panelId)}/stream`,
    window.location.origin,
  );
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, connection.token === undefined ? [] : [`kimi-code.bearer.${connection.token}`]);
  ws.binaryType = 'arraybuffer';
  const binary = new Set<(chunk: ArrayBuffer) => void>();
  const text = new Set<(text: string) => void>();
  const closed = new Set<(code: number, reason: string) => void>();
  const connectionSignal = connection.signal.signal;
  let closeEvent: CloseEvent | undefined;
  let ready = false;
  let settled = false;
  let clearTimer = () => {};
  let removeCallerAbortListener = () => {};
  let removeConnectionAbortListener = () => {};
  const removeAbortListeners = () => {
    removeCallerAbortListener();
    removeConnectionAbortListener();
  };
  const close = () => { ws.close(1000); };

  return new Promise((resolve, reject) => {
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      removeAbortListeners();
      reject(error);
    };
    const settleResolve = (stream: PluginPanelStream): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      removeCallerAbortListener();
      resolve(stream);
    };
    const abort = (): void => {
      if (!settled) settleReject(new Error('Connection changed'));
      close();
    };
    const onConnectionAbort = abort;
    const onCallerAbort = abort;
    connectionSignal.addEventListener('abort', onConnectionAbort, { once: true });
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    removeConnectionAbortListener = () => { connectionSignal.removeEventListener('abort', onConnectionAbort); };
    removeCallerAbortListener = () => { callerSignal?.removeEventListener('abort', onCallerAbort); };
    const timer = setTimeout(() => {
      settleReject(new Error('Plugin stream open timed out'));
      close();
    }, 15_000);
    clearTimer = () => { clearTimeout(timer); };

    ws.onopen = () => {
      if (settled) return;
      if (connectionSignal.aborted || callerSignal?.aborted) {
        abort();
        return;
      }
      ws.send(JSON.stringify({ type: 'open', ...wireOptions }));
    };
    ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (!ready) {
        if (settled) return;
        try {
          if (typeof event.data !== 'string') throw new Error('Expected plugin stream ready frame');
          const frame = JSON.parse(event.data) as { type: string; ok: boolean; result?: unknown; error?: string };
          if (frame.type !== 'ready' || !frame.ok) throw new Error(frame.error ?? 'Plugin stream open failed');
          if (connectionSignal.aborted || callerSignal?.aborted) {
            abort();
            return;
          }
          ready = true;
          settleResolve({ result: frame.result, sendBinary: send, sendText: send, close,
            onBinary: (listener) => { binary.add(listener); return () => { binary.delete(listener); }; },
            onText: (listener) => { text.add(listener); return () => { text.delete(listener); }; },
            onClose: (listener) => {
              if (closeEvent !== undefined) listener(closeEvent.code, closeEvent.reason);
              else closed.add(listener);
              return () => { closed.delete(listener); };
            },
          });
        } catch (error) {
          settleReject(error);
          close();
        }
        return;
      }
      if (typeof event.data === 'string') {
        for (const listener of text) listener(event.data);
      } else {
        for (const listener of binary) listener(event.data);
      }
    };
    ws.onerror = () => {
      if (!ready && !settled) {
        settleReject(new Error('Plugin stream connection failed'));
        close();
      }
    };
    ws.onclose = (event) => {
      clearTimer();
      removeAbortListeners();
      closeEvent = event;
      if (!ready) settleReject(new Error(event.reason || 'Plugin stream closed before opening'));
      for (const listener of closed) listener(event.code, event.reason);
      binary.clear();
      text.clear();
      closed.clear();
    };
    if (connectionSignal.aborted || callerSignal?.aborted) abort();
  });

  function send(chunk: string | ArrayBuffer | ArrayBufferView): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength;
    if (bytes > 16 * 1024 * 1024 || ws.bufferedAmount + bytes > 16 * 1024 * 1024) {
      ws.close(1009, 'Stream buffer limit exceeded');
      return false;
    }
    ws.send(chunk as string | ArrayBuffer | ArrayBufferView<ArrayBuffer>);
    return ws.bufferedAmount === 0;
  }
}
