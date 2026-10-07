// @vitest-environment jsdom

/**
 * The rail's plugin list for the session in focus. What matters here is that
 * the row names the workspace the *server* resolved, that a switch writes the
 * session scope and never the workspace, that a pending or failed save keeps
 * the reader's choice on screen instead of snapping back, that a plugin whose
 * global default is off can still be turned on locally, and that a server
 * without the capability simply contributes nothing.
 *
 * The fixtures declare the four-level usage contract (home → global →
 * workspace → session); they are the contract under test, not a stand-in.
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
    global_enabled: true,
    state: 'ok',
    override: 'inherit',
    effective: true,
    app_service: false,
    skillCount: 2,
    mcpServerCount: 0,
    ...overrides,
  } as PluginUsageItem;
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

async function render(sessionId = 'sess-a', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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

  it('is called Plugins and says its switches are about this conversation', async () => {
    getUsage.mockResolvedValue(answer());
    await render();
    await settle();
    const head = container.querySelector('[data-rail-plugins] [aria-expanded]')!;
    expect(head.textContent).toContain('插件');
    expect(head.textContent).not.toContain('工作区插件');
    await open();
    expect(container.querySelector('[data-rail-plugins-hint]')!.textContent).toContain('当前对话');
  });

  it('stays folded until the reader opens it, and the switch still works inside', async () => {
    getUsage.mockResolvedValue(answer());
    await render();
    await settle();
    // Folded by default: the rail contributes the chapter, not a wall of rows.
    expect(container.querySelector('[data-rail-plugin="demo"]')).toBeNull();
    await open();
    expect(container.querySelector('[data-rail-plugin="demo"]')).not.toBeNull();
  });

  it('reads a session row from its own session override, not the workspace one', async () => {
    getUsage.mockResolvedValue(answer({
      plugins: [item({ override: 'off', session_override: 'on', effective: true })],
    }));
    await render();
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    expect(row.dataset['override']).toBe('on');
    expect(row.dataset['effective']).toBe('true');
  });

  it('brings a workspace-disabled plugin up checked, and says on', async () => {
    // The other half of the switch contract: a plugin this workspace has off
    // can still be turned on for this conversation, and once the server
    // agrees it is checked and captioned on — not merely described as on.
    getUsage.mockResolvedValue(answer({
      plugins: [item({ override: 'off', effective: false, reason: 'workspace_disabled' })],
    }));
    setUsage.mockResolvedValue(answer({
      revision: 9,
      plugins: [item({ override: 'off', session_override: 'on', effective: true })],
    }));
    await render();
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    expect(row.dataset['effective']).toBe('false');
    expect(row.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);

    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();

    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'on' });
    // Checked, and the rail agrees with its own answer.
    const after = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    expect(after.dataset['effective']).toBe('true');
    expect(after.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
    expect(after.textContent).not.toContain('关闭');
  });

  it('offers restore only while the session overrides something', async () => {
    getUsage.mockResolvedValue(answer({ plugins: [item({ override: 'inherit', session_override: 'inherit', effective: true })] }));
    setUsage.mockResolvedValue(answer({ revision: 8, plugins: [item({ override: 'inherit', session_override: 'off', effective: false })] }));
    await render();
    await settle();
    await open();
    expect(container.querySelector('[data-rail-plugin="demo"] [data-rail-plugin-restore]')).toBeNull();

    // Turning it off for this conversation is what makes restore a choice.
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'off' });
    expect(container.querySelector('[data-rail-plugin="demo"] [data-rail-plugin-restore]')!.textContent).toBe('恢复默认');
  });

  it('writes inherit when the reader restores the default', async () => {
    setUsage.mockResolvedValue(answer({ plugins: [item({ session_override: 'inherit', effective: true })] }));
    getUsage.mockResolvedValue(answer({ plugins: [item({ session_override: 'off', effective: false })] }));
    await render();
    await settle();
    await open();
    const restore = container.querySelector<HTMLButtonElement>('[data-rail-plugin="demo"] [data-rail-plugin-restore]')!;
    await act(async () => { restore.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'inherit' });
  });

  it('turns on a plugin whose global default is off, without asking anyone else', async () => {
    getUsage.mockResolvedValue(answer({
      plugins: [item({ global_enabled: false, effective: false, reason: 'global_disabled' })],
    }));
    setUsage.mockResolvedValue(answer({
      revision: 8,
      plugins: [item({ global_enabled: false, session_override: 'on', effective: true })],
    }));
    await render();
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    expect(row.dataset['effective']).toBe('false');
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'on' });
    expect(container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!.dataset['effective']).toBe('true');
  });

  it('says which level decided, so a local on is not read as a global one', async () => {
    getUsage.mockResolvedValue(answer({
      plugins: [
        item({ id: 'a', session_override: 'on', effective: true }),
        item({ id: 'b', override: 'on', effective: true }),
        item({ id: 'c', global_enabled: false, effective: false, reason: 'global_disabled' }),
        item({ id: 'd', global_enabled: true, effective: true }),
      ],
    }));
    await render();
    await settle();
    await open();
    expect(container.querySelector('[data-rail-plugin="a"] [data-rail-plugin-source]')!.textContent).toBe('当前对话');
    expect(container.querySelector('[data-rail-plugin="b"] [data-rail-plugin-source]')!.textContent).toBe('本工作区');
    expect(container.querySelector('[data-rail-plugin="c"] [data-rail-plugin-source]')!.textContent).toBe('全局默认');
    expect(container.querySelector('[data-rail-plugin="d"] [data-rail-plugin-source]')!.textContent).toBe('全局开启');
  });

  it('keeps a home-disabled plugin off with its real reason and a way to fix it', async () => {
    getUsage.mockResolvedValue(answer({
      plugins: [item({ session_override: 'on', home_enabled: false, effective: false, reason: 'home_disabled' })],
    }));
    await render();
    await settle();
    await open();
    const row = container.querySelector('[data-rail-plugin="demo"]')!;
    expect(row.getAttribute('data-effective')).toBe('false');
    const reason = row.querySelector('[data-rail-plugin-reason="home_disabled"]')!;
    expect(reason.textContent).toBe('主开关已关闭');
    // The switch is present but not clickable into a lie.
    const toggle = row.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(toggle.disabled).toBe(true);
    // And the page that can actually change it is one click away.
    expect(row.querySelector('[data-rail-plugin-manage]')).not.toBeNull();
  });

  it('labels a home-scoped app service as shared, instead of implying the switch stops it', async () => {
    getUsage.mockResolvedValue(answer({ plugins: [item({ app_service: true, session_override: 'off', effective: false })] }));
    await render();
    await settle();
    await open();
    const row = container.querySelector('[data-rail-plugin="demo"]')!;
    const tag = row.querySelector('[data-rail-plugin-app-service]')!;
    // Named for what it is — one home-level service shared by the space's
    // workspaces — because "space service" beside a switch read as something
    // this row's own scope starts and stops.
    expect(tag.textContent).toBe('共享 home 后台');
    expect(tag.getAttribute('title')).toContain('由当前空间下的工作区共享');
    expect(row.textContent).toContain('共享 home 后台');
  });

  it('keeps the reader’s choice on screen while the server is still applying', async () => {
    let release: (value: PluginUsageResponse) => void = () => {};
    setUsage.mockImplementation(() => new Promise<PluginUsageResponse>((resolve) => { release = resolve; }));
    getUsage.mockResolvedValue(answer({ plugins: [item({ session_override: 'inherit', effective: true })] }));
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
      release(answer({ revision: 8, apply_state: 'pending', plugins: [item({ session_override: 'off', effective: false })] }));
      await new Promise((done) => setTimeout(done, 0));
    });
    await settle();
    expect(container.querySelector('[data-rail-plugins-applying]')!.textContent).toBe('正在应用，你的选择已经保存。');
  });

  it('reports the server’s errors and keeps the last good value after a failed save', async () => {
    setUsage.mockRejectedValue(new Error('session is read-only'));
    getUsage.mockResolvedValue(answer({ plugins: [item({ session_override: 'inherit', effective: true })] }));
    await render();
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();
    const error = container.querySelector('[data-rail-plugin-error]')!;
    expect(error.textContent).toContain('session is read-only');
    // The row returns to the server's answer rather than keeping a lie.
    expect(row.getAttribute('data-effective')).toBe('true');
    expect(row.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(false);
    // And the failure is recoverable from the row itself.
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();
    expect(setUsage).toHaveBeenLastCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'off' });
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

  it('keeps an unreadable scope quiet with a retry, never an alert', async () => {
    getUsage.mockRejectedValue(new Error('network down'));
    await render();
    await settle();
    await open();
    const line = container.querySelector('[data-rail-plugins-unavailable]')!;
    expect(line.textContent).toContain('暂时读不到当前对话的插件使用情况。');
    expect(line.querySelector('button')!.textContent).toBe('重试');
  });

  it('says what an empty scope means instead of showing a blank list', async () => {
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
  it('does not let a late failure land on the session now on screen', async () => {
    let rejectA: (error: Error) => void = () => {};
    setUsage.mockImplementation((input: { target: { session_id: string } }) =>
      input.target.session_id === 'sess-a'
        ? new Promise((_resolve, reject) => { rejectA = reject; })
        : Promise.resolve(answer()));
    getUsage.mockResolvedValue(answer({ plugins: [item({ session_override: 'inherit', effective: true })] }));
    await render('sess-a');
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'off' });

    // The reader switches to session B before session A's save answers.
    getUsage.mockResolvedValue(answer({
      target: { workspace_id: 'ws-b', name: 'Beta', root: 'C:/work/beta', session_id: 'sess-b' },
      plugins: [item({ session_override: 'inherit', effective: true })],
    }));
    await render('sess-b');
    await settle();
    await open();

    await act(async () => { rejectA(new Error('session A is read-only')); });
    await settle();
    // A's failure belongs to A. B's row must not claim it.
    expect(container.querySelector('[data-rail-plugin-error]')).toBeNull();
    expect(container.querySelector('[data-rail-plugins-scope]')!.textContent).toBe('本工作区 · Beta');
    getUsage.mockResolvedValue(answer());
    await render('sess-a');
    await settle();
    expect(container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!.dataset['effective']).toBe('true');
    expect(container.querySelector('[data-rail-plugin-error]')).toBeNull();
  });

  it('does not let a late success overwrite the session now on screen', async () => {
    let resolveA: (value: PluginUsageResponse) => void = () => {};
    setUsage.mockImplementation((input: { target: { session_id: string } }) =>
      input.target.session_id === 'sess-a'
        ? new Promise((resolve) => { resolveA = resolve; })
        : Promise.resolve(answer()));
    getUsage.mockResolvedValue(answer({ plugins: [item({ session_override: 'inherit', effective: true })] }));
    await render('sess-a');
    await settle();
    await open();
    const row = container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); });
    await settle();

    getUsage.mockResolvedValue(answer({
      target: { workspace_id: 'ws-b', name: 'Beta', root: 'C:/work/beta', session_id: 'sess-b' },
      plugins: [item({ session_override: 'inherit', effective: true })],
    }));
    await render('sess-b');
    await settle();
    await open();
    const before = container.querySelector('[data-rail-plugin="demo"]')!.getAttribute('data-effective');

    await act(async () => {
      resolveA(answer({ revision: 99, plugins: [item({ session_override: 'off', effective: false })] }));
      await new Promise((done) => setTimeout(done, 0));
    });
    await settle();
    // B still shows what B's own server said, not A's late answer.
    expect(container.querySelector('[data-rail-plugin="demo"]')!.getAttribute('data-effective')).toBe(before);
    expect(container.querySelector('[data-rail-plugin="demo"]')!.getAttribute('data-effective')).toBe('true');
    getUsage.mockResolvedValue(answer({ revision: 100 }));
    await render('sess-a');
    await settle();
    expect(container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!.dataset['effective']).toBe('true');
  });

  it('preserves a newer A request after the older A failure', async () => {
    let finishOld: () => void = () => {};
    let finishNew: () => void = () => {};
    setUsage.mockImplementation((input: { plugin_id: string; override: string }) => {
      if (input.plugin_id === 'other') return Promise.resolve(answer());
      if (input.override === 'off') return new Promise<PluginUsageResponse>((resolve, reject) => {
        finishOld = () => {
          reject(new Error('old A failure'));
          void resolve;
        };
      });
      return new Promise<PluginUsageResponse>((resolve) => {
        finishNew = () => { resolve(answer({ revision: 9, plugins: [item({ session_override: 'on', effective: true })] })); };
      });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getUsage.mockResolvedValue(answer());
    await render('sess-a', client);
    await settle();
    await open();
    await act(async () => { container.querySelector<HTMLInputElement>('[data-rail-plugin="demo"] input')!.click(); });
    await settle();
    getUsage.mockResolvedValue(answer({ target: { workspace_id: 'ws-b', name: 'Beta', root: 'C:/work/beta', session_id: 'sess-b' }, plugins: [item({ id: 'other' })] }));
    await render('sess-b', client);
    await settle();
    await act(async () => { container.querySelector<HTMLInputElement>('[data-rail-plugin="other"] input')!.click(); });
    await settle();
    getUsage.mockResolvedValue(answer({ revision: 8, plugins: [item({ session_override: 'off', effective: false })] }));
    await client.invalidateQueries({ queryKey: ['plugin-usage', 'sess-a'] });
    await render('sess-a', client);
    await settle();
    const toggle = container.querySelector<HTMLInputElement>('[data-rail-plugin="demo"] input')!;
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    await settle();
    expect(setUsage).toHaveBeenLastCalledWith({ target: { session_id: 'sess-a' }, plugin_id: 'demo', override: 'on' });
    await act(async () => { finishOld(); });
    await settle();
    // The old failure is not the row's truth: the newer on is.
    expect(container.querySelector('[data-rail-plugin-error]')).toBeNull();
    await act(async () => { finishNew(); });
    await settle();
    expect(container.querySelector<HTMLElement>('[data-rail-plugin="demo"]')!.dataset['override']).toBe('on');
  });

  it('addresses a restore-default write to the session that asked for it', async () => {
    getUsage.mockResolvedValue(answer({ plugins: [item({ session_override: 'off', effective: false })] }));
    setUsage.mockResolvedValue(answer({ plugins: [item({ session_override: 'inherit', effective: true })] }));
    await render('sess-b');
    await settle();
    await open();
    const restore = container.querySelector<HTMLButtonElement>('[data-rail-plugin="demo"] [data-rail-plugin-restore]')!;
    await act(async () => { restore.click(); });
    await settle();
    expect(setUsage).toHaveBeenCalledWith({ target: { session_id: 'sess-b' }, plugin_id: 'demo', override: 'inherit' });
  });
});