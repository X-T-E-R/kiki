import { createHash } from 'node:crypto';

import type { MCPToolDefinition } from '#/mcpCore/types';

import type { BrowserTab } from './browser';

const BASE = 'http://127.0.0.1:10086';
const PROBE_SESSION = 'kiki-browser-setup-check';
export const WEBBRIDGE_COMMAND_ORIGIN = BASE;
export const WEBBRIDGE_COMMAND_ID = 'webbridge-command';
const COMMAND_MISUSE = 'This CDP address is a WebBridge /command endpoint, not a DevTools endpoint. Add a WebBridge command connection; this CDP row was not changed.';

export interface WebbridgeStatus {
  readonly running: boolean;
  readonly extensionConnected: boolean;
  readonly version: string;
  readonly versionMismatch: boolean;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) throw new Error(`WebBridge request failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1024 * 1024) throw new Error('WebBridge response exceeds the size limit');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function readWebbridgeStatus(fetchImpl: typeof fetch = fetch): Promise<WebbridgeStatus | undefined> {
  try {
    const data = await boundedJson(await fetchImpl(`${BASE}/status`, { signal: AbortSignal.timeout(1_500), redirect: 'error' }));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const value = data as Record<string, unknown>;
    if (typeof value['running'] !== 'boolean' || typeof value['extension_connected'] !== 'boolean' || typeof value['version'] !== 'string') return undefined;
    return { running: value['running'], extensionConnected: value['extension_connected'], version: value['version'], versionMismatch: Boolean(value['version_mismatch']) };
  } catch { return undefined; }
}

export async function probeWebbridgeConnection(fetchImpl: typeof fetch = fetch): Promise<void> {
  const data = await boundedJson(await fetchImpl(`${BASE}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ action: 'list_tabs', args: {}, session: PROBE_SESSION }),
  }));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('WebBridge returned an invalid command response');
  const envelope = data as { ok?: boolean; data?: { success?: boolean; tabs?: unknown }; error?: unknown };
  if (envelope.ok !== true || envelope.data?.success !== true || !Array.isArray(envelope.data.tabs)) throw new Error('WebBridge did not confirm the extension connection; authorize or update the extension, then retry');
}

export function isCommandEndpointPath(value: string): boolean {
  try { return new URL(value).pathname.replace(/\/+$/, '') === '/command'; }
  catch { return false; }
}

export function cdpPublicError(endpoint: string, withheld: string): string {
  return isCommandEndpointPath(endpoint) ? COMMAND_MISUSE : withheld;
}

export function webbridgeCommandSession(connectionId: string): string {
  return `kiki-cmd-${createHash('sha256').update(connectionId).digest('hex').slice(0, 24)}`;
}

export class WebbridgeCommandError extends Error {
  constructor(readonly kind: 'lost' | 'rejected' | 'unreachable', message: string) {
    super(message);
    this.name = 'WebbridgeCommandError';
  }
}

function isLost(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (record.name === 'AbortError' || record.name === 'TimeoutError' || record.code === 20 || record.code === 'ABORT_ERR') return true;
  return record.cause !== undefined && record.cause !== error && isLost(record.cause);
}

async function commandPayload(response: Response): Promise<unknown> {
  if (response.body === null) throw new WebbridgeCommandError('rejected', `WebBridge command failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 1024 * 1024) throw new WebbridgeCommandError('rejected', 'WebBridge response exceeds the size limit');
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof WebbridgeCommandError) throw error;
    if (isLost(error)) throw new WebbridgeCommandError('lost', 'The WebBridge command was not confirmed. It was not sent again.');
    throw new WebbridgeCommandError('rejected', 'WebBridge returned an invalid command response');
  } finally { await reader.cancel(); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WebbridgeCommandError('rejected', 'WebBridge returned an invalid command response'); }
}

function commandData(value: unknown, httpStatus: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WebbridgeCommandError('rejected', httpStatus >= 400 ? `WebBridge command failed: HTTP ${httpStatus}` : 'WebBridge returned an invalid command response');
  }
  const envelope = value as { ok?: unknown; data?: unknown; error?: unknown };
  if (envelope.ok !== true) {
    throw new WebbridgeCommandError('rejected', typeof envelope.error === 'string' && envelope.error !== '' ? envelope.error : 'WebBridge rejected the command');
  }
  if (typeof envelope.data !== 'object' || envelope.data === null || Array.isArray(envelope.data)) {
    throw new WebbridgeCommandError('rejected', 'WebBridge returned an invalid command response');
  }
  const data = envelope.data as Record<string, unknown>;
  if (data['success'] === false) {
    const message = data['error'];
    throw new WebbridgeCommandError('rejected', typeof message === 'string' && message !== '' ? message : 'WebBridge rejected the command');
  }
  return data;
}

export async function sendWebbridgeCommand(input: {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly session: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const timeout = input.timeoutMs ?? 30_000;
  const signal = input.signal === undefined ? AbortSignal.timeout(timeout) : AbortSignal.any([input.signal, AbortSignal.timeout(timeout)]);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${BASE}/command`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal,
      body: JSON.stringify({ action: input.action, args: input.args, session: input.session }),
    });
  } catch (error) {
    if (isLost(error)) throw new WebbridgeCommandError('lost', 'The WebBridge command was not confirmed. It was not sent again.');
    throw new WebbridgeCommandError('unreachable', 'WebBridge command bridge is not reachable');
  }
  const payload = await commandPayload(response);
  if (!response.ok) {
    try { commandData(payload, response.status); }
    catch (error) {
      if (error instanceof WebbridgeCommandError) throw error;
    }
    throw new WebbridgeCommandError('rejected', `WebBridge command failed: HTTP ${response.status}`);
  }
  return commandData(payload, response.status);
}

/** Canonical command-tab token. `wb:` keeps the decimal id reversible and distinct from a DevTools target id. */
export function commandTabTokenFromWire(id: unknown): string {
  const digits = typeof id === 'number' ? String(id) : id;
  if (typeof digits !== 'string' || !/^(0|[1-9]\d*)$/.test(digits)) throw new WebbridgeCommandError('rejected', 'WebBridge returned invalid tab identities');
  const numeric = Number(digits);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || String(numeric) !== digits) throw new WebbridgeCommandError('rejected', 'WebBridge returned invalid tab identities');
  return `wb:${numeric}`;
}

export function commandTabIdFromToken(token: string): number | undefined {
  const digits = /^wb:(0|[1-9]\d*)$/.exec(token)?.[1];
  if (digits === undefined) return undefined;
  const id = Number(digits);
  return Number.isSafeInteger(id) && String(id) === digits ? id : undefined;
}

const BOUND_TAB_TOOLS = new Set([
  'agent_browser_snapshot', 'agent_browser_click', 'agent_browser_fill', 'agent_browser_eval',
  'agent_browser_screenshot', 'agent_browser_upload', 'agent_browser_pdf', 'agent_browser_network', 'agent_browser_cdp_action',
]);

export function commandUsesBoundTab(tool: string): boolean {
  return BOUND_TAB_TOOLS.has(tool);
}

export function commandTabsFromData(data: Record<string, unknown>): BrowserTab[] {
  const tabs = data['tabs'];
  if (!Array.isArray(tabs)) throw new WebbridgeCommandError('rejected', 'WebBridge returned invalid tab identities');
  const seen = new Set<string>();
  return tabs.map((tab) => {
    const id = tab !== null && typeof tab === 'object' ? (tab as { tabId?: unknown }).tabId : undefined;
    const token = commandTabTokenFromWire(id);
    if (seen.has(token)) throw new WebbridgeCommandError('rejected', 'WebBridge returned invalid tab identities');
    seen.add(token);
    const record = tab as { title?: unknown; url?: unknown; active?: unknown; groupTitle?: unknown };
    return {
      tabId: token,
      targetId: token,
      title: typeof record.title === 'string' ? record.title : undefined,
      url: typeof record.url === 'string' ? record.url : undefined,
      active: typeof record.active === 'boolean' ? record.active : undefined,
      label: typeof record.groupTitle === 'string' ? record.groupTitle : undefined,
    };
  });
}

export function commandSnapshotData(data: Record<string, unknown>): Record<string, unknown> {
  const refs: Record<string, true> = {};
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/@e\d+/g)) refs[match[0].slice(1)] = true;
      return;
    }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(data['tree']);
  const existing = data['refs'];
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const key of Object.keys(existing)) refs[key.replace(/^@/, '')] = true;
  }
  return { ...data, refs };
}

function definedArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function textArg(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export type WebbridgeToolPlan =
  | { readonly kind: 'command'; readonly action: string; readonly args: Record<string, unknown> }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'invalid'; readonly message: string };

export function webbridgeCommandForTool(tool: string, args: Readonly<Record<string, unknown>>): WebbridgeToolPlan {
  if (tool === 'agent_browser_window_new' || /^agent_browser_(?:window_|frame_)/.test(tool)) return { kind: 'unsupported' };
  if (tool === 'agent_browser_tab_list') return { kind: 'command', action: 'list_tabs', args: {} };
  if (tool === 'agent_browser_tab_new' || tool === 'agent_browser_open') {
    const url = textArg(args, 'url');
    if (url === undefined) return { kind: 'invalid', message: 'WebBridge navigate requires a url' };
    return { kind: 'command', action: 'navigate', args: definedArgs({ url, newTab: tool === 'agent_browser_tab_new', group_title: textArg(args, 'label') }) };
  }
  if (tool === 'agent_browser_snapshot') return { kind: 'command', action: 'snapshot', args: {} };
  if (tool === 'agent_browser_click') {
    const selector = textArg(args, 'selector');
    if (selector === undefined) return { kind: 'invalid', message: 'WebBridge click requires a selector' };
    return { kind: 'command', action: 'click', args: { selector } };
  }
  if (tool === 'agent_browser_fill') {
    const selector = textArg(args, 'selector');
    const value = textArg(args, 'value') ?? textArg(args, 'text');
    if (selector === undefined || value === undefined) return { kind: 'invalid', message: 'WebBridge fill requires a selector and a value' };
    return { kind: 'command', action: 'fill', args: { selector, value } };
  }
  if (tool === 'agent_browser_eval') {
    const code = textArg(args, 'code') ?? textArg(args, 'script');
    if (code === undefined) return { kind: 'invalid', message: 'WebBridge evaluate requires code' };
    return { kind: 'command', action: 'evaluate', args: { code } };
  }
  if (tool === 'agent_browser_screenshot') return { kind: 'command', action: 'screenshot', args: definedArgs({ format: textArg(args, 'format'), quality: typeof args['quality'] === 'number' ? args['quality'] : undefined, selector: textArg(args, 'selector'), path: textArg(args, 'path') }) };
  if (tool === 'agent_browser_upload') {
    const selector = textArg(args, 'selector');
    const files = args['files'];
    if (selector === undefined || !Array.isArray(files) || files.some((file) => typeof file !== 'string')) return { kind: 'invalid', message: 'WebBridge upload requires a selector and file paths' };
    return { kind: 'command', action: 'upload', args: { selector, files } };
  }
  if (tool === 'agent_browser_pdf') return { kind: 'command', action: 'save_as_pdf', args: definedArgs({ paper_format: textArg(args, 'paper_format'), landscape: typeof args['landscape'] === 'boolean' ? args['landscape'] : undefined, scale: typeof args['scale'] === 'number' ? args['scale'] : undefined, print_background: typeof args['print_background'] === 'boolean' ? args['print_background'] : undefined, path: textArg(args, 'path') }) };
  if (tool === 'agent_browser_network') {
    const cmd = textArg(args, 'cmd');
    if (cmd === undefined) return { kind: 'invalid', message: 'WebBridge network requires a cmd' };
    return { kind: 'command', action: 'network', args: definedArgs({ cmd, filter: textArg(args, 'filter'), requestId: textArg(args, 'requestId') }) };
  }
  if (tool === 'agent_browser_cdp_action') {
    const method = textArg(args, 'method');
    if (method === undefined) return { kind: 'invalid', message: 'WebBridge cdp requires a method' };
    const params = args['params'];
    return { kind: 'command', action: 'cdp', args: definedArgs({ method, params: params !== null && typeof params === 'object' ? params : undefined }) };
  }
  if (tool === 'agent_browser_end_session') return { kind: 'command', action: 'close_session', args: {} };
  return { kind: 'unsupported' };
}

function toolSchema(properties: Record<string, unknown>, required: readonly string[] = []): unknown {
  return { type: 'object', additionalProperties: false, properties, ...(required.length > 0 ? { required: [...required] } : {}) };
}

export function webbridgeCommandCatalog(): MCPToolDefinition[] {
  const url = { type: 'string', minLength: 1 };
  const selector = { type: 'string', minLength: 1, description: 'An @e ref from the latest snapshot, or a CSS selector.' };
  return [
    { name: 'agent_browser_open', description: 'Open a URL in the current WebBridge tab. This is the navigate command with newTab false.', inputSchema: toolSchema({ url, label: { type: 'string' } }, ['url']) },
    { name: 'agent_browser_tab_new', description: 'Open a URL in a new WebBridge tab. This is the navigate command with newTab true.', inputSchema: toolSchema({ url, label: { type: 'string' } }, ['url']) },
    { name: 'agent_browser_tab_list', description: 'List tabs in this WebBridge command session.', inputSchema: toolSchema({}) },
    { name: 'agent_browser_tab_switch', description: 'Bind the WebBridge command tab opened by the last navigate. The protocol cannot select a different tab by id, and this does not call find_tab or match a URL.', inputSchema: toolSchema({ tab: { type: 'string', minLength: 1, description: 'The command tab id returned when that tab was opened. Not a DevTools target id.' } }, ['tab']) },
    { name: 'agent_browser_tab_close', description: 'Close the WebBridge command tab opened by the last navigate. This does not choose a tab by URL.', inputSchema: toolSchema({ tab: { type: 'string', minLength: 1 } }, ['tab']) },
    { name: 'agent_browser_snapshot', description: 'Read the current WebBridge tab as an accessibility tree. Element refs look like @e1.', inputSchema: toolSchema({}) },
    { name: 'agent_browser_click', description: 'Click a selector on the current WebBridge tab.', inputSchema: toolSchema({ selector }, ['selector']) },
    { name: 'agent_browser_fill', description: 'Replace the value of an input on the current WebBridge tab.', inputSchema: toolSchema({ selector, value: { type: 'string' } }, ['selector', 'value']) },
    { name: 'agent_browser_eval', description: 'Evaluate JavaScript on the current WebBridge tab. The script is sent as the evaluate code.', inputSchema: toolSchema({ script: { type: 'string', minLength: 1 } }, ['script']) },
    { name: 'agent_browser_screenshot', description: 'Capture the current WebBridge tab. The command returns a file path.', inputSchema: toolSchema({ format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number' }, selector, path: { type: 'string' } }) },
    { name: 'agent_browser_network', description: 'Read WebBridge network data. cmd is start, stop, list, or detail.', inputSchema: toolSchema({ cmd: { type: 'string', enum: ['start', 'stop', 'list', 'detail'] }, filter: { type: 'string' }, requestId: { type: 'string' } }, ['cmd']) },
    { name: 'agent_browser_upload', description: 'Upload files through a selector on the current WebBridge tab.', inputSchema: toolSchema({ selector, files: { type: 'array', items: { type: 'string' } } }, ['selector', 'files']) },
    { name: 'agent_browser_pdf', description: 'Save the current WebBridge page as a PDF.', inputSchema: toolSchema({ paper_format: { type: 'string' }, landscape: { type: 'boolean' }, scale: { type: 'number' }, print_background: { type: 'boolean' }, path: { type: 'string' } }) },
    { name: 'agent_browser_cdp_action', description: 'Send one chrome.debugger method through the WebBridge command action. This does not attach a DevTools endpoint.', inputSchema: toolSchema({ method: { type: 'string', minLength: 1 }, params: { type: 'object' } }, ['method']) },
    { name: 'agent_browser_end_session', description: 'Close the tabs this WebBridge command session opened. Use it only when the user asks to close them.', inputSchema: toolSchema({}) },
  ];
}
