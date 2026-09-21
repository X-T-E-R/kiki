// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { AboutSection } from './AboutSection';

const { checkDesktopUpdate, supportsDesktopUpdates, writeDesktopPrefs } = vi.hoisted(() => ({
  checkDesktopUpdate: vi.fn(),
  supportsDesktopUpdates: vi.fn(),
  writeDesktopPrefs: vi.fn(),
}));

vi.mock('../../host', () => ({
  useHost: () => ({
    kind: 'tauri',
    checkDesktopUpdate,
    supportsDesktopUpdates,
    writeDesktopPrefs,
  }),
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    meta: {
      server_version: '1.0.0',
      server_id: 'example-server',
      backend: 'v2',
    },
  }),
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  checkDesktopUpdate.mockReset().mockResolvedValue(null);
  supportsDesktopUpdates.mockReset().mockResolvedValue(true);
  writeDesktopPrefs.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderSection(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AboutSection />
      </I18nProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function selectValue(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('AboutSection desktop updates', () => {
  it('persists the selected automatic update mode to local and native preferences', async () => {
    const container = await renderSection();
    const autoUpdate = container.querySelector<HTMLSelectElement>('select[aria-label="Automatic updates"]');
    expect(autoUpdate).not.toBeNull();
    expect(autoUpdate!.disabled).toBe(false);
    expect(autoUpdate!.value).toBe('notify');

    await selectValue(autoUpdate!, 'install');

    expect(JSON.parse(localStorage.getItem('kiki.desktopPrefs') ?? '{}')).toMatchObject({
      autoUpdate: 'install',
    });
    expect(writeDesktopPrefs).toHaveBeenCalledWith({ autoUpdate: 'install' });
  });

  it('disables update controls and shows a friendly message for unsupported builds', async () => {
    supportsDesktopUpdates.mockResolvedValue(false);
    const container = await renderSection();
    const selects = [...container.querySelectorAll('select')];
    const checkButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Check for updates',
    );

    expect(selects).toHaveLength(2);
    expect(selects.every((select) => select.disabled)).toBe(true);
    expect(checkButton).toBeDefined();
    expect(checkButton!.disabled).toBe(true);
    expect(container.textContent).toContain('This build does not include an update channel.');
    expect(checkDesktopUpdate).not.toHaveBeenCalled();
  });
});
