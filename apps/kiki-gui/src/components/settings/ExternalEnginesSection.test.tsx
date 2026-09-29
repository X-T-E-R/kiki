// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorCatalogItem } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { engineHealth, ExternalEnginesList } from './ExternalEnginesSection';

const { client } = vi.hoisted(() => ({ client: { listExecutors: vi.fn(), checkExecutor: vi.fn() } }));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }), useOptionalConnection: () => ({ client }) }));

const codex: ExecutorCatalogItem = {
  id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server', status: 'ready', version: '0.158.0',
  model_binding: 'mapped', thinking_binding: 'mapped',
  capabilities: { prompt_deliveries: ['append', 'replace', 'preamble'], steer: 'native', permission: { via: 'turn_param', trust_engine_settings: false }, thinking_binding: true },
  connection: { command: 'codex.exe', source: 'desktop', login_command: ['codex', 'login'], login_status: 'unknown', default_args: ['app-server'] },
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

  it('never reads a ready binary as signed in', () => {
    expect(engineHealth(codex, undefined)).toBe('ready');
    expect(engineHealth({ ...codex, connection: { ...codex.connection!, login_status: 'logged_out' } }, undefined)).toBe('warning');
    expect(engineHealth({ ...codex, status: 'unknown' }, undefined)).toBe('unknown');
  });
});
