// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { PluginSettingsForm } from './PluginSettingsForm';

const getPluginSettings = vi.fn();
const setPluginSettings = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getPluginSettings, setPluginSettings } }),
}));

const VIEW = {
  schema: {
    schemaVersion: 1,
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string', title: 'Label', description: 'Shown in the panel header.' },
        limit: { type: 'number', title: 'Limit', default: 10 },
        verbose: { type: 'boolean', title: 'Verbose logs' },
        apiKey: { type: 'string', title: 'API key', secret: true },
      },
    },
  },
  values: { label: 'Team' },
  secretsConfigured: ['apiKey'],
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  getPluginSettings.mockReset().mockResolvedValue(VIEW);
  setPluginSettings.mockReset().mockResolvedValue(VIEW);
});
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><I18nProvider><PluginSettingsForm pluginId="demo" /></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };
const save = (root: Element) => [...root.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
const input = (root: Element, key: string) => root.querySelector<HTMLInputElement>(`[data-plugin-setting="${key}"] input`)!;

describe('PluginSettingsForm', () => {
  it('renders nothing for a plugin without a settings form', async () => {
    getPluginSettings.mockResolvedValue({ values: {}, secretsConfigured: [] });
    const container = await render();
    expect(container.querySelector('[data-plugin-settings]')).toBeNull();
  });

  it('shows stored plain values, never a secret value, and saves only changed keys', async () => {
    const container = await render();
    expect(input(container, 'label').value).toBe('Team');
    expect(input(container, 'limit').placeholder).toBe('10');
    const secret = container.querySelector('[data-plugin-setting="apiKey"]')!;
    expect(secret.textContent).toContain('Saved in Kiki credentials');
    expect(secret.querySelector<HTMLButtonElement>('[data-secret-reveal]')!.disabled).toBe(true);

    await type(input(container, 'limit'), 'many');
    await click(save(container));
    expect(setPluginSettings).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Enter a number');

    await type(input(container, 'limit'), '25');
    await type(input(container, 'label'), '');
    await click(container.querySelector('[data-plugin-setting="verbose"] input[type="checkbox"]')!);
    await click(secret.querySelector('[data-plugin-secret-remove]')!);
    await click(save(container));
    expect(setPluginSettings).toHaveBeenCalledWith('demo', { label: null, limit: 25, verbose: true, apiKey: null });
  });
});
