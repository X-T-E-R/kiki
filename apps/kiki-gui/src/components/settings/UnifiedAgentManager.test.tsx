// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { UnifiedAgentManager } from './UnifiedAgentManager';

const { client, reportDirty, confirmDiscard } = vi.hoisted(() => ({
  reportDirty: vi.fn(), confirmDiscard: vi.fn((_id: string, action: () => void) => action()),
  client: {
    listNamedAgentProfiles: vi.fn(), listShippedAgentProfiles: vi.fn(), listWorkspaces: vi.fn(), getConfig: vi.fn(),
    updateNamedAgentProfile: vi.fn(), createAgentProfile: vi.fn(), patchConfig: vi.fn(), restoreShippedAgentProfile: vi.fn(),
    readHostFile: vi.fn(), getAgentCapabilities: vi.fn(),
  },
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }), useOptionalConnection: () => ({ client }),
}));
vi.mock('../dirtyGuard', () => ({
  useDirtyGuard: () => ({ confirmDiscard }), useGuardedNavigate: () => vi.fn(),
  useDirtyReporter: (id: string, dirty: boolean) => reportDirty(id, dirty),
}));

const main: NamedAgentProfile = {
  name: 'agent', main: true, source: 'user', source_file: '/fixture/agent/SYSTEM.md',
  workspace_id: 'ws-one', description: 'Default', prompt: 'Old instructions', disabled: false, routes: [],
};
const sub: NamedAgentProfile = {
  name: 'reviewer', main: false, source: 'user', source_file: '/fixture/reviewer/SYSTEM.md',
  workspace_id: 'ws-one', description: 'Review work', prompt: 'Check changes', disabled: false, routes: [],
};
let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const text = (value: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
  .find((button) => button.textContent?.trim() === value)!;
async function typeIn(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value',
  )!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub], complete: true });
  client.listShippedAgentProfiles.mockResolvedValue({ items: [] });
  client.listWorkspaces.mockResolvedValue({ items: [{ id: 'ws-one', root: '/fixture', name: 'Fixture' }] });
  client.getConfig.mockResolvedValue({});
  client.patchConfig.mockResolvedValue({});
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider>
    <UnifiedAgentManager />
  </I18nProvider></QueryClientProvider>));
  await settle();
}

describe('unified Settings agents manager', () => {
  it('filters main and subagent definitions in one list with an inline tabbed detail', async () => {
    await render();
    expect(container.querySelectorAll('[data-agent-list-item]')).toHaveLength(2);
    expect(container.querySelector('[data-agent-detail="agent"] h3')?.textContent).toBe('Kiki');
    await act(async () => text('Subagent').click());
    expect(container.querySelectorAll('[data-agent-list-item]')).toHaveLength(1);
    expect(container.querySelector('[data-agent-detail="reviewer"]')).not.toBeNull();
    await act(async () => text('Instructions').click());
    expect(container.querySelector<HTMLTextAreaElement>('[data-agent-detail] textarea')?.value).toBe('Check changes');
  });

  it('saves instructions through structured PATCH and guards switching a dirty detail', async () => {
    client.updateNamedAgentProfile.mockResolvedValue({ ...main, prompt: 'New instructions' });
    await render();
    await act(async () => text('Instructions').click());
    await typeIn(container.querySelector<HTMLTextAreaElement>('[data-agent-detail] textarea')!, 'New instructions');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-list-item="reviewer"]')!.click());
    expect(confirmDiscard).toHaveBeenCalledWith(expect.stringContaining('agent-detail:'), expect.any(Function));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-list-item="agent"]')!.click());
    await act(async () => text('Instructions').click());
    await typeIn(container.querySelector<HTMLTextAreaElement>('[data-agent-detail] textarea')!, 'New instructions');
    await act(async () => text('Save').click());
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({
      prompt: 'New instructions', scope: 'user', workspace_id: 'ws-one',
    }));
  });

  it('guards a raw-file draft before switching to another agent', async () => {
    client.readHostFile.mockResolvedValue('Original agent file');
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-list-item="reviewer"]')!.click());
    await act(async () => text('Advanced').click());
    expect([...container.querySelectorAll<HTMLButtonElement>('[data-agent-detail="reviewer"] button')]
      .some((button) => button.textContent === 'Edit')).toBe(false);
    await act(async () => text('View / edit raw file').click());
    await settle();
    await typeIn(container.querySelector<HTMLTextAreaElement>('[data-raw-file-collapse] textarea')!, 'Changed agent file');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-list-item="agent"]')!.click());
    expect(confirmDiscard).toHaveBeenCalledWith('agent-raw:/fixture/reviewer/SYSTEM.md', expect.any(Function));
  });

  it('creates a blank agent with description and prompt and offers all templates', async () => {
    const created = { ...sub, name: 'helper', prompt: 'Help here' };
    client.createAgentProfile.mockResolvedValue(created);
    client.listNamedAgentProfiles.mockResolvedValueOnce({ items: [main, sub], complete: true })
      .mockResolvedValue({ items: [main, sub, created], complete: true });
    await render();
    await act(async () => text('New agent').click());
    expect(text('Implementer')).toBeTruthy();
    expect(text('Reviewer')).toBeTruthy();
    expect(text('Duplicate current')).toBeTruthy();
    expect(text('Create agent').disabled).toBe(true);
    const form = container.querySelector('[data-agent-create]')!;
    await typeIn(form.querySelector<HTMLInputElement>('input:not([type])')!, 'helper');
    await typeIn(form.querySelectorAll<HTMLTextAreaElement>('textarea')[0]!, 'Help');
    await typeIn(form.querySelectorAll<HTMLTextAreaElement>('textarea')[1]!, 'Help here');
    await act(async () => text('Create agent').click());
    await settle();
    expect(client.createAgentProfile).toHaveBeenCalledWith({
      workspace_id: 'ws-one', name: 'helper', scope: 'user', main: false,
      template: 'blank', description: 'Help', prompt: 'Help here',
    });
  });

  it('does not submit an invalid name, a duplicate name, or a blank agent without instructions', async () => {
    await render();
    await act(async () => text('New agent').click());
    const form = container.querySelector('[data-agent-create]')!;
    const name = form.querySelector<HTMLInputElement>('input:not([type])')!;
    await typeIn(name, 'Invalid Name');
    expect(text('Create agent').disabled).toBe(true);
    await typeIn(name, 'reviewer');
    expect(text('Create agent').disabled).toBe(true);
    await typeIn(name, 'helper');
    await typeIn(form.querySelectorAll<HTMLTextAreaElement>('textarea')[0]!, 'A helpful agent');
    expect(text('Create agent').disabled).toBe(true);
    await act(async () => text('Create agent').click());
    expect(client.createAgentProfile).not.toHaveBeenCalled();
  });

  it('discards an edited instruction and restores the last loaded server value', async () => {
    await render();
    await act(async () => text('Instructions').click());
    const prompt = container.querySelector<HTMLTextAreaElement>('[data-agent-detail] textarea')!;
    await typeIn(prompt, 'Unsaved instructions');
    await act(async () => text('Discard changes').click());
    expect(prompt.value).toBe('Old instructions');
    expect(client.updateNamedAgentProfile).not.toHaveBeenCalled();
  });

  it('keeps shipped status and tombstone restore available in the unified list', async () => {
    client.listShippedAgentProfiles.mockResolvedValue({ items: [{
      template_id: 'plan', status: 'removed', managed: true, main: false,
      description: 'Planning agent', active_path: '/fixture/plan.md',
    }] });
    client.restoreShippedAgentProfile.mockResolvedValue({ template_id: 'plan', status: 'clean' });
    await render();
    const tombstone = container.querySelector('[data-shipped-removed="plan"]')!;
    expect(tombstone.querySelector('[data-shipped-status="removed"]')?.textContent).toBe('Built-in · removed');
    await act(async () => tombstone.querySelector<HTMLButtonElement>('[data-shipped-restore="plan"]')!.click());
    const dialog = document.body.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Restore the original of built-in agent "plan"?');
    await act(async () => [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Restore original')!.click());
    await settle();
    expect(client.restoreShippedAgentProfile).toHaveBeenCalledWith('plan');
  });
});
