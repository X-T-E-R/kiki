// @vitest-environment jsdom

/**
 * The rail's workspace plugin list. What matters here is that the row tells
 * the truth about the workspace the *server* resolved, that a pending or
 * failed save keeps the reader's choice on screen instead of snapping back,
 * that a home-disabled plugin never reads as usable here, and that a server
 * without the flag simply contributes nothing rather than an explanation wall.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginUsageItem, PluginUsageResponse } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { WorkspacePluginsSection } from './WorkspacePluginsSection';

const { getUsage, setUsage } = vi.hoisted(() => ({ getUsage: vi.fn(), setUsage: vi.fn() }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      getPluginUsage: (target: unknown) => getUsage(target),
      setPluginUsage: (input: unknown) => setUsage(input),
      listPluginMarketplace: () => Promise.resolve({ entries: [] }),
    },
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  localStorage.clear();
  localStorage.setItem('kiki.locale', 'zh');
  getUsage.mockReset();
  setUsage.mockReset();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

function item(overrides: Partial<PluginUsageItem> = {}): PluginUsageItem {
  return {
    id: 'demo',
    displayName: 'Demo Plugin',
    version: '1.0.0',
    home_enabled: true,
    state: 'ok',
    override: 'inherit',
    effective: true,
    app_service: false,
    skillCount: 2,
    mcpServerCount: 0,
    ...overrides,
  };
}

function answer(overrides: Partial<PluginUsageResponse> = {}): PluginUsageResponse {
  return {
    home_id: 'home-1',
    target: { workspace_id: 'ws-a', name: 'Alpha', root: 'C:/work/alpha' },
    revision: 7,
    apply_state: 'applied',
    errors: [],
    plugins: [item()],
    ...overrides,
  } as PluginUsageResponse;
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <WorkspacePluginsSection sessionId="sess-a" />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

/** Expand the chapter, unless this render already left it expanded. */
async function open() {
  const head = container.querySelector<HTMLButtonElement>('[data-rail-plugins] [aria-expanded]')!;
  if (head.getAttribute('aria-expanded') === 'false') {
    await act(async () => { head.click(); });
    await settle();
  }
}

describe('WorkspacePluginsSection', () => {
  it('names the workspace the server resolved, not the window cwd', async () => {
    getUsage.mockResolvedValue(answer());
    await render();
    await settle();
    await open();
    const scope = container.querySelector('[data-rail-plugins-scope]')!;
    expect(scope.textContent).toBe('本工作区 · Alpha');
    // The session resolves the workspace; no cwd or agent id rides along.
    expect(getUsage).toHaveBeenCalledWith({ session_id: 'sess-a' });
  });

  it('offers restore only while the workspace overrides something', async () => {
    getUsage.mockResolvedValue(answer({ plugins: [item({ override: 'inherit', effective: true })] }));
    setUsage.mockResolvedValue(answer({ revision: 8, plugins: [item({ override: 'off', effective: false })] }));
    await render();
    await settle();
    await open();
    expect(container.querySelector('[data-rail-plugin="demo"] [data-rail-plugin-restore]')).toBeNull();

    // Turning it off for this workspace is what makes restore a choice.
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'off' });
    expect(container.querySelector('[data-rail-plugin="demo"] [data-rail-plugin-restore]')!.textContent).toBe('恢复默认');
  });

  it('writes inherit when the reader restores the default', async () => {
    setUsage.mockResolvedValue(answer({ plugins: [item({ override: 'inherit', effective: true })] }));
    getUsage.mockResolvedValue(answer({ plugins: [item({ override: 'off', effective: false })] }));
    await render();
    await settle();
    await open();
    const restore = container.querySelector<HTMLButtonElement>('[data-rail-plugin="demo"] [data-rail-plugin-restore]')!;
    await act(async () => { restore.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'inherit' });
  });

  it('keeps a home-disabled plugin off with its real reason and a way to fix it', async () => {
    getUsage.mockResolvedValue(answer({
      plugins: [item({ override: 'on', home_enabled: false, effective: false, reason: 'home_disabled' })],
    }));
    await render();
    await settle();
    await open();
    const row = container.querySelector('[data-rail-plugin="demo"]')!;
    expect(row.getAttribute('data-effective')).toBe('false');
    const reason = row.querySelector('[data-rail-plugin-reason="home_disabled"]')!;
    expect(reason.textContent).toBe('空间主开关已关闭');
    // The switch is present but not clickable into a lie.
    const toggle = row.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(toggle.disabled).toBe(true);
    // And the page that can actually change it is one click away.
    expect(row.querySelector('[data-rail-plugin-manage]')).not.toBeNull();
  });

  it('labels a home-scoped app service instead of implying the switch stops it', async () => {
    getUsage.mockResolvedValue(answer({ plugins: [item({ app_service: true, override: 'off', effective: false })] }));
    await render();
    await settle();
    await open();
    const row = container.querySelector('[data-rail-plugin="demo"]')!;
    expect(row.querySelector('[data-rail-plugin-app-service]')!.textContent).toBe('空间常驻服务');
    expect(row.textContent).toContain('空间常驻服务');
  });

  it('keeps the reader’s choice on screen while the server is still applying', async () => {
    let release: (value: PluginUsageResponse) => void = () => {};
    setUsage.mockImplementation(() => new Promise<PluginUsageResponse>((resolve) => { release = resolve; }));
    getUsage.mockResolvedValue(answer({ plugins: [item({ override: 'inherit', effective: true })] }));
    await render();
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    const toggle = row.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    await act(async () => { toggle.click(); });
    await settle();
    // Mid-flight the row shows what was asked for, not the server's old answer.
    expect(row.getAttribute('data-override')).toBe('off');
    expect(row.getAttribute('data-effective')).toBe('false');
    // And it says so rather than pretending the click did nothing.
    expect(container.querySelector('[data-rail-plugins-applying]')).toBeNull();
    await act(async () => {
      release(answer({ revision: 8, apply_state: 'pending', plugins: [item({ override: 'off', effective: false })] }));
      await new Promise((done) => setTimeout(done, 0));
    });
    await settle();
    expect(container.querySelector('[data-rail-plugins-applying]')!.textContent).toBe('正在应用，你的选择已经保存。');
  });

  it('reports the server’s errors and leaves the row editable after a failed save', async () => {
    setUsage.mockRejectedValue(new Error('workspace is read-only'));
    getUsage.mockResolvedValue(answer({ plugins: [item({ override: 'inherit', effective: true })] }));
    await render();
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();
    const error = container.querySelector('[data-rail-plugin-error]')!;
    expect(error.textContent).toContain('workspace is read-only');
    // The row returns to the server's answer rather than keeping a lie.
    expect(row.getAttribute('data-effective')).toBe('true');
    expect(row.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(false);
  });

  it('shows a failed apply state with the server’s errors', async () => {
    getUsage.mockResolvedValue(answer({ apply_state: 'failed', errors: ['one plugin did not apply'], plugins: [item()] }));
    await render();
    await settle();
    await open();
    expect(container.querySelector('[data-rail-plugins-failed]')!.textContent).toContain('one plugin did not apply');
  });

  it('contributes nothing at all when the server does not offer the capability', async () => {
    getUsage.mockRejectedValue(Object.assign(new Error('unsupported procedure'), { code: 12 }));
    await render();
    await settle();
    // No chapter, no headline, no apology: the rail keeps what it had.
    expect(container.querySelector('[data-rail-plugins]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('keeps an unreadable workspace quiet with a retry, never an alert', async () => {
    getUsage.mockRejectedValue(new Error('network down'));
    await render();
    await settle();
    await open();
    const line = container.querySelector('[data-rail-plugins-unavailable]')!;
    expect(line.textContent).toContain('暂时读不到本工作区的插件使用情况。');
    expect(line.querySelector('button')!.textContent).toBe('重试');
  });

  it('says what an empty workspace means instead of showing a blank list', async () => {
    getUsage.mockResolvedValue(answer({ plugins: [] }));
    await render();
    await settle();
    await open();
    expect(container.querySelector('[data-rail-plugins-empty]')!.textContent).toContain('还没有安装插件');
  });

  it('counts only what is actually usable here while folded', async () => {
    getUsage.mockResolvedValue(answer({
      plugins: [
        item({ id: 'a', effective: true }),
        item({ id: 'b', effective: false }),
        item({ id: 'c', effective: false, reason: 'home_disabled' }),
      ],
    }));
    await render();
    await settle();
    const head = container.querySelector('[data-rail-plugins] [aria-expanded]')!;
    expect(head.textContent).toContain('此处可用 1');
  });
});

describe('a save that lands after the reader moved on', () => {
  /** Re-render the same tree against a second workspace's session. */
  async function renderAs(sessionId: string, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <I18nProvider>
              <WorkspacePluginsSection sessionId={sessionId} />
            </I18nProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
  }

  it('does not let a late failure land on the workspace now on screen', async () => {
    let rejectA: (error: Error) => void = () => {};
    setUsage.mockImplementation((input: { target: { session_id: string } }) =>
      input.target.session_id === 'sess-a'
        ? new Promise((_resolve, reject) => { rejectA = reject; })
        : Promise.resolve(answer()));
    getUsage.mockResolvedValue(answer({ plugins: [item({ override: 'inherit', effective: true })] }));
    await renderAs('sess-a');
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'off' });

    // The reader switches to workspace B before workspace A's save answers.
    getUsage.mockResolvedValue(answer({
      target: { workspace_id: 'ws-b', name: 'Beta', root: 'C:/work/beta' },
      plugins: [item({ override: 'inherit', effective: true })],
    }));
    await renderAs('sess-b');
    await settle();
    await open();

    await act(async () => { rejectA(new Error('workspace A is read-only')); });
    await settle();
    // A's failure belongs to A. B's row must not claim it.
    expect(container.querySelector('[data-rail-plugin-error]')).toBeNull();
    expect(container.querySelector('[data-rail-plugins-scope]')!.textContent).toBe('本工作区 · Beta');
    getUsage.mockResolvedValue(answer());
    await renderAs('sess-a');
    await settle();
    expect(container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!.dataset['effective']).toBe('true');
    expect(container.querySelector('[data-rail-plugin-error]')).toBeNull();
  });

  it('does not let a late success overwrite the workspace now on screen', async () => {
    let resolveA: (value: PluginUsageResponse) => void = () => {};
    setUsage.mockImplementation((input: { target: { session_id: string } }) =>
      input.target.session_id === 'sess-a'
        ? new Promise((resolve) => { resolveA = resolve; })
        : Promise.resolve(answer()));
    getUsage.mockResolvedValue(answer({ plugins: [item({ override: 'inherit', effective: true })] }));
    await renderAs('sess-a');
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();

    getUsage.mockResolvedValue(answer({
      target: { workspace_id: 'ws-b', name: 'Beta', root: 'C:/work/beta' },
      plugins: [item({ override: 'inherit', effective: true })],
    }));
    await renderAs('sess-b');
    await settle();
    await open();
    const before = container.querySelector('[data-rail-plugin="demo"]')!.getAttribute('data-effective');

    await act(async () => {
      resolveA(answer({ revision: 99, plugins: [item({ override: 'off', effective: false })] }));
      await new Promise((done) => setTimeout(done, 0));
    });
    await settle();
    // B still shows what B's own server said, not A's late answer.
    expect(container.querySelector('[data-rail-plugin="demo"]')!.getAttribute('data-effective')).toBe(before);
    expect(container.querySelector('[data-rail-plugin="demo"]')!.getAttribute('data-effective')).toBe('true');
    getUsage.mockResolvedValue(answer({ revision: 100 }));
    await renderAs('sess-a');
    await settle();
    expect(container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!.dataset['effective']).toBe('true');
  });

  it.each(['success', 'failure'] as const)('preserves a newer A request after the older A %s', async (outcome) => {
    let finishOld: () => void = () => {};
    let finishNew: () => void = () => {};
    setUsage.mockImplementation((input: { plugin_id: string; override: string }) => {
      if (input.plugin_id === 'other') return Promise.resolve(answer());
      if (input.override === 'off') return new Promise<PluginUsageResponse>((resolve, reject) => {
        finishOld = () => {
          if (outcome === 'failure') reject(new Error('old A failure'));
          else resolve(answer({ revision: 8, plugins: [item({ override: 'off', effective: false })] }));
        };
      });
      return new Promise<PluginUsageResponse>((resolve) => {
        finishNew = () => { resolve(answer({ revision: 9, plugins: [item({ override: 'on', effective: true })] })); };
      });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getUsage.mockResolvedValue(answer());
    await renderAs('sess-a', client);
    await settle();
    await open();
    await act(async () => { container.querySelector<HTMLInputElement>('[data-rail-plugin="demo"] input')!.click(); });
    await settle();
    getUsage.mockResolvedValue(answer({ target: { workspace_id: 'ws-b', name: 'Beta', root: 'C:/work/beta' }, plugins: [item({ id: 'other' })] }));
    await renderAs('sess-b', client);
    await settle();
    await act(async () => { container.querySelector<HTMLInputElement>('[data-rail-plugin="other"] input')!.click(); });
    await settle();
    getUsage.mockResolvedValue(answer({ revision: 8, plugins: [item({ override: 'off', effective: false })] }));
    await client.invalidateQueries({ queryKey: ['plugin-usage', 'sess-a'] });
    await renderAs('sess-a', client);
    await settle();
    const toggle = container.querySelector<HTMLInputElement>('[data-rail-plugin="demo"] input')!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    await settle();
    expect(setUsage).toHaveBeenLastCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'on' });
    await act(async () => { finishOld(); });
    await settle();
    expect(container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!.dataset['effective']).toBe('true');
    expect(container.querySelector('[data-rail-plugin-error]')).toBeNull();
    await act(async () => { finishNew(); });
    await settle();
    expect(container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!.dataset['override']).toBe('on');
  });

  it('addresses a restore-default write to the workspace that asked for it', async () => {
    getUsage.mockResolvedValue(answer({ plugins: [item({ override: 'off', effective: false })] }));
    setUsage.mockResolvedValue(answer({ plugins: [item({ override: 'inherit', effective: true })] }));
    await renderAs('sess-b');
    await settle();
    await open();
    const restore = container.querySelector<HTMLButtonElement>('[data-rail-plugin="demo"] [data-rail-plugin-restore]')!;
    await act(async () => { restore.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-b' }, plugin_id: 'demo', override: 'inherit' });
  });
});