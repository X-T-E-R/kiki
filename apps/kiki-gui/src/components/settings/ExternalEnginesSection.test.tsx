// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorCatalogItem } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { engineHealth, ExternalEnginesList } from './ExternalEnginesSection';

const { client } = vi.hoisted(() => ({ client: {
  listExecutors: vi.fn(), checkExecutor: vi.fn(), patchConfig: vi.fn(),
} }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }), useOptionalConnection: () => ({ client }) }));

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
  client.patchConfig.mockResolvedValue({});
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider><ExternalEnginesList /></I18nProvider></QueryClientProvider>));
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
    expect(container.querySelector('[data-engine-row="gemini-acp"] [data-engine-missing]')?.textContent).toContain('npm i -g @google/gemini-cli');
  });

  it('keeps engine overrides collapsed, validates through preflight, and rejects relative paths', async () => {
    client.listExecutors.mockResolvedValue({ items: [codex] });
    client.checkExecutor.mockResolvedValue({
      id: 'codex-app-server', status: 'ready', version: '0.158.0', command: 'codex.exe',
      resolved_args: ['app-server'], login_status: 'logged_in', diagnostics: [],
    });
    await render();
    const row = container.querySelector<HTMLElement>('[data-engine-row="codex-app-server"]')!;
    row.querySelector<HTMLElement>('summary')!.click();
    await settle();
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
    const row = container.querySelector<HTMLElement>('[data-engine-row="codex-app-server"]')!;
    row.querySelector<HTMLElement>('summary')!.click();
    await settle();
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
    expect(row.querySelector('[data-engine-last-check]')?.getAttribute('data-engine-last-check')).toBe('none');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(client.checkExecutor).toHaveBeenCalledWith('codex-app-server');
    expect(row.getAttribute('data-engine-health')).toBe('warning');
    expect(row.querySelector('[data-engine-last-check]')?.textContent).toContain('Check passed with warnings');
    expect(row.querySelector('[data-engine-fact="login"]')?.textContent).toContain('Signed out');
    expect(row.querySelector('[data-engine-fact="login"]')?.textContent).toContain('codex login');
    expect(row.querySelector('[data-engine-diagnostic="warning"]')?.textContent).toContain('auth state was not found');
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
    await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(row.querySelector('[data-engine-setup]')?.getAttribute('data-engine-setup')).toBe('install');
    expect(row.querySelector('[data-engine-step="claude"]')?.getAttribute('data-step-state')).toBe('done');
    expect(row.querySelector('[data-engine-step="claude"] [data-step-path]')?.textContent).toBe('C:/bin/claude.exe');
    const program = row.querySelector('[data-engine-step="program"]')!;
    expect(program.getAttribute('data-step-state')).toBe('current');
    expect(program.textContent).toContain('npm install --prefix X adapter@0.84.0');
    expect(row.querySelector('[data-engine-step="signin"]')?.getAttribute('data-step-state')).toBe('pending');
    expect(row.querySelector('[data-engine-missing]')).toBeNull();
    expect(row.querySelector('[data-engine-check-button]')?.textContent).toBe('Check again');

    await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(row.querySelector('[data-engine-setup]')?.getAttribute('data-engine-setup')).toBe('signin');
    expect(row.querySelector('[data-engine-step="program"]')?.getAttribute('data-step-state')).toBe('done');
    expect(row.querySelector('[data-engine-fact="program"]')?.textContent).toContain('C:/kiki/tools/index.js');
    const signIn = row.querySelector('[data-engine-step="signin"]')!;
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

    await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(row.querySelector('[data-engine-summary]')?.textContent).toContain('API key from Claude Code settings.json');
    const signedIn = row.querySelector('[data-engine-step="signin"]')!;
    expect(signedIn.getAttribute('data-step-state')).toBe('done');
    expect(signedIn.textContent).toContain('API key from Claude Code settings.json');
    expect(row.getAttribute('data-engine-health')).toBe('ready');

    await act(async () => row.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    const noCredential = row.querySelector('[data-engine-step="signin"]')!;
    expect(noCredential.getAttribute('data-step-state')).toBe('current');
    expect(noCredential.querySelector('[data-engine-route="login"]')?.textContent).toContain('claude auth login');
    expect(noCredential.querySelector('[data-engine-route="api-key"]')?.textContent).toContain('export ANTHROPIC_API_KEY=YOUR_API_KEY');
    expect(noCredential.textContent).toContain('~/.claude/settings.json');
    expect(row.getAttribute('data-engine-health')).toBe('warning');
  });
});
