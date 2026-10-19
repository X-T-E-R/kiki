// @vitest-environment jsdom
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecutorModelCatalogResponse } from '@kiki/protocol';
import { writeSettings } from '@kiki/session-core/settings';
import { I18nProvider } from '../i18n';
import { Composer } from './Composer';
import { resolveCompiledGuiStylesheet } from '../testSupport/compiledGuiStylesheet';

const getExecutorModels = vi.fn();
const refreshExecutorModels = vi.fn();
const listModels = vi.fn();
const listExecutors = vi.fn();
const getConfig = vi.fn();
const listNamedAgentProfiles = vi.fn();
const listSessionSkills = vi.fn();
const listWorkspaceSkills = vi.fn();
const listDraftSkills = vi.fn();
const getAgentCapabilities = vi.fn();
const meta = vi.fn();

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    connectionId: 'local',
    connectionSource: 'desktop',
    scopeId: 'desktop',
    meta: { server_id: 'server-a' },
    config: { url: 'http://127.0.0.1:1234' },
    client: {
      listModels, listExecutors, getConfig, listNamedAgentProfiles, listSessionSkills,
      listWorkspaceSkills, listDraftSkills, getAgentCapabilities, meta,
      klient: { rest: { executors: { getModels: getExecutorModels, refreshModels: refreshExecutorModels } } },
    },
  }),
  useOptionalConnection: () => ({ connectionSource: 'desktop' }),
}));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('../host/vscode', () => ({ isVscodeWebview: () => false, vscodeHost: { preparePrompt: async (content: string) => content } }));

const RAW_ID = 'gemini-4-argon-medium';
const bound = {
  executor: 'agy-cli-909',
  profile: undefined,
  overrides: { thinking: 'medium' },
};

function catalog(modelSwitch: ExecutorModelCatalogResponse['effective']['controls']['model_switch']): ExecutorModelCatalogResponse {
  return {
    executor_id: 'agy-cli-909',
    source: 'cli_probe',
    provenance: 'read_only_cli_probe',
    revision: 'rev-909',
    apply_state: 'ready',
    observed_at: Date.now(),
    executor_version: 'agy-cli-acp 0.1.0',
    catalog_program_version: 'agy 1.3.4',
    effective: {
      models: { state: 'ready', values: [RAW_ID, 'gemini-4-argon-high'] },
      thinking_levels: { state: 'unknown' },
      context: { state: 'unknown' },
      controls: {
        model_switch: modelSwitch,
        thinking_switch: { applicability: 'unknown', apply_state: 'unknown' },
        manual_compact: { applicability: 'unsupported', apply_state: 'unsupported' },
      },
    },
  };
}

let root: Root;
let container: HTMLDivElement;
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

beforeEach(() => {
  vi.clearAllMocks();
  writeSettings({ sendShortcut: 'enter' });
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listModels.mockResolvedValue({ items: [] });
  listExecutors.mockResolvedValue({ items: [
    { id: 'agy-cli-909', label: 'AGY CLI 909', protocol: 'acp-v1', status: 'ready', model_binding: 'unavailable', thinking_binding: 'unavailable' },
  ] });
  getConfig.mockResolvedValue({ raw: { agent_executor_display: { discovery_initialized: true } } });
  listNamedAgentProfiles.mockResolvedValue({ items: [] });
  listSessionSkills.mockResolvedValue({ skills: [] });
  listWorkspaceSkills.mockResolvedValue({ skills: [] });
  listDraftSkills.mockResolvedValue({ skills: [] });
  getAgentCapabilities.mockResolvedValue({ context: 'live', owner: { agent_id: 'main' }, available: true, targets: [] });
  meta.mockResolvedValue({ experimental_flags: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(props: Partial<Parameters<typeof Composer>[0]>) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queries}>
        <I18nProvider>
          <MemoryRouter>
            <Composer
              busy={false}
              disabled={false}
              value=""
              onChange={() => {}}
              model={undefined}
              defaultModel={undefined}
              serverDefaultModel={undefined}
              modelSource="session"
              agentProfileCatalogMode={{ mode: 'global' }}
              permissionMode="manual"
              planMode={false}
              goalObjective=""
              efforts={undefined}
              effort={undefined}
              attachments={[]}
              onChangeAttachments={() => {}}
              onChangeModel={() => {}}
              onChangePermissionMode={() => {}}
              onChangePlanMode={() => {}}
              onChangeGoalObjective={() => {}}
              onChangeEffort={() => {}}
              onSend={() => {}}
              {...props}
            />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

describe('external executor model writability', () => {
  it('writes a probed raw id onto the execution override and keeps thinking', async () => {
    getExecutorModels.mockResolvedValue(catalog({ advertised: true, applicability: 'fresh_binding', apply_state: 'unknown' }));
    const onChangeExecution = vi.fn();
    const onChangeModel = vi.fn();
    await render({ variant: 'subagent', boundExecution: bound, onChangeExecution, onChangeModel });
    await act(async () => container.querySelector<HTMLButtonElement>('#composer-model-select')!.click());
    await settle();
    const option = container.querySelector<HTMLElement>(`[data-option-value="${RAW_ID}"]`);
    expect(option).not.toBeNull();
    expect(container.textContent).not.toContain('not-a-vendor-model');
    await act(async () => option!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(onChangeModel).not.toHaveBeenCalled();
    expect(onChangeExecution).toHaveBeenCalledWith({
      executor: 'agy-cli-909',
      profile: undefined,
      overrides: { thinking: 'medium', model: RAW_ID },
    });
  });

  it('selects the same raw id from the execution menu', async () => {
    getExecutorModels.mockResolvedValue(catalog({ advertised: true, applicability: 'fresh_binding', apply_state: 'unknown' }));
    const onChangeExecution = vi.fn();
    const onChangeModel = vi.fn();
    const execution = { ...bound };
    await render({ execution, onChangeExecution, onChangeModel });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-execution-trigger]')!.click());
    await settle();
    const option = container.querySelector<HTMLElement>(`[data-execution-model="${RAW_ID}"]`);
    expect(option).not.toBeNull();
    expect(container.textContent).not.toContain('not-a-vendor-model');
    await shot('model-menu', container, 280);
    await act(async () => option!.click());
    await settle();
    expect(onChangeModel).not.toHaveBeenCalled();
    const payload = onChangeExecution.mock.calls[0]?.[0] as { overrides: { model?: string; thinking?: string | null } };
    expect(payload.overrides.model).toBe(RAW_ID);
    expect(payload.overrides.thinking).toBe('medium');
    expect(payload.overrides).not.toHaveProperty('thinking', undefined);
    expect(payload.overrides.thinking).not.toBe('');
  });

  it('drops an effort the advertised levels do not list, including an empty advertisement', async () => {
    const observed = catalog({ advertised: true, applicability: 'fresh_binding', apply_state: 'unknown' });
    observed.effective.thinking_levels = { state: 'ready', values: ['medium'] };
    observed.effective.controls.thinking_switch = { applicability: 'fresh_binding', apply_state: 'applied' };
    getExecutorModels.mockResolvedValue(observed);
    const onChangeExecution = vi.fn();
    const execution = { executor: 'agy-cli-909', profile: undefined, overrides: { thinking: 'high' } };
    await render({ execution, onChangeExecution, onChangeModel: vi.fn() });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-execution-trigger]')!.click());
    await settle();
    await act(async () => container.querySelector<HTMLElement>(`[data-execution-model="${RAW_ID}"]`)!.click());
    await settle();
    const dropped = onChangeExecution.mock.calls[0]?.[0] as { overrides: { model?: string; thinking?: string | null } };
    expect(dropped.overrides.model).toBe(RAW_ID);
    expect(dropped.overrides.thinking).toBeUndefined();

    onChangeExecution.mockClear();
    observed.effective.thinking_levels = { state: 'ready', values: [] };
    getExecutorModels.mockResolvedValue(observed);
    await render({ execution, onChangeExecution, onChangeModel: vi.fn() });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-execution-trigger]')!.click());
    await settle();
    await act(async () => container.querySelector<HTMLElement>(`[data-execution-model="${RAW_ID}"]`)!.click());
    await settle();
    const emptyAdvertisement = onChangeExecution.mock.calls[0]?.[0] as { overrides: { thinking?: string | null } };
    expect(emptyAdvertisement.overrides.thinking).toBeUndefined();

    onChangeExecution.mockClear();
    observed.effective.thinking_levels = { state: 'unavailable' };
    getExecutorModels.mockResolvedValue(observed);
    await render({ execution, onChangeExecution, onChangeModel: vi.fn() });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-execution-trigger]')!.click());
    await settle();
    await act(async () => container.querySelector<HTMLElement>(`[data-execution-model="${RAW_ID}"]`)!.click());
    await settle();
    const unavailable = onChangeExecution.mock.calls[0]?.[0] as { overrides: { thinking?: string | null } };
    expect(unavailable.overrides.thinking).toBeUndefined();
  });

  it('leaves the model read-only when the pass was not advertised', async () => {
    getExecutorModels.mockResolvedValue(catalog({ applicability: 'unknown', apply_state: 'unknown' }));
    const onChangeExecution = vi.fn();
    const onChangeModel = vi.fn();
    await render({ variant: 'subagent', boundExecution: bound, onChangeExecution, onChangeModel });
    expect(container.querySelector('[data-composer-engine-model]')).not.toBeNull();
    expect(container.querySelector(`#composer-model-select, [data-option-value="${RAW_ID}"]`)).toBeNull();
    expect(onChangeExecution).not.toHaveBeenCalled();
    expect(onChangeModel).not.toHaveBeenCalled();
  });
});

/**
 * Screenshot evidence for the colour assertions above. The compiled stylesheet
 * is part of the evidence, so a missing build fails this proof instead of
 * quietly passing the DOM checks without the paint they were written for.
 */
async function shot(name: string, node: HTMLElement, padTop = 16): Promise<void> {
  const { cssPath } = resolveCompiledGuiStylesheet();
  const out = join(process.cwd(), process.cwd().endsWith('kiki-gui') ? '.tmp' : 'apps/kiki-gui/.tmp', 'agy-catalog-gui');
  await mkdir(out, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body class="bg-canvas text-ink"><div style="width:960px;padding:${padTop}px 16px 16px">${node.innerHTML}</div></body></html>`);
    await page.addStyleTag({ path: cssPath });
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    await page.close();
  } finally {
    await browser.close();
  }
}
