// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageMigrationView } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { StorageMigrationViewComponent } from './StorageMigrationView';

const connectionHarness = vi.hoisted(() => ({
  connection: null as unknown,
}));

vi.mock('../../state/connection', () => ({
  useConnection: () => connectionHarness.connection,
}));

describe('StorageMigrationViewComponent', () => {
  let root: Root;
  let container: HTMLDivElement;

  const mockBaseView: StorageMigrationView = {
    schemaVersion: 1,
    mode: 'maintenance',
    status: {
      schemaVersion: 1,
      homeDir: '/test/home',
      authority: 'legacy',
      phase: 'detecting',
      state: 'ready',
      sources: [
        { name: 'thread-mailbox-v3', exists: true, bytes: 4096 },
        { name: 'agent-collaboration-mailbox-v2', exists: false },
      ],
      progress: { items: 0, bytes: 0 },
      canCancel: false,
      canRollback: false,
      minimumReaderVersion: '0.5.0',
      legacyImportRemovedVersion: '0.6.0',
    },
    actions: ['migrate'],
    transition: { state: 'idle' },
  };

  let getStorageMigrationMock = vi.fn(async () => mockBaseView);
  let postStorageMigrationActionMock = vi.fn(async (_action: string) => mockBaseView);
  let metaMock = vi.fn(async () => ({ server_id: 'srv-1', server_home_id: 'home-1', storage_mode: 'maintenance' as 'maintenance' | 'normal' }));

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    localStorage.setItem('kiki.locale', 'en');

    getStorageMigrationMock = vi.fn(async () => mockBaseView);
    postStorageMigrationActionMock = vi.fn(async (_action: string) => mockBaseView);
    metaMock = vi.fn(async () => ({ server_id: 'srv-1', server_home_id: 'home-1', storage_mode: 'maintenance' as 'maintenance' | 'normal' }));

    connectionHarness.connection = {
      scopeId: 'local',
      meta: { server_id: 'srv-1', server_home_id: 'home-1', storage_mode: 'maintenance' as const },
      client: {
        getStorageMigration: getStorageMigrationMock,
        postStorageMigrationAction: postStorageMigrationActionMock,
        meta: metaMock,
      },
    };

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    connectionHarness.connection = null;
    vi.unstubAllGlobals();
  });

  async function renderComponent(initialView?: StorageMigrationView, onComplete?: () => void) {
    await act(async () => {
      root.render(
        <I18nProvider>
          <StorageMigrationViewComponent initialView={initialView} onComplete={onComplete} />
        </I18nProvider>,
      );
    });
  }

  it('renders initial ready state and executes migrate action strictly driven by server actions', async () => {
    const runningView: StorageMigrationView = {
      ...mockBaseView,
      status: {
        ...mockBaseView.status,
        state: 'running',
        phase: 'importing',
        progress: { items: 10, totalItems: 100, bytes: 1024, totalBytes: 10240 },
        canCancel: true,
      },
      actions: ['cancel'],
    };
    postStorageMigrationActionMock.mockResolvedValueOnce(runningView);

    await renderComponent();

    expect(container.querySelector('h1')?.textContent).toContain('Mailbox storage upgrade');
    expect(container.querySelector('[data-testid="storage-authority-badge"]')?.textContent).toContain('Legacy JSON files');
    expect(container.querySelector('[data-testid="migration-state-tag"]')?.textContent).toContain('Ready to upgrade');
    expect(Array.from(container.querySelectorAll('[data-testid="migration-source-stage"]'), (node) => node.textContent))
      .toEqual(['Found · 4.0 KB', '—']);

    const migrateBtn = container.querySelector<HTMLButtonElement>('[data-action="migrate"]');
    expect(migrateBtn).not.toBeNull();
    expect(container.querySelector('[data-action="start"]')).toBeNull();

    await act(async () => {
      migrateBtn?.click();
    });

    expect(postStorageMigrationActionMock).toHaveBeenCalledWith('migrate');
    expect(container.querySelector('[data-action="cancel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="migration-progress"]')?.textContent).toContain('10 of 100 items');
  });

  it('distinguishes discovered, importing and verified sources without implying import from file presence', async () => {
    await renderComponent({
      ...mockBaseView,
      status: {
        ...mockBaseView.status,
        state: 'failed',
        phase: 'importing',
        sources: [
          { name: 'thread-mailbox-v3', exists: true, bytes: 4096 },
          { name: 'thread-mailbox-v1', exists: true, bytes: 1024, stage: 'verified' },
          { name: 'agent-collaboration-mailbox-v2', exists: true, bytes: 512, stage: 'importing' },
        ],
      },
    });
    expect(Array.from(container.querySelectorAll('[data-testid="migration-source-stage"]'), (node) => node.textContent))
      .toEqual(['Found · 4.0 KB', 'Verified · 1.0 KB', 'Importing · 512 B']);
    expect(container.textContent).not.toContain('✓');
  });

  it('renders status.failure details when migration fails during execution', async () => {
    const failedStatusView: StorageMigrationView = {
      ...mockBaseView,
      status: {
        ...mockBaseView.status,
        state: 'failed',
        phase: 'importing',
        failure: {
          code: 'mailbox.corrupt_record',
          message: 'Malformed JSON payload encountered at byte offset 1024',
          source: 'thread-mailbox-v3',
          key: 'thread_record_99',
        },
        canRollback: true,
      },
      actions: ['migrate', 'rollback'],
      transition: { state: 'idle' },
    };

    await renderComponent(failedStatusView);

    const banner = container.querySelector('[data-testid="migration-failure-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('mailbox.corrupt_record');
    expect(banner?.textContent).toContain('Malformed JSON payload encountered at byte offset 1024');
    expect(banner?.textContent).toContain('thread-mailbox-v3');
    expect(banner?.textContent).toContain('thread_record_99');

    expect(container.querySelector('[data-action="migrate"]')).not.toBeNull();
    expect(container.querySelector('[data-action="rollback"]')).not.toBeNull();
  });

  it('shows a damaged historical checkpoint as a warning without blocking normal startup', async () => {
    const warningView: StorageMigrationView = {
      ...mockBaseView,
      status: {
        ...mockBaseView.status,
        authority: 'sqlite',
        state: 'complete',
        phase: 'complete',
        canRollback: false,
        warning: { code: 'mailbox.checkpoint_warning', message: 'Unlocalized historical checkpoint diagnostic' },
      },
      actions: ['start'],
    };

    await renderComponent(warningView);

    expect(container.querySelector('[data-testid="migration-state-tag"]')?.textContent).toBe('Data migrated');
    expect(container.querySelector('[data-testid="migration-warning"]')?.textContent).toContain('Mailbox data is available');
    expect(container.querySelector('[data-testid="migration-failure-banner"]')).toBeNull();
    expect(container.querySelector('[data-action="start"]')).not.toBeNull();
    expect(container.querySelector('[data-action="migrate"]')).toBeNull();
    expect(container.querySelector('[data-action="rollback"]')).toBeNull();
  });

  it('handles cleanup state correctly: waiting when cleanupPending=true and actions empty', async () => {
    const cleaningWaitingView: StorageMigrationView = {
      ...mockBaseView,
      status: { ...mockBaseView.status, state: 'complete', phase: 'complete', authority: 'sqlite' },
      actions: [],
      transition: {
        state: 'failed',
        failure: { code: 'mailbox.start_failed', message: 'Startup failed because database was locked' },
        cleanupPending: true,
      },
    };

    await renderComponent(cleaningWaitingView);

    expect(container.querySelector('[data-testid="migration-state-tag"]')?.textContent).toBe('Normal startup failed');
    expect(container.textContent).toContain('Migration finished');
    // Should render startup failure banner
    expect(container.querySelector('[data-testid="startup-failure-banner"]')?.textContent).toContain('Startup failed because database was locked');
    // Should render cleaning indicator
    expect(container.querySelector('[data-testid="cleanup-pending-waiting"]')?.textContent).toContain('Cleaning up temporary resources…');
    // Actions are empty -> no action buttons
    expect(container.querySelector('[data-action="migrate"]')).toBeNull();
    expect(container.querySelector('[data-action="start"]')).toBeNull();
    expect(container.querySelector('[data-action="retry_cleanup"]')).toBeNull();
  });

  it('handles cleanup failure correctly: shows original failure + cleanup failure and exposes retry_cleanup action', async () => {
    const cleanupFailedView: StorageMigrationView = {
      ...mockBaseView,
      status: { ...mockBaseView.status, state: 'complete', phase: 'complete', authority: 'sqlite' },
      actions: ['retry_cleanup'],
      transition: {
        state: 'failed',
        failure: { code: 'mailbox.start_failed', message: 'Original startup error: missing key' },
        cleanupPending: true,
        cleanupFailure: { code: 'mailbox.cleanup_failed', message: 'Cleanup error: file locked by background process' },
      },
    };

    await renderComponent(cleanupFailedView);

    expect(container.querySelector('[data-testid="migration-state-tag"]')?.textContent).toBe('Cleanup failed');
    // Both failure banners must be displayed
    expect(container.querySelector('[data-testid="startup-failure-banner"]')?.textContent).toContain('Original startup error: missing key');
    expect(container.querySelector('[data-testid="cleanup-failure-banner"]')?.textContent).toContain('Cleanup error: file locked by background process');

    // retry_cleanup button is present
    const retryCleanupBtn = container.querySelector<HTMLButtonElement>('[data-action="retry_cleanup"]');
    expect(retryCleanupBtn).not.toBeNull();
    expect(retryCleanupBtn?.textContent).toContain('Retry cleanup');

    // Clicking retry_cleanup posts the action to server
    const settledView: StorageMigrationView = {
      ...mockBaseView,
      status: {
        ...mockBaseView.status,
        authority: 'sqlite',
        state: 'complete',
        phase: 'complete',
        canRollback: true,
      },
      actions: ['start', 'rollback'],
      transition: {
        state: 'idle',
        cleanupPending: false,
      },
    };
    postStorageMigrationActionMock.mockResolvedValueOnce(settledView);

    await act(async () => {
      retryCleanupBtn?.click();
    });

    expect(postStorageMigrationActionMock).toHaveBeenCalledWith('retry_cleanup');
    expect(container.querySelector('[data-testid="migration-state-tag"]')?.textContent).toBe('Data migrated');
    expect(container.querySelector('[data-action="start"]')).not.toBeNull();
    expect(container.querySelector('[data-action="rollback"]')).not.toBeNull();
  });

  it('handles start action and triggers onComplete when server transitions to normal mode', async () => {
    vi.useFakeTimers();
    try {
      const completeView: StorageMigrationView = {
        ...mockBaseView,
        status: {
          ...mockBaseView.status,
          authority: 'sqlite',
          state: 'complete',
          phase: 'complete',
        },
        actions: ['start'],
        transition: { state: 'idle' },
      };

      const startingView: StorageMigrationView = {
        ...completeView,
        actions: ['cancel'],
        transition: { state: 'starting' },
      };

      postStorageMigrationActionMock.mockResolvedValueOnce(startingView);
      getStorageMigrationMock.mockResolvedValue(startingView);
      const onCompleteSpy = vi.fn();

      await renderComponent(completeView, onCompleteSpy);

      const startBtn = container.querySelector<HTMLButtonElement>('[data-action="start"]');
      expect(startBtn).not.toBeNull();

      await act(async () => {
        startBtn?.click();
      });

      expect(postStorageMigrationActionMock).toHaveBeenCalledWith('start');
      expect(container.querySelector('[data-testid="transition-starting"]')).not.toBeNull();

      // meta returns normal mode on poll
      metaMock.mockResolvedValueOnce({
        server_id: 'srv-1',
        server_home_id: 'home-1',
        storage_mode: 'normal',
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });

      expect(onCompleteSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a meta response that settles after unmount', async () => {
    vi.useFakeTimers();
    try {
      const startingView: StorageMigrationView = {
        ...mockBaseView, actions: ['cancel'], transition: { state: 'starting' },
      };
      getStorageMigrationMock.mockResolvedValue(startingView);
      let resolveMeta!: (value: Awaited<ReturnType<typeof metaMock>>) => void;
      metaMock.mockImplementationOnce(() => new Promise((resolve) => { resolveMeta = resolve; }));
      const onComplete = vi.fn();
      await renderComponent(startingView, onComplete);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(metaMock).toHaveBeenCalledOnce();
      await act(async () => { root.unmount(); });
      await act(async () => {
        resolveMeta({ server_id: 'srv-1', server_home_id: 'home-1', storage_mode: 'normal' });
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(onComplete).not.toHaveBeenCalled();
      expect(getStorageMigrationMock).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('rejects identity mismatch when server_id changes upon restart', async () => {
    vi.useFakeTimers();
    try {
      const startingView: StorageMigrationView = {
        ...mockBaseView,
        status: {
          ...mockBaseView.status,
          authority: 'sqlite',
          state: 'complete',
          phase: 'complete',
        },
        actions: ['cancel'],
        transition: { state: 'starting' },
      };

      const onCompleteSpy = vi.fn();
      getStorageMigrationMock.mockResolvedValue(startingView);
      await renderComponent(startingView, onCompleteSpy);

      // meta returns normal mode with changed server_id
      metaMock.mockResolvedValueOnce({
        server_id: 'different-server',
        server_home_id: 'home-1',
        storage_mode: 'normal',
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });

      expect(onCompleteSpy).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="network-error-banner"]')?.textContent).toContain(
        'The server changed during startup',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovers normal mode after another client starts Kiki without a local start click', async () => {
    vi.useFakeTimers();
    try {
      const onComplete = vi.fn();
      getStorageMigrationMock.mockResolvedValue({ ...mockBaseView, mode: 'normal', actions: [] });
      metaMock.mockResolvedValue({ server_id: 'srv-1', server_home_id: 'home-1', storage_mode: 'normal' });
      await renderComponent(mockBaseView, onComplete);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(onComplete).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(onComplete).toHaveBeenCalledOnce();
      expect(postStorageMigrationActionMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('discards old connection action results while the new connection still has a pending action', async () => {
    let settleOld!: (value: StorageMigrationView) => void;
    let settleNew!: (value: StorageMigrationView) => void;
    postStorageMigrationActionMock.mockImplementationOnce(() => new Promise((resolve) => { settleOld = resolve; }));
    await renderComponent();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-action="migrate"]')!.click(); });
    const nextAction = vi.fn(() => new Promise<StorageMigrationView>((resolve) => { settleNew = resolve; }));
    connectionHarness.connection = {
      scopeId: 'remote:second',
      meta: { server_id: 'srv-2', server_home_id: 'home-2', storage_mode: 'maintenance' },
      client: { getStorageMigration: vi.fn(async () => mockBaseView), postStorageMigrationAction: nextAction, meta: metaMock },
    };
    await renderComponent();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-action="migrate"]')!.click(); });
    await act(async () => {
      settleOld({ ...mockBaseView, actions: ['start'], transition: { state: 'starting' } });
    });
    expect(container.querySelector('[data-action="start"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-action="migrate"]')!.disabled).toBe(true);
    await act(async () => { settleNew({ ...mockBaseView, actions: ['cancel'] }); });
    expect(container.querySelector('[data-action="cancel"]')).not.toBeNull();
  });

  it('coalesces manual status reads and ignores a read started before an action', async () => {
    let settleRead!: (value: StorageMigrationView) => void;
    getStorageMigrationMock.mockImplementationOnce(() => new Promise((resolve) => { settleRead = resolve; }));
    await renderComponent(mockBaseView);
    await act(async () => {
      const refresh = container.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
      refresh.click(); refresh.click();
    });
    expect(getStorageMigrationMock).toHaveBeenCalledOnce();
    postStorageMigrationActionMock.mockResolvedValueOnce({ ...mockBaseView, actions: ['cancel'] });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-action="migrate"]')!.click(); });
    await act(async () => { settleRead(mockBaseView); });
    expect(container.querySelector('[data-action="cancel"]')).not.toBeNull();
    expect(container.querySelector('[data-action="migrate"]')).toBeNull();
  });
});
