// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { I18nProvider } from '../i18n';
import { MemoryRouter } from 'react-router-dom';
import { usePaneResize } from '../lib/layoutHooks';
import { clampPreviewWidth } from './PreviewWorkspace';
import { Sidebar } from './Sidebar';

/**
 * Pane-resize interaction tests: the drag-feedback contract (data-dragging on
 * the handle + body[data-pane-resizing]), direction semantics, and the reset
 * behavior the three grab handles share.
 */

const mounts: { container: HTMLDivElement; root: Root }[] = [];

vi.mock('../state/connection', () => ({
  useOptionalControllerRegistry: () => null,
  useConnection: () => ({
    client: { searchMessages: () => Promise.resolve({ items: [], has_more: false }) },
    meta: {
      server_version: '1.0.0',
      server_id: 'srv_test',
      started_at: '2026-01-01T00:00:00.000Z',
      open_in_apps: [],
      dangerous_bypass_auth: false,
    },
    wsStatus: 'open',
    disconnect: () => {},
  }),
}));

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  // jsdom has no PointerEvent constructor and no pointer capture.
  if (typeof globalThis.PointerEvent === 'undefined') {
    vi.stubGlobal('PointerEvent', MouseEvent);
  }
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  const navigatorWithLanguage = Object.create(navigator);
  Object.defineProperty(navigatorWithLanguage, 'language', {
    value: 'en-US',
    configurable: true,
  });
  vi.stubGlobal('navigator', navigatorWithLanguage);
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { container, root } of mounts.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  delete document.body.dataset['paneResizing'];
});
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function mountPaneResizeHarness({
  direction,
  onReset,
}: { direction?: 1 | -1; onReset?: () => void } = {}) {
  const events: { value: number; final: boolean }[] = [];
  function Harness() {
    const { startResize, reset } = usePaneResize({
      value: 300,
      min: 220,
      max: 480,
      direction,
      onChange: (value, final) => { events.push({ value, final }); },
      onReset,
    });
    return (
      <div
        data-handle
        style={{ width: 100, height: 100 }}
        onPointerDown={startResize}
        onDoubleClick={reset}
      />
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  await act(async () => { root.render(<I18nProvider><Harness /></I18nProvider>); });
  return { container, events };
}

function dragSequence(handle: Element, moves: number[], upX: number) {
  act(() => {
    handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, bubbles: true }));
  });
  for (const clientX of moves) {
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { clientX, bubbles: true }));
    });
  }
  act(() => {
    handle.dispatchEvent(new PointerEvent('pointerup', { clientX: upX, bubbles: true }));
  });
}

describe('usePaneResize drag feedback', () => {
  it('sets data-dragging on the handle and body[data-pane-resizing] during the drag', async () => {
    const { container } = await mountPaneResizeHarness();
    const handle = container.querySelector('[data-handle]')!;

    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, bubbles: true }));
    });
    expect(handle.getAttribute('data-dragging')).toBe('true');
    expect(document.body.dataset['paneResizing']).toBe('true');

    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 20, bubbles: true }));
    });
    expect(handle.getAttribute('data-dragging')).toBe('false');
    expect(document.body.dataset['paneResizing']).toBeUndefined();
  });

  it('clears the body dragging flag on pointercancel too', async () => {
    const { container } = await mountPaneResizeHarness();
    const handle = container.querySelector('[data-handle]')!;

    act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, bubbles: true }));
    });
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
    });
    expect(document.body.dataset['paneResizing']).toBeUndefined();
  });
});

describe('usePaneResize direction semantics', () => {
  it('a right-drag widens a direction:1 pane', async () => {
    const { container, events } = await mountPaneResizeHarness();
    dragSequence(container.querySelector('[data-handle]')!, [20], 20);
    expect(events.at(-1)).toEqual({ value: 320, final: true });
  });

  it('a left-drag widens a direction:-1 pane (right-side panel)', async () => {
    const { container, events } = await mountPaneResizeHarness({ direction: -1 });
    dragSequence(container.querySelector('[data-handle]')!, [-20], -20);
    expect(events.at(-1)).toEqual({ value: 320, final: true });
  });

  it('clamps to min/max', async () => {
    const { container, events } = await mountPaneResizeHarness();
    dragSequence(container.querySelector('[data-handle]')!, [999], 999);
    expect(events.at(-1)).toEqual({ value: 480, final: true });
  });
});

describe('usePaneResize double-click reset', () => {
  it('invokes onReset on double-click', async () => {
    const onReset = vi.fn();
    const { container } = await mountPaneResizeHarness({ onReset });
    act(() => {
      container.querySelector('[data-handle]')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(onReset).toHaveBeenCalledOnce();
  });
});

describe('Sidebar resize wiring', () => {
  it('exposes a grab handle whose pointerdown engages the drag state', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ container, root });
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <I18nProvider>
              <Sidebar
            activeSessionId={undefined}
            sessions={[]}
            sessionGroups={[]}
            sessionsQuery={{
              isLoading: false,
              isError: false,
              error: null,
              hasNextPage: false,
              isFetchingNextPage: false,
              fetchNextPage: async () => {},
            }}
            workspaceOptions={[]}
            workspaceFilter={undefined}
            onWorkspaceFilter={() => {}}
            showArchived={false}
            onToggleArchived={() => {}}
            onNewSession={() => {}}
            groupBy="time"
            onGroupBy={() => {}}
            sortBy="updated-desc"
              onSortBy={() => {}}
            />
          </I18nProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    const handle = container.querySelector('[data-sidebar-resizer]');
    expect(handle).not.toBeNull();
    act(() => {
      handle!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, bubbles: true }));
    });
    expect(handle!.getAttribute('data-dragging')).toBe('true');
    expect(document.body.dataset['paneResizing']).toBe('true');
    act(() => {
      handle!.dispatchEvent(new PointerEvent('pointerup', { clientX: 0, bubbles: true }));
    });
    expect(document.body.dataset['paneResizing']).toBeUndefined();
  });
});

describe('clampPreviewWidth', () => {
  it('keeps the preview pane within min width and the 60% viewport cap', () => {
    expect(clampPreviewWidth(100, 1920)).toBe(320);
    expect(clampPreviewWidth(2000, 1920)).toBe(760);
    expect(clampPreviewWidth(600, 400)).toBe(320);
  });
});
