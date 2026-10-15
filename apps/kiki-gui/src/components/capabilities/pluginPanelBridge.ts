import type { PluginPanelBridgeRequest } from '@kiki/protocol';

export const PANEL_CHANNEL = 'kiki.panel.v1';
export type PanelRequestMethod =
  | 'session.summary'
  | 'session.sendMessage'
  | 'plugin.call'
  | 'plugin.openExternal'
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
  readonly prerequisiteId?: unknown;
  readonly consent?: unknown;
  readonly values?: unknown;
}

const PANEL_METHODS: readonly string[] = [
  'session.summary',
  'session.sendMessage',
  'plugin.call',
  'plugin.openExternal',
  'plugin.installPrerequisite',
  'plugin.settings.get',
  'plugin.settings.patch',
  'plugin.models.list',
];

export function isPanelRequest(data: unknown): data is PanelRequest {
  if (data === null || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return record['channel'] === PANEL_CHANNEL && record['kind'] === 'request' &&
    Number.isSafeInteger(record['id']) && PANEL_METHODS.includes(String(record['method']));
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
