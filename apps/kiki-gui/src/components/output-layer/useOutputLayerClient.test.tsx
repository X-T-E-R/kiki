// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOutputLayerClient, getActiveOutputLayerClient, setActiveOutputLayerClient } from './useOutputLayerClient';
import { outputLayerStore, useOutputLayer } from './outputLayerStore';

let mockConnectionValue: any = null;

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => mockConnectionValue,
}));

describe('useOutputLayerClient', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    setActiveOutputLayerClient(null);
    outputLayerStore.setConfiguration(null);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    mockConnectionValue = null;
    setActiveOutputLayerClient(null);
  });

  it('actively refetches queryFn when plugin queries are invalidated without setQueryData', async () => {
    let callCount = 0;
    let serverEnabled = false;

    const mockOutputLayerFacade = {
      configuration: vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          enabled: serverEnabled,
          presets: serverEnabled
            ? [{ id: 'hot-preset', label: '热启用预设', instruction: '测试', contextWindow: 32768, maxOutputTokens: 2048 }]
            : [],
          settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
        };
      }),
      configure: vi.fn(),
    };

    mockConnectionValue = {
      spaceKey: 'workspace-a',
      scopeId: 'scope-a',
      meta: { server_id: 'srv-1' },
      client: {
        rest: {
          outputLayer: mockOutputLayerFacade,
        },
      },
    };

    const sessionId = 'session-123';
    const contextKey = 'workspace-a:srv-1:session-123';

    function Consumer() {
      useOutputLayerClient(sessionId);
      return <div data-testid="consumer">ready</div>;
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Consumer />
        </QueryClientProvider>,
      );
    });

    expect(callCount).toBe(1);
    expect(outputLayerStore.getConfiguration(contextKey)?.enabled).toBe(false);

    // Simulate server side hot-enabling of plugin
    serverEnabled = true;

    // Trigger standard TanStack invalidateQueries for ['plugin'] (as done by pluginFreshness)
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin'] });
    });

    // Active QueryObserver immediately refetches queryFn
    expect(callCount).toBe(2);
    const updatedConfig = outputLayerStore.getConfiguration(contextKey);
    expect(updatedConfig?.enabled).toBe(true);
    expect(updatedConfig?.presets[0]?.label).toBe('热启用预设');
  });

  it('returns null and clears singleton when connection has no outputLayer facade', async () => {
    mockConnectionValue = {
      spaceKey: 'workspace-b',
      client: {}, // No outputLayer facade
    };

    function Consumer() {
      const client = useOutputLayerClient('session-empty');
      return <div data-testid="client-status">{client ? 'connected' : 'disconnected'}</div>;
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Consumer />
        </QueryClientProvider>,
      );
    });

    expect(document.querySelector('[data-testid="client-status"]')?.textContent).toBe('disconnected');
    expect(getActiveOutputLayerClient()).toBeNull();
  });

  it('keeps configuration and active selection isolated across home/server/session contexts', async () => {
    const config = { enabled: true, presets: [{ id: 'shared', label: 'Saved', instruction: 'Rewrite', contextWindow: 32768, modelId: 'explicit' }], settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 } };
    outputLayerStore.setConfiguration(config);
    const facade = { configuration: vi.fn().mockResolvedValue(config), configure: vi.fn(), stream: vi.fn() };
    mockConnectionValue = { spaceKey: 'home-a', meta: { server_id: 'server-a' }, client: { rest: { outputLayer: facade } } };
    let current!: ReturnType<typeof useOutputLayer>;
    function Consumer({ sessionId }: { sessionId: string }) {
      useOutputLayerClient(sessionId);
      current = useOutputLayer(sessionId);
      return <div>{String(current.isProcessingEnabled)}</div>;
    }
    const paint = async (sessionId = 'same-session') => {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><Consumer sessionId={sessionId} /></QueryClientProvider>));
    };
    await paint();
    await act(async () => current.setActivePreset('shared'));
    expect(current.isProcessingEnabled).toBe(true);
    let resolve!: (value: typeof config) => void;
    facade.configuration.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    mockConnectionValue = { ...mockConnectionValue, meta: { server_id: 'server-b' } };
    await paint();
    expect(current.configuration).toBeNull();
    expect(current.activePresetId).toBeNull();
    expect(current.isProcessingEnabled).toBe(false);
    await act(async () => resolve(config));
    expect(current.isPluginEnabled).toBe(true);
    expect(current.isProcessingEnabled).toBe(false);
    await act(async () => current.setActivePreset('shared'));
    mockConnectionValue = { ...mockConnectionValue, spaceKey: 'home-b' };
    await paint(); expect(current.activePresetId).toBeNull();
    await paint('another-session'); expect(current.activePresetId).toBeNull();
    mockConnectionValue = { ...mockConnectionValue, spaceKey: 'home-a', meta: { server_id: 'server-a' } };
    await paint(); expect(current.isProcessingEnabled).toBe(true);
  });
});
