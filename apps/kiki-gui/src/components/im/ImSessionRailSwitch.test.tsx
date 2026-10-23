// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImSessionSnapshot } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { ImSessionRailSwitch } from './ImSessionRailSwitch';

function snap(sessionEnabled: boolean | undefined, enabled = true, allowed = true): ImSessionSnapshot {
  const binding = (id: string) => ({
    id, provider_instance_id: 'inst', provider_kind: 'telegram' as const, account_id: '7',
    identity: { chat_id: 'c', sender_id: 'u', topic_id: '0' },
    session_id: 'sess', enabled, busy: 'queue' as const, reply: 'final' as const, mobile_interactions: true,
    ...(sessionEnabled === undefined ? {} : { session_enabled: sessionEnabled }),
  });
  return {
    policy: { allowed, default_enabled: true }, instances: [], discoveries: [], strangers: [], voice_fallbacks: 0,
    bindings: [binding('b1'), binding('b2')],
  };
}

const imSessions = {
  snapshot: vi.fn(async () => snap(false)),
  updateBinding: vi.fn(async (_id: string, _patch: { session_enabled?: boolean; target?: unknown }) => snap(true)),
  confirm: vi.fn(async (_id: string, _body: unknown) => snap(true)),
  check: vi.fn(async (_id: string) => ({ ok: true as const })),
  listen: vi.fn(async (_id: string, _on: boolean) => snap(true)),
};

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => ({ scopeId: 'fixture', client: { imSessions } }),
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
let client: QueryClient;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  imSessions.snapshot.mockReset();
  imSessions.updateBinding.mockReset();
  imSessions.confirm.mockReset();
  imSessions.check.mockReset();
  imSessions.listen.mockReset();
  imSessions.snapshot.mockResolvedValue(snap(false));
  imSessions.updateBinding.mockResolvedValue(snap(true));
  imSessions.confirm.mockResolvedValue(snap(true));
  imSessions.check.mockResolvedValue({ ok: true });
  imSessions.listen.mockResolvedValue(snap(true));
});

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><I18nProvider><ImSessionRailSwitch sessionId="sess" /></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

async function click(container: HTMLDivElement): Promise<void> {
  await act(async () => {
    container.querySelector('button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe('ImSessionRailSwitch', () => {
  it('updates only the selected binding and keeps the returned snapshot', async () => {
    imSessions.snapshot.mockResolvedValue(snap(false));
    let release: (value: ImSessionSnapshot) => void = () => {};
    const first = new Promise<ImSessionSnapshot>((resolve) => { release = resolve; });
    imSessions.updateBinding.mockReturnValue(first);
    const container = await render();
    await click(container);
    expect(imSessions.updateBinding).toHaveBeenCalledTimes(1);
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b1', { session_enabled: true });
    expect(container.querySelector('[data-im-rail-busy="yes"]')).not.toBeNull();
    await act(async () => { release(snap(true)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(client.getQueryData(['im-sessions'])).toEqual(snap(true));
    expect(container.querySelector('[data-im-rail-error]')).toBeNull();
    expect(container.querySelector('[data-im-rail-busy="yes"]')).toBeNull();
  });

  it('shows a failed update and reloads the snapshot', async () => {
    imSessions.snapshot.mockResolvedValue(snap(false));
    imSessions.updateBinding.mockRejectedValue(new Error('Save failed'));
    const container = await render();
    const seen = imSessions.snapshot.mock.calls.length;
    await click(container);
    expect(container.querySelector('[data-im-rail-error]')?.textContent).toBe('Save failed');
    expect(container.querySelector('[data-im-rail-busy="yes"]')).toBeNull();
    expect(imSessions.snapshot.mock.calls.length).toBeGreaterThan(seen);
    expect(container.textContent).not.toMatch(/reply|Receive/i);
  });

  it('does not offer a switch when two-way messaging or the binding is off', async () => {
    imSessions.snapshot.mockResolvedValue(snap(false, true, false));
    const closed = await render();
    expect(closed.querySelector('button')).toBeNull();
    expect(closed.querySelector('[data-im-rail-reason]')?.textContent).toContain('Two-way messaging is off.');
    expect(imSessions.updateBinding).not.toHaveBeenCalled();
    imSessions.snapshot.mockResolvedValue(snap(false, false, true));
    const disabled = await render();
    expect(disabled.querySelector('button')).toBeNull();
    expect(disabled.querySelector('[data-im-rail-reason]')?.textContent).toContain('This IM binding is disabled.');
    expect(imSessions.updateBinding).not.toHaveBeenCalled();
  });

  it('does not project or reroute a binding owned by another session', async () => {
    const otherSessionSnap: ImSessionSnapshot = {
      policy: { allowed: true, default_enabled: true },
      instances: [],
      discoveries: [],
      strangers: [],
      voice_fallbacks: 0,
      bindings: [{
        id: 'b-other',
        provider_instance_id: 'inst',
        provider_kind: 'wechat_bridge',
        account_id: 'wxid_1',
        identity: { chat_id: 'c', sender_id: 'u', topic_id: '0' },
        session_id: 'other-sess',
        enabled: true,
        busy: 'queue',
        reply: 'final',
        mobile_interactions: true,
      }],
    };
    imSessions.snapshot.mockResolvedValue(otherSessionSnap);
    const container = await render();
    expect(container.querySelector('[data-im-rail]')).toBeNull();
    expect(container.textContent).not.toContain('IM conversation');
    expect(imSessions.updateBinding).not.toHaveBeenCalled();
  });

  it('displays exact platform, group, and sender identities for discoveries and requires explicit choice when multiple unknown identities exist', async () => {
    const singleDiscoverySnap: ImSessionSnapshot = {
      policy: { allowed: true, default_enabled: true },
      instances: [{ id: 'wx-1', provider_kind: 'wechat_bridge', listening: true, configured: true, account_id: 'wxid_1', adapter: 'running' }],
      discoveries: [{
        id: 'd-wx',
        provider_instance_id: 'wx-1',
        provider_kind: 'wechat_bridge',
        account_id: 'wxid_1',
        identity: { chat_id: 'c-1', sender_id: 'u-1', topic_id: '0', chat_title: 'Product Crew', sender_name: 'Lin' },
        preview: 'hi',
        at: '2026-10-22T00:00:00.000Z',
      }],
      bindings: [],
      strangers: [],
      voice_fallbacks: 0,
    };
    imSessions.snapshot.mockResolvedValueOnce(singleDiscoverySnap);
    const single = await render();
    expect(single.querySelector('[data-im-rail-identity="d-wx"]')?.textContent).toBe('WeChat · Product Crew · Lin · c-1');
    expect(single.querySelector('[data-im-rail-action="bind"]')?.textContent).toContain('Bind here (WeChat · Product Crew · Lin · c-1)');

    const multiDiscoverySnap: ImSessionSnapshot = {
      ...singleDiscoverySnap,
      discoveries: [
        singleDiscoverySnap.discoveries[0]!,
        {
          id: 'd-tg',
          provider_instance_id: 'tg-1',
          provider_kind: 'telegram',
          account_id: '7',
          identity: { chat_id: 'c-2', sender_id: 'u-2', topic_id: '0', sender_name: 'Ada' },
          preview: 'ping',
          at: '2026-10-22T00:00:01.000Z',
        },
      ],
    };
    imSessions.snapshot.mockResolvedValueOnce(multiDiscoverySnap);
    const multi = await render();
    expect(multi.querySelector('[data-im-rail-action="bind"]')).toBeNull();
    expect(multi.querySelector('[data-im-rail-multi="discoveries"]')).not.toBeNull();
    expect(multi.querySelector('[data-im-rail-identity="d-wx"]')?.textContent).toBe('WeChat · Product Crew · Lin · c-1');
    expect(multi.querySelector('[data-im-rail-identity="d-tg"]')?.textContent).toBe('Telegram · Ada · c-2');

    await act(async () => {
      multi.querySelector<HTMLButtonElement>('[data-im-rail-confirm="d-tg"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(imSessions.confirm).toHaveBeenCalledTimes(1);
    expect(imSessions.confirm).toHaveBeenCalledWith('d-tg', {
      target: { kind: 'session', session_id: 'sess' },
    });
  });

  it('does not turn global account instances into a session binding surface', async () => {
    const instanceOnlySnap: ImSessionSnapshot = {
      policy: { allowed: true, default_enabled: true },
      instances: [
        { id: 'wx-1', provider_kind: 'wechat_bridge', listening: true, configured: true, account_id: 'wxid_1', adapter: 'stopped', connection: 'reconnecting' },
        { id: 'tg-1', provider_kind: 'telegram', listening: false, configured: true, account_id: 'bot_7', adapter: 'stopped' },
      ],
      discoveries: [],
      bindings: [],
      strangers: [],
      voice_fallbacks: 0,
    };
    imSessions.snapshot.mockResolvedValueOnce(instanceOnlySnap);
    const container = await render();
    expect(container.querySelector('[data-im-rail]')).toBeNull();
    expect(container.textContent).not.toMatch(/Reconnecting|WeChat|Telegram/);
    expect(imSessions.check).not.toHaveBeenCalled();
    expect(imSessions.listen).not.toHaveBeenCalled();
  });

  it('keeps Telegram chats and topics scoped to their own sessions', async () => {
    const telegramBindings: ImSessionSnapshot = {
      policy: { allowed: true, default_enabled: true },
      instances: [{ id: 'tg', provider_kind: 'telegram', listening: true, configured: true, account_id: 'bot_7', adapter: 'running' }],
      discoveries: [],
      strangers: [],
      voice_fallbacks: 0,
      bindings: [
        {
          id: 'tg-current', provider_instance_id: 'tg', provider_kind: 'telegram', account_id: 'bot_7',
          identity: { chat_id: '-1001', sender_id: 'u-1', topic_id: '41', chat_title: 'Release room', sender_name: 'Ada' },
          session_id: 'sess', enabled: true, busy: 'queue', reply: 'final', mobile_interactions: true,
        },
        {
          id: 'tg-other', provider_instance_id: 'tg', provider_kind: 'telegram', account_id: 'bot_7',
          identity: { chat_id: '-1001', sender_id: 'u-1', topic_id: '42', chat_title: 'Release room', sender_name: 'Ada' },
          session_id: 'other-sess', enabled: true, busy: 'queue', reply: 'final', mobile_interactions: true,
        },
      ],
    };
    imSessions.snapshot.mockResolvedValueOnce(telegramBindings);
    imSessions.updateBinding.mockResolvedValue(telegramBindings);
    const container = await render();
    expect(container.querySelector('[data-im-rail-binding="tg-current"]')).not.toBeNull();
    expect(container.querySelector('[data-im-rail-binding="tg-other"]')).toBeNull();
    expect(container.querySelector('[data-im-rail-identity="tg-current"]')?.textContent).toBe('Telegram · Release room · Ada · -1001/41');
    expect(container.textContent).not.toContain('-1001/42');
    const toggle = container.querySelector<HTMLButtonElement>('[data-im-rail-binding-toggle="tg-current"]')!;
    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Telegram · Release room · Ada · -1001/41');
    await act(async () => {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(imSessions.updateBinding).toHaveBeenCalledTimes(1);
    expect(imSessions.updateBinding).toHaveBeenCalledWith('tg-current', { session_enabled: false });
  });

  it('keeps the other topic on when one of this session’s bindings is paused', async () => {
    const snapshot = snap(true);
    snapshot.bindings = snapshot.bindings.map((binding, index) => ({
      ...binding,
      identity: { chat_id: '-1001', sender_id: 'u-1', topic_id: String(41 + index) },
    }));
    imSessions.snapshot.mockResolvedValue(snapshot);
    imSessions.updateBinding.mockImplementation(async (id, patch) => ({
      ...snapshot,
      bindings: snapshot.bindings.map((binding) => binding.id === id ? { ...binding, ...patch } : binding),
    }));
    const container = await render();
    await click(container);
    expect(imSessions.updateBinding).toHaveBeenCalledTimes(1);
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b1', { session_enabled: false });
    expect(container.querySelector<HTMLElement>('[data-im-rail-binding="b1"]')?.dataset['imRailBindingOn']).toBe('no');
    expect(container.querySelector<HTMLElement>('[data-im-rail-binding="b2"]')?.dataset['imRailBindingOn']).toBe('yes');
    expect(container.querySelector('[data-im-rail-binding-toggle="b2"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('does not carry pending state or a late failure into another session', async () => {
    const snapshot = snap(true);
    snapshot.bindings[1] = { ...snapshot.bindings[1]!, session_id: 'other-sess' };
    imSessions.snapshot.mockResolvedValue(snapshot);
    let reject!: (error: Error) => void;
    imSessions.updateBinding.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const container = await render();
    await click(container);
    expect(container.querySelector('[data-im-rail-busy="yes"]')).not.toBeNull();
    await act(async () => {
      roots.at(-1)!.render(<QueryClientProvider client={client}><I18nProvider><ImSessionRailSwitch sessionId="other-sess" /></I18nProvider></QueryClientProvider>);
    });
    expect(container.querySelector('[data-im-rail-binding="b1"]')).toBeNull();
    expect(container.querySelector('[data-im-rail-binding-toggle="b2"]')?.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      reject(new Error('Previous session update failed'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-im-rail-error]')).toBeNull();
    expect(container.querySelector('[data-im-rail-busy="yes"]')).toBeNull();
  });

  it('surfaces reconnecting state only for a binding owned by the current session', async () => {
    const reconnectingBoundSnap: ImSessionSnapshot = {
      ...snap(true),
      instances: [{
        id: 'inst',
        provider_kind: 'wechat_bridge',
        listening: true,
        configured: true,
        account_id: 'wxid_1',
        adapter: 'stopped',
        connection: 'reconnecting',
      }],
    };
    imSessions.snapshot.mockResolvedValueOnce(reconnectingBoundSnap);
    const container = await render();
    expect(container.querySelector('[data-im-rail-connection="reconnecting"]')?.textContent).toContain('Reconnecting');
    await click(container);
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b1', { session_enabled: false });
  });
});
