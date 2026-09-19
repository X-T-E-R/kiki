// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { SubagentDefaultTargetCard } from './SubagentsSection';

const { client } = vi.hoisted(() => ({
  client: {
    listNamedAgentProfiles: vi.fn(),
    getConfig: vi.fn(),
    patchConfig: vi.fn(),
  },
}));
vi.mock('../../state/connection', () => ({ useConnection: () => ({ client }) }));

const general: NamedAgentProfile = {
  name: 'general', main: false, source: 'builtin', description: 'General subagent', disabled: false, routes: [],
  subagent_policy: 'advisory',
};
const explore: NamedAgentProfile = {
  name: 'explore', main: false, source: 'builtin', description: 'Explore subagent', disabled: false, routes: [],
  pinned_model_alias: 'fixture/model-a', subagent_policy: 'strict',
};
const mainAgent: NamedAgentProfile = {
  name: 'agent', main: true, source: 'builtin', description: 'Main agent', disabled: false, routes: [],
};
const disabledSub: NamedAgentProfile = {
  name: 'paused', main: false, source: 'user', source_file: '/fixture/agents/paused.md', disabled: true, routes: [],
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
  client.patchConfig.mockResolvedValue({ subagent: { defaultProfile: '' } });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={queries}><I18nProvider><SubagentDefaultTargetCard /></I18nProvider></QueryClientProvider>,
  ));
  await settle();
}
async function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
const select = () => container.querySelector<HTMLSelectElement>('[data-subagent-default-target]')!;

describe('default subagent target card', () => {
  it('defaults to the engine fallback profile and lists only enabled subagent profiles', async () => {
    await render();
    expect(container.querySelector('#st-card-subagent-default-target')).not.toBeNull();
    expect(select().value).toBe('general');
    expect([...select().options].map((option) => option.textContent)).toEqual([
      'Require an explicit profile',
      'explore',
      'general',
    ]);
    // Resolved state: source chip, and the pinned model surfaces for explore only.
    expect(container.querySelector('[data-subagent-default-status="resolved"]')).not.toBeNull();
    expect(container.textContent).toContain('Advisory');
    expect(container.textContent).toContain('pins no model');
  });

  it('saves a named profile immediately on selection and echoes the saved state', async () => {
    client.patchConfig.mockResolvedValue({ subagent: { defaultProfile: 'explore' } });
    await render();
    await setSelect(select(), 'explore');
    expect(client.patchConfig).toHaveBeenCalledWith({ subagent: { default_profile: 'explore' } });
    expect(select().value).toBe('explore');
    expect(container.textContent).toContain('Default subagent target saved.');
    expect(container.textContent).toContain('Strict');
    expect(container.textContent).toContain('fixture/model-a');
    expect(container.textContent).not.toContain('pins no model');
  });

  it('saves the strict empty string and explains the consequence', async () => {
    await render();
    await setSelect(select(), '__strict__');
    expect(client.patchConfig).toHaveBeenCalledWith({ subagent: { default_profile: '' } });
    expect(select().value).toBe('__strict__');
    expect(container.textContent).toContain('fail with an error instead of falling back');
  });

  it('keeps an unresolvable configured default visible and warns about it', async () => {
    client.getConfig.mockResolvedValue({ subagent: { defaultProfile: 'ghost' } });
    await render();
    expect(select().value).toBe('ghost');
    expect(container.querySelector('[data-subagent-default-status="unresolvable"]')?.textContent).toContain('"ghost"');
  });

  it('warns when the configured default is disabled', async () => {
    client.getConfig.mockResolvedValue({ subagent: { defaultProfile: 'paused' } });
    client.listNamedAgentProfiles.mockResolvedValue({ items: [general, explore, mainAgent, disabledSub] });
    await render();
    expect(select().value).toBe('paused');
    expect(container.querySelector('[data-subagent-default-status="disabled"]')?.textContent).toContain('"paused"');
  });

  it('reports a save failure without changing the selected value', async () => {
    client.patchConfig.mockRejectedValue(new Error('fixture save failure'));
    await render();
    await setSelect(select(), 'explore');
    expect(container.textContent).toContain('fixture save failure');
    expect(select().value).toBe('general');
  });
});
