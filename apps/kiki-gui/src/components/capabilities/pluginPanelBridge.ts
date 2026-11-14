import type { PluginPanelBridgeRequest } from '@kiki/protocol';
import type { KikiClient, PluginPanelStream } from '../../lib/client';

export const PANEL_CHANNEL = 'kiki.panel.v1';
export type PanelRequestMethod =
  | 'session.summary'
  | 'session.sendMessage'
  | 'plugin.call'
  | 'plugin.openExternal'
  | 'plugin.openStream'
  | 'plugin.installPrerequisite'
  | 'plugin.settings.get'
  | 'plugin.settings.patch'
  | 'plugin.models.list';

export interface PanelRequest {
  readonly channel: typeof PANEL_CHANNEL;
  readonly kind: 'request';
  readonly id: number;
  readonly method: PanelRequestMethod;
  readonly text?: unknown;
  readonly action?: unknown;
  readonly args?: unknown;
  readonly url?: unknown;
  readonly stream?: unknown;
  readonly prerequisiteId?: unknown;
  readonly consent?: unknown;
  readonly values?: unknown;
}

const PANEL_METHODS = new Set<string>([
  'session.summary',
  'session.sendMessage',
  'plugin.call',
  'plugin.openExternal',
  'plugin.openStream',
  'plugin.installPrerequisite',
  'plugin.settings.get',
  'plugin.settings.patch',
  'plugin.models.list',
]);

export function isPanelRequest(data: unknown): data is PanelRequest {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return record['channel'] === PANEL_CHANNEL && record['kind'] === 'request' &&
    Number.isSafeInteger(record['id']) && PANEL_METHODS.has(String(record['method']));
}

export function isPluginPanelStreamName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value);
}

export function panelWebUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid webpage URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) webpages without embedded credentials can be opened');
  return url.href;
}

export function patchValues(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const values: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && item !== null) return undefined;
    values[key] = item;
  }
  return values;
}

export function bridgeBody(request: PanelRequest, sessionId?: string): PluginPanelBridgeRequest | string {
  if (request.method === 'plugin.models.list') {
    return { method: 'plugin.models.list' };
  }
  if (request.method === 'plugin.settings.get') {
    return { method: 'plugin.settings.get' };
  }
  if (request.method === 'plugin.settings.patch') {
    const values = patchValues(request.values);
    if (values === undefined) return 'invalid settings';
    return { method: 'plugin.settings.patch', values };
  }
  if (request.method === 'plugin.call') {
    if (typeof request.action !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(request.action)) return 'invalid action';
    return { method: 'plugin.call', session_id: sessionId, action: request.action, args: request.args };
  }
  if (sessionId === undefined) return 'no session';
  if (request.method === 'session.summary') return { method: 'session.summary', session_id: sessionId };
  if (request.method === 'session.sendMessage') {
    if (typeof request.text !== 'string' || request.text.trim() === '') return 'text must be a non-empty string';
    if (request.text.length > 16384) return 'text exceeds 16384 characters';
    return { method: 'session.sendMessage', session_id: sessionId, text: request.text };
  }
  return 'unsupported method';
}

export type PluginPanelStreamClient = Pick<KikiClient, 'openPluginPanelStream'>;

export interface PluginPanelStreamContext {
  readonly session_id?: string;
  readonly workspace_id?: string;
}

interface PendingPluginPanelStream {
  readonly port1: MessagePort;
  readonly port2: MessagePort;
  closed: boolean;
}

interface ActivePluginPanelStream {
  readonly stream: PluginPanelStream;
  readonly hostPort: MessagePort;
  readonly framePort: MessagePort;
  readonly unsubscribe: Array<() => void>;
  closed: boolean;
}

export class PluginPanelStreamBridge {
  private readonly streams = new Set<ActivePluginPanelStream>();
  private readonly pending = new Set<PendingPluginPanelStream>();

  closeAll(): void {
    for (const pending of this.pending) this.closePending(pending);
    this.pending.clear();
    for (const active of this.streams) this.close(active);
  }

  async open(input: {
    readonly client: PluginPanelStreamClient;
    readonly pluginId: string;
    readonly panelId: string;
    readonly request: PanelRequest;
    readonly context: PluginPanelStreamContext;
    readonly isCurrent: () => boolean;
    readonly respond: (message: unknown, transfer: Transferable[]) => boolean;
  }): Promise<void> {
    if (!isPluginPanelStreamName(input.request.stream)) throw new Error('invalid stream');
    const channel = new MessageChannel();
    const pending: PendingPluginPanelStream = { port1: channel.port1, port2: channel.port2, closed: false };
    this.pending.add(pending);
    let stream: PluginPanelStream;
    try {
      stream = await input.client.openPluginPanelStream(input.pluginId, input.panelId, {
        stream: input.request.stream,
        args: input.request.args,
        session_id: input.context.session_id,
        workspace_id: input.context.workspace_id,
      });
    } catch (error) {
      this.closePending(pending);
      throw error;
    }
    if (pending.closed || !input.isCurrent()) {
      stream.close();
      this.closePending(pending);
      return;
    }
    this.pending.delete(pending);

    const active: ActivePluginPanelStream = {
      stream,
      hostPort: channel.port1,
      framePort: channel.port2,
      unsubscribe: [],
      closed: false,
    };
    this.streams.add(active);
    const subscribe = (unsubscribe: () => void) => {
      if (active.closed) unsubscribe();
      else active.unsubscribe.push(unsubscribe);
    };
    active.hostPort.onmessage = (event: MessageEvent<unknown>) => {
      if (active.closed) return;
      const data = event.data;
      if (data !== null && typeof data === 'object' && (data as Record<string, unknown>)['__kikiStreamControl'] === 'close') {
        this.close(active);
        return;
      }
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        active.stream.sendBinary(data);
        return;
      }
      if (typeof data === 'string') {
        active.stream.sendText(data);
        return;
      }
      if (data !== null && typeof data === 'object') {
        try {
          const text = JSON.stringify(data);
          if (text !== undefined) active.stream.sendText(text);
        } catch {
          this.close(active);
        }
      }
    };
    active.hostPort.start();
    subscribe(stream.onBinary((chunk) => {
      if (active.closed) return;
      try { active.hostPort.postMessage(chunk, [chunk]); } catch { this.close(active); }
    }));
    subscribe(stream.onText((text) => {
      if (active.closed) return;
      try { active.hostPort.postMessage(text); } catch { this.close(active); }
    }));
    subscribe(stream.onClose((code, reason) => {
      if (active.closed) return;
      try { active.hostPort.postMessage({ __kikiStreamEvent: 'close', code, reason }); } catch {
        this.close(active);
        return;
      }
      active.closed = true;
      this.streams.delete(active);
      active.hostPort.onmessage = null;
      for (const unsubscribe of active.unsubscribe.splice(0)) unsubscribe();
      active.hostPort.close();
    }));

    try {
      const posted = !active.closed && input.isCurrent() && input.respond({
        channel: PANEL_CHANNEL,
        kind: 'response',
        id: input.request.id,
        ok: true,
        result: stream.result,
      }, [active.framePort]);
      if (!posted) this.close(active);
    } catch (error) {
      this.close(active);
      throw error;
    }
  }

  private closePending(pending: PendingPluginPanelStream): void {
    this.pending.delete(pending);
    if (pending.closed) return;
    pending.closed = true;
    this.closePorts(pending.port1, pending.port2);
  }

  private close(active: ActivePluginPanelStream): void {
    if (active.closed) return;
    active.closed = true;
    this.streams.delete(active);
    active.hostPort.onmessage = null;
    for (const unsubscribe of active.unsubscribe.splice(0)) unsubscribe();
    active.stream.close();
    this.closePorts(active.hostPort, active.framePort);
  }

  private closePorts(...ports: MessagePort[]): void {
    for (const port of ports) port.close();
  }
}
