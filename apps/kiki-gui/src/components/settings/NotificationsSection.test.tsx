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

const api = {
  getSettings: vi.fn(), updateSettings: vi.fn(), listProviders: vi.fn(), upsertInstance: vi.fn(), deleteInstance: vi.fn(),
  upsertChannel: vi.fn(), deleteChannel: vi.fn(), setCredential: vi.fn(), checkCredential: vi.fn(), sendTest: vi.fn(), listDeliveries: vi.fn(),
};
const revealSecret = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ scopeId: 'fixture', client: { notifications: api, revealSecret } }),
}));
vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser' }) }));

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

async function render(settings = SETTINGS): Promise<HTMLDivElement> {
  api.getSettings.mockResolvedValue(structuredClone(settings));
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><I18nProvider><MemoryRouter><NotificationsSection /></MemoryRouter></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

const click = async (element: Element | null) => { await act(async () => { (element as HTMLElement).click(); }); };

describe('NotificationsSection', () => {
  it('shows each failure as its own state and tags send-only, unverified channels', async () => {
    const container = await render();
    const state = (id: string) => container.querySelector(`[data-notify-channel="${id}"] [data-notify-state]`)?.getAttribute('data-notify-state');
    expect(state('a')).toBe('ok');
    expect(state('b')).toBe('unauthorized');
    // The component is missing: that wins over the stale connection health.
    expect(state('c')).toBe('dependency');
    expect(container.querySelector('[data-notify-channel="a"] [data-notify-tag="send-only"]')).not.toBeNull();
    expect(container.querySelector('[data-notify-channel="a"] [data-notify-tag="unverified"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/reply|Receive/i);
    // No Save button: the page is instant apply.
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Save')).toBe(false);
  });

  it('writes the whole global object on a switch', async () => {
    const container = await render();
    await act(async () => { container.querySelector<HTMLInputElement>('#notify-viewing')!.click(); });
    expect(api.updateSettings).toHaveBeenCalledWith({ ...GLOBAL, suppress_viewing_session: false });
  });

  it('toggles a scene with an instant channel upsert', async () => {
    const container = await render();
    await click(container.querySelector('[data-notify-channel="a"] button[aria-expanded]'));
    await act(async () => { container.querySelector<HTMLInputElement>('[data-notify-channel="a"] [data-notify-scene="question_pending"]')!.click(); });
    const [id, channel] = api.upsertChannel.mock.calls[0]!;
    expect(id).toBe('a');
    expect(channel.scenes).toEqual({ work_complete: true, question_pending: false });
    expect(channel).not.toHaveProperty('health');
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

  it('empty state, then an add form without script and with unavailable types named', async () => {
    const container = await render({ ...SETTINGS, provider_instances: {}, channels: {}, credential_slots: {} });
    expect(container.querySelector('[data-notify-empty]')).not.toBeNull();
    await click(container.querySelector('[data-notify-add-open]'));
    expect(container.querySelector('[data-notify-add]')).not.toBeNull();
    const unavailable = [...container.querySelectorAll('[data-notify-unavailable-provider]')].map((row) => row.getAttribute('data-notify-unavailable-provider'));
    expect(unavailable).toEqual(['windows_toast', 'smtp']);
    expect(container.textContent).not.toContain('Script');
  });

  it('creates the instance and slot first, then the channel', async () => {
    api.upsertInstance.mockResolvedValue(structuredClone(SETTINGS));
    api.setCredential.mockResolvedValue({ configured: true });
    const container = await render({ ...SETTINGS, provider_instances: {}, channels: {}, credential_slots: {} });
    await click(container.querySelector('[data-notify-add-open]'));
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
});
