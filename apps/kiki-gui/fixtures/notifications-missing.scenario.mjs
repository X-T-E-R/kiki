/**
 * notifications-missing — a Windows notifications channel saved while the
 * desktop host could deliver, now reported `dependency_missing` by the
 * registry, next to a working Telegram channel. The row must say "not
 * installed or needs repair", not "connection failed".
 */

import base from './notifications.scenario.mjs';

const settings = base.notifications.settings;

export default {
  ...base,
  notifications: {
    ...base.notifications,
    settings: {
      ...settings,
      provider_instances: {
        'telegram-1': settings.provider_instances['telegram-1'],
        'windows-toast-1': { provider_id: 'windows_toast', enabled: true, revision: 'r1', options: {}, health: 'unknown' },
      },
      channels: {
        'telegram-1': settings.channels['telegram-1'],
        'windows-toast-1': { provider_instance_id: 'windows-toast-1', enabled: true, revision: 'r1', target: {}, directions: ['send'], scenes: { work_complete: true, question_pending: true }, health: 'unknown' },
      },
      credential_slots: { 'telegram-1.telegram_bot': settings.credential_slots['telegram-1.telegram_bot'] },
    },
    deliveries: base.notifications.deliveries.filter((row) => row.channel_id === 'telegram-1'),
  },
};
