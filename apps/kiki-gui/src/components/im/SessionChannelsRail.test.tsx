// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImSessionSnapshot, OptionalCapabilitySessionResponse } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { SessionChannelsRail } from './SessionChannelsRail';

function createSnapshot(bindings: any[] = [], discoveries: any[] = [], allowed = true, allowBorrowing = false): ImSessionSnapshot {
  return {
    policy: { allowed, default_enabled: true, ...(allowBorrowing ? { allow_channel_borrowing: true } : {}) } as any,
    instances: [
      { id: 'tg-inst', provider_kind: 'telegram', listening: true, configured: true, adapter: 'running' },
      { id: 'wx-inst', provider_kind: 'wechat_bridge', listening: true, configured: true, adapter: 'running' },
    ],
    discoveries,
    strangers: [],
    voice_fallbacks: 0,
    bindings,
  };
}

const mockImSessions = {
  snapshot: vi.fn(),
  updateBinding: vi.fn(),
  removeBinding: vi.fn(),
  confirm: vi.fn(),
};

const mockClient = {
  scopeId: 'fixture',
  imSessions: mockImSessions,
  getSessionOptionalCapabilities: vi.fn(),
  setSessionOptionalCapability: vi.fn(),
  getConfig: vi.fn(),
  notifications: {
    getSettings: vi.fn(async () => ({ channels: [{ id: 'feishu-duty', name: '飞书值班群 Webhook', enabled: true }] })),
  },
};

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => ({ scopeId: 'fixture', client: mockClient }),
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
let queryClient: QueryClient;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  vi.clearAllMocks();
});

async function renderRail(props: { sessionId: string; sessionTitle?: string; personaId?: string; personaName?: string; onOpenSettings?: () => void }) {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <SessionChannelsRail {...props} />
        </I18nProvider>
      </QueryClientProvider>
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

describe('SessionChannelsRail', () => {
  it('renders channels section with counts and hot-loads SendMessage tool in pure thread', async () => {
    const bindings = [
      {
        id: 'b-tg-41',
        provider_instance_id: 'tg-inst',
        provider_kind: 'telegram' as const,
        account_id: 'bot-1',
        identity: { chat_id: '-1001', topic_id: '41', sender_id: 'u-1', chat_title: 'Release room #41', sender_name: 'Ada' },
        session_id: 'sess-1',
        enabled: true,
        session_enabled: true,
        input_enabled: true,
        output_enabled: true,
        busy: 'queue' as const,
        reply: 'final' as const,
        mobile_interactions: true,
      },
    ];
    mockImSessions.snapshot.mockResolvedValue(createSnapshot(bindings));
    mockClient.getSessionOptionalCapabilities.mockResolvedValue({
      sessionId: 'sess-1',
      revision: 1,
      rows: [{ id: 'send_message', choice: 'inherit', allowed: true, host_locked: false, default_on: false, unresolved: false, effective: false, reason: 'default_off', source: 'default', applies: 'next-step' }],
    } as OptionalCapabilitySessionResponse);
    mockClient.getConfig.mockResolvedValue({
      optional_capabilities: { send_message: { allowed: true, default_on: false } },
    });

    const container = await renderRail({ sessionId: 'sess-1', sessionTitle: '0.4.4 发布' });

    // Header count
    const countEl = container.querySelector('[data-rail-channels-count]');
    expect(countEl?.textContent).toBe('2'); // 1 IM + 1 notify

    // Summary
    const summaryEl = container.querySelector('[data-rail-channels-summary]');
    expect(summaryEl?.textContent).toContain('1'); // 1 in
    expect(summaryEl?.textContent).toContain('3'); // 3 out (internal + 1 IM + 1 notify)

    // SendMessage tool is initially off for pure thread
    const smSwitch = container.querySelector('[data-rail-sm-switch]') as HTMLButtonElement;
    expect(smSwitch.getAttribute('aria-checked')).toBe('false');

    // Click to toggle on
    mockClient.setSessionOptionalCapability.mockResolvedValue({
      sessionId: 'sess-1',
      revision: 2,
      rows: [{ id: 'send_message', choice: 'on', allowed: true, host_locked: false, default_on: false, unresolved: false, effective: true, reason: 'admitted', source: 'session', applies: 'next-step' }],
    });

    await act(async () => {
      smSwitch.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockClient.setSessionOptionalCapability).toHaveBeenCalledWith('sess-1', { id: 'send_message', choice: 'on' });
  });

  it('independently toggles Input and Output pills on IM binding', async () => {
    const bindings = [
      {
        id: 'b-tg-41',
        provider_instance_id: 'tg-inst',
        provider_kind: 'telegram' as const,
        account_id: 'bot-1',
        identity: { chat_id: '-1001', topic_id: '41', sender_id: 'u-1', chat_title: 'Release room #41', sender_name: 'Ada' },
        session_id: 'sess-1',
        enabled: true,
        session_enabled: true,
        input_enabled: true,
        output_enabled: true,
        busy: 'queue' as const,
        reply: 'final' as const,
        mobile_interactions: true,
      },
    ];
    mockImSessions.snapshot.mockResolvedValue(createSnapshot(bindings));
    mockImSessions.updateBinding.mockResolvedValue(createSnapshot(bindings));
    mockClient.getSessionOptionalCapabilities.mockResolvedValue({ sessionId: 'sess-1', revision: 1, rows: [] });
    mockClient.getConfig.mockResolvedValue({});

    const container = await renderRail({ sessionId: 'sess-1' });

    const inPill = container.querySelector('[data-io-pill-in="b-tg-41"]') as HTMLButtonElement;
    const outPill = container.querySelector('[data-io-pill-out="b-tg-41"]') as HTMLButtonElement;

    expect(inPill.getAttribute('aria-pressed')).toBe('true');
    expect(outPill.getAttribute('aria-pressed')).toBe('true');

    // Toggle Input off
    await act(async () => {
      inPill.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockImSessions.updateBinding).toHaveBeenCalledWith('b-tg-41', expect.objectContaining({ input_enabled: false }));

    // Toggle Output off
    await act(async () => {
      outPill.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockImSessions.updateBinding).toHaveBeenCalledWith('b-tg-41', expect.objectContaining({ output_enabled: false }));
  });

  it('opens rebind modal for occupied candidate and cancels without side effects', async () => {
    const bindings = [
      {
        id: 'b-tg-other',
        provider_instance_id: 'tg-inst',
        provider_kind: 'telegram' as const,
        account_id: 'bot-1',
        identity: { chat_id: '-1001', topic_id: '42', sender_id: 'u-1', chat_title: 'Release room #42', sender_name: 'Ada' },
        session_id: 'sess-other',
        enabled: true,
        busy: 'queue' as const,
        reply: 'final' as const,
        mobile_interactions: true,
      },
    ];
    mockImSessions.snapshot.mockResolvedValue(createSnapshot(bindings));
    mockClient.getSessionOptionalCapabilities.mockResolvedValue({ sessionId: 'sess-1', revision: 1, rows: [] });
    mockClient.getConfig.mockResolvedValue({});

    const container = await renderRail({ sessionId: 'sess-1', sessionTitle: '0.4.4 发布' });

    // Open candidate picker
    const addBtn = container.querySelector('[data-rail-channel-add]') as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const picker = container.querySelector('[data-rail-channel-picker]');
    expect(picker).not.toBeNull();

    // Find occupied candidate rebind button
    const rebindBtn = picker!.querySelector('button:not([type="button"][class*="text-ink-faint"])') as HTMLButtonElement;
    expect(rebindBtn.textContent).toMatch(/转绑到此会话|Rebind/);

    await act(async () => {
      rebindBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Check modal opened
    const dialog = document.body.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toMatch(/转移信道变体归属|Rebind channel identity/);

    // Click cancel
    const cancelBtn = Array.from(dialog!.querySelectorAll('button')).find((b) => b.textContent?.includes('取消') || b.textContent?.includes('Cancel'));
    expect(cancelBtn).toBeDefined();

    await act(async () => {
      cancelBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Dialog closed, no API called
    expect(document.body.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(mockImSessions.updateBinding).not.toHaveBeenCalled();
    expect(mockImSessions.confirm).not.toHaveBeenCalled();
  });

  it('confirms rebind with rebind: true flag on confirmation', async () => {
    const bindings = [
      {
        id: 'b-tg-other',
        provider_instance_id: 'tg-inst',
        provider_kind: 'telegram' as const,
        account_id: 'bot-1',
        identity: { chat_id: '-1001', topic_id: '42', sender_id: 'u-1', chat_title: 'Release room #42', sender_name: 'Ada' },
        session_id: 'sess-other',
        enabled: true,
        busy: 'queue' as const,
        reply: 'final' as const,
        mobile_interactions: true,
      },
    ];
    mockImSessions.snapshot.mockResolvedValue(createSnapshot(bindings));
    mockImSessions.updateBinding.mockResolvedValue(createSnapshot([]));
    mockClient.getSessionOptionalCapabilities.mockResolvedValue({ sessionId: 'sess-1', revision: 1, rows: [] });
    mockClient.getConfig.mockResolvedValue({});

    const container = await renderRail({ sessionId: 'sess-1', sessionTitle: '0.4.4 发布' });

    // Open candidate picker
    const addBtn = container.querySelector('[data-rail-channel-add]') as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const picker = container.querySelector('[data-rail-channel-picker]');
    const rebindBtn = picker!.querySelector('button:not([type="button"][class*="text-ink-faint"])') as HTMLButtonElement;
    await act(async () => {
      rebindBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const dialog = document.body.querySelector('[role="alertdialog"], [role="dialog"]');
    const confirmBtn = Array.from(dialog!.querySelectorAll('button')).find((b) => b.textContent?.includes('确认转移并开启') || b.textContent?.includes('Confirm and transfer'));
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockImSessions.updateBinding).toHaveBeenCalledWith(
      'b-tg-other',
      expect.objectContaining({
        session_id: 'sess-1',
        rebind: true,
        input_enabled: true,
        output_enabled: true,
      })
    );
  });
});
