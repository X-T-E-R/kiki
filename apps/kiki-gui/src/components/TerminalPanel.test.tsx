// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeSettings } from '@kiki/session-core/settings';

import { HostProvider, browserHost } from '../host';
import { I18nProvider } from '../i18n';
import type { TerminalManager, TerminalManagerState, TerminalTab } from '../state/terminalManager';
import { TerminalPanel } from './TerminalPanel';

const xtermState = vi.hoisted(() => ({
  instances: [] as {
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    open: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
  }[],
  fits: [] as { fit: ReturnType<typeof vi.fn> }[],
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockXTerm {
    options: Record<string, unknown>;
    cols = 100;
    rows = 28;
    open = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    attachCustomKeyEventHandler = vi.fn();
    write = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => '');
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      xtermState.instances.push(this);
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn();
    constructor() {
      xtermState.fits.push(this);
    }
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
});

beforeEach(() => {
  localStorage.clear();
  xtermState.instances.length = 0;
  xtermState.fits.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

function createStubManager(): { manager: TerminalManager; resize: ReturnType<typeof vi.fn> } {
  const tabs: readonly TerminalTab[] = [
    {
      id: 'tab-1',
      index: 1,
      shell: '/bin/bash',
      shellName: 'bash',
      cwd: '/workspace',
      status: 'live',
      exitCode: null,
      cols: 100,
      rows: 28,
      scrollbackIncomplete: false,
    },
  ];
  const state: TerminalManagerState = {
    loaded: true,
    tabs,
    activeId: 'tab-1',
    error: undefined,
    errorKey: 'term.loadFailed',
  };
  const resize = vi.fn();
  const manager = {
    subscribe: () => () => {},
    getState: () => state,
    getPlainTail: () => '',
    bindOutput: () => () => {},
    input: () => {},
    resize,
    setActive: () => {},
    createTab: async () => 'tab-1',
    killTab: async () => {},
    restartTab: async () => {},
    retryAttach: () => {},
    clearError: () => {},
    dispose: () => {},
  } as unknown as TerminalManager;
  return { manager, resize };
}

describe('TerminalPanel codeFontSize sync', () => {
  it('initializes xterm with saved codeFontSize and refits live when codeFontSize changes', async () => {
    writeSettings({ codeFontSize: 13 });
    const { manager, resize } = createStubManager();

    await act(async () => {
      root.render(
        <HostProvider host={browserHost}>
          <I18nProvider>
            <TerminalPanel
              manager={manager}
              height={240}
              wsStatus="open"
              onHeightChange={() => {}}
              onClose={() => {}}
            />
          </I18nProvider>
        </HostProvider>,
      );
    });

    expect(xtermState.instances).toHaveLength(1);
    const term = xtermState.instances[0]!;
    const fit = xtermState.fits[0]!;
    expect(term.options['fontSize']).toBe(13);

    fit.fit.mockClear();
    resize.mockClear();

    await act(async () => {
      writeSettings({ codeFontSize: 15 });
    });

    expect(term.options['fontSize']).toBe(15);
    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith('tab-1', 100, 28);
  });
});
