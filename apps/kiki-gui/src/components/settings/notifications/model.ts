/**
 * Pure helpers for Settings → Notifications (nb-IM): display names, the one
 * status a channel row leads with, id/slot allocation for new connections,
 * and option/slot bookkeeping for instance writes. No React here, so the
 * rules are unit-tested on their own.
 */

import type { I18nKey } from '@kiki/session-core/i18n';
import type {
  NotificationChannel,
  NotificationCredentialSlot,
  NotificationDelivery,
  NotificationErrorKind,
  NotificationInstance,
  NotificationProviderDescriptor,
  NotificationSettings,
} from '@kiki/klient';

export type InstanceField = NotificationProviderDescriptor['instance_fields'][number];
export type TargetField = NotificationProviderDescriptor['target_fields'][number];
export type SlotSpec = Omit<NotificationCredentialSlot, 'configured'>;

/** Providers the add entry never offers, whatever the registry says. */
const NEVER_ADDABLE = new Set(['script']);

const PROVIDER_KEYS: Readonly<Record<string, I18nKey>> = {
  telegram: 'st.notify.provider.telegram',
  wecom_webhook: 'st.notify.provider.wecom_webhook',
  discord_webhook: 'st.notify.provider.discord_webhook',
  slack_webhook: 'st.notify.provider.slack_webhook',
  dingtalk_webhook: 'st.notify.provider.dingtalk_webhook',
  feishu_webhook: 'st.notify.provider.feishu_webhook',
  http: 'st.notify.provider.http',
  windows_toast: 'st.notify.provider.windows_toast',
  smtp: 'st.notify.provider.smtp',
  matrix: 'st.notify.provider.matrix',
  script: 'st.notify.provider.script',
};

/** Field labels arrive in English from the registry; known keys get local copy. */
const FIELD_KEYS: Readonly<Record<string, I18nKey>> = {
  'telegram.token_slot': 'st.notify.field.botToken',
  'wecom_webhook.key_slot': 'st.notify.field.webhookKey',
  'discord_webhook.webhook_id': 'st.notify.field.webhookId',
  'discord_webhook.token_slot': 'st.notify.field.webhookToken',
  'slack_webhook.path_slot': 'st.notify.field.webhookPath',
  'dingtalk_webhook.token_slot': 'st.notify.field.webhookToken',
  'dingtalk_webhook.secret_slot': 'st.notify.field.signingSecret',
  'dingtalk_webhook.keyword': 'st.notify.field.keyword',
  'feishu_webhook.token_slot': 'st.notify.field.webhookToken',
  'feishu_webhook.secret_slot': 'st.notify.field.signingSecret',
  'http.endpoint': 'st.notify.field.endpoint',
  'http.format': 'st.notify.field.format',
  'http.auth_slot': 'st.notify.field.bearerToken',
  'http.path_slot': 'st.notify.field.privatePath',
  'http.private_grant': 'st.notify.field.privateGrant',
  'telegram.chat_id': 'st.notify.field.chatId',
  'telegram.message_thread_id': 'st.notify.field.topicId',
};

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

export function providerLabel(t: Translate, providerId: string): string {
  const key = PROVIDER_KEYS[providerId];
  return key === undefined ? providerId : t(key);
}

export function fieldLabel(t: Translate, providerId: string, field: { key: string; label: string }): string {
  const key = FIELD_KEYS[`${providerId}.${field.key}`];
  return key === undefined ? field.label : t(key);
}

export function isAddable(provider: NotificationProviderDescriptor): boolean {
  return provider.can_send && provider.status !== 'dependency_missing' && !NEVER_ADDABLE.has(provider.id);
}

/** Registry entries that exist but cannot be added yet, named honestly under the picker. */
export function unavailableProviders(providers: readonly NotificationProviderDescriptor[]): NotificationProviderDescriptor[] {
  return providers.filter((provider) => provider.status === 'dependency_missing' && !NEVER_ADDABLE.has(provider.id));
}

export function reasonKey(reason: string | undefined): I18nKey {
  return reason === 'desktop_host_unavailable' ? 'st.notify.reason.desktop_host_unavailable'
    : reason === 'adapter_not_installed' ? 'st.notify.reason.adapter_not_installed'
      : 'st.notify.reason.unknown';
}

export const ERROR_KIND_KEYS: Readonly<Record<NotificationErrorKind, I18nKey>> = {
  auth: 'st.notify.error.auth',
  forbidden: 'st.notify.error.forbidden',
  not_found: 'st.notify.error.not_found',
  rate_limited: 'st.notify.error.rate_limited',
  transient: 'st.notify.error.transient',
  too_long: 'st.notify.error.too_long',
  bad_format: 'st.notify.error.bad_format',
  dependency_missing: 'st.notify.error.dependency_missing',
  configuration: 'st.notify.error.configuration',
  protocol: 'st.notify.error.protocol',
  unknown: 'st.notify.error.unknown',
};

export function errorKindKey(kind: NotificationErrorKind | undefined): I18nKey {
  return ERROR_KIND_KEYS[kind ?? 'unknown'] ?? 'st.notify.error.unknown';
}

/**
 * The single state a channel row leads with. Three failures stay distinct:
 * a missing or broken component, a connection that failed, and a credential
 * the platform refused. Health is read from the server, never inferred.
 */
export type ChannelState = 'dependency' | 'unauthorized' | 'connection' | 'noCredential' | 'ok' | 'idle';

export function channelState(
  channel: NotificationChannel,
  instance: NotificationInstance | undefined,
  provider: NotificationProviderDescriptor | undefined,
  slots: Readonly<Record<string, NotificationCredentialSlot>>,
): ChannelState {
  if (provider === undefined || provider.status === 'dependency_missing') return 'dependency';
  const health = channel.health ?? instance?.health ?? 'unknown';
  if (health === 'unauthorized') return 'unauthorized';
  if (health === 'connection_failed') return 'connection';
  if (instance !== undefined && missingRequiredCredential(instance, provider, slots)) return 'noCredential';
  return health === 'ok' ? 'ok' : 'idle';
}

function missingRequiredCredential(
  instance: NotificationInstance,
  provider: NotificationProviderDescriptor,
  slots: Readonly<Record<string, NotificationCredentialSlot>>,
): boolean {
  return provider.instance_fields.some((field) => {
    if (field.kind !== 'secret' || !field.required) return false;
    const slotId = instance.options[field.key];
    return typeof slotId !== 'string' || slots[slotId]?.configured !== true;
  });
}

/** Smallest `<prefix>-<n>` not already taken. */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `${prefix}-${n}`;
    if (!used.has(id)) return id;
  }
}

export function slotIdFor(instanceId: string, purpose: string): string {
  return `${instanceId}.${purpose}`;
}

/** Env names must be unique and upper snake case (`^[A-Z][A-Z0-9_]{0,127}$`). */
export function slotEnvFor(slotId: string): string {
  return `KIKI_NOTIFY_${slotId.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`.slice(0, 128);
}

export function slotSpec(providerId: string, instanceId: string, purpose: string): SlotSpec {
  const id = slotIdFor(instanceId, purpose);
  return { provider_id: providerId, provider_instance_id: instanceId, purpose, env: slotEnvFor(id) };
}

/** The slots an instance currently owns, in the shape `upsertInstance` takes back. */
export function instanceSlots(settings: NotificationSettings, instanceId: string): Record<string, SlotSpec> {
  return Object.fromEntries(Object.entries(settings.credential_slots)
    .filter(([, slot]) => slot.provider_instance_id === instanceId)
    .map(([id, { configured: _configured, ...spec }]) => [id, spec]));
}

export function channelsUsing(settings: NotificationSettings, instanceId: string): string[] {
  return Object.entries(settings.channels)
    .filter(([, channel]) => channel.provider_instance_id === instanceId)
    .map(([id]) => id);
}

/** A fresh revision marks a change of where messages go; queued ones for the old target pause. */
export function freshRevision(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Parses a JSON-object field. Empty text means "not set". */
export function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  try {
    const value: unknown = JSON.parse(trimmed);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value: value as Record<string, unknown> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function lastDelivery(deliveries: readonly NotificationDelivery[], failed: boolean): NotificationDelivery | undefined {
  return deliveries.find((row) => failed
    ? row.status === 'failed' || row.status === 'unknown' || row.status === 'expired'
    : row.status === 'accepted_by_provider');
}

export function sortedChannels(settings: NotificationSettings): [string, NotificationChannel][] {
  return Object.entries(settings.channels).toSorted(([a], [b]) => a.localeCompare(b));
}
