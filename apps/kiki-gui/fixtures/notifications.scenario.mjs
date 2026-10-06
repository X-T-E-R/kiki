/**
 * notifications — Settings → Notifications & messages (nb-IM) with three
 * channels on two connections: a Telegram bot shared by two chats (one
 * verified, one whose last test failed on the network) and a WeCom group
 * bot whose webhook key was refused. Wire shapes follow kap-server
 * routes/notifications.ts; served by scripts/fixture-notifications.mjs.
 * `notifications-empty` and `notifications-missing` reuse this file's pieces.
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_notifications';
const WS_APP = 'wd_fixture_000000000000';

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

export const notificationsBase = {
  workspaces: [
    { id: WS_APP, root: 'C:/fixture/workshop', name: 'workshop', created_at: ts(4_000), last_opened_at: ts(4), session_count: 1, pinned: false },
  ],
  sessions: [sessionRecord(SID, { title: 'Fixture: notifications', workspace_id: WS_APP })],
  snapshots: { [SID]: { messages: [] } },
};

export const GLOBAL = { enabled: true, suppress_viewing_session: true, min_work_ms: 0, work_stable_ms: 3_000, question_delay_ms: 10_000, quiet_hours: { start: '22:30', end: '07:30', time_zone: 'Asia/Shanghai' } };

const slot = (provider, instance, purpose) => ({ provider_id: provider, provider_instance_id: instance, purpose, env: `KIKI_NOTIFY_${instance.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${purpose.toUpperCase()}` });

export default {
  ...notificationsBase,
  notifications: {
    settings: {
      global: GLOBAL,
      provider_instances: {
        'telegram-1': { provider_id: 'telegram', enabled: true, revision: 'r1', options: { token_slot: 'telegram-1.telegram_bot' }, label: 'Kiki bot', health: 'ok' },
        'wecom-webhook-1': { provider_id: 'wecom_webhook', enabled: true, revision: 'r1', options: { key_slot: 'wecom-webhook-1.wecom_key' }, health: 'unauthorized' },
      },
      channels: {
        'telegram-1': { provider_instance_id: 'telegram-1', enabled: true, revision: 'r1', target: { chat_id: '123456789' }, directions: ['send'], scenes: { work_complete: true, question_pending: true }, label: '我的 Telegram', health: 'ok' },
        'telegram-2': { provider_instance_id: 'telegram-1', enabled: true, revision: 'r1', target: { chat_id: '-1002233445566', message_thread_id: 42 }, directions: ['send'], scenes: { work_complete: false, question_pending: true }, label: '团队群 · 待回答', health: 'connection_failed' },
        'wecom-webhook-1': { provider_instance_id: 'wecom-webhook-1', enabled: true, revision: 'r1', target: {}, directions: ['send'], scenes: { work_complete: true, question_pending: false }, label: '研发群', health: 'unauthorized' },
      },
      credential_slots: {
        'telegram-1.telegram_bot': slot('telegram', 'telegram-1', 'telegram_bot'),
        'wecom-webhook-1.wecom_key': slot('wecom_webhook', 'wecom-webhook-1', 'wecom_key'),
      },
    },
    credentials: {
      'telegram-1.telegram_bot': '7012345678:AAFixtureTokenForScreenshotsOnly00',
      'wecom-webhook-1.wecom_key': 'fixture-wecom-key-0000',
    },
    deliveries: [
      { delivery_id: 'd5', channel_id: 'telegram-1', status: 'accepted_by_provider', attempt: 1, created_at: minutesAgo(12), expires_at: minutesAgo(2), result: { status: 'accepted', message_ids: ['901'], retryable: false } },
      { delivery_id: 'd4', channel_id: 'telegram-2', status: 'failed', attempt: 3, created_at: minutesAgo(40), expires_at: minutesAgo(30), result: { status: 'failed', message_ids: [], retryable: true, error_kind: 'transient' } },
      { delivery_id: 'd3', channel_id: 'wecom-webhook-1', status: 'failed', attempt: 1, created_at: minutesAgo(95), expires_at: minutesAgo(85), result: { status: 'failed', message_ids: [], retryable: false, error_kind: 'auth' } },
      { delivery_id: 'd2', channel_id: 'telegram-1', status: 'accepted_by_provider', attempt: 1, created_at: minutesAgo(180), expires_at: minutesAgo(170), result: { status: 'accepted', message_ids: ['887'], retryable: false } },
      { delivery_id: 'd1', channel_id: 'telegram-2', status: 'accepted_by_provider', attempt: 1, created_at: minutesAgo(1500), expires_at: minutesAgo(1490), result: { status: 'accepted', message_ids: ['850'], retryable: false } },
    ],
    // What a test send returns per channel: telegram-1 succeeds, telegram-2 fails on the network.
    tests: { 'telegram-2': { status: 'failed', error_kind: 'transient' } },
    checks: { 'wecom-webhook-1': { result: 'requires_test_send', health: 'unknown' } },
  },
};
