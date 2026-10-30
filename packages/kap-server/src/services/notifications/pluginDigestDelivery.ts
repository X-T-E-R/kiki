import { createHash, randomUUID } from 'node:crypto';
import {
  PROVIDERS, type Category, type CredentialPurpose, type ProviderId, type Runtime, type SendResult,
} from '@nb-im/core';
import type { NotificationsConfig } from '@kiki/agent-core-v2/app/notifications/configSection';
import {
  parsePluginImRequest, pluginImCaller, pluginImReceipt,
  type PluginImCapabilities, type PluginImErrorKind, type PluginImRoute, type PluginImSendReceipt, type PluginImSendRequest,
} from '@kiki/agent-core-v2';
import { sendProvider } from './providerDelivery';

const PURPOSES = new Set<CredentialPurpose>([
  'telegram_bot', 'wecom_key', 'discord_token', 'slack_path', 'dingtalk_token', 'feishu_token',
  'signing_secret', 'http_bearer', 'http_path', 'script_secret',
]);
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const KINDS = new Set<PluginImErrorKind>([
  'auth', 'forbidden', 'not_found', 'rate_limited', 'transient', 'too_long', 'bad_format',
  'dependency_missing', 'configuration', 'protocol', 'unknown',
]);

interface InstanceView {
  provider_id: string;
  enabled: boolean;
  revision: string;
  options: Record<string, unknown>;
  label?: string;
}
interface ChannelView {
  provider_instance_id: string;
  enabled: boolean;
  revision: string;
  target: Record<string, unknown>;
  label?: string;
}
interface ReceiptRow {
  fingerprint: string;
  channel_id: string;
  text_hash: string;
  state: string;
  diagnostic_code: string | null;
  error_kind: string | null;
}
interface Flight {
  readonly promise: Promise<PluginImSendReceipt>;
  readonly textHash: string;
  readonly channelId: string;
  readonly routeRevision: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort();
  return `{${entries.map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function asInstance(value: unknown): InstanceView | undefined {
  if (!record(value)) return undefined;
  const providerId = value['provider_id'];
  const enabled = value['enabled'];
  const revision = value['revision'];
  const options = value['options'];
  if (typeof providerId !== 'string' || typeof enabled !== 'boolean' ||
    typeof revision !== 'string' || !record(options)) return undefined;
  return value as unknown as InstanceView;
}
function asChannel(value: unknown): ChannelView | undefined {
  if (!record(value)) return undefined;
  const instanceId = value['provider_instance_id'];
  const enabled = value['enabled'];
  const revision = value['revision'];
  const target = value['target'];
  if (typeof instanceId !== 'string' || typeof enabled !== 'boolean' ||
    typeof revision !== 'string' || !record(target)) return undefined;
  return value as unknown as ChannelView;
}
function labelOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 1 && value.length <= 80 && !/[\u0000-\u001F\u007F]/u.test(value) ? value : undefined;
}
function sendable(providerId: string, runtime: Runtime): boolean {
  if (providerId === 'script' || providerId === 'windows_toast') return false;
  const known = PROVIDERS[providerId as keyof typeof PROVIDERS];
  return known?.can_send === true && runtime.providers.has(providerId);
}
function missingCredential(settings: NotificationsConfig, instanceId: string, instance: InstanceView): boolean {
  for (const value of Object.values(instance.options)) {
    if (typeof value !== 'string' || !Object.hasOwn(settings.credential_slots, value)) continue;
    const slot = settings.credential_slots[value];
    if (!record(slot) || slot['provider_instance_id'] !== instanceId) continue;
    if (!settings.credential_values[value]?.token) return true;
  }
  return false;
}
function fingerprint(settings: NotificationsConfig, runtime: Runtime, channelId: string): string | undefined {
  const channel = asChannel(settings.channels[channelId]);
  const instance = channel === undefined ? undefined : asInstance(settings.provider_instances[channel.provider_instance_id]);
  if (channel === undefined || instance === undefined) return undefined;
  return digest([
    channel.provider_instance_id, instance.provider_id, instance.revision, instance.options,
    channelId, channel.revision, channel.target, runtime.getAccountEpoch(channel.provider_instance_id),
  ]);
}

const DIGEST_RECEIPTS = `CREATE TABLE plugin_digest_receipts (
  plugin_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  diagnostic_code TEXT,
  error_kind TEXT,
  PRIMARY KEY (plugin_id, account_ref, idempotency_key)
)`;
const CURRENT_RECEIPT_COLUMNS = [
  'plugin_id', 'account_ref', 'idempotency_key', 'fingerprint', 'channel_id', 'text_hash', 'state',
  'diagnostic_code', 'error_kind',
];
const LEGACY_RECEIPT_COLUMNS = ['account_ref', 'idempotency_key', 'state'];
const UNSCOPED_RECEIPTS = 'plugin_digest_receipts_unscoped';

interface ReceiptDb {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
}

function columnNames(db: ReceiptDb, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().flatMap((row) => {
    if (!record(row)) return [];
    const name = row['name'];
    return typeof name === 'string' ? [name] : [];
  });
}

export function ensurePluginDigestReceipts(db: ReceiptDb): 'ready' | 'unavailable' {
  const present = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_digest_receipts'`).all();
  if (present.length === 0) {
    db.exec(DIGEST_RECEIPTS);
    return 'ready';
  }
  const names = columnNames(db, 'plugin_digest_receipts');
  if (CURRENT_RECEIPT_COLUMNS.every((name) => names.includes(name))) return 'ready';
  const legacy = !names.includes('plugin_id') && LEGACY_RECEIPT_COLUMNS.every((name) => names.includes(name));
  if (!legacy || db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${UNSCOPED_RECEIPTS}'`).all().length > 0) {
    return 'unavailable';
  }
  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    started = true;
    db.exec(`ALTER TABLE plugin_digest_receipts RENAME TO ${UNSCOPED_RECEIPTS}`);
    db.exec(DIGEST_RECEIPTS);
    db.exec('COMMIT');
    return 'ready';
  } catch {
    if (started) {
      try { db.exec('ROLLBACK'); } catch { return 'unavailable'; }
    }
    return 'unavailable';
  }
}

function legacyKey(runtime: Runtime, account: string, key: string): boolean {
  const tables = runtime.outbox.db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${UNSCOPED_RECEIPTS}'`).all();
  if (tables.length === 0) return false;
  const row = runtime.outbox.db.prepare(
    `SELECT state FROM ${UNSCOPED_RECEIPTS} WHERE account_ref = ? AND idempotency_key = ?`).get(account, key);
  return row !== undefined && row !== null;
}

function readReceipt(runtime: Runtime, pluginId: string, account: string, key: string): ReceiptRow | undefined {
  const row = runtime.outbox.db.prepare(
    `SELECT fingerprint, channel_id, text_hash, state, diagnostic_code, error_kind FROM plugin_digest_receipts
     WHERE plugin_id = ? AND account_ref = ? AND idempotency_key = ?`).get(pluginId, account, key);
  if (!record(row)) return undefined;
  const fingerprint = row['fingerprint'];
  const channelId = row['channel_id'];
  const textHash = row['text_hash'];
  const state = row['state'];
  const diagnostic = row['diagnostic_code'];
  const kind = row['error_kind'];
  if (typeof fingerprint !== 'string' || typeof channelId !== 'string' ||
    typeof textHash !== 'string' || typeof state !== 'string') return undefined;
  return {
    fingerprint, channel_id: channelId, text_hash: textHash, state,
    diagnostic_code: typeof diagnostic === 'string' ? diagnostic : null,
    error_kind: typeof kind === 'string' ? kind : null,
  };
}
function projectRow(row: ReceiptRow): PluginImSendReceipt {
  const errorKind = row.error_kind !== null && KINDS.has(row.error_kind as PluginImErrorKind) ? row.error_kind as PluginImErrorKind : undefined;
  if (row.state === 'accepted') return pluginImReceipt('accepted');
  if (row.state === 'suppressed') return pluginImReceipt('suppressed', { diagnosticCode: row.diagnostic_code ?? undefined, errorKind });
  if (row.state === 'failed') {
    return pluginImReceipt('failed', { diagnosticCode: row.diagnostic_code ?? 'provider_diagnostic_redacted', errorKind: errorKind ?? 'unknown' });
  }
  return pluginImReceipt('unknown', { diagnosticCode: row.diagnostic_code ?? 'send_outcome_unknown', errorKind: errorKind ?? 'unknown' });
}
function failed(diagnosticCode: string, errorKind: PluginImErrorKind, retryable = false): PluginImSendReceipt {
  return pluginImReceipt('failed', { diagnosticCode, errorKind, retryable });
}

export class PluginDigestDelivery {
  private readonly inflight = new Map<string, Flight>();
  constructor(private readonly deps: {
    settings: () => NotificationsConfig;
    runtime: () => Runtime | undefined;
    stopped: () => boolean;
  }) {}

  capabilities(signal: AbortSignal): PluginImCapabilities {
    if (signal.aborted || this.deps.stopped() || this.deps.runtime() === undefined) return { outbound: false, inbound: false };
    return { outbound: true, inbound: false };
  }

  routes(signal: AbortSignal): readonly PluginImRoute[] {
    if (signal.aborted) return [];
    const runtime = this.deps.runtime();
    const settings = this.deps.settings();
    if (runtime === undefined || this.deps.stopped() || !settings.global.enabled) return [];
    const routes: PluginImRoute[] = [];
    for (const channelId of Object.keys(settings.channels).sort()) {
      const channel = asChannel(settings.channels[channelId]);
      if (channel === undefined || !channel.enabled) continue;
      const instance = asInstance(settings.provider_instances[channel.provider_instance_id]);
      if (instance === undefined || !instance.enabled || !sendable(instance.provider_id, runtime)) continue;
      if (missingCredential(settings, channel.provider_instance_id, instance)) continue;
      const routeRevision = fingerprint(settings, runtime, channelId);
      if (routeRevision === undefined) continue;
      const label = labelOf(channel.label);
      routes.push(label === undefined
        ? { channelId, providerId: instance.provider_id, routeRevision }
        : { channelId, providerId: instance.provider_id, label, routeRevision });
    }
    return routes;
  }

  routeRevision(channelId: string): string | undefined {
    const runtime = this.deps.runtime();
    return runtime === undefined || this.deps.stopped() ? undefined : fingerprint(this.deps.settings(), runtime, channelId);
  }

  send(value: unknown, signal: AbortSignal, pluginId: string): Promise<PluginImSendReceipt> {
    const parsed = parsePluginImRequest(value);
    if (!parsed.ok) return Promise.resolve(parsed.receipt);
    if (!pluginImCaller(pluginId)) return Promise.resolve(failed('im_unsupported', 'dependency_missing'));
    if (signal.aborted) return Promise.resolve(pluginImReceipt('cancelled', { diagnosticCode: 'cancelled' }));
    const request = parsed.request;
    const textHash = createHash('sha256').update(request.text).digest('hex');
    const identity = `${pluginId}\n${request.accountRef}\n${request.idempotencyKey}`;
    const current = this.inflight.get(identity);
    if (current !== undefined) {
      if (current.textHash !== textHash || current.channelId !== request.channelId || current.routeRevision !== request.routeRevision) {
        return Promise.resolve(failed('idempotency_conflict', 'configuration'));
      }
      return current.promise;
    }
    let settle: (receipt: PluginImSendReceipt) => void = () => {};
    const promise = new Promise<PluginImSendReceipt>((resolve) => { settle = resolve; });
    this.inflight.set(identity, { promise, textHash, channelId: request.channelId, routeRevision: request.routeRevision });
    void this.deliver(pluginId, request, textHash, signal).then(settle, () => settle(pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' })));
    return promise.finally(() => { this.inflight.delete(identity); });
  }

  private async deliver(pluginId: string, request: PluginImSendRequest, textHash: string, signal: AbortSignal): Promise<PluginImSendReceipt> {
    const runtime = this.deps.runtime();
    const settings = this.deps.settings();
    if (signal.aborted) return pluginImReceipt('cancelled', { diagnosticCode: 'cancelled' });
    if (runtime === undefined || this.deps.stopped()) return failed('im_unsupported', 'dependency_missing');
    if (!settings.global.enabled) return failed('notifications_disabled', 'configuration');
    const channel = asChannel(settings.channels[request.channelId]);
    if (channel === undefined) return failed('route_unavailable', 'not_found');
    const instance = asInstance(settings.provider_instances[channel.provider_instance_id]);
    if (instance === undefined || !channel.enabled || !instance.enabled) return failed('route_disabled', 'configuration');
    if (!sendable(instance.provider_id, runtime)) return failed('provider_unavailable', 'dependency_missing');
    if (missingCredential(settings, channel.provider_instance_id, instance)) return failed('credential_unavailable', 'configuration');
    const routeRevision = fingerprint(settings, runtime, request.channelId);
    if (routeRevision === undefined || routeRevision !== request.routeRevision) return failed('route_changed', 'configuration');
    if (ensurePluginDigestReceipts(runtime.outbox.db) !== 'ready') return failed('im_unsupported', 'dependency_missing');
    const existing = readReceipt(runtime, pluginId, request.accountRef, request.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== routeRevision || existing.channel_id !== request.channelId || existing.text_hash !== textHash) {
        return failed('idempotency_conflict', 'configuration');
      }
      return projectRow(existing);
    }
    if (legacyKey(runtime, request.accountRef, request.idempotencyKey)) {
      return pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' });
    }
    runtime.outbox.db.prepare(
      `INSERT INTO plugin_digest_receipts
       (plugin_id, account_ref, idempotency_key, fingerprint, channel_id, text_hash, state, diagnostic_code)
       VALUES (?, ?, ?, ?, ?, ?, 'armed', NULL)`).run(pluginId, request.accountRef, request.idempotencyKey, routeRevision, request.channelId, textHash);
    const clearArmed = () => {
      runtime.outbox.db.prepare(
        `DELETE FROM plugin_digest_receipts WHERE plugin_id = ? AND account_ref = ? AND idempotency_key = ? AND state = 'armed'`)
        .run(pluginId, request.accountRef, request.idempotencyKey);
    };
    const store = (receipt: PluginImSendReceipt) => {
      runtime.outbox.db.prepare(
        `UPDATE plugin_digest_receipts SET state = ?, diagnostic_code = ?, error_kind = ? WHERE plugin_id = ? AND account_ref = ? AND idempotency_key = ?`)
        .run(receipt.status, receipt.diagnosticCode ?? null, receipt.errorKind ?? null, pluginId, request.accountRef, request.idempotencyKey);
      return receipt;
    };
    let dispatched = false;
    try {
      const provider = runtime.providers.get(instance.provider_id);
      if (provider === undefined) {
        clearArmed();
        return failed('provider_unavailable', 'dependency_missing');
      }
      const instanceId = channel.provider_instance_id;
      const snapshot = {
        provider_id: instance.provider_id as ProviderId,
        enabled: true,
        revision: instance.revision,
        options: structuredClone(instance.options),
      };
      const target = structuredClone(channel.target);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const canDispatch = (): 'ready' | 'expired' | 'stale' => {
        if (signal.aborted || this.deps.stopped() || this.deps.runtime() !== runtime) return 'stale';
        if (Date.parse(expiresAt) <= Date.now()) return 'expired';
        const live = this.deps.settings();
        if (!live.global.enabled) return 'stale';
        if (fingerprint(live, runtime, request.channelId) !== routeRevision) return 'stale';
        return 'ready';
      };
      const beginDispatch = (): 'ready' | 'expired' | 'stale' => {
        const state = canDispatch();
        if (state !== 'ready') return state;
        dispatched = true;
        return 'ready';
      };
      const resolveCredential = (slotId: string): string => {
        if (canDispatch() !== 'ready') throw new Error('credential_scope_violation');
        const spec = runtime.config.credential_slots[slotId];
        if (spec === undefined || spec.provider_instance_id !== instanceId || spec.provider_id !== snapshot.provider_id ||
          !Object.values(snapshot.options).includes(slotId) || !PURPOSES.has(spec.purpose)) {
          throw new Error('credential_scope_violation');
        }
        return runtime.resolveCredential(slotId, {
          provider_id: spec.provider_id, provider_instance_id: spec.provider_instance_id, purpose: spec.purpose,
        });
      };
      let result: SendResult;
      try {
        result = await sendProvider(provider, {
          delivery_id: randomUUID(), channel_id: request.channelId, category: 'mail_digest' as Category, text: request.text,
          idempotency_key: request.idempotencyKey, expires_at: expiresAt, instance: snapshot, target,
          canDispatch, beginDispatch, resolveCredential,
        }, signal);
      } catch {
        result = { status: 'unknown', message_ids: [], retryable: false, error_kind: 'unknown', diagnostic_code: 'send_outcome_unknown' };
      }
      const receipt = projectProvider(result, dispatched, signal);
      if (!dispatched && (receipt.status === 'cancelled' || receipt.diagnosticCode === 'route_changed' || receipt.status === 'failed')) {
        clearArmed();
        return receipt;
      }
      return store(receipt);
    } catch {
      if (!dispatched) {
        try { clearArmed(); } catch { return pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' }); }
        return pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' });
      }
      const receipt = pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' });
      try { return store(receipt); } catch { return receipt; }
    }
  }
}

function projectProvider(result: SendResult, dispatched: boolean, signal: AbortSignal): PluginImSendReceipt {
  const code = typeof result?.diagnostic_code === 'string' && CODE.test(result.diagnostic_code) ? result.diagnostic_code : undefined;
  const kind = result?.error_kind !== undefined && KINDS.has(result.error_kind) ? result.error_kind : undefined;
  if (result?.status === 'accepted' && !dispatched) return pluginImReceipt('unknown', { diagnosticCode: 'send_outcome_unknown', errorKind: 'unknown' });
  if (!dispatched && signal.aborted) return pluginImReceipt('cancelled', { diagnosticCode: 'cancelled' });
  if (!dispatched && (code === 'delivery_expired' || code === 'dispatch_stale')) return failed('route_changed', 'configuration');
  if (result?.status === 'accepted') return pluginImReceipt('accepted');
  if (result?.status === 'suppressed') return pluginImReceipt('suppressed', { diagnosticCode: code, errorKind: kind });
  if (result?.status === 'failed') {
    return pluginImReceipt('failed', { diagnosticCode: code ?? 'provider_diagnostic_redacted', errorKind: kind ?? 'unknown', retryable: false });
  }
  return pluginImReceipt('unknown', { diagnosticCode: code ?? 'send_outcome_unknown', errorKind: 'unknown' });
}
