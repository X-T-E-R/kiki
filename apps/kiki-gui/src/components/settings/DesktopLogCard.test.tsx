// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { DesktopLogCard } from './DesktopLogCard';
import { pickOption } from './testControls';

const { host } = vi.hoisted(() => ({
  host: {
    kind: 'tauri' as 'tauri' | 'browser',
    desktopLogInfo: vi.fn(),
    openDesktopLogDirectory: vi.fn(),
    writeDesktopPrefs: vi.fn(),
  },
}));
vi.mock('../../host', () => ({ useHost: () => host }));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  host.kind = 'tauri';
  host.desktopLogInfo.mockReset().mockResolvedValue({
    directory: 'C:/Users/example/.kiki', backendLogPath: 'C:/Users/example/.kiki/desktop-backend.log',
    maxBytes: 5 * 1024 * 1024, backups: 3, logLevel: 'warn', appliesOnNextLaunch: true,
  });
  host.openDesktopLogDirectory.mockReset().mockResolvedValue(undefined);
  host.writeDesktopPrefs.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<I18nProvider><DesktopLogCard /></I18nProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

describe('DesktopLogCard', () => {
  it('renders nothing outside the desktop runtime', async () => {
    host.kind = 'browser';
    const container = await render();
    expect(container.innerHTML).toBe('');
    expect(host.desktopLogInfo).not.toHaveBeenCalled();
  });

  it('shows the log path, rotation and the next-launch note, and opens the folder', async () => {
    const container = await render();
    expect(container.querySelector('[data-desktop-log-path]')?.textContent).toContain('desktop-backend.log');
    expect(container.textContent).toContain('5 MiB');
    expect(container.textContent).toContain('next time Kiki starts');
    expect(container.querySelector('[data-desktop-log-pending]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-desktop-log-open]')!.click(); });
    expect(host.openDesktopLogDirectory).toHaveBeenCalledTimes(1);
  });

  it('writes the level to the desktop prefs and says it waits for the next launch', async () => {
    const container = await render();
    await pickOption(container.querySelector('[data-desktop-log-level]')!, /^debug/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.writeDesktopPrefs).toHaveBeenCalledWith({ logLevel: 'debug' });
    expect(container.querySelector('[data-desktop-log-pending]')?.textContent).toMatch(/warn.*debug/);
  });
});
