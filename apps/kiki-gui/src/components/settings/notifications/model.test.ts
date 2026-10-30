import type { NotificationChannel, NotificationInstance, NotificationProviderDescriptor, NotificationSettings } from '@kiki/klient';
import type { ImProviderKind } from '@kiki/protocol';
import { translate, type I18nKey } from '@kiki/session-core/i18n';
import { describe, expect, it } from 'vitest';

import { addCatalog, brandAvailable, hasBothKinds, pasteText, routeKey } from './catalog';
import { instanceDisplayName } from './imModel';
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

describe('add catalog', () => {
  const setup = { platforms: [{ provider_kind: 'discord' as const, methods: ['token'], fields: [], portal_url: 'https://example.test', instructions: [],
    capabilities: { inbound: [], outbound: [], threads: true, edit_text: true, callbacks: false, encrypted_rooms: false, voice_rendering: 'unsupported', audio_rendering: 'attachment', transport: 'gateway' } }] };
  const webhook: NotificationProviderDescriptor = { ...telegram, id: 'discord_webhook' };

  it('merges both registries into one card per brand, two-way route first', () => {
    const brands = addCatalog(setup, false, [telegram, webhook, toast, script]);
    const discord = brands.find((brand) => brand.id === 'discord')!;
    expect(discord.routes.map((option) => routeKey(option.route))).toEqual(['im:discord', 'push:discord_webhook']);
    expect(hasBothKinds(discord)).toBe(true);
    const tg = brands.find((brand) => brand.id === 'telegram')!;
    expect(tg.routes.map((option) => routeKey(option.route))).toEqual(['im:paste:telegram', 'push:telegram']);
    expect(brands.find((brand) => brand.id === 'wechat')!.routes.map((option) => routeKey(option.route))).toEqual(['im:wechat']);
    expect(brands.map((brand) => brand.id)).not.toContain('script');
    // QQ: the official bot through the QQ plugin first, OneBot second, and the
    // panel asks which one.
    const qq = brands.find((brand) => brand.id === 'qq')!;
    expect(qq.routes.map((option) => routeKey(option.route))).toEqual(['im:plugin:kiki-qq', 'im:paste:qq']);
    expect(hasBothKinds(qq)).toBe(true);
    expect(hasBothKinds(brands.find((brand) => brand.id === 'wechat')!)).toBe(false);
  });

  it('keeps unavailable types listed but not addable', () => {
    const brands = addCatalog(undefined, true, [toast]);
    expect(brandAvailable(brands.find((brand) => brand.id === 'windows')!)).toBe(false);
    expect(brandAvailable(brands.find((brand) => brand.id === 'slack')!)).toBe(false);
    expect(brandAvailable(brands.find((brand) => brand.id === 'wechat')!)).toBe(true);
  });

  it('offers two-way on every platform the setup catalog lists, beside its webhook', () => {
    const platform = setup.platforms[0]!;
    const listed = { platforms: (['discord', 'slack', 'matrix'] as const).map((provider_kind) => ({ ...platform, provider_kind })) };
    const providers = ['discord_webhook', 'slack_webhook', 'matrix'].map((id) => ({ ...telegram, id }));
    const brands = addCatalog(listed, false, providers);
    for (const id of ['discord', 'slack', 'matrix'] as const) {
      const brand = brands.find((entry) => entry.id === id)!;
      expect(brand.routes.map((option) => [option.route.kind, option.unavailable])).toEqual([['im', undefined], ['push', undefined]]);
      expect(brandAvailable(brand)).toBe(true);
    }
  });

  it('keeps a card addable when only one of its purposes is unavailable', () => {
    const webhook = { ...telegram, id: 'discord_webhook' };
    const discord = addCatalog(undefined, true, [webhook]).find((brand) => brand.id === 'discord')!;
    expect(discord.routes.map((option) => [option.route.kind, option.unavailable])).toEqual([['im', 'setupCatalog'], ['push', undefined]]);
    expect(brandAvailable(discord)).toBe(true);
    const missingWebhook = { ...toast, id: 'discord_webhook' };
    const viaBot = addCatalog(setup, false, [missingWebhook]).find((brand) => brand.id === 'discord')!;
    expect(viaBot.routes.map((option) => [option.route.kind, option.unavailable])).toEqual([['im', undefined], ['push', 'dependency']]);
    expect(brandAvailable(viaBot)).toBe(true);
  });

  it('composes paste text in the formats the server parser reads', () => {
    expect(pasteText('telegram', { token: ' 1:abc ' })).toBe('1:abc');
    expect(pasteText('feishu', { appId: 'cli_x', appSecret: 's' })).toBe('app_id: cli_x\napp_secret: s');
    expect(pasteText('qq', { endpoint: 'ws://127.0.0.1:3001' })).toBe('onebot: ws://127.0.0.1:3001');
    expect(pasteText('qq', { endpoint: 'ws://h', accessToken: 't' })).toBe('onebot: ws://h\naccess_token: t');
  });
});

describe('account names', () => {
  const zh = (key: I18nKey) => translate('zh', key);
  const account = (label: string | undefined, provider_kind: ImProviderKind = 'wechat_bridge') => ({ id: 'a', provider_kind, label, configured: true, listening: true, adapter: 'running' as const });

  it('uses the platform name the add grid uses when the label only repeats the platform', () => {
    expect(instanceDisplayName(account('WeChat'), zh)).toBe('微信');
    expect(instanceDisplayName(account(undefined), zh)).toBe('微信');
    expect(instanceDisplayName(account('feishu_app', 'feishu_app'), zh)).toBe('飞书');
    expect(instanceDisplayName(account('QQ (OneBot)', 'onebot_v11'), zh)).toBe('QQ');
    expect(instanceDisplayName(account('Kiki bot', 'telegram'), zh)).toBe('Kiki bot');
  });
});
