// @vitest-environment jsdom
/**
 * Settings list painted from a scripted catalog. Clicks run on the real
 * component. Chromium then measures that DOM at 1280 and 390 with the compiled
 * stylesheet. The catalog and check results are fixtures; this file does not
 * launch a CLI or read a credential.
 */
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorCatalogItem } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { ExternalEnginesList, resetEngineDiscoveryRunsForTests } from './ExternalEnginesSection';
import { engineChoices } from './profileEditor/engines';

const { client } = vi.hoisted(() => ({ client: {
  listExecutors: vi.fn(), checkExecutor: vi.fn(), patchConfig: vi.fn(), getConfig: vi.fn(),
} }));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client, scopeId: 'proof-scope', meta: { server_id: 'proof-server' } }),
  useOptionalConnection: () => ({ client, scopeId: 'proof-scope', meta: { server_id: 'proof-server' } }),
}));

const codex: ExecutorCatalogItem = {
  id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server', status: 'ready',
  check_status: 'warning', checked_at: '2026-10-12T00:00:00.000Z', check_stale: true,
  model_binding: 'mapped', thinking_binding: 'mapped', version: '0.158.0',
  connection: { command: 'codex.exe', login_status: 'logged_out', default_args: ['app-server'] },
};
const pending: ExecutorCatalogItem = {
  id: 'pending-acp', label: 'Pending CLI', protocol: 'acp-v1', status: 'unknown',
  model_binding: 'unavailable', thinking_binding: 'unavailable',
  connection: { command: 'pending', login_status: 'unknown', default_args: [] },
};
const missing: ExecutorCatalogItem = {
  id: 'missing-acp', label: 'Missing CLI', protocol: 'acp-v1', status: 'unavailable',
  check_status: 'unavailable', checked_at: '2026-10-12T00:05:00.000Z', check_stale: false,
  model_binding: 'unavailable', thinking_binding: 'unavailable',
  connection: { command: 'missing', login_status: 'unknown', install_hint: 'npm i -g missing-cli', default_args: [] },
};

let root: Root;
let container: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

beforeEach(() => {
  vi.resetAllMocks();
  resetEngineDiscoveryRunsForTests();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('external engine enable proof', () => {
  it('filters new choices, keeps each check on its own row, and fits wide and narrow', async () => {
    const config: { raw: Record<string, unknown> } = { raw: {
      agent_executor_display: { discovery_initialized: true },
      agent_executor_overrides: { 'codex-app-server': { show_in_profile_list: true } },
    } };
    client.listExecutors.mockResolvedValue({ items: [codex, pending, missing] });
    client.getConfig.mockImplementation(async () => structuredClone(config));
    client.patchConfig.mockImplementation(async (patch: { agent_executor_overrides?: Record<string, { show_in_profile_list?: boolean }> }) => {
      const next = patch.agent_executor_overrides;
      if (next !== undefined) {
        const current = (config.raw['agent_executor_overrides'] ?? {}) as Record<string, unknown>;
        config.raw['agent_executor_overrides'] = { ...current, ...next };
      }
      return {};
    });
    client.checkExecutor.mockImplementation(async (id: string) => {
      if (id === 'pending-acp') throw new Error('timed out');
      return { id, status: 'ready', command: 'codex.exe', resolved_args: [], login_status: 'logged_in', diagnostics: [] };
    });
    const catalog = [codex, pending, missing];
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queries}><I18nProvider><ExternalEnginesList /></I18nProvider></QueryClientProvider></MemoryRouter>);
    });
    await settle();

    // The row is a summary line; everything that changes one engine — the
    // offer switch, the check, the facts — lives in the panel the row opens.
    const panel = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-engine-panel="${id}"]`);
    const openPanel = async (id: string): Promise<HTMLElement> => {
      await act(async () => { container.querySelector<HTMLButtonElement>(`[data-engine-row="${id}"] [data-engine-open]`)!.click(); });
      await settle();
      const found = panel(id);
      if (found === null) throw new Error(`engine panel did not open: ${id}`);
      return found;
    };
    const closePanel = async (id: string): Promise<void> => {
      const close = document.querySelector<HTMLButtonElement>('[data-detail-close]');
      if (close === null) return;
      await act(async () => close.click());
      await settle();
    };

    expect([...container.querySelectorAll<HTMLElement>('[data-engine-row]')].map((row) => row.dataset['engineRow']))
      .toEqual(['codex-app-server', 'missing-acp', 'pending-acp']);
    expect(container.querySelector('[data-engine-row="codex-app-server"]')?.getAttribute('data-engine-health')).toBe('warning');
    expect(container.querySelector('[data-engine-row="missing-acp"]')?.getAttribute('data-engine-health')).toBe('missing');

    const codexPanel = await openPanel('codex-app-server');
    expect(codexPanel.querySelector<HTMLInputElement>('[data-engine-visible="codex-app-server"] input')!.checked).toBe(true);
    expect(codexPanel.querySelector('[data-engine-last-check]')?.textContent).toContain('Check passed with warnings');
    expect(codexPanel.querySelector('[data-engine-check-stale]')?.getAttribute('data-engine-check-stale')).toBe('true');
    await closePanel('codex-app-server');
    expect(panel('codex-app-server')).toBeNull();

    const pendingPanel = await openPanel('pending-acp');
    expect(pendingPanel.querySelector<HTMLInputElement>('[data-engine-visible="pending-acp"] input')!.checked).toBe(false);
    expect(pendingPanel.querySelector('[data-engine-last-check]')?.textContent).toContain('Not checked yet');
    await closePanel('pending-acp');

    const missingPanel = await openPanel('missing-acp');
    expect(missingPanel.querySelector<HTMLInputElement>('[data-engine-visible="missing-acp"] input')!.checked).toBe(false);
    expect(missingPanel.querySelector('[data-engine-last-check]')?.getAttribute('data-engine-last-check')).toBe('unavailable');
    await closePanel('missing-acp');
    expect(client.checkExecutor).not.toHaveBeenCalled();
    expect(engineChoices([], catalog, {
      overrides: config.raw['agent_executor_overrides'] as Record<string, unknown>,
      display: config.raw['agent_executor_display'] as Record<string, unknown>,
    })).toEqual(['', 'codex-app-server']);
    expect(engineChoices([], catalog, {
      overrides: config.raw['agent_executor_overrides'] as Record<string, unknown>,
      display: config.raw['agent_executor_display'] as Record<string, unknown>,
      retain: ['missing-acp'],
    })).toEqual(['', 'codex-app-server', 'missing-acp']);

    const checkPanel = await openPanel('pending-acp');
    await act(async () => checkPanel.querySelector<HTMLButtonElement>('[data-engine-check-button]')!.click());
    await settle();
    expect(checkPanel.querySelector('[data-engine-last-check]')?.getAttribute('data-engine-last-check')).toBe('failed');
    expect(checkPanel.querySelector('[data-engine-last-check]')?.textContent).toContain('timed out');
    await closePanel('pending-acp');
    const codexCheck = await openPanel('codex-app-server');
    expect(codexCheck.querySelector('[data-engine-last-check]')?.textContent).toContain('Check passed with warnings');
    expect(codexCheck.querySelector('[data-engine-last-check]')?.textContent).not.toContain('timed out');
    expect(client.checkExecutor).toHaveBeenCalledTimes(1);

    await act(async () => { codexCheck.querySelector<HTMLInputElement>('[data-engine-visible="codex-app-server"] input')!.click(); });
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ agent_executor_overrides: { 'codex-app-server': { show_in_profile_list: false } } });
    for (let i = 0; i < 40; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      if (codexCheck.querySelector('[data-engine-visible="codex-app-server"]')?.getAttribute('data-visible') === 'false') break;
    }
    expect(codexCheck.querySelector('[data-engine-visible="codex-app-server"]')?.getAttribute('data-visible')).toBe('false');
    expect(codexCheck.querySelector<HTMLInputElement>('[data-engine-visible="codex-app-server"] input')!.checked).toBe(false);
    await closePanel('codex-app-server');
    expect(engineChoices([], catalog, {
      overrides: config.raw['agent_executor_overrides'] as Record<string, unknown>,
      display: config.raw['agent_executor_display'] as Record<string, unknown>,
      retain: ['missing-acp'],
    })).toEqual(['', 'missing-acp']);

    expect(panel('codex-app-server')).toBeNull();
    const assets = [join(process.cwd(), 'dist', 'assets'), join(process.cwd(), 'apps', 'kiki-gui', 'dist', 'assets')].find((dir) => existsSync(dir));
    if (assets === undefined) throw new Error('compiled gui stylesheet is missing');
    const cssName = (await readdir(assets)).find((name) => name.startsWith('index-') && name.endsWith('.css'));
    if (cssName === undefined) throw new Error(`no compiled stylesheet in ${assets}`);
    const out = join(process.cwd(), process.cwd().endsWith('kiki-gui') ? '.tmp' : 'apps/kiki-gui/.tmp', 'engine-enable-proof');
    await mkdir(out, { recursive: true });
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      for (const [name, width] of [['wide-1280', 1280], ['narrow-390', 390]] as const) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        await page.setContent(
          `<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head>`
          + `<body class="bg-canvas text-ink"><div style="width:${width}px;padding:16px">${container.innerHTML}</div></body></html>`,
        );
        await page.addStyleTag({ path: join(assets, cssName) });
        // The raw id no longer rides beside the name (#14); the label box is the row's anchor.
        const labelBox = await page.locator('[data-engine-row="codex-app-server"] [data-engine-open] .font-medium').boundingBox();
        expect(labelBox).not.toBeNull();
        expect(await page.locator('[data-engine-row="missing-acp"] [data-engine-status]').getAttribute('data-engine-status')).toBe('missing');
        const overflow = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          width: window.innerWidth,
        }));
        expect(overflow.doc).toBeLessThanOrEqual(overflow.width + 1);
        await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
});
