// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRestartRequirement, restartRequirementSnapshot } from '@kiki/session-core/settings';
import { I18nProvider } from '../../i18n';
import { ExperimentalRows } from './ExperimentalRows';

const client = {
  getConfig: vi.fn(),
  patchConfig: vi.fn(),
  meta: vi.fn(),
};

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }),
}));

let root: Root;
let container: HTMLDivElement;
let query: QueryClient;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(section: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={query}>
        <I18nProvider>
          <ExperimentalRows section={section} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.getConfig.mockReset().mockResolvedValue({ experimental: { task_wait: true } });
  client.meta.mockReset().mockResolvedValue({
    experimental_flags: {
      task_wait: true,
      task_board: false,
      search_worker: true,
      auto_session_title: false,
      vendor_extension: true,
    },
  });
  client.patchConfig.mockReset().mockImplementation(async (patch) => ({ experimental: { ...patch.experimental } }));
  clearRestartRequirement();
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  query.clear();
  localStorage.removeItem('kiki.locale');
});

describe('ExperimentalRows', () => {
  it('lists only the flags whose home is this page, each with the tag, description and timing', async () => {
    await render('tasks');
    const block = container.querySelector('#st-card-exp-tasks')!;
    expect(block.querySelector('h2')?.textContent).toBe('Experimental');
    const rows = [...block.querySelectorAll('[data-experimental-row]')];
    expect(rows.map((row) => row.getAttribute('data-experimental-row'))).toEqual(['task_wait', 'task_board']);
    const wait = rows[0]!;
    expect(wait.querySelector('[data-experimental-tag]')?.textContent).toBe('Experimental');
    expect(wait.textContent).toContain('Wait for background tasks');
    expect(wait.querySelector('[data-experimental-effect]')?.textContent).toBe('Applies right away.');
    expect(wait.querySelector('[data-flag-effective]')?.textContent).toBe('Currently on');
    // The saved override is the selected choice; the flag id stays visible but quiet.
    expect(wait.querySelector('[data-experimental-choice="on"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(wait.textContent).toContain('task_wait');
  });

  it('renders nothing on a page that owns no reported flag', async () => {
    await render('permissions');
    expect(container.querySelector('[data-experimental-rows]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('skips a flag whose feature card already has the switch', async () => {
    await render('sessions');
    expect(container.querySelector('[data-experimental-row="auto_session_title"]')).toBeNull();
  });

  it('puts server-specific flags nobody claims on Developer', async () => {
    await render('developer');
    const row = container.querySelector('[data-experimental-row="vendor_extension"]')!;
    expect(row.textContent).toContain('Server-specific feature');
  });

  it.each(['en', 'zh'] as const)('renders new builtins on their owning pages without unknown copy (%s)', async (locale) => {
    localStorage.setItem('kiki.locale', locale);
    const flags = ['recipes', 'plugin_workspace_usage', 'plugin_app_lifecycle', 'work_presets', 'external_clients'];
    client.getConfig.mockResolvedValue({ experimental: {} });
    client.meta.mockResolvedValue({ experimental_flags: Object.fromEntries([...flags, 'vendor_extension'].map((id) => [id, true])) });
    const names = locale === 'en'
      ? ['Model Recipes', 'Workspace plugin selection', 'App plugin services', 'Space work modes', 'External MCP clients']
      : ['模型 Recipe', '工作区插件选择', '应用级插件服务', '空间工作模式', '外部 MCP 客户端'];
    const sections = ['ai', 'plugins', 'plugins', 'spaces', 'external-clients'];
    for (const [index, id] of flags.entries()) {
      await render(sections[index]!);
      const row = container.querySelector(`[data-experimental-row="${id}"]`)!;
      expect(row).not.toBeNull();
      expect(row.textContent).toContain(names[index]);
      expect(row.textContent).not.toContain(locale === 'en' ? 'Server-specific feature' : '此服务器特有的功能');
      expect(row.querySelector('[data-experimental-choice="default"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(row.querySelector('[data-experimental-choice="default"]')?.textContent).toBe(locale === 'en' ? 'Default (on)' : '默认（开启）');
    }
    await render('developer');
    for (const id of flags) expect(container.querySelector(`[data-experimental-row="${id}"]`)).toBeNull();
    expect(container.querySelector('[data-experimental-row="vendor_extension"]')?.textContent)
      .toContain(locale === 'en' ? 'Server-specific feature' : '此服务器特有的功能');
    localStorage.removeItem('kiki.locale');
  });

  it.each([true, false])('does not recreate a retired usage export switch from saved config (%s)', async (value) => {
    client.getConfig.mockResolvedValue({ experimental: { usage_export: value, vendor_extension: false } });
    client.meta.mockResolvedValue({ experimental_flags: { usage_export: value, plugin_import: false, vendor_extension: true } });
    await render('developer');
    expect(container.querySelector('[data-experimental-row="usage_export"]')).toBeNull();
    expect(container.querySelector('[data-experimental-row="plugin_import"]')?.textContent)
      .not.toContain('Import history from other tools');
    expect(container.querySelector('[data-experimental-row="vendor_extension"]')?.textContent)
      .toContain('Server-specific feature');
  });

  it('names local session continuation on Sessions and applies the choice on the next attachment', async () => {
    client.meta.mockResolvedValue({ experimental_flags: { local_session_resume: true, vendor_extension: true } });
    await render('sessions');
    const row = container.querySelector('[data-experimental-row="local_session_resume"]')!;
    expect(row.textContent).toContain('Continue local external sessions');
    expect(row.textContent).toContain('Continue existing Claude Code and Codex sessions on this machine.');
    expect(row.textContent).not.toContain('Server-specific feature');
    expect(row.querySelector('[data-experimental-effect]')?.textContent).toBe('Applies right away.');
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-experimental-choice="off"]')!.click(); });
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith({ experimental: { task_wait: true, local_session_resume: false }, replace_domains: ['experimental'] });
    expect(restartRequirementSnapshot().required).toBe(false);
    await render('developer');
    expect(container.querySelector('[data-experimental-row="local_session_resume"]')).toBeNull();
    expect(container.querySelector('[data-experimental-row="vendor_extension"]')).not.toBeNull();
  });

  it('marks a restart when a restart-only flag is turned on', async () => {
    await render('search');
    const on = container.querySelector<HTMLButtonElement>('[data-experimental-row="search_worker"] [data-experimental-choice="off"]')!;
    expect(container.querySelector('[data-experimental-row="search_worker"] [data-experimental-effect]')?.textContent)
      .toBe('Turning it on needs a server restart.');
    await act(async () => { on.click(); });
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith({
      experimental: { task_wait: true, search_worker: false },
      replace_domains: ['experimental'],
    });
    // Turning a restart-only flag off applies on the next check; no restart prompt.
    expect(restartRequirementSnapshot().required).toBe(false);
    const again = container.querySelector<HTMLButtonElement>('[data-experimental-row="search_worker"] [data-experimental-choice="on"]')!;
    await act(async () => { again.click(); });
    await flush();
    expect(restartRequirementSnapshot().fields).toContain('search_worker');
  });

  it.each([true, false])('marks a restart only when restoring Default resolves on (%s)', async (enabled) => {
    client.getConfig.mockResolvedValue({ experimental: { external_clients: false } });
    client.meta.mockResolvedValueOnce({ experimental_flags: { external_clients: false } })
      .mockResolvedValue({ experimental_flags: { external_clients: enabled } });
    await render('external-clients');
    const button = container.querySelector<HTMLButtonElement>('[data-experimental-row="external_clients"] [data-experimental-choice="default"]')!;
    await act(async () => { button.click(); });
    await flush();
    expect(client.patchConfig).toHaveBeenCalledWith({ experimental: {}, replace_domains: ['experimental'] });
    expect(restartRequirementSnapshot().required).toBe(enabled);
  });

  it('rolls the choice back and explains the failure when the save fails', async () => {
    client.patchConfig.mockRejectedValueOnce(new Error('offline'));
    await render('tasks');
    const off = container.querySelector<HTMLButtonElement>('[data-experimental-row="task_wait"] [data-experimental-choice="off"]')!;
    await act(async () => { off.click(); });
    await flush();
    const row = container.querySelector('[data-experimental-row="task_wait"]')!;
    expect(row.querySelector('[role="alert"]')?.textContent).toContain('offline');
    expect(row.querySelector('[data-experimental-choice="on"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});
