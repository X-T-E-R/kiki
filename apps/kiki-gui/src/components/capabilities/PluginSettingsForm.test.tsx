// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCALE_STORAGE_KEY } from '@kiki/session-core/i18n';

import { I18nProvider, useI18n } from '../../i18n';
import { PluginSettingsForm } from './PluginSettingsForm';

const getPluginSettings = vi.fn();
const setPluginSettings = vi.fn();
const listProviders = vi.fn(async () => ({ items: [] as { id: string; name?: string }[] }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getPluginSettings, setPluginSettings, listProviders } }),
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
  localStorage.removeItem(LOCALE_STORAGE_KEY);
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
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return container;
}

/** The same form, in the reader's language, with the switch the locale menu performs. */
function LocaleSwitch() {
  const { locale, setLocale } = useI18n();
  return (
    <button type="button" data-locale-switch={locale} onClick={() => { setLocale(locale === 'zh' ? 'en' : 'zh'); }}>
      {locale}
    </button>
  );
}

async function renderAtLocale(locale: 'en' | 'zh'): Promise<HTMLDivElement> {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <LocaleSwitch />
          <PluginSettingsForm pluginId="demo" />
        </I18nProvider>
      </QueryClientProvider>,
    );
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

  it('shows one source at a time, hides tombstones, and restores a removed source', async () => {
    getPluginSettings.mockResolvedValue({
      schema: {
        schemaVersion: 1,
        schema: {
          type: 'object',
          properties: {
            defaultImageProvider: { type: 'string', title: 'Default image', enum: ['openai-image', 'google-image'] },
            openai__apiKey: { type: 'string', title: 'API key', secret: true, group: 'openai', groupTitle: 'OpenAI' },
            openai__baseUrl: { type: 'string', title: 'API base URL', group: 'openai', groupTitle: 'OpenAI', default: 'https://api.openai.com/v1' },
            openai__note: { type: 'string', title: 'Note', group: 'openai', groupTitle: 'OpenAI', advanced: true, multiline: true },
            openai__enabled: { type: 'boolean', title: 'Enabled', group: 'openai', groupTitle: 'OpenAI', default: true },
            openai__removed: { type: 'boolean', hidden: true, group: 'openai', groupTitle: 'OpenAI' },
            openai__cleared: { type: 'string', hidden: true, default: '[]', group: 'openai', groupTitle: 'OpenAI' },
            google__baseUrl: { type: 'string', title: 'API base URL', group: 'google', groupTitle: 'Google' },
            google__removed: { type: 'boolean', hidden: true, group: 'google', groupTitle: 'Google' },
            google__cleared: { type: 'string', hidden: true, group: 'google', groupTitle: 'Google' },
          },
        },
      },
      values: { defaultImageProvider: 'openai-image', google__removed: true, google__baseUrl: 'https://example.test/v1' },
      secretsConfigured: [],
    });
    const container = await render();
    expect(container.textContent).not.toContain('openai__cleared');
    expect(container.textContent).not.toContain('openai__removed');
    expect(container.querySelector('[data-plugin-setting="defaultImageProvider"] select')?.textContent).toContain('openai-image');
    // Groups are rows; their fields stay closed until the row is opened.
    expect(container.querySelector('[data-plugin-setting="openai__baseUrl"]')).toBeNull();
    // A removed source is a quiet row with Restore, in place of its fields.
    expect(container.querySelector('[data-plugin-setting-group="google"] [data-plugin-setting-restore="google__removed"]')).not.toBeNull();
    // The group switch is the group's own control, not a field inside it.
    expect(container.querySelector('[data-plugin-setting-group-switch="openai"] input[type="checkbox"]')).not.toBeNull();
    await click(container.querySelector('[data-plugin-setting-group-open="openai"]')!);
    expect(container.querySelector('[data-plugin-setting="openai__baseUrl"]')).not.toBeNull();
    expect(container.querySelector('[data-plugin-setting="openai__enabled"]')).toBeNull();
    const advanced = container.querySelector<HTMLDetailsElement>('[data-plugin-settings-advanced="openai"]');
    expect(advanced?.open).toBe(false);
    expect(advanced?.querySelector('[data-plugin-setting="openai__note"] textarea')).not.toBeNull();
    expect(container.querySelector('[data-plugin-setting="google__baseUrl"]')).toBeNull();
    await click(container.querySelector('[data-plugin-setting-restore="google__removed"]')!);
    await click(container.querySelector('[data-plugin-setting-group-open="google"]')!);
    expect(container.querySelector<HTMLInputElement>('[data-plugin-setting="google__baseUrl"] input')?.value).toBe('https://example.test/v1');
    await click(save(container));
    expect(setPluginSettings).toHaveBeenCalledWith('demo', { google__removed: false });
  });

  it('reads translated field text per language, falls back field by field, and keeps the draft across a switch', async () => {
    getPluginSettings.mockResolvedValue({
      schema: {
        schemaVersion: 1,
        schema: {
          type: 'object',
          properties: {
            openai__apiKey: {
              type: 'string', title: 'API key', secret: true, group: 'openai', groupTitle: 'OpenAI Media',
              localizations: { zh: { title: 'API 密钥', groupTitle: 'OpenAI 媒体' } },
            },
            openai__baseUrl: {
              type: 'string', title: 'API base URL', description: 'Where image requests are sent.', group: 'openai', groupTitle: 'OpenAI Media',
              localizations: { zh: { title: 'API 基础地址', description: '图像请求发送到的地址。' } },
            },
            google__baseUrl: {
              type: 'string', title: 'API base URL', description: 'Still English, by choice.', group: 'google', groupTitle: 'Google',
              localizations: { zh: { groupTitle: 'Google 媒体' } },
            },
          },
        },
      },
      values: { google__baseUrl: 'https://example.test/v1' },
      secretsConfigured: ['openai__apiKey'],
    });

    const container = await renderAtLocale('zh');
    const title = (id: string) => container.querySelector(`[data-plugin-setting-group="${id}"] [data-plugin-setting-group-title]`)?.textContent;
    expect(title('openai')).toBe('OpenAI 媒体');
    expect(title('google')).toBe('Google 媒体');
    // A closed row says what is set, without opening it.
    expect(container.querySelector('[data-plugin-setting-group="openai"] [data-plugin-setting-group-summary]')?.textContent).toContain('API 密钥已设置');
    await click(container.querySelector('[data-plugin-setting-group-open="openai"]')!);
    const openai = container.querySelector('[data-plugin-setting="openai__baseUrl"]')!;
    expect(openai.querySelector('label')?.textContent).toBe('API 基础地址');
    expect(openai.textContent).toContain('图像请求发送到的地址。');
    const secret = container.querySelector('[data-plugin-setting="openai__apiKey"]')!;
    expect(secret.textContent).toContain('API 密钥');
    expect(secret.textContent).toContain('已保存在 Kiki 凭据中');
    // The untranslated field in the same locale keeps its own English text.
    await click(container.querySelector('[data-plugin-setting-group-open="google"]')!);
    const google = container.querySelector('[data-plugin-setting="google__baseUrl"]')!;
    expect(google.querySelector('label')?.textContent).toBe('API base URL');
    expect(google.textContent).toContain('Still English, by choice.');
    await click(container.querySelector('[data-plugin-setting-group-open="openai"]')!);

    await type(input(container, 'openai__baseUrl'), 'https://example.test/openai');
    await click(container.querySelector('[data-locale-switch]')!);
    expect(container.querySelector('[data-locale-switch]')?.getAttribute('data-locale-switch')).toBe('en');
    expect(title('openai')).toBe('OpenAI Media');
    expect(container.querySelector('[data-plugin-setting="openai__baseUrl"] label')?.textContent).toBe('API base URL');
    expect(container.querySelector('[data-plugin-setting="openai__baseUrl"]')?.textContent).toContain('Where image requests are sent.');
    expect(input(container, 'openai__baseUrl').value).toBe('https://example.test/openai');
    expect(container.querySelector<HTMLElement>('[data-settings-draft]')?.hidden).not.toBe(true);

    await click(save(container));
    expect(setPluginSettings).toHaveBeenCalledWith('demo', { openai__baseUrl: 'https://example.test/openai' });
  });

  it('separates ungrouped global defaults from source group panels and offers a connection picker when model connections exist', async () => {
    listProviders.mockResolvedValueOnce({
      items: [
        { id: 'openai-main', name: 'OpenAI Main' },
        { id: 'proxy-gateway', name: 'Proxy Gateway' },
      ],
    });
    getPluginSettings.mockResolvedValue({
      schema: {
        schemaVersion: 1,
        schema: {
          type: 'object',
          properties: {
            defaultImageProvider: { type: 'string', title: 'Default image provider', enum: ['openai-image', 'google-image'] },
            openai__connectionId: { type: 'string', title: 'Connection ID', group: 'openai', groupTitle: 'OpenAI' },
            openai__enabled: { type: 'boolean', title: 'Enabled', group: 'openai', groupTitle: 'OpenAI', default: true },
            google__connectionId: { type: 'string', title: 'Connection ID', group: 'google', groupTitle: 'Google' },
          },
        },
      },
      values: { openai__connectionId: 'openai-main' },
      secretsConfigured: [],
    });

    const container = await render();
    expect(container.querySelector('[data-plugin-settings-global] [data-plugin-setting="defaultImageProvider"]')).not.toBeNull();
    await click(container.querySelector('[data-plugin-setting-group-open="openai"]')!);
    const panel = container.querySelector('[data-plugin-setting-group-panel="openai"]');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('[data-plugin-setting="defaultImageProvider"]')).toBeNull();
    const picker = panel?.querySelector<HTMLSelectElement>('[data-plugin-setting-connection="openai__connectionId"]');
    expect(picker).not.toBeNull();
    expect(picker?.value).toBe('openai-main');
    expect(picker?.textContent).toContain('OpenAI Main');
    expect(picker?.textContent).toContain('Proxy Gateway');
  });
});
