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
  updateBinding: vi.fn(async (_id: string, _patch: { session_enabled: boolean }) => snap(true)),
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
  imSessions.snapshot.mockResolvedValue(snap(false));
  imSessions.updateBinding.mockResolvedValue(snap(true));
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
});
