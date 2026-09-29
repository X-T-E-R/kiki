// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { GlobalRequestIdentityCard } from './ModelsSection';

const getConfig = vi.fn();
const patchConfig = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig } }),
}));

const CONFIG = {
  request_identity: { overrides: { client: { user_agent: 'host' } } },
} as unknown as KikiConfigResponse;

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  getConfig.mockReset().mockResolvedValue(CONFIG);
  patchConfig.mockReset().mockResolvedValue(CONFIG);
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
    root.render(<QueryClientProvider client={queryClient}><I18nProvider><GlobalRequestIdentityCard /></I18nProvider></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

async function type(element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function footer(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-settings-draft="global-request-identity"]')!;
}

describe('GlobalRequestIdentityCard', () => {
  it('shows the draft footer only once the JSON is edited', async () => {
    const container = await render();
    expect(footer(container).hidden).toBe(true);
    await type(container.querySelector('textarea')!, '{"client":{"user_agent":"none"}}');
    expect(footer(container).hidden).toBe(false);
    expect(footer(container).dataset['dirty']).toBe('true');
    const save = footer(container).querySelector<HTMLButtonElement>('button')!;
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(patchConfig).toHaveBeenCalledWith({ request_identity: { overrides: { client: { user_agent: 'none' } } } });
  });

  it('blocks the save and marks the field when the JSON does not parse', async () => {
    const container = await render();
    const textarea = container.querySelector('textarea')!;
    await type(textarea, '{"client":');
    const save = footer(container).querySelector<HTMLButtonElement>('button')!;
    await act(async () => { save.click(); });
    expect(patchConfig).not.toHaveBeenCalled();
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).not.toBe('');
    expect(save.disabled).toBe(true);
    await type(textarea, '{"client":{"user_agent":"codex"}}');
    expect(textarea.getAttribute('aria-invalid')).toBe('false');
    expect(save.disabled).toBe(false);
  });

  it('discard restores the stored layer', async () => {
    const container = await render();
    const textarea = container.querySelector('textarea')!;
    const stored = textarea.value;
    await type(textarea, '{}');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-settings-discard="global-request-identity"]')!.click(); });
    expect(container.querySelector('textarea')!.value).toBe(stored);
    expect(footer(container).hidden).toBe(true);
  });
});
