// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImProviderKind, ImSessionSnapshot } from '@kiki/protocol';

import { I18nProvider } from '../../../i18n';
import { createImSettingsFixture, imChannelSnapshot, imSettingsSnapshot } from '../../../../fixtures/im-channels.fixture';
import { ImSessionCard } from './ImSessionCard';

let fixture = createImSettingsFixture();
vi.mock('../../../state/connection', () => ({ useConnection: () => ({ scopeId: 'fixture', client: fixture.client }) }));

const empty: ImSessionSnapshot = { policy: { allowed: true, default_enabled: true }, instances: [], bindings: [], discoveries: [], strangers: [], voice_fallbacks: 0 };
const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const clients: QueryClient[] = [];

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  fixture = createImSettingsFixture(imChannelSnapshot());
  localStorage.setItem('kiki.locale', 'en');
  window.history.replaceState({}, '', '/');
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

async function settle() { await new Promise((resolve) => setTimeout(resolve, 20)); }
async function render(width = '1100px') {
  const container = document.createElement('div');
  container.style.width = width;
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  await act(async () => { root.render(<QueryClientProvider client={client}><I18nProvider><ImSessionCard /></I18nProvider></QueryClientProvider>); });
  await act(settle);
  await act(settle);
  return container;
}
async function click(container: ParentNode, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => { button!.click(); await settle(); });
}
async function input(container: ParentNode, selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  });
}
async function choose(container: ParentNode, selector: string, value: string) {
  await click(container, selector);
  await click(document.body, `[data-option-value="${value}"]`);
}
function binding(container: ParentNode, id: string) { return container.querySelector<HTMLElement>(`[data-im-binding="${id}"]`)!; }

const platforms: ImProviderKind[] = ['wechat_bridge', 'feishu_app', 'onebot_v11', 'telegram'];

describe('ImSessionCard channel management', () => {
  it.each(platforms)('groups two %s channels under one account and edits only the chosen target, options and off override', async (kind) => {
    fixture = createImSettingsFixture(imChannelSnapshot(kind));
    const container = await render();
    const before = fixture.read().bindings[0]!;
    const contact = binding(container, 'binding-contact');
    const group = binding(container, 'binding-group');
    expect(container.querySelectorAll('[data-im-account]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-im-binding]')).toHaveLength(2);
    expect(contact.textContent).toContain('Lin');
    expect(group.textContent).toContain(kind === 'wechat_bridge' ? 'Mei' : 'Release team · Mei');
    expect(group.textContent).toContain(kind === 'wechat_bridge' ? 'contact-mei' : 'release-group');
    expect(group.querySelector('[data-im-session-switch]')?.getAttribute('aria-checked')).toBe('false');
    expect(group.querySelector('[data-im-binding-target="session:release-notes"]')).not.toBeNull();
    await choose(group, '#im-binding-target-binding-group', 'persona:mei');
    expect(fixture.calls.at(-1)).toEqual({ operation: 'updateBinding', id: 'binding-group', body: { target: { kind: 'persona', persona_id: 'mei' } } });
    expect(fixture.read().bindings[1]?.session_enabled).toBe(false);
    await click(group, '[data-im-binding-options-toggle]');
    await click(group, '[data-im-binding-busy="queue"]');
    await click(group, '[data-im-binding-actions="on"]');
    expect(fixture.read().bindings[1]).toMatchObject({ persona_id: 'mei', busy: 'queue', mobile_interactions: true, session_enabled: false });
    expect(fixture.read().bindings[0]).toEqual(before);
    await click(group, '[data-im-session-switch]');
    expect(fixture.read().bindings[1]?.session_enabled).toBe(true);
    await click(group, '[data-im-binding-policy="default"]');
    expect(fixture.read().bindings[1]?.session_enabled).toBeUndefined();
    expect(fixture.read().bindings[0]).toEqual(before);
  });

  it('opens add-channel discovery without an account-wide target and confirms independent drafts across accounts', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render('360px');
    const original = fixture.read().bindings;
    await click(container, '[data-im-start-bind="account-a"]');
    expect(container.querySelector('[data-im-bind-flow="account-a"]')?.textContent).toContain('direct message from each contact');
    expect(container.querySelector('[data-im-bind-flow="account-a"] [data-im-target]')).toBeNull();
    fixture.discover('account-a', 'wx-new');
    fixture.discover('account-tg', 'tg-new');
    await click(container, '[data-im-bind-flow="account-a"] [data-im-refresh-discovery]');
    const wx = container.querySelector<HTMLElement>('[data-im-discovery="wx-new"]')!;
    const tg = container.querySelector<HTMLElement>('[data-im-discovery="tg-new"]')!;
    await click(wx, '[data-im-target-kind="session"]');
    await choose(wx, '#im-target-wx-new', 'session:reading-list');
    await click(tg, '[data-im-also-home]');
    expect(wx.querySelector('[data-im-target="session:reading-list"]')).not.toBeNull();
    expect(tg.querySelector('[data-im-target="persona:lin"]')).not.toBeNull();
    await click(wx, '[data-im-confirm]');
    await click(tg, '[data-im-confirm]');
    expect(fixture.calls.filter((item) => item.operation === 'confirm')).toEqual([
      { operation: 'confirm', id: 'wx-new', body: { target: { kind: 'session', session_id: 'reading-list' }, busy: 'queue', reply: 'final', mobile_interactions: true, also_home: false } },
      { operation: 'confirm', id: 'tg-new', body: { target: { kind: 'persona', persona_id: 'lin' }, busy: 'queue', reply: 'final', mobile_interactions: true, also_home: true } },
    ]);
    expect(fixture.read().bindings.slice(0, original.length)).toEqual(original);
    expect(container.querySelectorAll('[data-im-account="account-a"] [data-im-binding]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-im-account="account-tg"] [data-im-binding]')).toHaveLength(2);
  });

  it('keeps an explicit off when re-confirming a paused channel; only explicit enable and on restore it', async () => {
    const state = imChannelSnapshot();
    state.bindings[1] = { ...state.bindings[1]!, enabled: false, session_enabled: false };
    state.discoveries = [{ ...state.bindings[1]!, id: 'rediscovered', preview: 'hello again', at: '2026-10-23T00:00:00.000Z' }];
    fixture = createImSettingsFixture(state);
    const container = await render();
    const untouched = fixture.read().bindings[0];
    await click(container, '[data-im-confirm="rediscovered"]');
    const group = binding(container, 'binding-group');
    expect(fixture.read().bindings[1]).toMatchObject({ enabled: false, session_enabled: false });
    expect(group.querySelector('[data-im-session-switch]')?.getAttribute('aria-checked')).toBe('false');
    await click(group, '[data-im-binding-options-toggle]');
    await click(group, '[data-im-enabled]');
    expect(fixture.read().bindings[1]).toMatchObject({ enabled: true, session_enabled: false });
    await click(group, '[data-im-session-switch]');
    expect(fixture.read().bindings[1]).toMatchObject({ enabled: true, session_enabled: true });
    expect(fixture.read().bindings[0]).toEqual(untouched);
  });

  it('keeps the global master authoritative and preserves explicit off through default changes', async () => {
    const container = await render();
    await click(container, '#im-default');
    expect(fixture.read().policy.default_enabled).toBe(false);
    expect(fixture.read().bindings[1]?.session_enabled).toBe(false);
    await click(container, '#im-allowed');
    const contact = binding(container, 'binding-contact');
    expect(contact.querySelector<HTMLButtonElement>('[data-im-session-switch]')?.disabled).toBe(true);
    expect(contact.querySelector('[data-im-session-switch]')?.getAttribute('aria-checked')).toBe('false');
    expect(contact.textContent).toContain('Two-way messaging is off.');
    expect(fixture.read().bindings[0]?.session_enabled).toBe(true);
  });

  it('distinguishes topic identity, session identity and persona identity without guessing from a daily session', async () => {
    const state = imSettingsSnapshot();
    state.bindings[0] = { ...state.bindings[0]!, persona_id: undefined };
    fixture = createImSettingsFixture(state);
    const container = await render();
    expect(binding(container, 'binding-topic').textContent).toContain('Research group · Lin · Paper reviews');
    expect(binding(container, 'binding-topic').textContent).toContain('42');
    expect(binding(container, 'binding-contact').querySelector('[data-im-binding-target="session:lin-daily"]')).not.toBeNull();
    await choose(binding(container, 'binding-contact'), '#im-binding-target-binding-contact', 'persona:lin');
    expect(fixture.read().bindings[0]?.persona_id).toBe('lin');
  });

  it('preserves deep-linked target IDs including colons and offers discovered-channel search', async () => {
    window.history.replaceState({}, '', '/?target=session:session:with:colons');
    fixture.discover();
    const container = await render();
    const row = container.querySelector<HTMLElement>('[data-im-discovery]')!;
    await click(row, '[data-im-confirm]');
    expect(fixture.calls.find((item) => item.operation === 'confirm')?.body).toMatchObject({ target: { kind: 'session', session_id: 'session:with:colons' } });
  });

  it.each([
    ['en', 'group', '0'], ['zh', 'group', '0'], ['en', 'private', '42'], ['zh', 'private', '42'],
  ] as const)('blocks unsupported WeChat discovery in %s for %s chat with topic %s without losing it', async (locale, chat_kind, topic_id) => {
    localStorage.setItem('kiki.locale', locale);
    fixture.discover();
    const state = fixture.read();
    state.discoveries[0]!.identity = { ...state.discoveries[0]!.identity, chat_kind, topic_id };
    fixture.replace(state);
    const container = await render();
    const row = container.querySelector<HTMLElement>('[data-im-discovery]')!;
    expect(row.querySelector('[data-im-unsupported]')?.textContent).toBe(locale === 'en'
      ? 'This WeChat connection supports direct messages only. Group chats are not supported.'
      : '此微信连接只支持私聊，群聊暂不支持。');
    expect(row.querySelector<HTMLButtonElement>('[data-im-confirm]')?.disabled).toBe(true);
    expect(row.querySelector('[data-im-target]')).toBeNull();
    await click(row, '[data-im-confirm]');
    expect(fixture.calls.some((item) => item.operation === 'confirm')).toBe(false);
    expect(fixture.read().discoveries).toHaveLength(1);
    expect(fixture.read().bindings).toEqual(state.bindings);
  });

  it.each(['telegram', 'feishu_app', 'onebot_v11'] as const)('keeps %s group topics confirmable without a reply-context prerequisite', async (kind) => {
    fixture = createImSettingsFixture(imChannelSnapshot(kind));
    fixture.discover();
    const state = fixture.read();
    state.discoveries[0]!.identity.topic_id = '42';
    fixture.replace(state);
    const container = await render();
    const row = container.querySelector<HTMLElement>('[data-im-discovery]')!;
    expect(row.querySelector('[data-im-unsupported]')).toBeNull();
    await click(row, '[data-im-confirm]');
    expect(fixture.read().bindings.at(-1)?.identity.topic_id).toBe('42');
  });

  it('keeps legacy identities readable without guessing from titles and translates a backend group rejection locally', async () => {
    fixture.discover();
    const state = fixture.read();
    state.discoveries[0]!.identity = { ...state.discoveries[0]!.identity, chat_kind: undefined, chat_title: 'Design group' };
    fixture.replace(state);
    vi.spyOn(fixture.client.imSessions, 'confirm').mockRejectedValueOnce(new Error('unsupported_wechat_group'));
    const container = await render();
    const row = container.querySelector<HTMLElement>('[data-im-discovery]')!;
    expect(row.querySelector('[data-im-unsupported]')).toBeNull();
    await click(row, '[data-im-confirm]');
    expect(row.textContent).toContain('This WeChat connection supports direct messages only. Group chats are not supported.');
    expect(row.textContent).not.toContain('unsupported_wechat_group');
    expect(fixture.read().discoveries).toHaveLength(1);
    expect(fixture.read().bindings).toEqual(state.bindings);
  });

  it('removes only the named channel after confirmation', async () => {
    const container = await render();
    const group = binding(container, 'binding-group');
    await click(group, '[data-im-binding-options-toggle]');
    await click(group, '[data-im-remove]');
    expect(fixture.calls.some((item) => item.operation === 'removeBinding')).toBe(false);
    expect(group.textContent).toContain('Remove Mei?');
    await click(group, '[data-im-remove-confirm]');
    expect(container.querySelector('[data-im-binding="binding-group"]')).toBeNull();
    expect(container.querySelector('[data-im-binding="binding-contact"]')).not.toBeNull();
  });

  it('shows mutation failure beside the affected channel and permits recovery', async () => {
    const update = vi.spyOn(fixture.client.imSessions, 'updateBinding').mockRejectedValueOnce(new Error('Could not save. Try again.'));
    const container = await render();
    const group = binding(container, 'binding-group');
    await click(group, '[data-im-session-switch]');
    expect(group.textContent).toContain('Could not save. Try again.');
    expect(binding(container, 'binding-contact').textContent).not.toContain('Could not save.');
    await click(group, '[data-im-session-switch]');
    expect(update).toHaveBeenCalledTimes(2);
    expect(group.querySelector('[data-im-session-switch]')?.getAttribute('aria-checked')).toBe('true');
    expect(group.textContent).not.toContain('Could not save.');
  });

  it('retries a failed snapshot and catalog without offering a false binding action', async () => {
    fixture.discover();
    vi.spyOn(fixture.client.imSessions, 'snapshot').mockRejectedValueOnce(new Error('Unavailable'));
    vi.spyOn(fixture.client.imSessions, 'catalog').mockRejectedValueOnce(new Error('Unavailable'));
    const container = await render();
    expect(container.textContent).toContain('Could not load IM accounts.');
    await click(container, '[data-im-retry]');
    await act(settle);
    expect(container.querySelector('[data-im-account]')).not.toBeNull();
    expect(container.querySelector('[data-im-catalog-error]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-im-confirm]')?.disabled).toBe(true);
    await click(container, '[data-im-catalog-error] button');
    expect(container.querySelector('[data-im-catalog-error]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-im-confirm]')?.disabled).toBe(false);
  });

  it('starts discovery for a new account only after its check succeeds, and stops without rechecking', async () => {
    const state = { ...empty, instances: [{ ...imChannelSnapshot().instances[0]!, listening: false, adapter: 'stopped' as const }] };
    fixture = createImSettingsFixture(state);
    const check = vi.spyOn(fixture.client.imSessions, 'check').mockResolvedValueOnce({ ok: false, account_id: 'account-a' });
    const container = await render('360px');
    expect(container.querySelector('[data-im-bind-flow]')?.textContent).toContain('Start listening');
    expect(container.querySelector('[data-im-target]')).toBeNull();
    await click(container, '[data-im-bind-listen]');
    expect(fixture.calls.some((item) => item.operation === 'listen')).toBe(false);
    await click(container, '[data-im-bind-listen]');
    expect(fixture.calls).toContainEqual({ operation: 'listen', id: 'account-a', body: true });
    check.mockClear();
    await click(container, '[data-im-listen="account-a"]');
    expect(check).not.toHaveBeenCalled();
    expect(fixture.calls.at(-1)).toEqual({ operation: 'listen', id: 'account-a', body: false });
  });

  it.each(['starting', 'reconnecting', 'auth_expired', 'stopped'] as const)('shows the real %s connection and the relevant recovery control', async (connection) => {
    const state = imChannelSnapshot();
    state.instances[0] = { ...state.instances[0]!, connection };
    fixture = createImSettingsFixture(state);
    const container = await render();
    expect(container.querySelector('[data-im-instance-state]')?.getAttribute('data-im-instance-state')).toBe(connection);
    expect(container.querySelector('[data-im-instance-state]')?.textContent).not.toBe('Listening');
    if (connection === 'auth_expired') {
      await click(container, '[data-im-reauthorize="account-a"]');
      expect(container.querySelector('[data-im-connect-drawer]')?.classList.contains('hidden')).toBe(false);
      expect(container.querySelector('[data-im-instance="account-a"]')).not.toBeNull();
    }
    if (connection === 'stopped') {
      await click(container, '[data-im-retry-connection="account-a"]');
      expect(fixture.calls).toContainEqual({ operation: 'listen', id: 'account-a', body: true });
    }
  });

  it('shows only server-provided diagnosis, clears it on recovery, and keeps advanced numeric detail available', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    const detail = container.querySelector<HTMLElement>('[data-im-connection-detail]')!;
    expect(detail.textContent).toContain('Network request failed.');
    expect(detail.textContent).toContain('Failures: 3');
    expect(detail.textContent).toContain('Retry delay: 2s');
    expect(container.querySelectorAll('[data-im-connection-detail]')).toHaveLength(1);
    const next = fixture.read();
    next.instances[0] = { ...next.instances[0]!, connection: undefined, connection_detail: undefined };
    fixture.replace(next);
    await act(async () => { clients[0]!.setQueryData(['im-sessions'], next); await settle(); });
    expect(container.querySelector('[data-im-connection-detail]')).toBeNull();
    expect(container.querySelector('[data-im-account="account-a"] [data-im-instance-state]')?.textContent).toBe('Listening');
  });

  it('searches a thread beyond the initial catalog for only the edited binding', async () => {
    vi.spyOn(fixture.client, 'listSessions').mockResolvedValue({ items: [{ id: 'older-thread', title: 'Older research' }] });
    const container = await render();
    const group = binding(container, 'binding-group');
    await click(group, '[data-im-binding-options-toggle]');
    await input(group, '[data-im-binding-target-search]', 'Older');
    await act(settle);
    await choose(group, '#im-binding-target-binding-group', 'session:older-thread');
    expect(fixture.read().bindings[1]).toMatchObject({ session_id: 'older-thread', session_enabled: false });
    expect(fixture.read().bindings[0]?.session_id).toBe('lin-daily');
  });

  it('keeps adapter-stopped intent from appearing connected on an older server', async () => {
    const state = imChannelSnapshot();
    state.instances[0] = { ...state.instances[0]!, adapter: 'stopped' };
    fixture = createImSettingsFixture(state);
    const container = await render();
    expect(container.querySelector('[data-im-instance-state]')?.textContent).toBe('Connection stopped');
  });

  it.each(platforms)('keeps platform %s text restrictions accurate', async (kind) => {
    fixture = createImSettingsFixture(imChannelSnapshot(kind));
    fixture.discover();
    const container = await render();
    await click(binding(container, 'binding-contact'), '[data-im-binding-options-toggle]');
    await click(container, '[data-im-discovery] [data-im-advanced-toggle]');
    const live = kind === 'telegram' || kind === 'feishu_app';
    expect(container.querySelector('[data-im-text="edit"]') !== null).toBe(live);
    expect(container.querySelector('[data-im-binding-text="edit"]') !== null).toBe(live);
    if (!live) expect(container.querySelector(`[data-im-text-fixed="${kind}"]`)?.textContent).toBe('Full text');
    expect(container.textContent?.includes('QQ cannot take a file.')).toBe(kind === 'onebot_v11');
  });

  it.each(['en', 'zh'])('uses %s channel terminology and readable per-channel controls at wide and narrow widths', async (locale) => {
    localStorage.setItem('kiki.locale', locale);
    for (const width of ['360px', '1100px']) {
      const container = await render(width);
      expect(container.textContent).toContain(locale === 'en' ? 'IM accounts & channels' : 'IM 账号与渠道');
      expect(container.textContent).toContain(locale === 'en' ? 'Add channel' : '新增渠道');
      expect(container.textContent).not.toMatch(/Phone|手机/);
      expect(container.querySelectorAll('[data-im-binding-target]')).toHaveLength(2);
    }
  });

  it('pastes new accounts without implicitly selecting an existing account', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    await click(container, '[data-im-connect-toggle]');
    expect(container.querySelector('[data-im-instance=""]')).not.toBeNull();
    await input(container, '[data-im-paste]', 'fixture-bot-token');
    await click(container, '[data-im-check]');
    expect(fixture.calls).toContainEqual({ operation: 'paste', id: undefined });
  });

  it('draws a QR payload, cancels and retries an expired code without authorizing a real account', async () => {
    fixture = createImSettingsFixture(empty);
    vi.spyOn(fixture.client.imSessions, 'pollWechatQr').mockResolvedValue({ status: 'expired' });
    const container = await render('360px');
    await click(container, '[data-im-wechat-scan]');
    expect(container.querySelector('[data-im-wechat-image]')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    expect(container.textContent).toContain('This code expired.');
    await click(container, '[data-im-wechat-retry]');
    await click(container, '[data-im-wechat-cancel]');
    expect(container.querySelector('[data-im-wechat-image]')).toBeNull();
    expect(fixture.calls.at(-1)).toEqual({ operation: 'cancelWechatQr', id: 'fixture-login' });
  });

  it.each(['poll', 'verification'] as const)('starts only the WeChat account identified by confirmed %s', async (route) => {
    const state = imChannelSnapshot();
    state.instances = ['wx-old', 'wx-new'].map((id) => ({ id, provider_kind: 'wechat_bridge', listening: false, configured: true, account_id: id, adapter: 'stopped' }));
    fixture = createImSettingsFixture(state);
    const poll = vi.spyOn(fixture.client.imSessions, 'pollWechatQr').mockResolvedValueOnce(route === 'poll' ? { status: 'confirmed', provider_instance_id: 'wx-new' } : { status: 'need_verifycode' });
    const container = await render();
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-wechat-scan]');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    if (route === 'verification') {
      await input(container, '[data-im-wechat-verify]', 'fixture-code');
      poll.mockResolvedValueOnce({ status: 'confirmed', provider_instance_id: 'wx-new' });
      await click(container, '[data-im-wechat-verify-submit]');
    }
    expect(fixture.calls.filter((item) => item.operation === 'listen')).toEqual([{ operation: 'listen', id: 'wx-new', body: true }]);
  });

  it('restarts an authorized account whose listening intent remained on after authorization expired', async () => {
    const state = imChannelSnapshot();
    state.instances[0] = { ...state.instances[0]!, listening: true, adapter: 'stopped', connection: 'auth_expired', connection_detail: { code: 'auth_expired' } };
    fixture = createImSettingsFixture(state);
    vi.spyOn(fixture.client.imSessions, 'pollWechatQr').mockResolvedValueOnce({ status: 'confirmed', provider_instance_id: 'account-a' });
    const container = await render();
    expect(container.querySelector('[data-im-connection-detail]')?.tagName).toBe('P');
    await click(container, '[data-im-reauthorize]');
    await click(container, '[data-im-wechat-scan]');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    expect(fixture.calls.filter((item) => item.operation === 'listen')).toEqual([{ operation: 'listen', id: 'account-a', body: true }]);
    expect(container.querySelector('[data-im-instance-state]')?.textContent).toBe('Listening');
    expect(container.querySelector('[data-im-connection-detail]')).toBeNull();
  });

  it('does not guess an account when QR confirmation lacks an instance ID', async () => {
    fixture = createImSettingsFixture(imChannelSnapshot());
    vi.spyOn(fixture.client.imSessions, 'pollWechatQr').mockResolvedValueOnce({ status: 'confirmed' });
    const container = await render();
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-wechat-scan]');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    expect(fixture.calls.filter((item) => item.operation === 'listen' || item.operation === 'check')).toEqual([]);
  });

  it('supports Discord OAuth invite generation and saves bot token without auto-listening', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-setup-mode="discord"]');

    expect(container.querySelector('[data-im-cap-voice="discord"]')?.textContent).toContain('ordinary audio files are sent as attachment');
    await input(container, '[data-im-discord-app-id]', '123456789012345678');
    await input(container, '[data-im-discord-guild-id]', '987654321098765432');
    await click(container, '[data-im-discord-install-btn]');

    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: { action: 'discord_install', application_id: '123456789012345678', guild_id: '987654321098765432' },
    });
    expect(container.querySelector<HTMLInputElement>('[data-im-setup-link-input]')?.value).toContain('client_id=123456789012345678');

    await input(container, '[data-im-setup-field="bot_token"]', 'discord-bot-secret-token');
    await click(container, '[data-im-setup-save]');

    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: { action: 'save', provider_kind: 'discord', fields: { bot_token: 'discord-bot-secret-token' } },
    });
    expect(fixture.calls.some((item) => item.operation === 'listen')).toBe(false);
    expect(container.querySelector('[data-im-setup-saved-notice]')?.textContent).toContain('Credential saved for account-discord');

    await click(container, '[data-im-platform-setup="discord"] [data-im-check]');
    expect(fixture.calls).toContainEqual({ operation: 'check', id: 'account-discord' });
    expect(fixture.calls).toContainEqual({ operation: 'listen', id: 'account-discord', body: true });
  });

  it('supports Slack manifest link and OAuth token exchange without auto-listening', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-setup-mode="slack"]');

    await input(container, '[data-im-slack-app-name]', 'Kiki Team');
    await click(container, '[data-im-slack-manifest-btn]');
    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: { action: 'slack_manifest', name: 'Kiki Team' },
    });
    expect(container.querySelector<HTMLInputElement>('[data-im-setup-link-input]')?.value).toContain('new_app=1');

    const oauthDetails = container.querySelector<HTMLDetailsElement>('[data-im-slack-oauth]')!;
    await act(async () => {
      oauthDetails.open = true;
      oauthDetails.dispatchEvent(new Event('toggle'));
      await settle();
    });
    await input(container, '[data-im-slack-client-id]', 'slack-client-1');
    await click(container, '[data-im-slack-oauth-begin]');
    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: { action: 'slack_oauth_begin', client_id: 'slack-client-1', redirect_uri: 'http://127.0.0.1/slack-callback' },
    });

    await input(container, '[data-im-slack-client-secret]', 'slack-secret-1');
    await input(container, '[data-im-slack-oauth-app-token]', 'xapp-1-token');
    await input(container, '[data-im-slack-oauth-code]', 'oauth-code-1');
    await input(container, '[data-im-slack-oauth-state]', 'oauth-state-1');
    await click(container, '[data-im-slack-oauth-complete]');

    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: {
        action: 'slack_oauth_complete',
        attempt_id: 'attempt-slack-1',
        state: 'oauth-state-1',
        code: 'oauth-code-1',
        client_secret: 'slack-secret-1',
        app_token: 'xapp-1-token',
      },
    });
    expect(fixture.calls.some((item) => item.operation === 'listen')).toBe(false);
    expect(container.querySelector('[data-im-setup-saved-notice]')?.textContent).toContain('Credential saved for account-slack');
  });

  it('supports Matrix .well-known discovery, SSO exchange, password login, and surfaces unencrypted rooms notice', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-setup-mode="matrix"]');

    expect(container.querySelector('[data-im-cap-matrix-unencrypted]')?.textContent).toContain('Unencrypted rooms only');
    expect(container.querySelector('[data-im-cap-voice="matrix"]')?.textContent).toContain('ordinary audio files are sent as m.audio');

    await input(container, '[data-im-matrix-server]', '@bot:example.test');
    await click(container, '[data-im-matrix-discover-btn]');
    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: { action: 'matrix_discover', server: '@bot:example.test' },
    });
    expect(container.querySelector('[data-im-matrix-discovery-result]')?.textContent).toContain('https://matrix.example.test');

    await click(container, '[data-im-matrix-method="sso"]');
    await click(container, '[data-im-matrix-sso-begin]');
    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: { action: 'matrix_sso_begin', homeserver: 'https://matrix.example.test', redirect_uri: 'http://127.0.0.1/matrix-callback' },
    });

    await input(container, '[data-im-matrix-login-token]', 'sso-login-token-1');
    await click(container, '[data-im-matrix-sso-complete]');
    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: {
        action: 'matrix_sso_complete',
        attempt_id: 'attempt-matrix-1',
        callback_uri: 'http://127.0.0.1/matrix-callback?kiki_im_state=fixture-state',
        login_token: 'sso-login-token-1',
      },
    });
    expect(fixture.calls.some((item) => item.operation === 'listen')).toBe(false);
    expect(container.querySelector('[data-im-setup-saved-notice]')?.textContent).toContain('Credential saved for account-matrix');
    expect(container.querySelector('[data-im-account="account-matrix"] [data-im-account-matrix-unencrypted]')?.textContent).toContain('Unencrypted rooms only');
  });

  it('controls local conversation internal channel independently of reply mode and shows bound media capabilities', async () => {
    fixture = createImSettingsFixture(imChannelSnapshot('matrix'));
    const container = await render();
    const contact = binding(container, 'binding-contact');
    await click(contact, '[data-im-binding-options-toggle]');
    await act(settle);

    expect(contact.querySelector('[data-im-binding-text="edit"]')).not.toBeNull();
    expect(contact.querySelector('[data-im-binding-media]')?.textContent).toContain('Image / File / Audio / Video');
    expect(contact.querySelector('[data-im-binding-media]')?.textContent).not.toContain('Voice');
    expect(contact.querySelector('[data-im-binding-voice-note]')?.textContent).toContain('m.audio');

    const internalToggle = contact.querySelector<HTMLInputElement>('#im-internal-binding-contact')!;
    expect(internalToggle.checked).toBe(true);
    await click(contact, '#im-internal-binding-contact');
    await act(settle);

    expect(fixture.calls).toContainEqual({ operation: 'setInternalChannel', id: 'lin-daily', body: false });
    expect(contact.querySelector<HTMLInputElement>('#im-internal-binding-contact')?.checked).toBe(false);
    // Reply mode remains independent when internal channel is switched off
    await click(contact, '[data-im-binding-text="edit"]');
    expect(fixture.read().bindings[0]?.reply).toBe('edit');
  });

  it('scopes saved target and drafts when switching accounts, creating new accounts, or reauthorizing', async () => {
    const state = imSettingsSnapshot();
    state.instances.push(
      { id: 'discord-a', provider_kind: 'discord', label: 'Bot A', account_id: 'bot-a', listening: false, configured: true, adapter: 'stopped' },
      { id: 'discord-b', provider_kind: 'discord', label: 'Bot B', account_id: 'bot-b', listening: true, configured: true, adapter: 'running', connection: 'auth_expired', connection_detail: { code: 'auth_expired' } },
      { id: 'matrix-expired', provider_kind: 'matrix', label: 'Matrix Team', account_id: '@team:example.test', listening: true, configured: true, adapter: 'stopped', connection: 'auth_expired', connection_detail: { code: 'auth_expired' } },
    );
    fixture = createImSettingsFixture(state);
    const container = await render();
    await click(container, '[data-im-connect-toggle]');
    await click(container, '[data-im-setup-mode="discord"]');

    // Select discord-a and save a bot token
    await choose(container, '#im-instance', 'discord-a');
    await input(container, '[data-im-setup-field="bot_token"]', 'token-for-a');
    await click(container, '[data-im-setup-save]');
    expect(fixture.calls.at(-1)).toEqual({
      operation: 'setup',
      body: { action: 'save', provider_kind: 'discord', instance_id: 'discord-a', fields: { bot_token: 'token-for-a' } },
    });
    expect(container.querySelector('[data-im-setup-saved-notice]')?.textContent).toContain('Credential saved for discord-a');
    expect(container.querySelector<HTMLInputElement>('[data-im-setup-field="bot_token"]')?.value).toBe('');

    // Switch selector to discord-b -> saved notice for discord-a is cleared and check targets discord-b
    await choose(container, '#im-instance', 'discord-b');
    expect(container.querySelector('[data-im-setup-saved-notice]')).toBeNull();
    await click(container, '[data-im-platform-setup="discord"] [data-im-check]');
    expect(fixture.calls.filter((item) => item.operation === 'check').at(-1)).toEqual({ operation: 'check', id: 'discord-b' });
    expect(fixture.calls.filter((item) => item.operation === 'listen').at(-1)).toEqual({ operation: 'listen', id: 'discord-b', body: true });

    // Reopen drawer, save discord-a again, then switch to "New account" ('') -> check button disappears and no stale saved notice remains
    await click(container, '[data-im-connect-toggle]');
    await choose(container, '#im-instance', 'discord-a');
    await input(container, '[data-im-setup-field="bot_token"]', 'token-for-a-2');
    await click(container, '[data-im-setup-save]');
    expect(container.querySelector('[data-im-setup-saved-notice]')?.textContent).toContain('Credential saved for discord-a');

    await choose(container, '#im-instance', '');
    expect(container.querySelector('[data-im-setup-saved-notice]')).toBeNull();
    expect(container.querySelector('[data-im-platform-setup="discord"] [data-im-check]')).toBeNull();

    // Clicking "Authorize again" on matrix-expired switches platform to matrix, selects matrix-expired, and checks matrix-expired
    await click(container, '[data-im-reauthorize="matrix-expired"]');
    expect(container.querySelector('[data-im-platform-setup="matrix"]')).not.toBeNull();
    expect(container.querySelector('[data-im-setup-saved-notice]')).toBeNull();
    await click(container, '[data-im-platform-setup="matrix"] [data-im-check]');
    expect(fixture.calls.filter((item) => item.operation === 'check').at(-1)).toEqual({ operation: 'check', id: 'matrix-expired' });
  });

  it('shows setupCatalog error with retry recovery while keeping WeChat and paste setup available', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const setupCatalogSpy = vi.spyOn(fixture.client.imSessions, 'setupCatalog').mockRejectedValueOnce(new Error('setup_catalog_offline'));
    const container = await render();
    await click(container, '[data-im-connect-toggle]');
    await act(settle);

    expect(container.querySelector('[data-im-setup-catalog-error]')?.textContent).toContain(
      'Could not load Discord, Slack and Matrix setup options. Try again.',
    );
    expect(container.querySelector('[data-im-wechat-scan]')).not.toBeNull();
    expect(container.querySelector('[data-im-paste]')).not.toBeNull();

    await click(container, '[data-im-setup-catalog-retry]');
    await act(settle);

    expect(setupCatalogSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-im-setup-catalog-error]')).toBeNull();
    expect(container.querySelector('[data-im-setup-mode="discord"]')).not.toBeNull();
    expect(container.querySelector('[data-im-setup-mode="slack"]')).not.toBeNull();
    expect(container.querySelector('[data-im-setup-mode="matrix"]')).not.toBeNull();
  });
});
