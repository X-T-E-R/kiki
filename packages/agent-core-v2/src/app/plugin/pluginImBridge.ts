import { Buffer } from 'node:buffer';

export interface PluginImCapabilities {
  readonly outbound: boolean;
  readonly inbound: false;
}

export interface PluginImRoute {
  readonly channelId: string;
  readonly providerId: string;
  readonly label?: string;
  readonly routeRevision: string;
}

export type PluginImSendStatus =
  | 'queued'
  | 'accepted'
  | 'failed'
  | 'unknown'
  | 'suppressed'
  | 'cancelled';

export type PluginImErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'transient'
  | 'too_long'
  | 'bad_format'
  | 'dependency_missing'
  | 'configuration'
  | 'protocol'
  | 'unknown';

export interface PluginImSendRequest {
  readonly channelId: string;
  readonly routeRevision: string;
  readonly idempotencyKey: string;
  readonly accountRef: string;
  readonly text: string;
}

export interface PluginImSendReceipt {
  readonly status: PluginImSendStatus;
  readonly retryable: boolean;
  readonly diagnosticCode?: string;
  readonly errorKind?: PluginImErrorKind;
}

export interface PluginImCaller {
  readonly pluginId: string;
}

export interface PluginImBridge {
  capabilities(signal: AbortSignal): Promise<PluginImCapabilities>;
  listRoutes(signal: AbortSignal): Promise<readonly PluginImRoute[]>;
  send(request: PluginImSendRequest, signal: AbortSignal, caller: PluginImCaller): Promise<PluginImSendReceipt>;
}

const KINDS = new Set<PluginImErrorKind>([
  'auth', 'forbidden', 'not_found', 'rate_limited', 'transient', 'too_long', 'bad_format',
  'dependency_missing', 'configuration', 'protocol', 'unknown',
]);
const STATUSES = new Set<PluginImSendStatus>(['queued', 'accepted', 'failed', 'unknown', 'suppressed', 'cancelled']);
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const ID = /^[A-Za-z0-9_.:-]{1,120}$/u;
const KEY = /^[A-Za-z0-9_.:-]{1,200}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
export const PLUGIN_IM_DIGEST_MAX_UTF8_BYTES = 16 * 1024;

export function pluginImCaller(pluginId: string): boolean {
  return ID.test(pluginId);
}

export function pluginImReceipt(
  status: PluginImSendStatus,
  options: { diagnosticCode?: string; errorKind?: PluginImErrorKind; retryable?: boolean } = {},
): PluginImSendReceipt {
  const sticky = status === 'accepted' || status === 'unknown' || status === 'suppressed' || status === 'queued' || status === 'cancelled';
  const receipt: { status: PluginImSendStatus; retryable: boolean; diagnosticCode?: string; errorKind?: PluginImErrorKind } = {
    status,
    retryable: sticky ? false : options.retryable === true,
  };
  if (options.diagnosticCode !== undefined && CODE.test(options.diagnosticCode)) receipt.diagnosticCode = options.diagnosticCode;
  if (options.errorKind !== undefined && KINDS.has(options.errorKind)) receipt.errorKind = options.errorKind;
  return receipt;
}

export function parsePluginImRequest(value: unknown): { ok: true; request: PluginImSendRequest } | { ok: false; receipt: PluginImSendReceipt } {
  const bad = pluginImReceipt('failed', { diagnosticCode: 'bad_format', errorKind: 'bad_format', retryable: true });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, receipt: bad };
  const raw = value as Record<string, unknown>;
  const channelId = raw['channelId'];
  const routeRevision = raw['routeRevision'];
  const idempotencyKey = raw['idempotencyKey'];
  const accountRef = raw['accountRef'];
  const text = raw['text'];
  if (typeof channelId !== 'string' || !ID.test(channelId)) return { ok: false, receipt: bad };
  if (typeof routeRevision !== 'string' || !REVISION.test(routeRevision)) return { ok: false, receipt: bad };
  if (typeof idempotencyKey !== 'string' || !KEY.test(idempotencyKey)) return { ok: false, receipt: bad };
  if (typeof accountRef !== 'string' || !ID.test(accountRef)) return { ok: false, receipt: bad };
  if (typeof text !== 'string' || text.length < 1 || text.trim().length === 0) return { ok: false, receipt: bad };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return { ok: false, receipt: bad };
  if (Buffer.byteLength(text, 'utf8') > PLUGIN_IM_DIGEST_MAX_UTF8_BYTES) {
    return { ok: false, receipt: pluginImReceipt('failed', { diagnosticCode: 'too_long', errorKind: 'too_long', retryable: true }) };
  }
  return { ok: true, request: { channelId, routeRevision, idempotencyKey, accountRef, text } };
}

export function sanitizePluginImCapabilities(value: unknown): PluginImCapabilities {
  const outbound = typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (value as { outbound?: unknown }).outbound === true;
  return { outbound, inbound: false };
}

export function sanitizePluginImRoutes(value: unknown): readonly PluginImRoute[] {
  if (!Array.isArray(value)) return [];
  const routes: PluginImRoute[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    const channelId = raw['channelId'];
    const providerId = raw['providerId'];
    const routeRevision = raw['routeRevision'];
    const label = raw['label'];
    if (typeof channelId !== 'string' || !ID.test(channelId)) continue;
    if (typeof providerId !== 'string' || !ID.test(providerId)) continue;
    if (typeof routeRevision !== 'string' || !REVISION.test(routeRevision)) continue;
    const route: { channelId: string; providerId: string; routeRevision: string; label?: string } = {
      channelId, providerId, routeRevision,
    };
    if (typeof label === 'string' && label.length >= 1 && label.length <= 80 && !/[\u0000-\u001F\u007F]/u.test(label)) {
      route.label = label;
    }
    routes.push(route);
  }
  return routes;
}

export function sanitizePluginImReceipt(value: unknown): PluginImSendReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' });
  }
  const raw = value as Record<string, unknown>;
  const status = raw['status'];
  const diagnostic = raw['diagnosticCode'];
  const kind = raw['errorKind'];
  if (typeof status !== 'string' || !STATUSES.has(status as PluginImSendStatus)) {
    return pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' });
  }
  const diagnosticCode = typeof diagnostic === 'string' && CODE.test(diagnostic) ? diagnostic : undefined;
  const errorKind = typeof kind === 'string' && KINDS.has(kind as PluginImErrorKind) ? kind as PluginImErrorKind : undefined;
  return pluginImReceipt(status as PluginImSendStatus, { diagnosticCode, errorKind, retryable: raw['retryable'] === true });
}
