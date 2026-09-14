// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { PromptConfigCard } from './PromptConfigCard';

const { client } = vi.hoisted(() => ({
  client: { getConfig: vi.fn(), patchConfig: vi.fn() },
}));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));

type TestConfig = {
  prompt: {
    variables: Record<string, string>;
    overrides: { files: string[]; fields: Record<string, string> };
  };
};

let config: TestConfig;
let root: Root;
let container: HTMLDivElement;
let query: QueryClient;

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render() {
  await act(async () => root.render(<QueryClientProvider client={query}><I18nProvider><PromptConfigCard /></I18nProvider></QueryClientProvider>));
  await settle();
}

async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => { button!.click(); });
  await settle();
}

beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  config = {
    prompt: {
      variables: { search_guidance: 'Prefer documentation' },
      overrides: {
        files: ['prompt/team.toml'],
        fields: {
          'system.shared': 'Use ${search_guidance}',
          'tool.web-search.guidance': '${search_guidance}',
        },
      },
    },
  };
  client.getConfig.mockReset().mockImplementation(async () => structuredClone(config));
  client.patchConfig.mockReset().mockImplementation(async (patch: { prompt: TestConfig['prompt'] }) => {
    config = { prompt: structuredClone(patch.prompt) };
    return structuredClone(config);
  });
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  query.clear();
  container.remove();
});

describe('PromptConfigCard', () => {
  it('previews one-pass variable expansion and saves only the prompt domain', async () => {
    await render();
    const preview = container.querySelector<HTMLDetailsElement>('[data-prompt-preview]')!;
    preview.open = true;
    expect(preview.textContent).toContain('system.shared: Use Prefer documentation');
    expect(preview.textContent).toContain('tool.web-search.guidance: Prefer documentation');

    const variableValue = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Variable content"]')!;
    await setValue(variableValue, 'Prefer primary docs');
    await click('Save prompt fields');

    expect(client.patchConfig).toHaveBeenCalledWith({
      prompt: {
        variables: { search_guidance: 'Prefer primary docs' },
        overrides: {
          files: ['prompt/team.toml'],
          fields: {
            'system.shared': 'Use ${search_guidance}',
            'tool.web-search.guidance': '${search_guidance}',
          },
        },
      },
      replace_domains: ['prompt'],
    });
    expect(config.prompt.variables['search_guidance']).toBe('Prefer primary docs');
  });

  it('keeps focus on a variable name while typing sequentially', async () => {
    await render();
    await click('Add variable');
    const name = container.querySelectorAll<HTMLInputElement>('[data-prompt-variable-row] input')[1]!;
    name.focus();
    let typed = '';
    for (const character of 'search_hint') {
      typed += character;
      await setValue(name, typed);
      expect(document.activeElement).toBe(name);
    }
    expect(name.value).toBe('search_hint');
  });

  it('keeps a failed-save draft and refetch cannot overwrite it', async () => {
    await render();
    const field = container.querySelector<HTMLTextAreaElement>('[data-prompt-field-row] textarea')!;
    await setValue(field, 'Draft survives failure');
    client.patchConfig.mockRejectedValueOnce(new Error('fixture offline'));
    await click('Save prompt fields');
    expect(field.value).toBe('Draft survives failure');
    expect(container.textContent).toContain('fixture offline');

    await act(async () => { query.setQueryData(['config'], { prompt: { variables: {}, overrides: { files: [], fields: { 'system.shared': 'server refresh' } } } }); });
    await settle();
    expect(field.value).toBe('Draft survives failure');
  });

  it('disables every editor while a save is in flight', async () => {
    await render();
    const field = container.querySelector<HTMLTextAreaElement>('[data-prompt-field-row] textarea')!;
    await setValue(field, 'Saving now');
    let releaseSave: ((value: TestConfig) => void) | undefined;
    client.patchConfig.mockImplementationOnce(() => new Promise((resolve) => { releaseSave = resolve; }));
    const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save prompt fields')!;
    await act(async () => { saveButton.click(); });
    await settle();
    expect(field.matches(':disabled')).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-prompt-variable-row] input')?.matches(':disabled')).toBe(true);
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Add variable')?.matches(':disabled')).toBe(true);
    expect(saveButton.disabled).toBe(true);
    releaseSave!(structuredClone(config));
    await settle();
    expect(field.matches(':disabled')).toBe(false);
  });

  it('blocks duplicate variable names and malformed field ids before saving', async () => {
    await render();
    const fieldName = container.querySelector<HTMLInputElement>('[data-prompt-field-row] input')!;
    await setValue(fieldName, 'WebSearch');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('dot-separated lowercase field id');
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Save prompt fields')?.hasAttribute('disabled')).toBe(true);

    await setValue(fieldName, 'system.shared');
    await click('Add variable');
    const variableNames = container.querySelectorAll<HTMLInputElement>('[data-prompt-variable-row] input');
    await setValue(variableNames[0]!, 'duplicate');
    await setValue(variableNames[1]!, 'duplicate');
    expect(container.textContent).toContain('The name “duplicate” is used more than once.');
    expect(client.patchConfig).not.toHaveBeenCalled();
  });
});
