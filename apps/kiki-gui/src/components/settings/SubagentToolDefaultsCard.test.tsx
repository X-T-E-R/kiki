// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { SubagentToolDefaultsCard } from './SubagentToolDefaultsCard';

const { client } = vi.hoisted(() => ({
  client: {
    listNamedAgentProfiles: vi.fn(),
    getConfig: vi.fn(),
    patchConfig: vi.fn(),
  },
}));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));
vi.mock('../dirtyGuard', () => ({ useDirtyReporter: vi.fn() }));

const general: NamedAgentProfile = {
  name: 'general', main: false, source: 'builtin', description: 'General subagent', disabled: false, routes: [],
};
const explore: NamedAgentProfile = {
  name: 'explore', main: false, source: 'builtin', description: 'Explore subagent', disabled: false, routes: [],
  tools: ['BoardRead'], disallowed_tools: ['Bash'],
};
const mainAgent: NamedAgentProfile = {
  name: 'agent', main: true, source: 'builtin', description: 'Main agent', disabled: false, routes: [],
};

let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.getConfig.mockResolvedValue({});
  client.listNamedAgentProfiles.mockResolvedValue({ items: [general, explore, mainAgent] });
  client.patchConfig.mockImplementation(async (patch: { subagent?: { allowed_tools?: string[] } }) => ({
    subagent: { allowedTools: patch.subagent?.allowed_tools ?? [] },
  }));
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={queries}><I18nProvider><SubagentToolDefaultsCard /></I18nProvider></QueryClientProvider>,
  ));
  await settle();
}
const row = (name: string) => container.querySelector<HTMLElement>(`[data-tool-row="${name}"]`)!;
const checkbox = (name: string) =>
  row(name).querySelector<HTMLInputElement>(`input[data-server-allow="${name}"]`)!;

async function selectProfile(name: string) {
  const select = container.querySelector<HTMLSelectElement>('[data-subagent-tools-profile-select]')!;
  await act(async () => {
    select.value = name;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

describe('default subagent tool access card', () => {
  it('renders the expanded three-state table with both board tools disabled first', async () => {
    await render();
    expect(container.querySelector('#st-card-subagent-tool-defaults')).not.toBeNull();
    expect(container.querySelector('details')).toBeNull();
    const rows = container.querySelectorAll('[data-tool-row]');
    expect(rows[0]?.getAttribute('data-tool-row')).toBe('BoardRead');
    expect(rows[1]?.getAttribute('data-tool-row')).toBe('BoardWrite');
    for (const name of ['BoardRead', 'BoardWrite']) {
      expect(checkbox(name).checked).toBe(false);
      expect(row(name).textContent).toContain('disabled by default');
    }
    expect(row('__default_allowed__').textContent).toContain('Allowed by default');
    expect(row('__main_only__').textContent).toContain('Main agent only');
    expect(container.textContent).toContain('Cannot be opened to subagents through server or profile opt-ins.');
    expect(container.textContent).toContain('not a promise that a call succeeds now');
  });

  it('saving a board opt-in sends only allowed_tools and accepts the echo', async () => {
    await render();
    await act(async () => { checkbox('BoardRead').click(); });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-subagent-tools-save]')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ subagent: { allowed_tools: ['BoardRead'] } });
    expect(container.textContent).toContain('Subagent tool access saved.');
    expect(checkbox('BoardRead').checked).toBe(true);
    expect(container.textContent).not.toContain('Unsaved changes.');
  });

  it('reset clears only server opt-ins and keeps profile opt-ins in the preview', async () => {
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['BoardRead', 'BoardWrite'], timeoutMs: 1000 } });
    await render();
    await selectProfile('explore');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-subagent-tools-reset]')!.click());
    await settle();
    expect(client.patchConfig).toHaveBeenCalledWith({ subagent: { allowed_tools: [] } });
    expect(container.textContent).toContain('Server default restored.');
    expect(checkbox('BoardRead').checked).toBe(false);
    expect(row('BoardRead').textContent).toContain('Configuration allows');
  });

  it('previews exact profile entries and blocks board tools omitted by its allowlist', async () => {
    await render();
    expect(container.textContent).not.toContain('Profile preview');
    await selectProfile('explore');
    expect(row('BoardRead').textContent).toContain('Explicit profile opt-in');
    expect(row('BoardRead').textContent).toContain('Configuration allows');
    expect(row('BoardWrite').textContent).toContain('Blocked by profile tool list');
    await act(async () => { checkbox('BoardWrite').click(); });
    expect(row('BoardWrite').textContent).toContain('Configuration blocks');
    expect(container.textContent).toContain('Profile disallowedTools: Bash');
    await selectProfile('');
    expect(container.textContent).not.toContain('Profile preview');
  });

  it('keeps explicit profile denies above profile and server opt-ins', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({
      items: [{ ...general, tools: ['BoardRead', 'BoardWrite'], disallowed_tools: ['BoardRead'] }],
    });
    client.getConfig.mockResolvedValue({ subagent: { allowedTools: ['BoardRead'] } });
    await render();
    await selectProfile('general');
    expect(row('BoardRead').textContent).toContain('Configuration blocks');
    expect(row('BoardRead').textContent).toContain('Blocked by profile tool list');
    expect(row('BoardWrite').textContent).toContain('Configuration allows');
  });

  it.each([undefined, ['*']])('does not treat missing tools or wildcard as board opt-in: %j', async (tools) => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...general, tools }] });
    await render();
    await selectProfile('general');
    expect(row('BoardRead').textContent).toContain('Configuration blocks');
    expect(row('BoardRead').textContent).toContain('No explicit profile opt-in');
    await act(async () => { checkbox('BoardRead').click(); });
    expect(row('BoardRead').textContent).toContain('Configuration allows');
  });

  it('does not present external executor tools as native availability', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...general, executor: 'external-example', tools: ['BoardRead'] }] });
    await render();
    await selectProfile('general');
    expect(row('BoardRead').textContent).toContain('Managed by executor');
    expect(row('BoardRead').textContent).not.toContain('Configuration allows');
  });

  it('a save failure preserves the checked dirty draft and supports retry', async () => {
    client.patchConfig.mockRejectedValueOnce(new Error('fixture save failure'));
    await render();
    await act(async () => { checkbox('BoardWrite').click(); });
    const save = container.querySelector<HTMLButtonElement>('[data-subagent-tools-save]')!;
    await act(async () => save.click());
    await settle();
    expect(container.textContent).toContain('fixture save failure');
    expect(checkbox('BoardWrite').checked).toBe(true);
    expect(container.textContent).toContain('Unsaved changes.');
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await settle();
    expect(client.patchConfig).toHaveBeenLastCalledWith({ subagent: { allowed_tools: ['BoardWrite'] } });
    expect(checkbox('BoardWrite').checked).toBe(true);
    expect(container.textContent).not.toContain('Unsaved changes.');
  });
});
