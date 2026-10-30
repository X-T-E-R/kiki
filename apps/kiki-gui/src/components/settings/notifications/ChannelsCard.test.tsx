// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImProviderKind, ImSessionSnapshot } from '@kiki/protocol';

import { I18nProvider } from '../../../i18n';
import { clearToasts, getToasts } from '../../../lib/toasts';
import { createImSettingsFixture, imChannelSnapshot, imSettingsSnapshot } from '../../../../fixtures/im-channels.fixture';
import { ChannelsCard } from './ChannelsCard';

let fixture = createImSettingsFixture();
const notifications = {
  getSettings: async () => ({ global: { enabled: true, suppress_viewing_session: true, min_work_ms: 0, work_stable_ms: 3_000, question_delay_ms: 10_000 }, provider_instances: {}, channels: {}, credential_slots: {} }),
  listProviders: async () => [],
  listDeliveries: async () => [],
};
vi.mock('../../../state/connection', () => ({ useConnection: () => ({ scopeId: 'fixture', client: { ...fixture.client, notifications, getConfig: async () => ({}) } }) }));

const empty: ImSessionSnapshot = { policy: { allowed: true, default_enabled: true }, instances: [], bindings: [], discoveries: [], strangers: [], voice_fallbacks: 0 };
const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const clients: QueryClient[] = [];

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  fixture = createImSettingsFixture(imChannelSnapshot());
  localStorage.setItem('kiki.locale', 'en');
  window.history.replaceState({}, '', '/');
  clearToasts();
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

function Harness() {
  const [adding, setAdding] = useState(false);
  return <ChannelsCard adding={adding} setAdding={setAdding} />;
}

async function settle() { await new Promise((resolve) => setTimeout(resolve, 20)); }
async function render(width = '1100px') {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  for (const client of clients.splice(0)) client.clear();
  const container = document.createElement('div');
  container.style.width = width;
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <Harness />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(settle);
  await act(settle);
  return document.body as HTMLDivElement;
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
/** Opens "Add channel", picks the platform and, where it offers both, the two-way route. */
async function addTwoWay(brand: string) {
  await click(document.body, '[data-notify-add-open]');
  await click(document.body, `[data-channel-brand="${brand}"]`);
  const route = document.body.querySelector<HTMLButtonElement>('[data-channel-route^="im:"]');
  if (route !== null) await click(document.body, `[data-channel-route="${route.getAttribute('data-channel-route')}"]`);
}
async function rules(container: ParentNode) {
  await act(async () => { container.querySelector<HTMLDetailsElement>('[data-im-rules]')!.open = true; await settle(); });
}

const platforms: ImProviderKind[] = ['wechat_bridge', 'feishu_app', 'onebot_v11', 'telegram'];

describe('ChannelsCard two-way accounts', () => {
  it('shows plugin labels and uses the namespaced kind when a label is unavailable', async () => {
    const state = imChannelSnapshot('plugin:fixture-qq/account');
    state.instances[0] = { ...state.instances[0]!, label: 'Study QQ' };
    state.instances.push({ ...state.instances[0]!, id: 'unnamed-account', provider_kind: 'plugin:fixture-qq/other', label: undefined });
    fixture = createImSettingsFixture(state);
    const container = await render();
    expect(container.querySelector('[data-im-account="account-a"] h3')?.textContent).toBe('Study QQ');
    expect(container.querySelector('[data-im-account="unnamed-account"] h3')?.textContent).toBe('plugin:fixture-qq/other');
    expect(container.textContent).not.toContain('st.im.provider.plugin:');
  });

  it('renders a configure account link to kiki-qq plugin settings for QQ plugin instances only', async () => {
    const state = imChannelSnapshot('plugin:kiki-qq/qq-official');
    state.instances[0] = { ...state.instances[0]!, label: 'Official QQ', account_id: '12345678' };
    state.instances.push({
      id: 'other-im',
      provider_kind: 'telegram',
      label: 'TG Bot',
      account_id: 'tg_bot',
      listening: false,
      configured: true,
      adapter: 'running',
    });
    fixture = createImSettingsFixture(state);
    const container = await render();

    const qqAccount = container.querySelector('[data-im-account="account-a"]')!;
    expect(qqAccount).not.toBeNull();
    const qqLink = qqAccount.querySelector<HTMLAnchorElement>('[data-im-plugin-settings="kiki-qq"]');
    expect(qqLink).not.toBeNull();
    expect(qqLink?.textContent).toBe('Configure account');
    expect(qqLink?.getAttribute('href')).toBe('/settings/plugins?plugin=kiki-qq');

    const tgAccount = container.querySelector('[data-im-account="other-im"]')!;
    expect(tgAccount).not.toBeNull();
    expect(tgAccount.querySelector('[data-im-plugin-settings="kiki-qq"]')).toBeNull();
  });

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
    expect(fixture.calls.at(-1)).toEqual({ operation: 'updateBinding', id: 'binding-group', body: { target: { kind: 'persona', persona_id: 'mei' }, rebind: true } });
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

  it('uses immediate for discovery, preserves saved delivery choices, and persists queue changes', async () => {
    fixture = createImSettingsFixture(imChannelSnapshot('telegram'));
    const container = await render();
    const contact = binding(container, 'binding-contact');
    await click(contact, '[data-im-binding-options-toggle]');
    expect(contact.querySelector('[data-im-binding-busy="queue"]')?.getAttribute('aria-pressed')).toBe('true');

    const group = binding(container, 'binding-group');
    await click(group, '[data-im-binding-options-toggle]');
    expect(group.querySelector('[data-im-binding-busy="steer"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(group.querySelector('[data-im-binding-policy="off"]')?.getAttribute('aria-pressed')).toBe('true');

    fixture.discover('account-a', 'immediate-discovery');
    await click(container, '[data-im-refresh-discovery]');
    const discovery = container.querySelector<HTMLElement>('[data-im-discovery="immediate-discovery"]')!;
    await click(discovery, '[data-im-advanced-toggle]');
    expect(discovery.querySelector('[data-im-busy="immediate"]')?.getAttribute('aria-pressed')).toBe('true');
    await click(discovery, '[data-im-confirm="immediate-discovery"]');
    expect(fixture.calls).toContainEqual({
      operation: 'confirm',
      id: 'immediate-discovery',
      body: { target: { kind: 'persona', persona_id: 'lin' }, busy: 'immediate', reply: 'final', mobile_interactions: true, also_home: false },
    });

    const created = binding(container, 'bound-immediate-discovery');
    await click(created, '[data-im-binding-options-toggle]');
    await click(created, '[data-im-binding-busy="queue"]');
    expect(fixture.read().bindings.find((item) => item.id === 'bound-immediate-discovery')?.busy).toBe('queue');
  });

  it('opens add-channel discovery without an account-wide target and confirms independent drafts across accounts', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render('360px');
    const original = fixture.read().bindings;
    expect(container.querySelector('[data-im-bind-flow="account-a"]')?.textContent).toContain('Have the contact send a direct message');
    expect(container.querySelector('[data-im-bind-flow="account-a"] [data-im-target]')).toBeNull();
    fixture.discover('account-a', 'wx-new');
    fixture.discover('account-tg', 'tg-new');
    await click(container, '[data-im-account="account-a"] [data-im-refresh-discovery]');
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
      { operation: 'confirm', id: 'wx-new', body: { target: { kind: 'session', session_id: 'reading-list' }, busy: 'immediate', reply: 'final', mobile_interactions: true, also_home: false } },
      { operation: 'confirm', id: 'tg-new', body: { target: { kind: 'persona', persona_id: 'lin' }, busy: 'immediate', reply: 'final', mobile_interactions: true, also_home: true } },
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
    await rules(container);
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
    expect(container.querySelector('[data-im-bind-flow]')?.textContent).toContain('Start listening to add conversations.');
    expect(container.querySelector('[data-im-target]')).toBeNull();
    await click(container, '[data-im-bind-listen]');
    expect(fixture.calls.some((item) => item.operation === 'listen')).toBe(false);
    await click(container, '[data-im-bind-listen]');
    expect(fixture.calls).toContainEqual({ operation: 'listen', id: 'account-a', body: true });
    check.mockClear();
    await click(container, '[data-im-listen="account-a"] input');
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
      await click(container, '[data-im-reauthorize-now="account-a"]');
      expect(container.querySelector('[data-im-account="account-a"] [data-im-instance="account-a"] [data-im-wechat]')).not.toBeNull();
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

  it('shows receive diagnostics on their account and removes only the recovered source while keeping connection errors', async () => {
    const state = imSettingsSnapshot();
    state.instances[0] = { ...state.instances[0]!, inbound_diagnostics: [
      { source_id: 'opaque-1', account_id: 'studio-account', code: 'download_failed', at: '2026-10-27T00:00:00.000Z' },
      { source_id: 'opaque-2', account_id: 'studio-account', code: 'hydrate_failed', at: '2026-10-27T00:01:00.000Z' },
    ] };
    fixture = createImSettingsFixture(state);
    const container = await render('360px');
    const account = container.querySelector('[data-im-account="account-a"]')!;
    expect(account.querySelector('[data-im-inbound-diagnostics]')?.textContent).toContain('Receive diagnostics (2)');
    await click(account, '[data-im-inbound-diagnostics] summary');
    expect(account.querySelector('[data-im-inbound-code="download_failed"]')?.textContent).toContain('Attachment download failed.');
    expect(container.querySelector('[data-im-account="account-tg"] [data-im-inbound-diagnostics]')).toBeNull();
    const next = fixture.read();
    next.instances[0]!.inbound_diagnostics = next.instances[0]!.inbound_diagnostics!.slice(1);
    fixture.replace(next);
    await act(async () => { clients[0]!.setQueryData(['im-sessions'], next); await settle(); });
    expect(account.querySelector('[data-im-inbound-code="download_failed"]')).toBeNull();
    expect(account.querySelector('[data-im-inbound-code="hydrate_failed"]')).not.toBeNull();
    expect(account.querySelector('[data-im-connection-detail]')?.textContent).toContain('Network request failed.');
    next.instances[0]!.inbound_diagnostics = [];
    fixture.replace(next);
    await act(async () => { clients[0]!.setQueryData(['im-sessions'], next); await settle(); });
    expect(account.querySelector('[data-im-inbound-diagnostics]')).toBeNull();
    expect(account.querySelector('[data-im-connection-detail]')).not.toBeNull();
    expect(fixture.calls).toEqual([]);
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
    expect(container.querySelector('[data-im-retry-connection="account-a"]')).not.toBeNull();
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
    expect(container.textContent).not.toContain('QQ cannot take a file.');
  });

  it.each(['en', 'zh'])('uses %s channel terminology and readable per-channel controls at wide and narrow widths', async (locale) => {
    localStorage.setItem('kiki.locale', locale);
    for (const width of ['360px', '1100px']) {
      const container = await render(width);
      expect(container.textContent).toContain(locale === 'en' ? 'My channels' : '我的渠道');
      expect(container.textContent).toContain(locale === 'en' ? 'Add channel' : '添加渠道');
      expect(container.textContent).toContain(locale === 'en' ? 'Two-way' : '可对话');
      expect(container.textContent).not.toMatch(/Phone|手机/);
      expect(container.querySelectorAll('[data-im-binding-target]')).toHaveLength(2);
    }
  });

  it('adds a Telegram bot from the add panel as a new account and starts listening', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    await addTwoWay('telegram');
    expect(document.body.querySelector('[data-im-instance]')).toBeNull();
    expect(document.body.querySelector('[data-im-wechat]')).toBeNull();
    await input(document.body, '[data-im-paste-field="token"]', '123456789:fixture-token-not-real-0000');
    await click(document.body, '[data-im-paste-panel="telegram"] [data-im-check]');
    expect(fixture.calls).toContainEqual({ operation: 'paste', id: undefined });
    expect(fixture.calls.filter((item) => item.operation === 'listen').at(-1)).toMatchObject({ body: true });
    expect(container.querySelector('[data-channel-add]')).toBeNull();
  });

  it('shows the WeChat QR only on the WeChat path, then cancels and asks for a new code after expiry', async () => {
    fixture = createImSettingsFixture(empty);
    vi.spyOn(fixture.client.imSessions, 'pollWechatQr').mockResolvedValue({ status: 'expired' });
    const container = await render('360px');
    expect(container.querySelector('[data-notify-empty]')).not.toBeNull();
    await click(document.body, '[data-notify-add-open]');
    expect(document.body.querySelector('[data-im-wechat]')).toBeNull();
    await click(document.body, '[data-channel-brand="discord"]');
    expect(document.body.querySelector('[data-im-wechat]')).toBeNull();
    await click(document.body, '[data-channel-back]');
    await click(document.body, '[data-channel-brand="wechat"]');
    expect(document.body.querySelector('[data-im-wechat-image]')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    expect(document.body.textContent).toContain('This code expired.');
    await click(document.body, '[data-im-wechat-retry]');
    await click(document.body, '[data-im-wechat-cancel]');
    expect(document.body.querySelector('[data-im-wechat-image]')).toBeNull();
    expect(fixture.calls.at(-1)).toEqual({ operation: 'cancelWechatQr', id: 'fixture-login' });
  });

  it.each(['poll', 'verification'] as const)('adds another WeChat account and starts only the one confirmed by %s', async (route) => {
    const state = imChannelSnapshot();
    state.instances = ['wx-old', 'wx-new'].map((id) => ({ id, provider_kind: 'wechat_bridge', listening: false, configured: true, account_id: id, adapter: 'stopped' }));
    state.bindings = [];
    fixture = createImSettingsFixture(state);
    const poll = vi.spyOn(fixture.client.imSessions, 'pollWechatQr').mockResolvedValueOnce(route === 'poll' ? { status: 'confirmed', provider_instance_id: 'wx-new' } : { status: 'need_verifycode' });
    const container = await render();
    expect(container.querySelectorAll('[data-channel-row^="im:"]')).toHaveLength(2);
    await addTwoWay('wechat');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    if (route === 'verification') {
      await input(document.body, '[data-im-wechat-verify]', 'fixture-code');
      poll.mockResolvedValueOnce({ status: 'confirmed', provider_instance_id: 'wx-new' });
      await click(document.body, '[data-im-wechat-verify-submit]');
    }
    await act(settle);
    expect(fixture.calls.filter((item) => item.operation === 'listen')).toEqual([{ operation: 'listen', id: 'wx-new', body: true }]);
    expect(container.querySelector('[data-channel-add]')).toBeNull();
  });

  it('re-authorizes an expired WeChat account inside its row and restarts it', async () => {
    const state = imChannelSnapshot();
    state.instances[0] = { ...state.instances[0]!, listening: true, adapter: 'stopped', connection: 'auth_expired', connection_detail: { code: 'auth_expired' } };
    fixture = createImSettingsFixture(state);
    vi.spyOn(fixture.client.imSessions, 'pollWechatQr').mockResolvedValueOnce({ status: 'confirmed', provider_instance_id: 'account-a' });
    const container = await render();
    const account = container.querySelector<HTMLElement>('[data-im-account="account-a"]')!;
    expect(account.querySelector('[data-im-connection-detail]')?.tagName).toBe('P');
    await click(account, '[data-im-reauthorize-now="account-a"]');
    expect(account.querySelector('[data-im-wechat]')).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    await act(settle);
    expect(fixture.calls.filter((item) => item.operation === 'listen')).toEqual([{ operation: 'listen', id: 'account-a', body: true }]);
    expect(container.querySelector('[data-im-instance-state]')?.textContent).toBe('Listening');
    expect(container.querySelector('[data-im-connection-detail]')).toBeNull();
  });

  it('does not guess an account when QR confirmation lacks an instance ID', async () => {
    fixture = createImSettingsFixture(imChannelSnapshot());
    vi.spyOn(fixture.client.imSessions, 'pollWechatQr').mockResolvedValueOnce({ status: 'confirmed' });
    await render();
    await addTwoWay('wechat');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_550)); });
    expect(fixture.calls.filter((item) => item.operation === 'listen' || item.operation === 'check')).toEqual([]);
  });

  it('supports Discord OAuth invite generation and saves bot token without auto-listening', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    await addTwoWay('discord');

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
    expect(document.body.querySelector('[data-im-setup-saved-notice]')?.textContent).toContain('Credential saved.');

    await click(document.body, '[data-im-platform-setup="discord"] [data-im-check]');
    expect(fixture.calls).toContainEqual({ operation: 'check', id: 'account-discord' });
    expect(fixture.calls).toContainEqual({ operation: 'listen', id: 'account-discord', body: true });
  });

  it('supports Slack manifest link and OAuth token exchange without auto-listening', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    await addTwoWay('slack');

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
    expect(document.body.querySelector('[data-im-setup-saved-notice]')?.textContent).toContain('Credential saved.');
  });

  it('supports Matrix .well-known discovery, SSO exchange, password login, and surfaces unencrypted rooms notice', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const container = await render();
    await addTwoWay('matrix');

    expect(document.body.querySelector('[data-im-cap-matrix-unencrypted]')?.textContent).toBe('Unencrypted rooms only');

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
    expect(document.body.querySelector('[data-im-setup-saved-notice]')?.textContent).toContain('Credential saved.');
  });

  it('shows bound media capabilities and keeps reply mode independent', async () => {
    fixture = createImSettingsFixture(imChannelSnapshot('matrix'));
    const container = await render();
    const contact = binding(container, 'binding-contact');
    await click(contact, '[data-im-binding-options-toggle]');
    await act(settle);
    expect(contact.querySelector('[data-im-binding-text="edit"]')).not.toBeNull();
    expect(contact.querySelector('[data-im-binding-media]')?.textContent).toContain('Image / File / Audio / Video');
    expect(contact.querySelector('[data-im-binding-media]')?.textContent).not.toContain('Voice');
    expect(contact.querySelector('#im-internal-binding-contact')).toBeNull();
    await click(contact, '[data-im-binding-text="edit"]');
    expect(fixture.read().bindings[0]?.reply).toBe('edit');
  });

  it('creates a new Discord bot every time from the add panel and re-authorizes an existing one only from its row', async () => {
    const state = imSettingsSnapshot();
    state.instances.push(
      { id: 'discord-a', provider_kind: 'discord', label: 'Bot A', account_id: 'bot-a', listening: false, configured: true, adapter: 'stopped' },
      { id: 'matrix-expired', provider_kind: 'matrix', label: 'Matrix Team', account_id: '@team:example.test', listening: true, configured: true, adapter: 'stopped', connection: 'auth_expired', connection_detail: { code: 'auth_expired' } },
    );
    fixture = createImSettingsFixture(state);
    const container = await render();
    await addTwoWay('discord');
    expect(document.body.querySelector('#im-instance')).toBeNull();
    await input(document.body, '[data-im-setup-field="bot_token"]', 'token-for-new');
    await click(document.body, '[data-im-setup-save]');
    expect(fixture.calls.at(-1)).toEqual({ operation: 'setup', body: { action: 'save', provider_kind: 'discord', fields: { bot_token: 'token-for-new' } } });
    await click(document.body, '[data-im-platform-setup="discord"] [data-im-check]');
    expect(fixture.calls.filter((item) => item.operation === 'listen').at(-1)).toEqual({ operation: 'listen', id: 'account-discord', body: true });

    const row = container.querySelector<HTMLElement>('[data-im-account="discord-a"]')!;
    await click(row, 'button[aria-controls]');
    await click(row, '[data-im-reauthorize="discord-a"]');
    await input(row, '[data-im-setup-field="bot_token"]', 'token-for-a');
    await click(row, '[data-im-setup-save]');
    expect(fixture.calls.at(-1)).toEqual({ operation: 'setup', body: { action: 'save', provider_kind: 'discord', instance_id: 'discord-a', fields: { bot_token: 'token-for-a' } } });
    expect(row.querySelector('[data-im-setup-saved-notice]')).not.toBeNull();

    const matrix = container.querySelector<HTMLElement>('[data-im-account="matrix-expired"]')!;
    await click(matrix, '[data-im-reauthorize-now="matrix-expired"]');
    expect(matrix.querySelector('[data-im-platform-setup="matrix"]')).not.toBeNull();
    await click(matrix, '[data-im-platform-setup="matrix"] [data-im-check]');
    expect(fixture.calls.filter((item) => item.operation === 'check').at(-1)).toEqual({ operation: 'check', id: 'matrix-expired' });
  });

  it('keeps setup-catalog platforms listed as unavailable with retry, while WeChat and paste stay addable', async () => {
    fixture = createImSettingsFixture(imSettingsSnapshot());
    const setupCatalogSpy = vi.spyOn(fixture.client.imSessions, 'setupCatalog').mockRejectedValueOnce(new Error('setup_catalog_offline'));
    await render();
    await click(document.body, '[data-notify-add-open]');
    await act(settle);
    expect(document.body.querySelector('[data-im-setup-catalog-error]')?.textContent).toContain('Could not load Discord, Slack and Matrix setup options. Try again.');
    expect(document.body.querySelector<HTMLButtonElement>('[data-channel-brand="discord"]')?.disabled).toBe(true);
    expect(document.body.querySelector<HTMLButtonElement>('[data-channel-brand="wechat"]')?.disabled).toBe(false);
    expect(document.body.querySelector<HTMLButtonElement>('[data-channel-brand="other"]')?.disabled).toBe(false);
    await click(document.body, '[data-im-setup-catalog-retry]');
    await act(settle);
    expect(setupCatalogSpy).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('[data-im-setup-catalog-error]')).toBeNull();
    for (const brand of ['discord', 'slack', 'matrix']) {
      expect(document.body.querySelector<HTMLButtonElement>(`[data-channel-brand="${brand}"]`)?.disabled).toBe(false);
    }
  });

  it('guides connected 0-discovery accounts through step-by-step binding and pre-selects a target from 50+ sessions without false bound state', async () => {
    const fiftySessions = Array.from({ length: 50 }, (_, idx) => ({
      id: `session-${idx + 1}`,
      title: `Session #${idx + 1} · Research Topic ${idx + 1}`,
    }));
    const state: ImSessionSnapshot = {
      policy: { allowed: true, default_enabled: true },
      instances: [
        { id: 'wx-live', provider_kind: 'wechat_bridge', label: 'WeChat Live', account_id: 'wx-live', listening: true, configured: true, adapter: 'running' },
      ],
      bindings: [],
      discoveries: [],
      strangers: [],
      voice_fallbacks: 0,
    };
    fixture = createImSettingsFixture(state);
    vi.spyOn(fixture.client.imSessions, 'catalog').mockResolvedValue({
      personas: [{ id: 'nia', name: 'Nia' }],
      sessions: fiftySessions,
    });

    const container = await render();
    const flow = container.querySelector<HTMLElement>('[data-im-bind-flow="wx-live"]')!;
    expect(flow).not.toBeNull();
    expect(flow.textContent).toContain('Have the contact send a direct message');
    expect(container.querySelectorAll('[data-im-binding]')).toHaveLength(0);

    // Pre-select a session target from the 50+ session list via search
    await click(flow, '[data-im-preselect-kind="session"]');
    await input(flow, '[data-im-preselect-search]', 'Topic 42');
    await choose(flow, '#im-preselect-wx-live', 'session:session-42');
    expect(flow.querySelector('[data-im-preselect="session:session-42"]')).not.toBeNull();

    // Still not bound until an inbound discovery arrives and is explicitly confirmed
    expect(fixture.calls.some((item) => item.operation === 'confirm')).toBe(false);

    // Inbound message arrives -> discovery appears above with the pre-selected session target ready
    fixture.discover('wx-live', 'wx-inbound-1');
    await click(container, '[data-im-account="wx-live"] [data-im-refresh-discovery]');
    const discovery = container.querySelector<HTMLElement>('[data-im-discovery="wx-inbound-1"]')!;
    expect(discovery).not.toBeNull();
    expect(discovery.querySelector('[data-im-target="session:session-42"]')).not.toBeNull();

    await click(discovery, '[data-im-confirm="wx-inbound-1"]');
    expect(fixture.calls.find((item) => item.operation === 'confirm')).toEqual({
      operation: 'confirm',
      id: 'wx-inbound-1',
      body: {
        target: { kind: 'session', session_id: 'session-42' },
        busy: 'immediate',
        reply: 'final',
        mobile_interactions: true,
        also_home: false,
      },
    });
    expect(container.querySelectorAll('[data-im-binding]')).toHaveLength(1);
  });

  it.each(['en', 'zh'] as const)('tests a confirmed binding in %s and reports delivered, unknown (without auto-resend), and failed states', async (locale) => {
    localStorage.setItem('kiki.locale', locale);
    fixture = createImSettingsFixture(imChannelSnapshot());
    const testSpy = vi.spyOn(fixture.client.imSessions, 'testBinding');
    const container = await render();
    const contact = binding(container, 'binding-contact');

    // 1. Delivered
    await click(contact, '[data-im-test-binding="binding-contact"]');
    expect(testSpy).toHaveBeenCalledTimes(1);
    expect(testSpy).toHaveBeenLastCalledWith('binding-contact');
    expect(contact.querySelector('[data-im-test-binding-result="binding-contact"]')?.textContent).toContain(
      locale === 'en' ? 'Test message delivered.' : '测试消息已送达。',
    );

    // 2. Unknown (must not auto-resend)
    testSpy.mockResolvedValueOnce({ binding_id: 'binding-contact', status: 'unknown', message_ids: [] });
    await click(contact, '[data-im-test-binding="binding-contact"]');
    expect(testSpy).toHaveBeenCalledTimes(2);
    expect(contact.querySelector('[data-im-test-binding-result="binding-contact"]')?.textContent).toContain(
      locale === 'en' ? 'do not auto-resend' : '切勿自动重发',
    );

    // 3. Partial (preserves detail/ids, no invented pending count, no auto-resend)
    testSpy.mockResolvedValueOnce({ binding_id: 'binding-contact', status: 'partial', message_ids: ['msg-1'], detail: 'timeout on second chunk' });
    await click(contact, '[data-im-test-binding="binding-contact"]');
    expect(testSpy).toHaveBeenCalledTimes(3);
    expect(contact.querySelector('[data-im-test-binding-result="binding-contact"]')?.textContent).toContain('timeout on second chunk');

    // 4. Failed: channel_not_connected
    testSpy.mockResolvedValueOnce({ binding_id: 'binding-contact', status: 'failed', message_ids: [], detail: 'channel_not_connected' });
    await click(contact, '[data-im-test-binding="binding-contact"]');
    expect(testSpy).toHaveBeenCalledTimes(4);
    expect(contact.querySelector('[data-im-test-binding-result="binding-contact"]')?.textContent).toContain(
      locale === 'en' ? 'Account is not listening' : '账号当前未开启监听',
    );
  });

  it('keeps WeChat QR polling alive when the add panel is closed without cancelling', async () => {
    const state = imChannelSnapshot();
    state.instances = [{ id: 'wx-bg', provider_kind: 'wechat_bridge', listening: false, configured: true, account_id: 'wx-bg', adapter: 'stopped' }];
    fixture = createImSettingsFixture(state);
    const poll = vi.spyOn(fixture.client.imSessions, 'pollWechatQr')
      .mockResolvedValueOnce({ status: 'wait' })
      .mockResolvedValueOnce({ status: 'confirmed', provider_instance_id: 'wx-bg' });

    const container = await render();
    await addTwoWay('wechat');
    expect(container.querySelector('[data-im-wechat-image]')).not.toBeNull();

    // Close the panel without cancelling the scan.
    await click(document.body, '[data-channel-add] button[aria-label="Close"]');
    expect(container.querySelector('[data-channel-add]')).toBeNull();
    expect(fixture.calls.some((item) => item.operation === 'cancelWechatQr')).toBe(false);

    // Let two poll intervals fire while the panel is closed
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_200)); });
    expect(poll).toHaveBeenCalled();
    expect(fixture.calls.filter((item) => item.operation === 'listen')).toEqual([{ operation: 'listen', id: 'wx-bg', body: true }]);
  });

  it('rebinds the target at once with rebind: true, offers undo to the prior target, and handles 40949 conflict details', async () => {
    fixture = createImSettingsFixture(imChannelSnapshot('telegram'));
    const container = await render();
    const group = binding(container, 'binding-group');
    const updateSpy = vi.spyOn(fixture.client.imSessions, 'updateBinding');

    // 1. Select a new target -> single immediate mutation, no confirmation modal
    await choose(group, '#im-binding-target-binding-group', 'persona:mei');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenLastCalledWith('binding-group', {
      target: { kind: 'persona', persona_id: 'mei' },
      rebind: true,
    });
    expect(document.body.querySelector('[data-confirm-action="confirm"]')).toBeNull();

    // 2. The landed write leaves an undo toast whose inverse rebinds back to the
    //    session the binding had before the change.
    const toast = getToasts().at(-1);
    expect(toast?.undo).not.toBeUndefined();
    expect(toast!.text).toBe('Channel transferred');
    await act(async () => { await toast!.undo!.run(); await settle(); });
    expect(updateSpy).toHaveBeenLastCalledWith('binding-group', {
      target: { kind: 'session', session_id: 'release-notes' },
      rebind: true,
    });

    // 3. Handles 40949 conflict details gracefully, and a failed rebind pushes no undo
    const toastCount = getToasts().length;
    const conflictError = Object.assign(new Error('im_identity_already_bound'), {
      code: 40949,
      msg: 'im_identity_already_bound',
      details: {
        previous_session_id: 'sess-prev-123',
        previous_session_title: 'Previous Workspace Incident',
      },
    });
    updateSpy.mockRejectedValueOnce(conflictError);
    await choose(group, '#im-binding-target-binding-group', 'session:release-notes');
    expect(updateSpy).toHaveBeenCalledTimes(3);
    expect(group.textContent).toContain('Previous Workspace Incident');
    expect(getToasts().length).toBe(toastCount);
  });

  it('renders pending_reanchor correctly in settings without false active or persona display, keeps switch disabled with 0 mutation, and resolves pending via target confirmation', async () => {
    const state = imChannelSnapshot('telegram');
    state.bindings[0] = {
      ...state.bindings[0]!,
      pending_reanchor: true,
      persona_id: 'lin', // old historical persona
      session_id: 'sess-old-456',
      enabled: true,
      session_enabled: true,
    };
    fixture = createImSettingsFixture(state);
    const container = await render();
    const contact = binding(container, 'binding-contact');
    const updateSpy = vi.spyOn(fixture.client.imSessions, 'updateBinding');

    // Should NOT display as active session switch
    const switchBtn = contact.querySelector<HTMLButtonElement>('[data-im-session-switch]');
    expect(switchBtn?.getAttribute('aria-checked')).toBe('false');
    expect(switchBtn?.disabled).toBe(true);
    expect(contact.querySelector('[data-im-binding-blocked]')?.textContent).toContain('Confirm ownership');

    // Clicking disabled switch triggers 0 mutation
    await click(contact, '[data-im-session-switch]');
    expect(updateSpy).not.toHaveBeenCalled();

    // In expanded details, policy segment control is also disabled
    await click(contact, '[data-im-binding-options-toggle]');
    const policySegment = contact.querySelector('[data-im-binding-policy="on"]');
    expect(policySegment?.getAttribute('disabled')).not.toBeNull();

    // Target select should display unassigned / pending reanchor label, NOT Lin
    const targetSelect = contact.querySelector('#im-binding-target-binding-contact');
    expect(targetSelect).not.toBeNull();
    expect(contact.querySelector('[data-im-binding-target="unassigned"]')).not.toBeNull();
    expect(contact.textContent).toContain('Confirm ownership');

    // Selecting a target resolves the pending ownership at once, without a confirm
    await choose(contact, '#im-binding-target-binding-contact', 'session:reading-list');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenLastCalledWith('binding-contact', {
      target: { kind: 'session', session_id: 'reading-list' },
      rebind: true,
    });
    expect(document.body.querySelector('[data-confirm-action="confirm"]')).toBeNull();
  });

  it('renders group scope and wake options in DiscoveryRow for group channels and submits them on confirm', async () => {
    const state = imChannelSnapshot('telegram');
    state.discoveries = [{
      id: 'tg-disc-group',
      provider_instance_id: 'account-a',
      provider_kind: 'telegram',
      account_id: 'studio-account',
      identity: { chat_id: 'disc-group-1', chat_title: 'Engineering Team', sender_id: 'member-1', sender_name: 'Bob', topic_id: '100', topic_title: 'Deployments', chat_kind: 'group' },
      preview: 'Hello group',
      at: '2026-10-27T01:00:00.000Z',
    }];
    fixture = createImSettingsFixture(state);
    const container = await render();
    const row = container.querySelector<HTMLElement>('[data-im-discovery="tg-disc-group"]')!;

    expect(row.querySelector('[data-im-group-options]')).not.toBeNull();
    expect(row.querySelector('[data-im-discovery-scope="sender"]')?.getAttribute('aria-pressed')).toBe('true');
    await click(row, '[data-im-discovery-scope="topic"]');
    expect(row.querySelector('[data-im-discovery-wake="mention_or_reply"]')?.getAttribute('aria-pressed')).toBe('true');
    await click(row, '[data-im-discovery-wake="always"]');
    expect(row.querySelector('[data-im-discovery-wake="always"]')?.getAttribute('aria-pressed')).toBe('true');

    await click(row, '[data-im-discovery-scope="chat"]');
    expect(row.querySelector('[data-im-discovery-scope="chat"]')?.getAttribute('aria-pressed')).toBe('true');
    await click(row, '[data-im-discovery-wake="mention_or_reply"]');
    row.querySelector<HTMLInputElement>('[data-im-prefixes="data-im-discovery"]')!.focus();
    await input(row, '[data-im-prefixes="data-im-discovery"]', 'Kiki:');
    await act(async () => { row.querySelector<HTMLInputElement>('[data-im-prefixes="data-im-discovery"]')!.blur(); await settle(); });

    await click(row, '[data-im-confirm]');
    expect(fixture.calls.find((call) => call.operation === 'confirm' && call.id === 'tg-disc-group')?.body).toMatchObject({
      binding_scope: 'chat',
      group_policy: { wake: 'mention_or_reply', prefixes: ['Kiki:'] },
    });
  });

  it('handles group scope changes in BindingRow: expands at once with rebind: true and undo restores the prior scope', async () => {
    const state = imChannelSnapshot('telegram');
    // binding-group starts with binding_scope: 'sender'
    fixture = createImSettingsFixture(state);
    const container = await render();
    const group = binding(container, 'binding-group');
    const updateSpy = vi.spyOn(fixture.client.imSessions, 'updateBinding');

    await click(group, '[data-im-binding-options-toggle]');
    expect(group.querySelector('[data-im-binding-scope="sender"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(group.querySelector<HTMLButtonElement>('[data-im-binding-scope="topic"]')?.disabled).toBe(true);

    // 1. Expand scope: sender -> chat (SCOPE_RANK 1 -> 3). Runs at once, no modal.
    await click(group, '[data-im-binding-scope="chat"]');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenLastCalledWith('binding-group', {
      binding_scope: 'chat',
      group_policy: { wake: 'mention_or_reply' },
      rebind: true,
    });
    expect(document.body.querySelector('[data-confirm-action="confirm"]')).toBeNull();

    // The undo toast puts the captured prior scope back.
    const toast = getToasts().at(-1);
    expect(toast?.undo).not.toBeUndefined();
    await act(async () => { await toast!.undo!.run(); await settle(); });
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenLastCalledWith('binding-group', {
      binding_scope: 'sender',
      group_policy: { wake: 'mention_or_reply' },
    });

    // The expanded state is what the echo reports, so land that echo before
    // exercising the plain reduction path.
    fixture.replace({
      ...fixture.read(),
      bindings: fixture.read().bindings.map((b) => b.id === 'binding-group' ? { ...b, binding_scope: 'chat', group_policy: { wake: 'mention_or_reply' } } : b),
    });
    await act(settle);

    // 2. Reduce scope: chat -> sender (SCOPE_RANK 3 -> 1). Direct mutation without confirmation dialog
    await click(group, '[data-im-binding-scope="sender"]');
    expect(updateSpy).toHaveBeenCalledTimes(3);
    expect(updateSpy).toHaveBeenLastCalledWith('binding-group', {
      binding_scope: 'sender',
    });

    // 3. Update wake policy and prefixes
    fixture.replace({
      ...fixture.read(),
      bindings: fixture.read().bindings.map((b) => b.id === 'binding-group' ? { ...b, binding_scope: 'chat', group_policy: { wake: 'mention_or_reply' } } : b),
    });
    await act(settle);
    await click(group, '[data-im-binding-wake="manual"]');
    expect(updateSpy).toHaveBeenCalledTimes(4);
    expect(updateSpy).toHaveBeenLastCalledWith('binding-group', {
      group_policy: { wake: 'manual' },
    });
    await click(group, '[data-im-binding-wake="mention_or_reply"]');
    group.querySelector<HTMLInputElement>('[data-im-prefixes="data-im-binding"]')!.focus();
    await input(group, '[data-im-prefixes="data-im-binding"]', 'Kiki:');
    await act(async () => { group.querySelector<HTMLInputElement>('[data-im-prefixes="data-im-binding"]')!.blur(); await settle(); });
    expect(updateSpy).toHaveBeenLastCalledWith('binding-group', {
      group_policy: { wake: 'mention_or_reply', prefixes: ['Kiki:'] },
    });
  });

  it('keeps prefix labels and saves scoped to each of multiple group bindings', async () => {
    const state = imChannelSnapshot('telegram');
    const firstBinding = {
      ...state.bindings[1]!,
      binding_scope: 'chat' as const,
      group_policy: { wake: 'mention_or_reply' as const, prefixes: ['First:'] },
    };
    const secondBinding = {
      ...firstBinding,
      id: 'binding-group-2',
      identity: { ...firstBinding.identity, chat_id: 'release-group-2', chat_title: 'Release team 2' },
      session_id: 'reading-list',
    };
    state.bindings = [firstBinding, secondBinding];
    fixture = createImSettingsFixture(state);
    const updateSpy = vi.spyOn(fixture.client.imSessions, 'updateBinding');
    const container = await render();
    const firstRow = binding(container, 'binding-group');
    const secondRow = binding(container, 'binding-group-2');
    await click(firstRow, '[data-im-binding-options-toggle]');
    await click(secondRow, '[data-im-binding-options-toggle]');

    const inputs = container.querySelectorAll<HTMLInputElement>('[data-im-prefixes="data-im-binding"]');
    expect(inputs).toHaveLength(2);
    const firstInput = firstRow.querySelector<HTMLInputElement>('[data-im-prefixes="data-im-binding"]')!;
    const secondInput = secondRow.querySelector<HTMLInputElement>('[data-im-prefixes="data-im-binding"]')!;
    expect(secondInput.id).not.toBe(firstInput.id);
    const secondLabel = secondRow.querySelector<HTMLLabelElement>(`label[for="${secondInput.id}"]`)!;
    expect(secondLabel).not.toBeNull();
    expect(document.getElementById(secondLabel.htmlFor)).toBe(secondInput);
    secondInput.focus();

    await input(secondRow, '[data-im-prefixes="data-im-binding"]', 'Second:, Review:');
    expect(firstInput.value).toBe('First:');
    await act(async () => { secondInput.blur(); await settle(); });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenLastCalledWith('binding-group-2', {
      group_policy: { wake: 'mention_or_reply', prefixes: ['Second:', 'Review:'] },
    });
    expect(fixture.read().bindings.find((item) => item.id === 'binding-group')?.group_policy?.prefixes).toEqual(['First:']);
    expect(fixture.read().bindings.find((item) => item.id === 'binding-group-2')?.group_policy?.prefixes).toEqual(['Second:', 'Review:']);
  });

  it('keeps prefix labels and confirms scoped to each of multiple discoveries', async () => {
    const state = imChannelSnapshot('telegram');
    state.discoveries = [{
      id: 'tg-disc-group-1',
      provider_instance_id: 'account-a',
      provider_kind: 'telegram',
      account_id: 'studio-account',
      identity: { chat_id: 'disc-group-1', sender_id: 'member-1', topic_id: '0', chat_kind: 'group', chat_title: 'Design Team', sender_name: 'Bob' },
      preview: 'hello',
      at: '2026-10-27T01:00:00.000Z',
    }];
    state.discoveries.push({
      ...state.discoveries[0]!,
      id: 'tg-disc-group-2',
      identity: { ...state.discoveries[0]!.identity, chat_id: 'disc-group-2', chat_title: 'Release Team' },
    });
    fixture = createImSettingsFixture(state);
    const container = await render();
    const firstRow = container.querySelector<HTMLElement>('[data-im-discovery="tg-disc-group-1"]')!;
    const secondRow = container.querySelector<HTMLElement>('[data-im-discovery="tg-disc-group-2"]')!;
    await click(firstRow, '[data-im-discovery-scope="chat"]');
    await click(secondRow, '[data-im-discovery-scope="chat"]');

    const inputs = container.querySelectorAll<HTMLInputElement>('[data-im-prefixes="data-im-discovery"]');
    expect(inputs).toHaveLength(2);
    const firstInput = firstRow.querySelector<HTMLInputElement>('[data-im-prefixes="data-im-discovery"]')!;
    const secondInput = secondRow.querySelector<HTMLInputElement>('[data-im-prefixes="data-im-discovery"]')!;
    expect(secondInput.id).not.toBe(firstInput.id);
    const secondLabel = secondRow.querySelector<HTMLLabelElement>(`label[for="${secondInput.id}"]`)!;
    expect(secondLabel).not.toBeNull();
    expect(document.getElementById(secondLabel.htmlFor)).toBe(secondInput);
    secondInput.focus();

    await input(secondRow, '[data-im-prefixes="data-im-discovery"]', 'Second:, Review:');
    expect(firstInput.value).toBe('');
    await act(async () => { secondInput.blur(); await settle(); });
    await click(secondRow, '[data-im-confirm]');
    const confirmCalls = fixture.calls.filter((call) => call.operation === 'confirm');
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]?.id).toBe('tg-disc-group-2');
    expect(confirmCalls[0]?.body).toMatchObject({
      binding_scope: 'chat',
      group_policy: { wake: 'mention_or_reply', prefixes: ['Second:', 'Review:'] },
    });
    expect(fixture.read().discoveries.map((item) => item.id)).toEqual(['tg-disc-group-1']);
  });

  it('renders inline error feedback when backend returns topic_scope_unavailable or group_binding_scope_required', async () => {
    const state = imChannelSnapshot('telegram');
    state.bindings[1] = { ...state.bindings[1]!, identity: { ...state.bindings[1]!.identity, topic_id: '42' } };
    fixture = createImSettingsFixture(state);
    const container = await render();
    const group = binding(container, 'binding-group');
    const updateSpy = vi.spyOn(fixture.client.imSessions, 'updateBinding');

    await click(group, '[data-im-binding-options-toggle]');

    // Mock 40001 topic_scope_unavailable: the write runs at once and fails inline
    updateSpy.mockRejectedValueOnce(new Error('topic_scope_unavailable'));
    await click(group, '[data-im-binding-scope="topic"]');
    expect(group.textContent).toContain('This group has no topics. Select the whole group.');

    // Mock 40001 group_binding_scope_required
    updateSpy.mockRejectedValueOnce(new Error('group_binding_scope_required'));
    await click(group, '[data-im-binding-scope="chat"]');
    expect(group.textContent).toContain('Only groups support topic or whole-group scope.');
  });
});
