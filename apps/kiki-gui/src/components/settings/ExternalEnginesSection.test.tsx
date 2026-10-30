// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorCatalogItem } from '@kiki/protocol';
import type { ExecutorCheckResult } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { engineHealth, ExternalEnginesList, resetEngineDiscoveryRunsForTests } from './ExternalEnginesSection';

const { client } = vi.hoisted(() => ({ client: {
  listExecutors: vi.fn(), checkExecutor: vi.fn(), patchConfig: vi.fn(), getConfig: vi.fn(),
  removeExecutorRegistration: vi.fn(),
} }));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client, scopeId: 'local', meta: { server_id: 'server-1' } }),
  useOptionalConnection: () => ({ client, scopeId: 'local', meta: { server_id: 'server-1' } }),
}));

const codex: ExecutorCatalogItem = {
  id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server', status: 'ready', version: '0.158.0',
  model_binding: 'mapped', thinking_binding: 'mapped',
  capabilities: { prompt_deliveries: ['append', 'replace', 'preamble'], steer: 'native', permission: { via: 'turn_param', trust_engine_settings: false }, thinking_binding: true },
  connection: {
    command: 'codex.exe', source: 'desktop', login_command: ['codex', 'login'], login_status: 'unknown',
    home_env: 'CODEX_HOME', override: { args: [], env_keys: [] }, default_args: ['app-server'],
  },
};
const gemini: ExecutorCatalogItem = {
  id: 'gemini-acp', label: 'Gemini CLI', protocol: 'acp-v1', status: 'unavailable', model_binding: 'unavailable', thinking_binding: 'unavailable',
  connection: { command: 'gemini', install_hint: 'npm i -g @google/gemini-cli', login_status: 'unknown', default_args: [] },
};

let root: Root;
let container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

beforeEach(() => {
  vi.resetAllMocks();
  resetEngineDiscoveryRunsForTests();
  client.patchConfig.mockResolvedValue({});
  client.getConfig.mockResolvedValue({ raw: { agent_executor_display: { discovery_initialized: true } } });
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queries}><I18nProvider><ExternalEnginesList /></I18nProvider></QueryClientProvider></MemoryRouter>));
  await settle();
}

async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set ??
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** Opens one engine's detail panel (portaled to body) and returns its body. */
async function openEngine(id: string): Promise<HTMLElement> {
  const existing = document.querySelector<HTMLElement>(`[data-engine-panel="${id}"]`);
  if (existing !== null) return existing;
  const row = container.querySelector<HTMLElement>(`[data-engine-row="${id}"]`)!;
  await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-open]')!.click());
  await settle();
  return document.querySelector<HTMLElement>(`[data-engine-panel="${id}"]`)!;
}

async function closeEngine(): Promise<void> {
  const close = document.querySelector<HTMLButtonElement>('[data-detail-close]');
  if (close === null) return;
  await act(async () => close.click());
  await settle();
}

describe('external engines connection kind', () => {
  it('lists engines without the native one and states health in words', async () => {
    client.listExecutors.mockResolvedValue({ items: [
      { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' }, codex, gemini,
    ] });
    await render();
    const rows = [...container.querySelectorAll<HTMLElement>('[data-engine-row]')].map((row) => row.dataset['engineRow']);
    expect(rows).toEqual(['codex-app-server', 'gemini-acp']);
    expect(container.querySelector('[data-engine-row="codex-app-server"] [data-engine-summary]')?.textContent).toContain('Sign-in unknown');
    expect(container.querySelector('[data-engine-row="gemini-acp"]')?.getAttribute('data-engine-health')).toBe('missing');
    expect((await openEngine('gemini-acp')).querySelector('[data-engine-missing]')?.textContent).toContain('npm i -g @google/gemini-cli');
    expect(client.checkExecutor).not.toHaveBeenCalled();
  });

  it('keeps engine overrides collapsed, validates through preflight, and rejects relative paths', async () => {
    client.listExecutors.mockResolvedValue({ items: [codex] });
    client.checkExecutor.mockResolvedValue({
      id: 'codex-app-server', status: 'ready', version: '0.158.0', command: 'codex.exe',
      resolved_args: ['app-server'], login_status: 'logged_in', diagnostics: [],
    });
    await render();
    const row = await openEngine('codex-app-server');
    const advanced = row.querySelector<HTMLDetailsElement>('[data-engine-advanced]')!;
    const binPath = row.querySelector<HTMLInputElement>('[data-engine-override="bin-path"]')!;
    expect(advanced.open).toBe(false);
    expect(binPath.placeholder).toBe('Auto-detected: codex.exe');

    await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-override-validate]')!.click());
    await settle();
    expect(client.checkExecutor).toHaveBeenCalledWith('codex-app-server');
    expect(row.querySelector('[data-engine-advanced] [data-feedback-tone="success"]')?.textContent).toContain('Check passed');

    advanced.querySelector<HTMLElement>('summary')!.click();
    await setValue(binPath, 'relative/codex.exe');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-override-save]')!.click());
    await settle();
    expect(client.patchConfig).not.toHaveBeenCalled();
    expect(row.querySelector('[data-engine-advanced] [data-feedback-tone="error"]')?.textContent).toContain('absolute path');
  });

  it('saves overrides, reruns the check, and surfaces a missing-program reason', async () => {
    client.listExecutors.mockResolvedValue({ items: [codex] });
    client.checkExecutor.mockResolvedValue({
      id: 'codex-app-server', status: 'unavailable', command: 'C:/missing/codex.exe',
      resolved_args: [], login_status: 'unknown',
      diagnostics: [{ severity: 'error', message: 'C:/missing/codex.exe was not found.' }],
    });
    await render();
    const row = await openEngine('codex-app-server');
    const advanced = row.querySelector<HTMLDetailsElement>('[data-engine-advanced]')!;
    advanced.querySelector<HTMLElement>('summary')!.click();
    await setValue(row.querySelector<HTMLInputElement>('[data-engine-override="bin-path"]')!, 'C:/missing/codex.exe');

    await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-override-save]')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({
      agent_executor_overrides: {
        'codex-app-server': { bin_path: 'C:/missing/codex.exe', home_dir: null, args: [], env: undefined },
      },
    });
    expect(client.checkExecutor).toHaveBeenCalledWith('codex-app-server');
    expect(row.querySelector('[data-engine-advanced] [data-feedback-tone="error"]')?.textContent).toContain('was not found');
  });

  it('runs the descriptor preflight and shows its result and diagnostics', async () => {
    client.listExecutors.mockResolvedValue({ items: [codex] });
    client.checkExecutor.mockResolvedValue({
      id: 'codex-app-server', status: 'warning', version: '0.158.0', command: 'codex.exe', resolved_args: ['app-server'], login_status: 'logged_out',
      diagnostics: [{ severity: 'warning', message: 'Codex auth state was not found.' }],
    });
    await render();
    const row = container.querySelector<HTMLElement>('[data-engine-row="codex-app-server"]')!;
    const panel = await openEngine('codex-app-server');
    expect(panel.querySelector('[data-engine-last-check]')?.getAttribute('data-engine-last-check')).toBe('none');
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(client.checkExecutor).toHaveBeenCalledWith('codex-app-server');
    expect(row.getAttribute('data-engine-health')).toBe('warning');
    expect(panel.querySelector('[data-engine-last-check]')?.textContent).toContain('Check passed with warnings');
    expect(panel.querySelector('[data-engine-fact="login"]')?.textContent).toContain('Signed out');
    expect(panel.querySelector('[data-engine-fact="login"]')?.textContent).toContain('codex login');
    expect(panel.querySelector('[data-engine-diagnostic="warning"]')?.textContent).toContain('auth state was not found');
  });

  it('guides setup step by step from the check requirements', async () => {
    const claude: ExecutorCatalogItem = {
      id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'unavailable', model_binding: 'mapped', thinking_binding: 'unavailable',
      connection: { command: 'claude-agent-acp', login_command: ['claude', 'auth', 'login'], login_status: 'unknown', default_args: [] },
    };
    const cli = { id: 'claude', label: 'Claude Code CLI', role: 'dependency' as const, install_hint: 'npm install -g @anthropic-ai/claude-code' };
    const adapter = { id: 'claude-acp', label: 'claude-agent-acp', role: 'program' as const, install_hint: 'npm install --prefix X adapter@0.84.0' };
    const base = { id: 'claude-acp', command: '', resolved_args: [], diagnostics: [] };
    client.listExecutors.mockResolvedValue({ items: [claude] });
    client.checkExecutor
      .mockResolvedValueOnce({ ...base, status: 'unavailable', login_status: 'unknown',
        requirements: [{ ...cli, status: 'ok', version: '2.1.220', path: 'C:/bin/claude.exe' }, { ...adapter, status: 'missing' }] })
      .mockResolvedValueOnce({ ...base, status: 'ready', version: '0.84.0', login_status: 'logged_out',
        requirements: [{ ...cli, status: 'ok', version: '2.1.220' }, { ...adapter, status: 'ok', version: '0.84.0', path: 'C:/kiki/tools/index.js' }] });
    await render();
    const row = container.querySelector<HTMLElement>('[data-engine-row="claude-acp"]')!;
    const panel = await openEngine('claude-acp');
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(panel.querySelector('[data-engine-setup]')?.getAttribute('data-engine-setup')).toBe('install');
    expect(panel.querySelector('[data-engine-step="claude"]')?.getAttribute('data-step-state')).toBe('done');
    expect(panel.querySelector('[data-engine-step="claude"] [data-step-path]')?.textContent).toBe('C:/bin/claude.exe');
    const program = panel.querySelector('[data-engine-step="program"]')!;
    expect(program.getAttribute('data-step-state')).toBe('current');
    expect(program.textContent).toContain('npm install --prefix X adapter@0.84.0');
    expect(panel.querySelector('[data-engine-step="signin"]')?.getAttribute('data-step-state')).toBe('pending');
    expect(panel.querySelector('[data-engine-missing]')).toBeNull();
    expect(panel.querySelector('[data-engine-check-button]')?.textContent).toBe('Check again');

    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(panel.querySelector('[data-engine-setup]')?.getAttribute('data-engine-setup')).toBe('signin');
    expect(panel.querySelector('[data-engine-step="program"]')?.getAttribute('data-step-state')).toBe('done');
    expect(panel.querySelector('[data-engine-fact="program"]')?.textContent).toContain('C:/kiki/tools/index.js');
    const signIn = panel.querySelector('[data-engine-step="signin"]')!;
    expect(signIn.getAttribute('data-step-state')).toBe('current');
    expect(signIn.textContent).toContain('claude auth login');
    expect(row.getAttribute('data-engine-health')).toBe('warning');
  });

  it('never reads a ready binary as signed in', () => {
    expect(engineHealth(codex, undefined)).toBe('ready');
    expect(engineHealth({ ...codex, connection: { ...codex.connection!, login_status: 'logged_out' } }, undefined)).toBe('warning');
    expect(engineHealth({ ...codex, status: 'unknown' }, undefined)).toBe('unknown');
  });

  it('names the credential Claude Code reuses, and offers both routes when it has none', async () => {
    const claude: ExecutorCatalogItem = {
      id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready', model_binding: 'mapped', thinking_binding: 'unavailable',
      connection: { command: 'claude-agent-acp', login_command: ['claude', 'auth', 'login'], login_status: 'unknown', api_key_env: 'ANTHROPIC_API_KEY', default_args: [] },
    };
    const cli = { id: 'claude', label: 'Claude Code CLI', role: 'dependency' as const, status: 'ok' as const, version: '2.1.220', path: 'C:/bin/claude.exe' };
    const adapter = { id: 'claude-acp', label: 'claude-agent-acp', role: 'program' as const, status: 'ok' as const, version: '0.84.0', path: 'C:/kiki/tools/index.js' };
    const base = { id: 'claude-acp', command: 'claude-agent-acp', resolved_args: [], diagnostics: [], requirements: [cli, adapter] };
    client.listExecutors.mockResolvedValue({ items: [claude] });
    client.checkExecutor
      .mockResolvedValueOnce({ ...base, status: 'ready', version: '0.84.0', login_status: 'logged_in',
        credential_source: 'settings_env', credential_detail: 'C:/Users/me/.claude/settings.json#env.ANTHROPIC_API_KEY' })
      .mockResolvedValueOnce({ ...base, status: 'warning', version: '0.84.0', login_status: 'logged_out', credential_source: 'none' });
    await render();
    const row = container.querySelector<HTMLElement>('[data-engine-row="claude-acp"]')!;
    const panel = await openEngine('claude-acp');

    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(row.querySelector('[data-engine-summary]')?.textContent).toContain('API key from Claude Code settings.json');
    const signedIn = panel.querySelector('[data-engine-step="signin"]')!;
    expect(signedIn.getAttribute('data-step-state')).toBe('done');
    expect(signedIn.textContent).toContain('API key from Claude Code settings.json');
    expect(row.getAttribute('data-engine-health')).toBe('ready');

    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    const noCredential = panel.querySelector('[data-engine-step="signin"]')!;
    expect(noCredential.getAttribute('data-step-state')).toBe('current');
    expect(noCredential.querySelector('[data-engine-route="login"]')?.textContent).toContain('claude auth login');
    expect(noCredential.querySelector('[data-engine-route="api-key"]')?.textContent).toContain('export ANTHROPIC_API_KEY=YOUR_API_KEY');
    expect(noCredential.textContent).toContain('~/.claude/settings.json');
    expect(row.getAttribute('data-engine-health')).toBe('warning');
  });

  it('shows a remembered check per engine and leaves an unchecked engine unchecked', async () => {
    const remembered: ExecutorCatalogItem = {
      ...codex, check_status: 'warning', checked_at: '2026-10-12T00:00:00.000Z', check_stale: true,
      connection: { ...codex.connection!, login_status: 'logged_out' },
    };
    const pending: ExecutorCatalogItem = {
      ...gemini, id: 'pending-acp', label: 'Pending', status: 'unknown',
      connection: { command: 'pending', login_status: 'unknown', default_args: [] },
    };
    client.listExecutors.mockResolvedValue({ items: [remembered, pending] });
    await render();
    const codexRow = container.querySelector('[data-engine-row="codex-app-server"]')!;
    const pendingRow = container.querySelector('[data-engine-row="pending-acp"]')!;
    expect(codexRow.getAttribute('data-engine-health')).toBe('warning');
    const codexPanel = await openEngine('codex-app-server');
    expect(codexPanel.querySelector('[data-engine-last-check]')?.getAttribute('data-engine-last-check')).toBe('warning');
    expect(codexPanel.querySelector('[data-engine-last-check]')?.textContent).toContain('Check passed with warnings');
    expect(codexPanel.querySelector('[data-engine-check-stale]')?.getAttribute('data-engine-check-stale')).toBe('true');
    await closeEngine();
    expect(pendingRow.getAttribute('data-engine-health')).toBe('unknown');
    const pendingPanel = await openEngine('pending-acp');
    expect(pendingPanel.querySelector('[data-engine-last-check]')?.textContent).toContain('Not checked yet');
    expect(client.checkExecutor).not.toHaveBeenCalled();
  });

  it('keeps the on switch off until the user turns it on, and an explicit off stays off after a successful save', async () => {
    client.listExecutors.mockResolvedValue({ items: [codex] });
    await render();
    const panel = await openEngine('codex-app-server');
    const toggle = panel.querySelector<HTMLInputElement>('[data-engine-visible="codex-app-server"] input')!;
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ agent_executor_overrides: { 'codex-app-server': { show_in_profile_list: true } } });

    client.patchConfig.mockClear();
    client.getConfig.mockResolvedValue({ raw: {
      agent_executor_display: { discovery_initialized: true },
      agent_executor_overrides: { 'codex-app-server': { show_in_profile_list: false } },
    } });
    client.checkExecutor.mockResolvedValue({
      id: 'codex-app-server', status: 'ready', command: 'codex.exe', resolved_args: [], login_status: 'logged_in', diagnostics: [],
    });
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-override-save]')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledTimes(1);
    expect(client.patchConfig).toHaveBeenCalledWith({
      agent_executor_overrides: { 'codex-app-server': { bin_path: null, home_dir: null, args: [], env: undefined } },
    });
  });

  it('turns an engine on after the first successful setup and not after a failed one', async () => {
    client.listExecutors.mockResolvedValue({ items: [codex] });
    client.getConfig.mockResolvedValue({ raw: { agent_executor_display: { discovery_initialized: true } } });
    client.checkExecutor.mockResolvedValue({
      id: 'codex-app-server', status: 'ready', version: '0.158.0', command: 'codex.exe', resolved_args: ['app-server'], login_status: 'logged_in', diagnostics: [],
    });
    await render();
    const panel = await openEngine('codex-app-server');
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-override-save]')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenNthCalledWith(1, {
      agent_executor_overrides: { 'codex-app-server': { bin_path: null, home_dir: null, args: [], env: undefined } },
    });
    expect(client.patchConfig).toHaveBeenNthCalledWith(2, {
      agent_executor_overrides: { 'codex-app-server': { show_in_profile_list: true } },
    });

    client.patchConfig.mockClear();
    client.checkExecutor.mockResolvedValue({
      id: 'codex-app-server', status: 'unavailable', command: 'codex.exe', resolved_args: [], login_status: 'unknown', diagnostics: [],
    });
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-override-save]')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledTimes(1);
  });

  it('checks each engine on first import, enables only successes, and does not repeat or restore an off', async () => {
    const off = { ...gemini, id: 'off-acp', label: 'Off', status: 'unknown' as const };
    const pending = { ...gemini, id: 'slow-acp', label: 'Slow', status: 'unknown' as const, connection: { command: 'slow', login_status: 'unknown' as const, default_args: [] } };
    const catalog = new Map<string, ExecutorCatalogItem>([['codex-app-server', codex], ['off-acp', off], ['slow-acp', pending]]);
    const config: { raw: Record<string, unknown> } = { raw: { agent_executor_overrides: { 'off-acp': { show_in_profile_list: false } } } };
    client.listExecutors.mockImplementation(async () => ({ items: [...catalog.values()] }));
    client.getConfig.mockImplementation(async () => config);
    client.patchConfig.mockImplementation(async (patch: { agent_executor_display?: { discovery_initialized?: boolean } }) => {
      if (patch.agent_executor_display?.discovery_initialized === true) {
        config.raw['agent_executor_display'] = { discovery_initialized: true };
      }
      return {};
    });
    let releaseSlow: (value: ExecutorCheckResult) => void = () => {};
    client.checkExecutor.mockImplementation(async (id: string) => {
      if (id === 'slow-acp') return new Promise<ExecutorCheckResult>((resolve) => { releaseSlow = resolve; });
      if (id === 'off-acp') return { id, status: 'ready', command: 'off', resolved_args: [], login_status: 'logged_in', diagnostics: [] };
      return { id, status: 'unavailable', command: 'codex.exe', resolved_args: [], login_status: 'unknown', diagnostics: [{ severity: 'error', message: 'missing' }] };
    });
    await render();
    await until(() => client.checkExecutor.mock.calls.length >= 2);
    const slowPanel = await openEngine('slow-acp');
    expect(slowPanel.querySelector('[data-engine-last-check]')?.textContent).toContain('Not checked yet');
    releaseSlow({ id: 'slow-acp', status: 'ready', command: 'slow', resolved_args: [], login_status: 'logged_in', diagnostics: [] });
    await until(() => client.patchConfig.mock.calls.some((call) => {
      const body = call[0] as { agent_executor_overrides?: Record<string, { show_in_profile_list?: boolean }> };
      return body.agent_executor_overrides?.['slow-acp']?.show_in_profile_list === true;
    }));
    const enabled = client.patchConfig.mock.calls.map((call) => call[0] as { agent_executor_overrides?: Record<string, { show_in_profile_list?: boolean }> });
    expect(enabled.some((body) => body.agent_executor_overrides?.['codex-app-server']?.show_in_profile_list === true)).toBe(false);
    expect(enabled.some((body) => body.agent_executor_overrides?.['off-acp'] !== undefined)).toBe(false);
    expect(client.checkExecutor).toHaveBeenCalledTimes(3);
    await act(async () => { root.unmount(); });
    resetEngineDiscoveryRunsForTests();
    root = createRoot(container);
    await render();
    expect(client.checkExecutor).toHaveBeenCalledTimes(3);
  });

  it('shows one engine timing out without marking the engine that already succeeded', async () => {
    const bad = { ...gemini, id: 'bad-acp', label: 'Bad', status: 'unknown' as const, connection: { command: 'bad', login_status: 'unknown' as const, default_args: [] } };
    client.listExecutors.mockResolvedValue({ items: [codex, bad] });
    client.checkExecutor.mockImplementation(async (id: string) => {
      if (id === 'bad-acp') throw new Error('timed out');
      return { id, status: 'ready', command: 'codex.exe', resolved_args: [], login_status: 'logged_in', diagnostics: [] };
    });
    await render();
    const badRow = container.querySelector<HTMLElement>('[data-engine-row="bad-acp"]')!;
    const codexRow = container.querySelector<HTMLElement>('[data-engine-row="codex-app-server"]')!;
    const badPanel = await openEngine('bad-acp');
    await act(async () => badPanel.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(badRow.getAttribute('data-engine-health')).toBe('warning');
    expect(badPanel.querySelector('[data-engine-last-check]')?.getAttribute('data-engine-last-check')).toBe('failed');
    expect(badPanel.querySelector('[data-engine-last-check]')?.textContent).toContain('timed out');
    expect(codexRow.getAttribute('data-engine-health')).not.toBe('warning');
    await closeEngine();
    const codexPanel = await openEngine('codex-app-server');
    expect(codexPanel.querySelector('[data-engine-last-check]')?.textContent).not.toContain('timed out');
  });

  it('removes only a custom registration and shows why owned files stay', async () => {
    const custom: ExecutorCatalogItem = {
      id: 'agy-cli-909', label: 'AGY CLI 909', protocol: 'acp-v1', status: 'ready',
      model_binding: 'unavailable', thinking_binding: 'unavailable',
      connection: { command: 'node', source: 'local-adapter', login_status: 'unknown', default_args: [] },
    };
    client.listExecutors.mockResolvedValue({ items: [codex, custom] });
    client.getConfig.mockResolvedValue({ raw: {
      agent_executor_display: { discovery_initialized: true },
      agent_executors: { 'agy-cli-909': { protocol: 'acp-v1', source: 'local-adapter' } },
    } });
    client.removeExecutorRegistration.mockResolvedValue({
      id: 'agy-cli-909', registration_removed: true, builtin_retained: false,
      resources: 'retained', reason: 'a live or recoverable binding is still present',
    });
    await render();
    const codexPanel = await openEngine('codex-app-server');
    expect(codexPanel.querySelector('[data-engine-remove-registration]')).toBeNull();
    await closeEngine();

    const panel = await openEngine('agy-cli-909');
    expect(panel.querySelector('[data-engine-registration="agy-cli-909"]')).not.toBeNull();
    expect(client.removeExecutorRegistration).not.toHaveBeenCalled();

    await act(async () => panel.querySelector<HTMLButtonElement>('[data-engine-remove-registration]')!.click());
    await settle();
    expect(client.removeExecutorRegistration).toHaveBeenCalledTimes(1);
    expect(client.removeExecutorRegistration).toHaveBeenCalledWith('agy-cli-909');
    const note = container.querySelector('[data-engine-removal-result]')?.textContent ?? '';
    expect(note).toContain('Custom registration removed.');
    expect(note).toContain('a live or recoverable binding is still present');
    expect(note).not.toContain('Owned adapter files were removed.');
  });

  it('renders MCP injection switch in engine connection details and patches on/off/inherit delta', async () => {
    let rawConfig: Record<string, any> = {
      agent_executor_display: { discovery_initialized: true },
      agent_executor_overrides: {
        'codex-app-server': {
          defaults: {
            model_alias: 'gpt-5-codex',
          },
        },
      },
    };
    client.getConfig.mockImplementation(async () => ({ raw: rawConfig }));
    client.patchConfig.mockImplementation(async (patch: any) => {
      const overrides = patch.agent_executor_overrides?.['codex-app-server'];
      if (overrides?.defaults) {
        const nextDefaults = {
          ...rawConfig['agent_executor_overrides']?.['codex-app-server']?.defaults,
          ...overrides.defaults,
        };
        if (overrides.defaults.inject_kiki_mcp === null) {
          delete nextDefaults.inject_kiki_mcp;
        }
        rawConfig = {
          ...rawConfig,
          agent_executor_overrides: {
            'codex-app-server': {
              defaults: nextDefaults,
            },
          },
        };
      }
      return {};
    });

    const codexWithMcp: ExecutorCatalogItem = {
      ...codex,
      kiki_mcp: {
        effective: false,
        source: 'harness-default',
        applies: 'next_binding',
        precedence: ['session', 'profile', 'harness-settings', 'harness-default'],
        support: { state: 'supported', fact: 'ACP protocol supports MCP stdio transport' },
      },
    };
    client.listExecutors.mockResolvedValue({ items: [codexWithMcp] });
    await render();
    const panel = await openEngine('codex-app-server');

    const switchEl = panel.querySelector<HTMLElement>('[data-engine-mcp-switch="codex-app-server"]')!;
    expect(switchEl).not.toBeNull();
    expect(switchEl.getAttribute('data-mcp-choice')).toBe('inherit');
    expect(switchEl.getAttribute('data-mcp-supported')).toBe('true');

    // Click "With Kiki tools" (kiki -> inject_kiki_mcp: true)
    const kikiBtn = switchEl.querySelector<HTMLButtonElement>('[data-mcp-option="kiki"]')!;
    expect(kikiBtn).not.toBeNull();
    await act(async () => kikiBtn.click());
    await settle();

    expect(client.patchConfig).toHaveBeenCalledWith({
      agent_executor_overrides: {
        'codex-app-server': {
          defaults: {
            inject_kiki_mcp: true,
          },
        },
      },
    });
    expect(switchEl.getAttribute('data-mcp-choice')).toBe('on');

    // Click "Plain engine" (plain -> inject_kiki_mcp: false)
    const plainBtn = switchEl.querySelector<HTMLButtonElement>('[data-mcp-option="plain"]')!;
    await act(async () => plainBtn.click());
    await settle();

    expect(client.patchConfig).toHaveBeenCalledWith({
      agent_executor_overrides: {
        'codex-app-server': {
          defaults: {
            inject_kiki_mcp: false,
          },
        },
      },
    });
    expect(switchEl.getAttribute('data-mcp-choice')).toBe('off');

    // Click "Use engine default" ([data-mcp-restore] -> inject_kiki_mcp: null)
    const restoreBtn = switchEl.querySelector<HTMLButtonElement>('[data-mcp-restore]')!;
    expect(restoreBtn).not.toBeNull();
    await act(async () => restoreBtn.click());
    await settle();

    expect(client.patchConfig).toHaveBeenCalledWith({
      agent_executor_overrides: {
        'codex-app-server': {
          defaults: {
            inject_kiki_mcp: null,
          },
        },
      },
    });
    expect(switchEl.getAttribute('data-mcp-choice')).toBe('inherit');
  });

  it('renders unsupported badge and fact when harness MCP is unsupported without offering interactive switch', async () => {
    const unsuppEngine: ExecutorCatalogItem = {
      ...codex,
      id: 'unsupported-engine',
      label: 'Old Engine',
      kiki_mcp: {
        effective: false,
        source: 'harness-default',
        applies: 'next_binding',
        precedence: ['session', 'profile', 'harness-settings', 'harness-default'],
        support: { state: 'unsupported', fact: 'This engine has no tool injection bridge' },
      },
    };
    client.listExecutors.mockResolvedValue({ items: [unsuppEngine] });
    client.getConfig.mockResolvedValue({ raw: {
      agent_executor_display: { discovery_initialized: true },
    } });
    await render();
    const panel = await openEngine('unsupported-engine');

    const switchEl = panel.querySelector<HTMLElement>('[data-engine-mcp-switch="unsupported-engine"]')!;
    expect(switchEl).not.toBeNull();
    expect(switchEl.getAttribute('data-mcp-supported')).toBe('false');
    expect(switchEl.querySelector('[data-mcp-unsupported-badge]')).not.toBeNull();
    expect(switchEl.textContent).toContain('This engine has no tool injection bridge');
    expect(switchEl.querySelector('[data-mcp-option]')).toBeNull();
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    if (predicate()) return;
  }
  throw new Error('condition was not met');
}
