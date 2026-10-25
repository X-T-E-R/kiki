// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OutputLayerSelect } from './OutputLayerSelect';
import { outputLayerStore } from './outputLayerStore';
import { I18nProvider } from '../../i18n';

// Mock connection
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listModels: vi.fn().mockResolvedValue({ items: [] }),
      listProviders: vi.fn().mockResolvedValue([]),
    },
  }),
  useOptionalConnection: () => ({
    client: {
      listModels: vi.fn().mockResolvedValue({ items: [] }),
      listProviders: vi.fn().mockResolvedValue([]),
    },
  }),
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  localStorage.clear();
  outputLayerStore.setConfiguration({
    enabled: true,
    presets: [
      { id: 'translate', label: '流式翻译', instruction: '将原文翻译为简体中文', contextWindow: 32768, maxOutputTokens: 2048 },
      { id: 'plain', label: '说人话', instruction: '通俗改写', contextWindow: 32768, maxOutputTokens: 2048 },
    ],
    settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
});

function renderComponent(sessionId = 'test-session') {
  outputLayerStore.setConfiguration(outputLayerStore.getConfiguration(), `local::${sessionId}`);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <OutputLayerSelect sessionId={sessionId} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return container.querySelector('[data-output-layer-select]');
}

describe('OutputLayerSelect', () => {
  it('renders trigger button in Composer status line', () => {
    renderComponent();
    const button = container.querySelector('button[aria-haspopup="listbox"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('输出层');
  });

  it('opens popover panel when trigger is clicked and allows selecting preset', () => {
    renderComponent('session-1');
    const button = container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    act(() => {
      button.click();
    });

    const panel = container.querySelector('[data-output-layer-panel]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('输出预设');
    expect(panel?.textContent).toContain('流式翻译');
    expect(panel?.textContent).toContain('说人话');
    const instructionPreview = panel?.querySelector('.line-clamp-2');
    expect(instructionPreview).not.toBeNull();
    expect(instructionPreview?.classList.contains('block')).toBe(false);

    // Click translate preset
    const options = container.querySelectorAll('[role="option"]');
    const translateOption = Array.from(options).find((el) => el.textContent?.includes('流式翻译')) as HTMLButtonElement;
    expect(translateOption).toBeDefined();

    act(() => {
      translateOption.click();
    });

    // Verify state updated
    expect(outputLayerStore.getSessionState('local::session-1').activePresetId).toBe('translate');
  });

  it('shows view mode switch when a preset is active', () => {
    outputLayerStore.setActivePreset('local::session-2', 'translate');
    renderComponent('session-2');

    const button = container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
    act(() => {
      button.click();
    });

    const panel = container.querySelector('[data-output-layer-panel]');
    expect(panel?.textContent).toContain('显示版本');
    expect(panel?.textContent).toContain('处理版');
    expect(panel?.textContent).toContain('原文');
  });
});
