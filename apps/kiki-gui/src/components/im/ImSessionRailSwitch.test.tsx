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
  it('updates bindings one at a time and keeps the last snapshot', async () => {
    imSessions.snapshot.mockResolvedValue(snap(false));
    let release: (value: ImSessionSnapshot) => void = () => {};
    const first = new Promise<ImSessionSnapshot>((resolve) => { release = resolve; });
    const calls: string[] = [];
    imSessions.updateBinding.mockImplementation((id: string) => {
      calls.push(id);
      return calls.length === 1 ? first : Promise.resolve(snap(true));
    });
    const container = await render();
    await click(container);
    expect(calls).toEqual(['b1']);
    expect(container.querySelector('[data-im-rail-busy="yes"]')).not.toBeNull();
    await act(async () => { release(snap(true)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(calls).toEqual(['b1', 'b2']);
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
    expect(closed.querySelector('[data-im-rail-blocked="allowed"]')?.textContent).toContain('Two-way messaging is off.');
    expect(imSessions.updateBinding).not.toHaveBeenCalled();
    imSessions.snapshot.mockResolvedValue(snap(false, false, true));
    const disabled = await render();
    expect(disabled.querySelector('button')).toBeNull();
    expect(disabled.querySelector('[data-im-rail-blocked="disabled"]')?.textContent).toContain('This phone binding is disabled.');
    expect(imSessions.updateBinding).not.toHaveBeenCalled();
  });

  it('routes an existing phone binding to the current session directly from the rail', async () => {
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
    imSessions.updateBinding.mockResolvedValue({
      ...otherSessionSnap,
      bindings: [{ ...otherSessionSnap.bindings[0]!, session_id: 'sess' }],
    });
    const container = await render();
    expect(container.querySelector('[data-im-rail-identity="b-other"]')?.textContent).toBe('WeChat · u');
    expect(container.querySelector('[data-im-rail-action="route"]')?.textContent).toContain('Route here (WeChat · u)');
    await click(container);
    expect(imSessions.updateBinding).toHaveBeenCalledWith('b-other', {
      target: { kind: 'session', session_id: 'sess' },
    });
    expect(container.textContent).not.toMatch(/reply|Receive/i);
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
    expect(single.querySelector('[data-im-rail-identity="d-wx"]')?.textContent).toBe('WeChat · Product Crew · Lin');
    expect(single.querySelector('[data-im-rail-action="bind"]')?.textContent).toContain('Bind here (WeChat · Product Crew · Lin)');

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
    expect(multi.querySelector('[data-im-rail-identity="d-wx"]')?.textContent).toBe('WeChat · Product Crew · Lin');
    expect(multi.querySelector('[data-im-rail-identity="d-tg"]')?.textContent).toBe('Telegram · Ada');

    await act(async () => {
      multi.querySelector<HTMLButtonElement>('[data-im-rail-confirm="d-tg"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(imSessions.confirm).toHaveBeenCalledTimes(1);
    expect(imSessions.confirm).toHaveBeenCalledWith('d-tg', {
      target: { kind: 'session', session_id: 'sess' },
    });
  });

  it('lists each stopped account explicitly instead of silently starting the first account when multiple accounts exist', async () => {
    const multiStoppedSnap: ImSessionSnapshot = {
      policy: { allowed: true, default_enabled: true },
      instances: [
        { id: 'wx-1', provider_kind: 'wechat_bridge', listening: false, configured: true, account_id: 'wxid_1', adapter: 'stopped' },
        { id: 'tg-1', provider_kind: 'telegram', listening: false, configured: true, account_id: 'bot_7', adapter: 'stopped' },
      ],
      discoveries: [],
      bindings: [],
      strangers: [],
      voice_fallbacks: 0,
    };
    imSessions.snapshot.mockResolvedValueOnce(multiStoppedSnap);
    const container = await render();
    expect(container.querySelector('[data-im-rail-action="listen"]')).toBeNull();
    expect(container.querySelector('[data-im-rail-multi="instances"]')).not.toBeNull();
    expect(container.querySelector('[data-im-rail-identity="wx-1"]')?.textContent).toBe('WeChat (wxid_1)');
    expect(container.querySelector('[data-im-rail-identity="tg-1"]')?.textContent).toBe('Telegram (bot_7)');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-im-rail-listen="tg-1"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(imSessions.check).toHaveBeenCalledWith('tg-1');
    expect(imSessions.listen).toHaveBeenCalledWith('tg-1', true);
  });

  it('surfaces reconnecting state in the rail while keeping the bound session switch operable', async () => {
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
