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
  channelViews: vi.fn(async () => ({
    internal_enabled: true,
    channels: [{ id: 'feishu-duty', kind: 'notify' as const, bound: true, enabled: true, capabilities: [] }],
  })),
  setNotificationChannel: vi.fn(),
  removeNotificationChannel: vi.fn(),
};

const mockClient = {
  scopeId: 'fixture',
  spaceKey: 'main',
  imSessions: mockImSessions,
  getSessionOptionalCapabilities: vi.fn(),
  setSessionOptionalCapability: vi.fn(),
  getConfig: vi.fn(),
  notifications: {
    getSettings: vi.fn(async () => ({ channels: [{ id: 'feishu-duty', name: '飞书值班群 Webhook', enabled: true }] })),
  },
};

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => ({ scopeId: 'fixture', spaceKey: 'main', client: mockClient }),
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
      host_id: 'host-1',
      sessionId: 'sess-1',
      revision: 1,
      rows: [{ id: 'send_message', choice: 'inherit', allowed: true, host_locked: false, default_on: false, unresolved: false, effective: false, reason: 'default_off', source: 'default', applies: 'next-step' }],
    } as unknown as OptionalCapabilitySessionResponse);
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
    const smSwitch = container.querySelector('[data-rail-sendmessage-switch]') as HTMLButtonElement;
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
    const rebindBtn = picker!.querySelector('[data-candidate-action="rebind"]') as HTMLButtonElement;
    expect(rebindBtn.textContent).toMatch(/转绑到此会话|Transfer here|Rebind/);

    await act(async () => {
      rebindBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Check modal opened
    const dialog = document.body.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toMatch(/转移信道变体归属|Transfer this channel|Rebind channel identity/);

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
    const rebindBtn = picker!.querySelector('[data-candidate-action="rebind"]') as HTMLButtonElement;
    await act(async () => {
      rebindBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const dialog = document.body.querySelector('[role="alertdialog"], [role="dialog"]');
    const confirmBtn = Array.from(dialog!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认转移并开启') || b.textContent?.includes('Confirm transfer') || b.textContent?.includes('Confirm and transfer')
    );
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

  it('strips notify: prefix when calling setNotificationChannel and removeNotificationChannel', async () => {
    mockImSessions.snapshot.mockResolvedValue(createSnapshot([]));
    mockImSessions.channelViews.mockResolvedValue({
      internal_enabled: true,
      channels: [
        { id: 'notify:mail', kind: 'notify' as const, bound: true, enabled: false, capabilities: [] },
        { id: 'notify:webhook-duty', kind: 'notify' as const, bound: false, enabled: false, capabilities: [] },
      ],
    });
    mockClient.getSessionOptionalCapabilities.mockResolvedValue({
      host_id: 'host-1',
      sessionId: 'sess-1',
      revision: 1,
      rows: [],
    } as unknown as OptionalCapabilitySessionResponse);
    mockClient.getConfig.mockResolvedValue({});

    const container = await renderRail({ sessionId: 'sess-1' });

    // 1. Toggle bound notify channel on -> calls setNotificationChannel with stripped 'mail'
    const notifyItem = container.querySelector('[data-rail-out-list]');
    const toggleBtn = notifyItem?.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      toggleBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockImSessions.setNotificationChannel).toHaveBeenCalledWith('sess-1', 'mail', true);

    // 2. Remove bound notify channel -> calls removeNotificationChannel with stripped 'mail'
    const removeBtn = notifyItem?.querySelectorAll('button')[1] as HTMLButtonElement;
    await act(async () => {
      removeBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockImSessions.removeNotificationChannel).toHaveBeenCalledWith('sess-1', 'mail');

    // 3. Bind unbound candidate -> calls setNotificationChannel with stripped 'webhook-duty'
    const addBtn = container.querySelector('[data-rail-channel-add]') as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const picker = container.querySelector('[data-rail-channel-picker]');
    const bindCandidateBtn = Array.from(picker!.querySelectorAll('button')).find((b) => b.getAttribute('data-candidate-action') === null && b.textContent?.includes('Bind') || b.textContent?.includes('绑定'));
    if (bindCandidateBtn) {
      await act(async () => {
        bindCandidateBtn.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mockImSessions.setNotificationChannel).toHaveBeenCalledWith('sess-1', 'webhook-duty', true);
    }
  });

  it('respects authoritative row.effective=false even when persona is present (no guessing)', async () => {
    mockImSessions.snapshot.mockResolvedValue(createSnapshot([]));
    mockImSessions.channelViews.mockResolvedValue({ internal_enabled: true, channels: [] });
    // Persona exists, row has allowed=true, but reason='tool_policy' and effective=false
    mockClient.getSessionOptionalCapabilities.mockResolvedValue({
      host_id: 'host-1',
      sessionId: 'sess-1',
      revision: 1,
      rows: [{ id: 'send_message', choice: 'inherit', allowed: true, host_locked: false, default_on: false, unresolved: false, effective: false, reason: 'tool_policy', source: 'off', applies: 'next-step' }],
    } as unknown as OptionalCapabilitySessionResponse);
    mockClient.getConfig.mockResolvedValue({});

    const container = await renderRail({ sessionId: 'sess-1', personaId: 'ada', personaName: 'Ada' });

    const smSwitch = container.querySelector('[data-rail-sendmessage-switch]') as HTMLButtonElement;
    expect(smSwitch.getAttribute('aria-checked')).toBe('false');
    expect(smSwitch.disabled).toBe(true);

    const subText = container.querySelector('[data-rail-sm-sub]');
    expect(subText?.textContent).not.toMatch(/已开启|Enabled/);
    expect(subText?.textContent).toMatch(/策略不允许|does not allow/);
  });

  it('shows unavailable status when query rejects or row is missing without reporting strategy forbidden', async () => {
    mockImSessions.snapshot.mockResolvedValue(createSnapshot([]));
    mockImSessions.channelViews.mockResolvedValue({ internal_enabled: true, channels: [] });
    // Query rejects
    mockClient.getSessionOptionalCapabilities.mockRejectedValue(new Error('service_down'));
    mockClient.getConfig.mockResolvedValue({});

    const container = await renderRail({ sessionId: 'sess-1' });

    const smSwitch = container.querySelector('[data-rail-sendmessage-switch]') as HTMLButtonElement;
    expect(smSwitch.getAttribute('aria-checked')).toBe('false');
    expect(smSwitch.disabled).toBe(true);

    const subText = container.querySelector('[data-rail-sm-sub]');
    // Must show unavailable (unresolved), NOT hard off / strategy forbidden
    expect(subText?.textContent).toMatch(/状态暂不可用|unavailable/i);
    expect(subText?.textContent).not.toMatch(/策略不允许|does not allow/);
  });

  it('requires explicit confirmation modal before updating pending_reanchor binding and preserves zero-mutation on cancel', async () => {
    const bindings = [
      {
        id: 'b-orphan-pending',
        provider_instance_id: 'tg-inst',
        provider_kind: 'telegram' as const,
        account_id: 'bot-1',
        identity: { chat_id: '-1001', topic_id: '99', sender_id: 'u-1', chat_title: 'Orphan Chat', sender_name: 'Bob' },
        enabled: true,
        session_id: 'sess-prev-other',
        pending_reanchor: true,
      },
    ];
    mockImSessions.snapshot.mockResolvedValue(createSnapshot(bindings));
    mockImSessions.channelViews.mockResolvedValue({ internal_enabled: true, channels: [] });
    mockClient.getSessionOptionalCapabilities.mockResolvedValue({
      host_id: 'host-1',
      sessionId: 'sess-1',
      revision: 1,
      rows: [],
    } as unknown as OptionalCapabilitySessionResponse);
    mockClient.getConfig.mockResolvedValue({});

    const container = await renderRail({ sessionId: 'sess-1' });

    // Open candidate picker
    const addBtn = container.querySelector('[data-rail-channel-add]') as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const picker = container.querySelector('[data-rail-channel-picker]');
    expect(picker?.textContent).toContain('Orphan Chat');

    // Click candidate -> modal must open without calling updateBinding or confirm
    const actionBtn = picker!.querySelector('[data-candidate-action="bind"]') as HTMLButtonElement;
    await act(async () => {
      actionBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockImSessions.updateBinding).not.toHaveBeenCalled();
    expect(mockImSessions.confirm).not.toHaveBeenCalled();

    // Check modal contents
    const dialog = document.body.querySelector('[role="alertdialog"], [role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('sess-prev-other');

    // 1. Cancel modal -> zero mutation
    const cancelBtn = Array.from(dialog.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('取消') || b.textContent?.includes('Cancel')
    );
    expect(cancelBtn).toBeDefined();
    await act(async () => {
      cancelBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockImSessions.updateBinding).not.toHaveBeenCalled();
    expect(mockImSessions.confirm).not.toHaveBeenCalled();

    // 2. Open modal again and confirm -> exactly one updateBinding call with rebind: true
    await act(async () => {
      actionBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialogAgain = document.body.querySelector('[role="alertdialog"], [role="dialog"]')!;
    const confirmBtn = Array.from(dialogAgain.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认转移并开启') || b.textContent?.includes('Confirm transfer') || b.textContent?.includes('Confirm and transfer')
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Must call updateBinding with target session sess-1 and rebind: true (NOT confirm)
    expect(mockImSessions.updateBinding).toHaveBeenCalledTimes(1);
    expect(mockImSessions.updateBinding).toHaveBeenCalledWith('b-orphan-pending', expect.objectContaining({
      session_id: 'sess-1',
      rebind: true,
      input_enabled: true,
      output_enabled: true,
    }));
    expect(mockImSessions.confirm).not.toHaveBeenCalled();
  });
});
