// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { PresetGrid } from './PresetGrid';
import { draftForPreset, type ProviderPreset, type ProviderWireType } from './providerPresets';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(dense = false) {
  const onPick = vi.fn<(preset: ProviderPreset | null, protocol?: ProviderWireType) => void>();
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<I18nProvider><PresetGrid dense={dense} onPick={onPick} /></I18nProvider>);
  });
  return { container, onPick };
}

async function search(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(button: Element): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('protocol-first API connection picker', () => {
  it('shows five wire protocols and vendor-neutral shortcuts, not the full vendor list', async () => {
    const { container, onPick } = await mount();
    expect([...container.querySelectorAll('[data-provider-protocol]')].map((button) =>
      button.getAttribute('data-provider-protocol'))).toEqual([
      'openai', 'openai_responses', 'anthropic', 'google-genai', 'vertexai',
    ]);
    expect([...container.querySelectorAll('[data-provider-template]')].map((button) =>
      button.getAttribute('data-provider-template'))).toEqual([
      'openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'ollama',
    ]);
    // Presets only fill a URL; no single vendor is promoted to the front row.
    expect(container.querySelector('[data-provider-template="moonshot"]')).toBeNull();
    expect(container.textContent).not.toContain('Local servers');
    expect(container.textContent).not.toContain('API gateways');
    expect(container.querySelector('[data-provider-protocol="openai"] span[title]')?.getAttribute('title')).toBe('OpenAI Chat Completions');
    await click(container.querySelector('[data-provider-protocol="openai_responses"]')!);
    expect(onPick).toHaveBeenCalledWith(null, 'openai_responses');
    expect(draftForPreset(null, 'openai_responses')).toMatchObject({
      id: '', type: 'openai_responses', baseUrl: '',
    });
  });

  it.each([
    ['deepseek', 'deepseek', 'openai', 'https://api.deepseek.com/v1'],
    ['glm', 'zhipu', 'openai', 'https://open.bigmodel.cn/api/paas/v4'],
    ['kimi', 'moonshot', 'kimi', 'https://api.moonshot.ai/v1'],
    ['ollama', 'ollama', 'openai', 'http://localhost:11434/v1'],
    ['lmstudio', 'lmstudio', 'openai', 'http://localhost:1234/v1'],
    ['openrouter', 'openrouter', 'openai', 'https://openrouter.ai/api/v1'],
  ])('searches %s directly to the matching base URL and protocol', async (query, id, type, baseUrl) => {
    const { container, onPick } = await mount(true);
    expect(container.querySelectorAll('[data-provider-template]')).toHaveLength(0);
    await search(container, query);
    expect(container.querySelector('[data-preset-results]')).not.toBeNull();
    const result = container.querySelector(`[data-provider-template="${id}"]`)!;
    await click(result);
    const preset = onPick.mock.lastCall?.[0];
    expect(preset?.id).toBe(id);
    expect(draftForPreset(preset ?? null)).toMatchObject({ type, baseUrl });
  });

  it('keeps protocol selection available when no service matches', async () => {
    const { container, onPick } = await mount(true);
    await search(container, 'my-private-gateway');
    expect(container.textContent).toContain('Choose a protocol and enter its base URL');
    expect(container.querySelectorAll('[data-provider-template]')).toHaveLength(0);
    await click(container.querySelector('[data-provider-protocol="anthropic"]')!);
    expect(onPick).toHaveBeenCalledWith(null, 'anthropic');
    expect(draftForPreset(null, 'anthropic')).toMatchObject({ type: 'anthropic', baseUrl: '' });
  });
});
