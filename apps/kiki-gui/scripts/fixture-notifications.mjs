/**
 * Fixture stand-in for the nb-IM notification REST surface (kap-server
 * routes/notifications.ts, klient `rest.notifications`): settings, provider
 * registry, instance/channel upsert and delete, write-only credential slots,
 * credential check, test send and the delivery log. Credential values never
 * appear in GET; `/secrets:reveal` with `{ kind: 'notification_credential' }`
 * reads one on request.
 *
 * Scenario seeds (all optional):
 *   notifications: {
 *     settings:    NotificationSettings (without `configured` on slots)
 *     credentials: { [slotId]: value }
 *     providers:   NotificationProviderDescriptor[]   (defaults to the server registry)
 *     deliveries:  NotificationDelivery[]
 *     checks:      { [instanceId]: NotificationCredentialCheck }
 *     tests:       { [channelId]: { status, error_kind? } }  what a test send returns
 *   }
 */

const identifier = /^[a-zA-Z0-9_.:-]{1,120}$/u;

const text = (key, label, required = true) => ({ key, label, kind: 'text', required });
const secret = (key, label, purpose, required = true) => ({ key, label, kind: 'secret', purpose, required });

/** Mirrors `notificationProviders` in kap-server services/notifications. */
export const NOTIFICATION_PROVIDERS = [
  { id: 'telegram', can_send: true, can_receive: false, status: 'unverified', status_reason: 'real_account_not_tested',
    instance_fields: [secret('token_slot', 'Bot token', 'telegram_bot')],
    target_fields: [{ key: 'chat_id', label: 'Chat ID', kind: 'text', required: true }, { key: 'message_thread_id', label: 'Topic ID', kind: 'number', required: false }] },
  { id: 'script', can_send: false, can_receive: false, status: 'dependency_missing', status_reason: 'protected_script_execution_unavailable',
    instance_fields: [], target_fields: [{ key: 'key', label: 'Target key', kind: 'text', required: true }] },
  { id: 'windows_toast', can_send: false, can_receive: false, status: 'dependency_missing', status_reason: 'desktop_host_unavailable', instance_fields: [], target_fields: [] },
  { id: 'wecom_webhook', can_send: true, can_receive: false, status: 'unverified', status_reason: 'real_account_not_tested', instance_fields: [secret('key_slot', 'Webhook key', 'wecom_key')], target_fields: [] },
  { id: 'discord_webhook', can_send: true, can_receive: false, status: 'unverified', status_reason: 'real_account_not_tested', instance_fields: [text('webhook_id', 'Webhook ID'), secret('token_slot', 'Webhook token', 'discord_token')], target_fields: [] },
  { id: 'slack_webhook', can_send: true, can_receive: false, status: 'unverified', status_reason: 'real_account_not_tested', instance_fields: [secret('path_slot', 'Webhook path', 'slack_path')], target_fields: [] },
  { id: 'dingtalk_webhook', can_send: true, can_receive: false, status: 'unverified', status_reason: 'real_account_not_tested', instance_fields: [secret('token_slot', 'Webhook token', 'dingtalk_token'), secret('secret_slot', 'Signing secret', 'signing_secret', false), text('keyword', 'Keyword', false)], target_fields: [] },
  { id: 'feishu_webhook', can_send: true, can_receive: false, status: 'unverified', status_reason: 'real_account_not_tested', instance_fields: [secret('token_slot', 'Webhook token', 'feishu_token'), secret('secret_slot', 'Signing secret', 'signing_secret', false)], target_fields: [] },
  { id: 'http', can_send: true, can_receive: false, status: 'unverified', status_reason: 'real_account_not_tested',
    instance_fields: [text('endpoint', 'Endpoint'), { key: 'format', label: 'Body format', kind: 'select', required: true, options: ['json', 'form', 'xml'] }, secret('auth_slot', 'Bearer token', 'http_bearer', false), secret('path_slot', 'Private path', 'http_path', false), { key: 'private_grant', label: 'Private endpoint grant', kind: 'json', required: false }], target_fields: [] },
  { id: 'smtp', can_send: false, can_receive: false, status: 'dependency_missing', status_reason: 'adapter_not_installed', instance_fields: [], target_fields: [] },
  { id: 'matrix', can_send: false, can_receive: false, status: 'dependency_missing', status_reason: 'adapter_not_installed', instance_fields: [], target_fields: [] },
];

const DEFAULT_SETTINGS = {
  global: { enabled: true, suppress_viewing_session: true, min_work_ms: 60_000, work_stable_ms: 3_000, question_delay_ms: 10_000 },
  provider_instances: {},
  channels: {},
  credential_slots: {},
};

export function resetNotifications(server) {
  const seed = server.scenario?.data.notifications ?? {};
  server.notifications = {
    settings: structuredClone(seed.settings ?? DEFAULT_SETTINGS),
    credentials: new Map(Object.entries(seed.credentials ?? {})),
    providers: structuredClone(seed.providers ?? NOTIFICATION_PROVIDERS),
    deliveries: structuredClone(seed.deliveries ?? []),
    checks: structuredClone(seed.checks ?? {}),
    tests: structuredClone(seed.tests ?? {}),
    counter: 0,
  };
}

function state(server) {
  if (server.notifications === undefined) resetNotifications(server);
  return server.notifications;
}

function publicSettings(store) {
  const { settings, credentials } = store;
  return {
    ...structuredClone(settings),
    provider_instances: Object.fromEntries(Object.entries(settings.provider_instances).map(([id, instance]) => [id, { ...instance, health: instance.health ?? 'unknown' }])),
    channels: Object.fromEntries(Object.entries(settings.channels).map(([id, channel]) => [id, { ...channel, health: channel.health ?? 'unknown' }])),
    credential_slots: Object.fromEntries(Object.entries(settings.credential_slots).map(([id, slot]) => [id, { ...slot, configured: (credentials.get(id) ?? '') !== '' }])),
  };
}

/** Value for `/secrets:reveal` `{ kind: 'notification_credential', slot_id }`. */
export function revealNotificationCredential(server, slotId) {
  return state(server).credentials.get(slotId);
}

function invalid(server, res) {
  server.envelope(res, null, 40001, 'Notification configuration or delivery request is invalid; reload and retry.');
  return true;
}

export function handleNotifications(server, res, path, query, method, body) {
  if (!path.startsWith('/notifications/')) return false;
  const store = state(server);
  const { settings } = store;
  const ok = (data) => { server.envelope(res, data); return true; };
  const match = /^\/notifications\/(instances|channels|credentials)\/([^/:]+)(?::(check|test))?$/u.exec(path);
  const id = match === null ? undefined : decodeURIComponent(match[2]);
  if (id !== undefined && !identifier.test(id)) return invalid(server, res);

  if (path === '/notifications/settings' && method === 'GET') return ok(publicSettings(store));
  if (path === '/notifications/settings' && method === 'PUT') {
    if (typeof body?.enabled !== 'boolean') return invalid(server, res);
    const quiet = body.quiet_hours;
    if (quiet !== undefined && ![quiet.start, quiet.end].every((time) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(time ?? ''))) return invalid(server, res);
    settings.global = structuredClone(body);
    return ok(publicSettings(store));
  }
  if (path === '/notifications/providers' && method === 'GET') return ok(store.providers);
  if (path === '/notifications/deliveries' && method === 'GET') {
    const channel = query.get('channel_id');
    return ok(store.deliveries.filter((row) => channel === null || row.channel_id === channel)
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at)));
  }
  if (match === null) return false;
  const [, kind, , action] = match;

  if (kind === 'instances' && action === undefined && method === 'PUT') {
    const instance = body?.instance;
    const slots = body?.slots ?? {};
    if (instance === undefined || !store.providers.some((provider) => provider.id === instance.provider_id)) return invalid(server, res);
    for (const [slotId, slot] of Object.entries(settings.credential_slots)) {
      if (slot.provider_instance_id === id && !Object.hasOwn(slots, slotId)) {
        delete settings.credential_slots[slotId];
        store.credentials.delete(slotId);
      }
    }
    for (const [slotId, slot] of Object.entries(slots)) {
      if (!identifier.test(slotId) || slot.provider_instance_id !== id || slot.provider_id !== instance.provider_id) return invalid(server, res);
      settings.credential_slots[slotId] = structuredClone(slot);
    }
    const { health: _health, ...persisted } = instance;
    settings.provider_instances[id] = { ...persisted, health: settings.provider_instances[id]?.health };
    return ok(publicSettings(store));
  }
  if (kind === 'instances' && action === undefined && method === 'DELETE') {
    delete settings.provider_instances[id];
    for (const [key, channel] of Object.entries(settings.channels)) if (channel.provider_instance_id === id) delete settings.channels[key];
    for (const [key, slot] of Object.entries(settings.credential_slots)) {
      if (slot.provider_instance_id === id) { delete settings.credential_slots[key]; store.credentials.delete(key); }
    }
    return ok(publicSettings(store));
  }
  if (kind === 'instances' && action === 'check' && method === 'POST') {
    const instance = settings.provider_instances[id];
    if (instance === undefined) return invalid(server, res);
    const check = store.checks[id] ?? (instance.provider_id === 'telegram'
      ? { result: 'ok', health: 'ok' }
      : { result: 'requires_test_send', health: 'unknown' });
    if (check.result !== 'requires_test_send') instance.health = check.health;
    return ok(check);
  }
  if (kind === 'channels' && action === undefined && method === 'PUT') {
    if (body === undefined || settings.provider_instances[body.provider_instance_id] === undefined) return invalid(server, res);
    const { health: _health, ...persisted } = body;
    settings.channels[id] = { ...persisted, health: settings.channels[id]?.health };
    return ok(publicSettings(store));
  }
  if (kind === 'channels' && action === undefined && method === 'DELETE') {
    delete settings.channels[id];
    return ok(publicSettings(store));
  }
  if (kind === 'channels' && action === 'test' && method === 'POST') {
    const channel = settings.channels[id];
    if (!settings.global.enabled || channel === undefined || !channel.enabled) return invalid(server, res);
    const outcome = store.tests[id] ?? { status: 'accepted' };
    const now = new Date();
    const failed = outcome.status === 'failed';
    const delivery = {
      delivery_id: `delivery_fixture_${++store.counter}`,
      channel_id: id,
      status: failed ? 'failed' : 'accepted_by_provider',
      attempt: 1,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      result: failed
        ? { status: 'failed', message_ids: [], retryable: false, error_kind: outcome.error_kind ?? 'unknown' }
        : { status: 'accepted', message_ids: [], retryable: false },
    };
    store.deliveries.unshift(delivery);
    const health = failed ? (outcome.error_kind === 'auth' || outcome.error_kind === 'forbidden' ? 'unauthorized' : 'connection_failed') : 'ok';
    channel.health = health;
    const instance = settings.provider_instances[channel.provider_instance_id];
    if (instance !== undefined) instance.health = health;
    return ok(delivery);
  }
  if (kind === 'credentials' && method === 'PUT') {
    if (settings.credential_slots[id] === undefined) return invalid(server, res);
    const value = body?.value;
    if (value === null) store.credentials.delete(id);
    else if (typeof value === 'string' && value.length > 0) store.credentials.set(id, value);
    else return invalid(server, res);
    return ok({ configured: value !== null });
  }
  return false;
}
