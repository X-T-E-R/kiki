import { IPluginHostService, IPluginService, IPluginUsageService, ISessionIndex, type Scope } from '@kiki/agent-core-v2';
import type { PluginPanelStream } from '@kiki/agent-core-v2/app/plugin/panelStream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { selectWsBearerProtocol } from '../transport/ws/bearerProtocol';
import { pluginContextWorkspace } from './plugins';

export const PLUGIN_PANEL_STREAM_PATH = /^\/api\/plugins\/([^/?]+)\/panels\/([^/?]+)\/stream(?:\?.*)?$/;
const MAX_BYTES = 16 * 1024 * 1024;
const openSchema = z.object({
  type: z.literal('open'),
  stream: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  args: z.unknown().optional(),
  session_id: z.string().min(1).max(128).optional(),
  workspace_id: z.string().min(1).max(4096).optional(),
});

export function createPluginPanelStreamServer(core: Scope): { server: WebSocketServer; closeStream(ws: WebSocket, code: number, reason: string): void } {
  const server = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol, maxPayload: MAX_BYTES, perMessageDeflate: false });
  const closers = new WeakMap<WebSocket, (code: number, reason: string) => void>();
  server.on('connection', (ws, request) => {
    let stream: PluginPanelStream | undefined;
    let state: 'waiting' | 'opening' | 'ready' | 'closed' = 'waiting';
    const subscriptions: Array<() => void> = [];
    const controller = new AbortController();
    const close = (code: number, reason: string) => {
      if (state === 'closed') return;
      state = 'closed';
      clearTimeout(timer);
      controller.abort(new Error(reason));
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      stream?.close(reason);
      ws.close(code, Buffer.from(reason).subarray(0, 120).toString('utf8'));
      const terminate = setTimeout(() => ws.terminate(), 1000);
      terminate.unref();
      ws.once('close', () => clearTimeout(terminate));
    };
    closers.set(ws, close);
    const timer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ready', ok: false, error: 'Plugin stream open timed out' }));
      close(1008, 'Plugin stream open timed out');
    }, 15_000);
    timer.unref();
    const send = (data: Buffer | string, binary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      if (ws.bufferedAmount + bytes > MAX_BYTES) { close(1013, 'Plugin stream consumer is too slow'); return; }
      ws.send(data, { binary }, (error) => { if (error) close(1011, 'Plugin stream send failed'); });
    };
    const open = async (data: RawData, isBinary: boolean) => {
      let admitted = false;
      try {
        if (isBinary) throw new Error('Expected a text open frame');
        const message = openSchema.parse(JSON.parse(data.toString()));
        const match = PLUGIN_PANEL_STREAM_PATH.exec(request.url ?? '')!;
        const pluginId = decodeURIComponent(match[1]!);
        const panelId = decodeURIComponent(match[2]!);
        const info = await core.accessor.get(IPluginService).getPluginInfo({ id: pluginId });
        const panel = info.manifest?.kiki?.panels?.find((item) => item.id === panelId);
        if (!info.enabled || info.state !== 'ok' || panel === undefined) throw new Error('Panel is not enabled');
        const sessionId = message.session_id;
        if (panel.slot === 'settings' && sessionId !== undefined) throw new Error('Settings panels cannot access a session');
        const session = sessionId === undefined ? undefined : await core.accessor.get(ISessionIndex).get(sessionId);
        if (sessionId !== undefined && session === undefined) throw new Error('Session not found');
        if (session !== undefined && message.workspace_id !== undefined && message.workspace_id !== session.workspaceId) throw new Error('Session workspace does not match');
        const workspaceId = await pluginContextWorkspace(core, sessionId === undefined ? message : { session_id: sessionId });
        if (panel.slot !== 'settings' && !await core.accessor.get(IPluginUsageService).allows(workspaceId, info.id, sessionId)) throw new Error('Panel is not enabled in this workspace');
        if (ws.readyState !== WebSocket.OPEN) return;
        admitted = true;
        const opened = await core.accessor.get(IPluginHostService).openPanelStream(info.id, panel.id, message.stream, message.args, { sessionId, workspaceId, signal: controller.signal });
        if (ws.readyState !== WebSocket.OPEN) { opened.close(); return; }
        stream = opened;
        state = 'ready';
        clearTimeout(timer);
        send(JSON.stringify({ type: 'ready', ok: true, result: opened.result }), false);
        subscriptions.push(opened.onBinary((chunk) => send(chunk, true)), opened.onText((text) => send(text, false)));
        const unsubscribeClose = opened.onClose((reason) => close(1000, reason ?? ''));
        if (ws.readyState !== WebSocket.OPEN) unsubscribeClose();
        else subscriptions.push(unsubscribeClose);
      } catch (error) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const message = error instanceof Error ? error.message : String(error);
        send(JSON.stringify({ type: 'ready', ok: false, error: message }), false);
        close(admitted ? 1011 : 1008, message);
      }
    };
    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== WebSocket.OPEN) { close(1000, 'Connection closing'); return; }
      if (state === 'waiting') { state = 'opening'; void open(data, isBinary); }
      else if (state === 'ready') {
        if (isBinary) stream!.sendBinary(Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        else stream!.sendText(data.toString());
      } else if (state === 'opening') close(1008, 'Wait for the stream ready frame');
    });
    ws.on('error', () => close(1011, 'Plugin stream connection failed'));
    ws.once('close', () => close(1000, 'Client closed'));
  });
  return { server, closeStream: (ws, code, reason) => { closers.get(ws)?.(code, reason); } };
}
