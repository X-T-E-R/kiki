import type { NotificationChannel, NotificationInstance, NotificationProviderDescriptor, NotificationSettings } from '@kiki/klient';
import { describe, expect, it } from 'vitest';

import { channelState, instanceSlots, isAddable, nextId, parseJsonObject, slotEnvFor, unavailableProviders } from './model';

const telegram: NotificationProviderDescriptor = {
  id: 'telegram', can_send: true, can_receive: false, status: 'unverified',
  instance_fields: [{ key: 'token_slot', label: 'Bot token', kind: 'secret', required: true, purpose: 'telegram_bot' }],
  target_fields: [{ key: 'chat_id', label: 'Chat ID', kind: 'text', required: true }],
};
const toast: NotificationProviderDescriptor = { id: 'windows_toast', can_send: false, can_receive: false, status: 'dependency_missing', status_reason: 'desktop_host_unavailable', instance_fields: [], target_fields: [] };
const script: NotificationProviderDescriptor = { ...toast, id: 'script', status_reason: 'protected_script_execution_unavailable' };

const instance: NotificationInstance = { provider_id: 'telegram', enabled: true, revision: 'r1', options: { token_slot: 'tg.telegram_bot' } };
const channel = (health?: NotificationChannel['health']): NotificationChannel => ({
  provider_instance_id: 'tg', enabled: true, revision: 'r1', target: {}, directions: ['send'], scenes: { work_complete: true, question_pending: true }, ...(health === undefined ? {} : { health }),
});
const slots = (configured: boolean) => ({ 'tg.telegram_bot': { provider_id: 'telegram', provider_instance_id: 'tg', purpose: 'telegram_bot', env: 'X', configured } });

describe('channelState', () => {
  it('keeps missing component, refused credential and failed connection apart', () => {
    expect(channelState(channel('ok'), instance, toast, {})).toBe('dependency');
    expect(channelState(channel('unauthorized'), instance, telegram, slots(true))).toBe('unauthorized');
    expect(channelState(channel('connection_failed'), instance, telegram, slots(true))).toBe('connection');
  });

  it('reads health from the channel, then its instance, and never from deliveries', () => {
    expect(channelState(channel(), { ...instance, health: 'unauthorized' }, telegram, slots(true))).toBe('unauthorized');
    expect(channelState(channel('ok'), instance, telegram, slots(true))).toBe('ok');
    expect(channelState(channel(), instance, telegram, slots(true))).toBe('idle');
  });

  it('flags a required credential that is not configured', () => {
    expect(channelState(channel(), instance, telegram, slots(false))).toBe('noCredential');
    expect(channelState(channel(), { ...instance, options: {} }, telegram, {})).toBe('noCredential');
  });
});

describe('add entry', () => {
  it('offers only sendable built-ins and never the script provider', () => {
    expect([telegram, toast, script].filter(isAddable).map((provider) => provider.id)).toEqual(['telegram']);
    expect(unavailableProviders([telegram, toast, script]).map((provider) => provider.id)).toEqual(['windows_toast']);
  });

  it('allocates the next free id and a valid unique env name', () => {
    expect(nextId('telegram', ['telegram-1', 'telegram-3'])).toBe('telegram-2');
    expect(slotEnvFor('wecom-webhook-1.wecom_key')).toBe('KIKI_NOTIFY_WECOM_WEBHOOK_1_WECOM_KEY');
    expect(slotEnvFor('a.b')).toMatch(/^[A-Z][A-Z0-9_]{0,127}$/u);
  });
});

describe('instanceSlots', () => {
  it('returns only the slots the instance owns, without the configured flag', () => {
    const settings = {
      credential_slots: { ...slots(true), other: { provider_id: 'telegram', provider_instance_id: 'other', purpose: 'telegram_bot', env: 'Y', configured: false } },
    } as unknown as NotificationSettings;
    expect(instanceSlots(settings, 'tg')).toEqual({ 'tg.telegram_bot': { provider_id: 'telegram', provider_instance_id: 'tg', purpose: 'telegram_bot', env: 'X' } });
  });
});

describe('parseJsonObject', () => {
  it('accepts objects and empty text, rejects everything else', () => {
    expect(parseJsonObject('')).toEqual({ ok: true, value: undefined });
    expect(parseJsonObject('{"host":"10.0.0.5"}')).toEqual({ ok: true, value: { host: '10.0.0.5' } });
    expect(parseJsonObject('[1]').ok).toBe(false);
    expect(parseJsonObject('{bad').ok).toBe(false);
  });
});
