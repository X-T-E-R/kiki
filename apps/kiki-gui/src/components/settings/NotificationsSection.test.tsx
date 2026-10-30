// @vitest-environment jsdom

/**
 * NotificationsSection: schema-driven channel rows with distinct states,
 * instant-apply writes, the check/test results, and an add entry that never
 * offers the script provider or unavailable types.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NotificationProviderDescriptor, NotificationSettings } from '@kiki/klient';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { NotificationsSection } from './NotificationsSection';
import { readSettings } from '@kiki/session-core/settings';
import { CompletionObserver } from '@kiki/session-core/sessions';
import { AwayNotifier } from '../../lib/awayNotify';

const api = {
  getSettings: vi.fn(), updateSettings: vi.fn(), listProviders: vi.fn(), upsertInstance: vi.fn(), deleteInstance: vi.fn(),
  upsertChannel: vi.fn(), deleteChannel: vi.fn(), setCredential: vi.fn(), checkCredential: vi.fn(), sendTest: vi.fn(), listDeliveries: vi.fn(),
};
const revealSecret = vi.fn();
const imSessions = {
  snapshot: vi.fn(async () => ({ policy: { allowed: true, default_enabled: true }, instances: [], discoveries: [], bindings: [], strangers: [], voice_fallbacks: 0 })),
  catalog: vi.fn(async () => ({ personas: [], sessions: [] })),
  setupCatalog: vi.fn(async () => ({ platforms: [] })),
  setPolicy: vi.fn(), paste: vi.fn(), check: vi.fn(), listen: vi.fn(), confirm: vi.fn(), dismiss: vi.fn(), updateBinding: vi.fn(), removeBinding: vi.fn(),
};

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ scopeId: 'fixture', client: { notifications: api, revealSecret, imSessions, getConfig: async () => ({}) } }),
}));
vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser', notify: async () => {} }) }));

const PROVIDERS: NotificationProviderDescriptor[] = [
  { id: 'telegram', can_send: true, can_receive: false, status: 'unverified', status_reason: 'real_account_not_tested',
    instance_fields: [{ key: 'token_slot', label: 'Bot token', kind: 'secret', required: true, purpose: 'telegram_bot' }],
    target_fields: [{ key: 'chat_id', label: 'Chat ID', kind: 'text', required: true }] },
  { id: 'http', can_send: true, can_receive: false, status: 'unverified',
    instance_fields: [{ key: 'endpoint', label: 'Endpoint', kind: 'text', required: true }, { key: 'auth_slot', label: 'Bearer token', kind: 'secret', required: false, purpose: 'http_bearer' }, { key: 'private_grant', label: 'Private endpoint grant', kind: 'json', required: false }],
    target_fields: [] },
  { id: 'script', can_send: false, can_receive: false, status: 'dependency_missing', status_reason: 'protected_script_execution_unavailable', instance_fields: [], target_fields: [] },
  { id: 'windows_toast', can_send: false, can_receive: false, status: 'dependency_missing', status_reason: 'desktop_host_unavailable', instance_fields: [], target_fields: [] },
  { id: 'smtp', can_send: false, can_receive: false, status: 'dependency_missing', status_reason: 'adapter_not_installed', instance_fields: [], target_fields: [] },
];

const GLOBAL = { enabled: true, suppress_viewing_session: true, min_work_ms: 60_000, work_stable_ms: 3_000, question_delay_ms: 10_000 };
const scenes = { work_complete: true, question_pending: true };
const SETTINGS: NotificationSettings = {
  global: GLOBAL,
  provider_instances: {
    tg: { provider_id: 'telegram', enabled: true, revision: 'r1', options: { token_slot: 'tg.telegram_bot' }, health: 'ok' },
    toast: { provider_id: 'windows_toast', enabled: true, revision: 'r1', options: {} },
  },
  channels: {
    a: { provider_instance_id: 'tg', enabled: true, revision: 'r1', target: { chat_id: '1' }, directions: ['send'], scenes, label: 'Phone', health: 'ok' },
    b: { provider_instance_id: 'tg', enabled: true, revision: 'r1', target: { chat_id: '2' }, directions: ['send'], scenes, label: 'Team', health: 'unauthorized' },
    c: { provider_instance_id: 'toast', enabled: true, revision: 'r1', target: {}, directions: ['send'], scenes, health: 'connection_failed' },
  },
  credential_slots: { 'tg.telegram_bot': { provider_id: 'telegram', provider_instance_id: 'tg', purpose: 'telegram_bot', env: 'KIKI_NOTIFY_TG', configured: true } },
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => { vi.stubGlobal('navigator', { language: 'en-US' }); env.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getSettings.mockResolvedValue(structuredClone(SETTINGS));
  api.listProviders.mockResolvedValue(PROVIDERS);
  api.listDeliveries.mockResolvedValue([]);
  api.updateSettings.mockImplementation(async (global: typeof GLOBAL) => ({ ...structuredClone(SETTINGS), global }));
  api.upsertChannel.mockImplementation(async () => structuredClone(SETTINGS));
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

async function render(settings = SETTINGS, entry = '/settings/notifications'): Promise<HTMLDivElement> {
  api.getSettings.mockResolvedValue(structuredClone(settings));
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter initialEntries={[entry]}><NotificationsSection /></MemoryRouter></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  // Editors open in a portaled side panel, so the whole document is the surface.
  return document.body as HTMLDivElement;
}

const click = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); };

describe('NotificationsSection', () => {
  it('shows the existing default-on conversation completion switch and persists disabling/re-enabling it', async () => {
    const container = await render();
    const row = () => container.querySelector('[data-notify-away-kind="completed"]')!;
    expect(row().textContent).toContain('Notify when the conversation finishes');
    expect(row().textContent).toContain('finite background tasks');
    expect(row().querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    const observer = new CompletionObserver();
    const notifier = new AwayNotifier();
    const notify = vi.fn(async () => {});
    notifier.configure({ isAway: async () => true, notify, format: () => ({ title: 'Work settled', route: '/s/example' }) });
    observer.observe([], []);
    const completion = (episode_id: string) => [{ session_id: 'example', episode_id, completed_at: Date.now() }];
    await click(row().querySelector('input'));
    expect(readSettings().awayNotifications.completed).toBe(false);
    await notifier.report(observer.observe(completion('disabled'), []));
    expect(notify).not.toHaveBeenCalled();
    await click(row().querySelector('input'));
    expect(readSettings().awayNotifications.completed).toBe(true);
    await notifier.report(observer.observe(completion('disabled'), []));
    expect(notify).not.toHaveBeenCalled();
    await notifier.report(observer.observe(completion('enabled'), []));
    expect(notify).toHaveBeenCalledTimes(1);
    notifier.reset();
  });

  it('shows each failure as its own state and marks every alert channel as alerts only', async () => {
    const container = await render();
    const state = (id: string) => container.querySelector(`[data-notify-channel="${id}"] [data-notify-state]`)?.getAttribute('data-notify-state');
    expect(state('a')).toBe('ok');
    expect(state('b')).toBe('unauthorized');
    // The component is missing: that wins over the stale connection health.
    expect(state('c')).toBe('dependency');
    for (const id of ['a', 'b', 'c']) {
      expect(container.querySelector(`[data-notify-channel="${id}"] [data-channel-capability="alerts"]`)).not.toBeNull();
    }
    // No Save button: the page is instant apply.
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Save')).toBe(false);
  });

  it('keeps a paused master switch visible on the list and on each row', async () => {
    const container = await render({ ...SETTINGS, global: { ...GLOBAL, enabled: false } });
    expect(container.querySelector('[data-notify-paused-banner]')).not.toBeNull();
    expect(container.querySelector('[data-notify-channel="a"] [data-notify-state]')?.textContent).toBe('Paused');
    expect(container.querySelector('[data-notify-tab-paused]')).not.toBeNull();
  });

  it('writes the whole global object on a switch', async () => {
    const container = await render();
    await act(async () => { container.querySelector<HTMLInputElement>('#notify-viewing')!.click(); });
    expect(api.updateSettings).toHaveBeenCalledWith({ ...GLOBAL, suppress_viewing_session: false });
  });

  it('chooses moments only in the rules matrix, with an instant channel upsert', async () => {
    const container = await render(SETTINGS, '/settings/notifications?tab=rules');
    // The channel's own page no longer carries a second set of moment boxes.
    await click(container.querySelector('[data-notify-channel="a"] button[aria-expanded]'));
    expect(container.querySelector('[data-notify-channel="a"] [data-notify-scene]')).toBeNull();
    const rows = [...container.querySelectorAll('[data-notify-matrix-row]')].map((row) => row.getAttribute('data-notify-matrix-row'));
    expect(rows).toEqual(['a', 'b', 'c']);
    const box = container.querySelector<HTMLInputElement>('[data-notify-scene-channel="a"][data-notify-scene="question_pending"]')!;
    expect(box.getAttribute('aria-label')).toBe('Phone: A question is waiting');
    await act(async () => { box.click(); });
    const [id, channel] = api.upsertChannel.mock.calls[0]!;
    expect(id).toBe('a');
    expect(channel.scenes).toEqual({ work_complete: true, question_pending: false });
    expect(channel).not.toHaveProperty('health');
  });

  it('names where to find a platform credential when it was refused and in the add form, not on a working channel', async () => {
    const container = await render();
    await click(container.querySelector('[data-notify-channel="a"] button[aria-expanded]'));
    expect(container.querySelector('[data-notify-channel="a"] [data-notify-guide]')).toBeNull();
    await click(container.querySelector('[data-notify-channel="b"] button[aria-expanded]'));
    expect(container.querySelector('[data-notify-channel="b"] [data-notify-guide="telegram"]')?.textContent).toContain('@BotFather');
    await click(container.querySelector('[data-notify-add-open]'));
    await click(container.querySelector('[data-channel-brand="telegram"]'));
    await click(container.querySelector('[data-channel-route="push:telegram"]'));
    expect(container.querySelector('[data-notify-add="telegram"] [data-notify-guide="telegram"]')).not.toBeNull();
  });

  it('reports a failed test send with the platform reason', async () => {
    api.sendTest.mockResolvedValue({ delivery_id: 'd', channel_id: 'a', status: 'failed', attempt: 1, created_at: '', expires_at: '', result: { status: 'failed', message_ids: [], retryable: false, error_kind: 'transient' } });
    const container = await render();
    await click(container.querySelector('[data-notify-channel="a"] button[aria-expanded]'));
    await click(container.querySelector('[data-notify-channel="a"] [data-notify-test]'));
    expect(container.querySelector('[data-notify-channel="a"] [data-notify-result]')!.textContent).toContain('network unavailable');
  });

  it('says a webhook check needs a test send', async () => {
    api.checkCredential.mockResolvedValue({ result: 'requires_test_send', health: 'unknown' });
    const container = await render();
    await click(container.querySelector('[data-notify-channel="a"] button[aria-expanded]'));
    await click(container.querySelector('[data-notify-channel="a"] [data-notify-check]'));
    expect(container.querySelector('[data-notify-channel="a"] [data-notify-result]')!.textContent).toContain('Send a test notification');
  });

  it('empty state, then one add panel listing both kinds, with unavailable types marked and no script', async () => {
    const container = await render({ ...SETTINGS, provider_instances: {}, channels: {}, credential_slots: {} });
    expect(container.querySelector('[data-notify-empty]')).not.toBeNull();
    await click(container.querySelector('[data-notify-add-open]'));
    const brands = [...container.querySelectorAll('[data-channel-brand]')].map((card) => card.getAttribute('data-channel-brand'));
    expect(brands).toEqual(expect.arrayContaining(['wechat', 'telegram', 'feishu', 'qq', 'http', 'email', 'windows', 'other']));
    const telegram = container.querySelector('[data-channel-brand="telegram"]')!;
    expect(telegram.querySelector('[data-channel-capability="two-way"]')).not.toBeNull();
    expect(telegram.querySelector('[data-channel-capability="alerts"]')).not.toBeNull();
    const unavailable = [...container.querySelectorAll('[data-notify-unavailable-provider]')].map((row) => row.getAttribute('data-notify-unavailable-provider'));
    expect(unavailable).toEqual(expect.arrayContaining(['smtp', 'windows_toast']));
    expect(container.querySelector<HTMLButtonElement>('[data-channel-brand="email"]')?.disabled).toBe(true);
    expect(container.textContent).not.toContain('Script');
    expect(container.querySelector('[data-im-wechat]')).toBeNull();
  });

  it('opens the add panel when a search hit or link targets its card', async () => {
    const container = await render(SETTINGS, '/settings/notifications#st-card-notify-add');
    expect(container.querySelector('#st-card-notify-add [data-channel-brands]')).not.toBeNull();
  });

  it('creates the instance and slot first, then the channel', async () => {
    api.upsertInstance.mockResolvedValue(structuredClone(SETTINGS));
    api.setCredential.mockResolvedValue({ configured: true });
    const container = await render({ ...SETTINGS, provider_instances: {}, channels: {}, credential_slots: {} });
    await click(container.querySelector('[data-notify-add-open]'));
    await click(container.querySelector('[data-channel-brand="telegram"]'));
    await click(container.querySelector('[data-channel-route="push:telegram"]'));
    expect(container.querySelector('[data-notify-add-connection]')).toBeNull();
    const form = container.querySelector('[data-notify-add]')!;
    const setInput = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await setInput(form.querySelector<HTMLInputElement>('[data-secret-field] input')!, '1:token');
    const chat = [...form.querySelectorAll<HTMLInputElement>('input')].find((input) => input.id.endsWith('t.chat_id'))!;
    await setInput(chat, '42');
    await click([...form.querySelectorAll('button')].find((button) => button.textContent === 'Add channel')!);
    const [instanceId, instance, slots] = api.upsertInstance.mock.calls[0]!;
    expect(instanceId).toBe('telegram-1');
    expect(instance.options).toEqual({ token_slot: 'telegram-1.telegram_bot' });
    expect(Object.keys(slots)).toEqual(['telegram-1.telegram_bot']);
    expect(api.setCredential).toHaveBeenCalledWith('telegram-1.telegram_bot', '1:token');
    const [channelId, channel] = api.upsertChannel.mock.calls[0]!;
    expect(channelId).toBe('telegram-1');
    expect(channel).toMatchObject({ provider_instance_id: 'telegram-1', target: { chat_id: '42' }, directions: ['send'] });
    expect(api.upsertInstance.mock.invocationCallOrder[0]).toBeLessThan(api.upsertChannel.mock.invocationCallOrder[0]!);
  });

  it('opens on channels and accounts, with chat accounts and push channels together', async () => {
    const container = await render();
    expect([...container.querySelectorAll('[data-notify-tab]')].map((tab) => tab.getAttribute('data-notify-tab')))
      .toEqual(['accounts', 'rules', 'device']);
    expect(container.querySelector('[data-notify-tab="accounts"]')?.getAttribute('aria-selected')).toBe('true');
    const accounts = container.querySelector('#notify-panel-accounts')!;
    expect(accounts.classList.contains('hidden')).toBe(false);
    // One list: the two-way anchor sits inside the channels card.
    expect(accounts.querySelector('#st-card-notify-channels #st-card-im-session')).not.toBeNull();
    expect(accounts.querySelectorAll('[data-settings-card]')).toHaveLength(1);
    // A channel needing attention marks the tab that holds it.
    expect(container.querySelector('[data-notify-tab-attention="accounts"]')).not.toBeNull();

    await click(container.querySelector('[data-notify-tab="rules"]'));
    const rules = container.querySelector('#notify-panel-rules')!;
    expect(rules.classList.contains('hidden')).toBe(false);
    expect(rules.querySelector('#st-card-notify-rules #notify-enabled')).not.toBeNull();
    expect(rules.querySelector('#st-card-notify-scenes')).not.toBeNull();
  });

  it.each([
    ['?tab=im', 'accounts'],
    ['?tab=channels', 'accounts'],
    ['?tab=away', 'device'],
    ['#st-card-notify-away', 'device'],
    ['#st-card-notify-rules', 'rules'],
    ['#st-card-im-session', 'accounts'],
  ])('keeps the older address %s landing on %s', async (suffix, tab) => {
    const container = await render(SETTINGS, `/settings/notifications${suffix}`);
    expect(container.querySelector(`[data-notify-tab="${tab}"]`)?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector(`#notify-panel-${tab}`)?.classList.contains('hidden')).toBe(false);
  });

  it('keeps chat accounts usable while push settings fail to load, and says why', async () => {
    api.getSettings.mockRejectedValue(new Error('fixture offline'));
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter initialEntries={['/settings/notifications']}><NotificationsSection /></MemoryRouter></I18nProvider></QueryClientProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('#notify-panel-accounts #st-card-im-session')).not.toBeNull();
    expect(container.querySelector('#notify-panel-accounts')!.textContent).toContain('fixture offline');
  });
});
