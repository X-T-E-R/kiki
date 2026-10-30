// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateNamedAgentProfileRequestSchema, type NamedAgentProfile } from '@kiki/protocol';
import { readDraft, resetDraftMemoryForTests, writeDraft } from '@kiki/session-core/composer';
import { I18nProvider } from '../../i18n';
import { UnifiedAgentManager } from './UnifiedAgentManager';

const { client, reportDirty, confirmDiscard, navigate } = vi.hoisted(() => ({
  reportDirty: vi.fn(), navigate: vi.fn(), confirmDiscard: vi.fn((_id: string, action: () => void) => action()),
  client: {
    listNamedAgentProfiles: vi.fn(), listShippedAgentProfiles: vi.fn(), listWorkspaceCatalog: vi.fn(), getConfig: vi.fn(),
    updateNamedAgentProfile: vi.fn(), createAgentProfile: vi.fn(), patchConfig: vi.fn(), restoreShippedAgentProfile: vi.fn(),
    readHostFile: vi.fn(), getAgentCapabilities: vi.fn(), listModels: vi.fn(), listExecutors: vi.fn(),
    previewExecutorPrompt: vi.fn(), createSession: vi.fn(), getRecipe: vi.fn(),
    klient: { rest: { agents: { previewModelMenu: vi.fn() } } },
  },
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client, scopeId: 'local' }), useOptionalConnection: () => ({ client, scopeId: 'local' }),
}));
// No `runAction` here on purpose: this file models a page that is not dirty,
// so the handoff creates and leaves without a prompt. The cancel-the-leave order
// is covered against the real guard in askKiki.dirtyOrder.test.tsx.
// The guarded navigator records every call and still moves the router, so
// `?agent=` opens and closes the in-page detail as it does in the app.
const routerNavigate: { current: ((...args: unknown[]) => void) | null } = { current: null };
vi.mock('../dirtyGuard', () => ({
  useDirtyGuard: () => ({ confirmDiscard }),
  useGuardedNavigate: () => (...args: unknown[]) => { navigate(...args); routerNavigate.current?.(...args); },
  useDirtyReporter: (id: string, dirty: boolean) => reportDirty(id, dirty),
}));

const main: NamedAgentProfile = {
  name: 'agent', main: true, source: 'user', source_file: '/fixture/agent/SYSTEM.md',
  workspace_id: 'ws-one', description: 'Default', prompt: 'Old instructions', disabled: false, routes: [],
  pinned_model_alias: 'fixture/opus', thinking_effort: 'high',
  allowed_subagents: ['reviewer', { name: 'explore', model_alias: 'fixture/lite', thinking_effort: 'max' }],
};
const sub: NamedAgentProfile = {
  name: 'reviewer', main: false, source: 'user', source_file: '/fixture/reviewer/SYSTEM.md',
  workspace_id: 'ws-one', description: 'Review work', prompt: 'Check changes', disabled: false, routes: [],
  pinned_model_alias: 'typo/model', allowed_subagents: [],
  model_profiles: [{ alias: 'fixture/lite', when: 'short diffs', thinking_effort: 'high', request_params: { temperature: 0 } }],
};
const explore: NamedAgentProfile = {
  name: 'explore', main: false, source: 'builtin', description: 'Read-only search', prompt: 'Find things.', disabled: false, routes: [],
};
let root: Root;
let container: HTMLDivElement;
let queries: QueryClient;
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const buttonIn = (scope: ParentNode, value: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
  .find((button) => button.textContent?.trim() === value)!;
/** The open editing surface: the in-page profile detail, or the create panel. */
const sheet = () => document.body.querySelector<HTMLElement>('[data-agent-create-panel] [role="dialog"]')
  ?? document.body.querySelector<HTMLElement>('[data-detail-pane]')!;
let currentSearch = '';
function RouterProbe() {
  const go = useNavigate();
  routerNavigate.current = (target: unknown, options?: unknown) => {
    if (typeof target === 'number') void go(target);
    else void go(target as string, options as object);
  };
  currentSearch = useLocation().search;
  return null;
}
async function typeIn(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value',
  )!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function choose(trigger: HTMLElement, label: string) {
  await act(async () => trigger.click());
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes(label))!;
  expect(option).toBeDefined();
  await act(async () => option.click());
}
async function open(name: string) {
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-team-open="${name}"]`)!.click());
  await settle();
}
async function openTab(tab: string) {
  await act(async () => sheet().querySelector<HTMLButtonElement>(`[data-profile-tab="${tab}"]`)!.click());
}
async function save() {
  await act(async () => buttonIn(sheet(), 'Save').click());
  await settle();
}

beforeEach(() => {
  vi.resetAllMocks();
  resetDraftMemoryForTests();
  confirmDiscard.mockImplementation((_id: string, action: () => void) => action());
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore], complete: true });
  client.listShippedAgentProfiles.mockResolvedValue({ items: [] });
  client.listWorkspaceCatalog.mockResolvedValue({ items: [{ id: 'ws-one', root: '/fixture', name: 'Fixture' }] });
  client.getConfig.mockResolvedValue({});
  client.listExecutors.mockResolvedValue({ items: [] });
  client.previewExecutorPrompt.mockRejectedValue(new Error('preview unavailable'));
  client.klient.rest.agents.previewModelMenu.mockResolvedValue({ restrict_models_to_menu: true,
    declared_model_menu: { aliases: ['fixture/opus'], identities: ['fixture/opus'], default_alias: 'fixture/opus' },
    effective_model_aliases: ['fixture/opus'], added_model_identities: [], removed_model_identities: [],
  });
  client.patchConfig.mockResolvedValue({});
  client.readHostFile.mockResolvedValue('---\nname: reviewer\ndescription: Review work\n---\n\nCheck changes\n');
  client.listModels.mockResolvedValue({ items: [
    { id: 'fixture/opus', provider_id: 'fixture', remote_id: 'opus', max_context_size: 1_000_000, support_efforts: ['low', 'high', 'max'] },
    { id: 'fixture/lite', provider_id: 'fixture', remote_id: 'lite', max_context_size: 200_000 },
  ] });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queries.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(<MemoryRouter initialEntries={['/settings/agents']}><QueryClientProvider client={queries}><I18nProvider>
    <RouterProbe /><UnifiedAgentManager />
  </I18nProvider></QueryClientProvider></MemoryRouter>));
  await settle();
}

describe('agents team view', () => {
  it('lists every agent with model, effort and whom it may call, and flags an alias the catalog lacks', async () => {
    await render();
    const rows = [...container.querySelectorAll<HTMLElement>('[data-team-row]')].map((row) => row.dataset['teamRow']);
    // Grouped by what the user talks to: main agents, then the helpers they dispatch.
    expect(rows).toEqual(['agent', 'explore', 'reviewer']);
    const lead = container.querySelector('[data-team-row="agent"]')!;
    expect(lead.querySelector('[data-team-dispatch]')?.textContent).toContain('reviewer, explore');
    expect(lead.querySelector('[data-team-effort]')?.textContent).toContain('High');
    const reviewer = container.querySelector('[data-team-row="reviewer"]')!;
    // An empty preset list reads as a quiet fact, not a warning.
    expect(reviewer.querySelector('[data-team-dispatch]')?.textContent).toContain('No presets');
    // An undeclared list is the neutral default.
    expect(container.querySelector('[data-team-row="explore"] [data-team-dispatch]')?.textContent).toContain('Default');
    // Where the file lives is a row tag, not a group: a built-in says so, your own folder says nothing.
    expect(container.querySelector('[data-team-row="explore"] [data-team-tag="source"]')?.textContent).toBe('Built-in');
    expect(container.querySelector('[data-team-row="reviewer"] [data-team-tag="source"]')).toBeNull();
    expect(reviewer.querySelector('[data-team-warning]')).not.toBeNull();
    expect(container.querySelector('[data-team-warnings]')?.textContent).toContain('1 setting needs attention');
    // A built-in is read-only: its cells are text, not pickers.
    expect(container.querySelector('[data-team-row="explore"] [data-team-model] button')).toBeNull();
  });

  it('saves a model change from the table on its own', async () => {
    client.updateNamedAgentProfile.mockResolvedValue({ ...sub, pinned_model_alias: 'fixture/opus' });
    await render();
    await choose(container.querySelector<HTMLElement>('[data-team-row="reviewer"] [data-team-model] button')!, 'fixture/opus');
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('reviewer', {
      scope: 'user', workspace_id: 'ws-one', source_file: '/fixture/reviewer/SYSTEM.md', pinned_model_alias: 'fixture/opus',
    });
    expect(container.querySelector('[data-saved-tick]')).not.toBeNull();
  });

  it('groups main agents above helpers, tags the project source, and hides an empty group', async () => {
    const local: NamedAgentProfile = { ...sub, name: 'local-lead', main: true, source: 'workspace', source_file: '/fixture/.kiki/agents/local-lead.md' };
    const localSub: NamedAgentProfile = { ...sub, name: 'local-helper', source: 'workspace', source_file: '/fixture/.kiki/agents/local-helper.md' };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore, localSub, local], complete: true });
    await render();
    const groups = [...container.querySelectorAll<HTMLElement>('[data-team-group]')];
    expect(groups.map((group) => group.dataset['teamGroup'])).toEqual(['main', 'subagent']);
    expect([...groups[0]!.querySelectorAll<HTMLElement>('[data-team-row]')].map((row) => row.dataset['teamRow'])).toEqual(['agent', 'local-lead']);
    expect(container.querySelector('[data-team-row="local-helper"] [data-team-tag="source"]')?.textContent).toBe('Project');
    // Engine status lives on the providers page; this page has no status strip and no layout switch.
    expect(container.querySelector('[data-agent-passthrough-presets]')).toBeNull();
    expect(container.querySelector('[data-team-layout]')).toBeNull();
    // Disabling by name is a rare action kept in one quiet fold at the bottom.
    expect(container.querySelector('details[data-disabled-by-name-fold]')?.hasAttribute('open')).toBe(false);
    client.listNamedAgentProfiles.mockResolvedValue({ items: [sub, explore], complete: true });
    await act(async () => { await queries.invalidateQueries(); });
    await settle();
    expect(container.querySelector('[data-team-group="main"]')).toBeNull();
  });

  it('greys a shadowed file and says which file wins', async () => {
    const shadow: NamedAgentProfile = { ...sub, source: 'extra', source_file: '/extra/reviewer.md', pinned_model_alias: 'fixture/opus' };
    client.listNamedAgentProfiles.mockImplementation(async (query?: unknown) =>
      typeof query === 'object' && query !== null && 'effective' in query
        ? { items: [main, sub, explore], complete: true }
        : { items: [main, sub, shadow, explore], complete: true });
    await render();
    const row = container.querySelector('[data-team-source="extra"]')!;
    expect(row.querySelector('[data-team-model] button')).toBeNull();
    await act(async () => row.querySelector<HTMLButtonElement>('[data-team-open]')!.click());
    await settle();
    expect(sheet().querySelector('[data-profile-diagnostic="shadowedBy"]')?.textContent).toContain('/fixture/reviewer/SYSTEM.md');
    await act(async () => buttonIn(sheet(), 'Open it').click());
    await settle();
    expect(sheet().querySelector('[data-profile-editor]')?.textContent).toContain('/fixture/reviewer/SYSTEM.md');
  });
});

describe('profile editor detail', () => {
  it('opens a profile in the page with a rail of names, addressed by ?agent=', async () => {
    await render();
    await open('reviewer');
    expect(currentSearch).toBe('?agent=reviewer');
    // In-page, not modal: no scrim, no dialog, the team table hidden but mounted.
    expect(document.body.querySelector('[aria-modal="true"]')).toBeNull();
    expect(container.querySelector('[data-detail-split="open"]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('[data-detail-list]')!.hidden).toBe(true);
    const rail = container.querySelector<HTMLElement>('[data-agent-rail]')!;
    expect([...rail.querySelectorAll('[data-detail-rail-item]')].map((item) => item.getAttribute('data-detail-rail-item')))
      .toEqual(['agent', 'explore', 'reviewer']);
    expect(rail.querySelector('[data-detail-rail-item="reviewer"]')?.getAttribute('aria-current')).toBe('page');
    // The rail switches profiles in place.
    await act(async () => rail.querySelector<HTMLButtonElement>('[data-detail-rail-item="agent"]')!.click());
    await settle();
    expect(currentSearch).toBe('?agent=agent');
    expect(sheet().querySelector('[data-agent-detail="agent"]')).not.toBeNull();
  });

  it('creates in a side panel and lands in the new profile detail', async () => {
    const created = { ...explore, name: 'explore-fast', source: 'user', source_file: '/fixture/home/agents/explore-fast.md', workspace_id: 'ws-one' };
    client.createAgentProfile.mockResolvedValue(created);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-profile-new]')!.click());
    expect(document.body.querySelector('[data-agent-create-panel] [role="dialog"]')).not.toBeNull();
    await typeIn(sheet().querySelector<HTMLInputElement>('#new-profile-name')!, 'explore-fast');
    client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore, created], complete: true });
    await act(async () => buttonIn(sheet(), 'Create agent').click());
    await settle();
    expect(document.body.querySelector('[data-agent-create-panel]')).toBeNull();
    expect(currentSearch).toBe('?agent=explore-fast');
    expect(sheet().querySelector('[data-agent-detail="explore-fast"]')).not.toBeNull();
  });

  it('puts the instructions first and saves only what changed', async () => {
    client.updateNamedAgentProfile.mockResolvedValue({ ...main, prompt: 'New instructions' });
    await render();
    await open('agent');
    const prompt = sheet().querySelector<HTMLTextAreaElement>('#profile-prompt')!;
    expect(prompt.value).toBe('Old instructions');
    await typeIn(prompt, 'New instructions');
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', {
      scope: 'user', workspace_id: 'ws-one', source_file: '/fixture/agent/SYSTEM.md', prompt: 'New instructions',
    });
  });

  it('edits recipe options in the run tab and saves them without dropping other values', async () => {
    const profile = { ...main, recipe: './recipe.toml', recipe_options: { safe: true, legacy: false } };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile, sub, explore], complete: true });
    client.getRecipe.mockResolvedValue({ resolved: { options: [
      { id: 'safe', name: 'Safe mode', default: false },
      { id: 'fast', name: 'Fast mode', default: false, description: 'Use the shorter prompt.' },
    ] } });
    client.updateNamedAgentProfile.mockImplementation(async (_name: string, body: Record<string, unknown>) => ({ ...profile, ...body }));
    await render();
    await open('agent');
    await openTab('run');
    const options = sheet().querySelector<HTMLElement>('[data-profile-panel="run"] [data-profile-block="runs"] [data-recipe-options]')!;
    expect(options).not.toBeNull();
    expect(client.getRecipe).toHaveBeenCalledWith('/fixture/agent/./recipe.toml');
    const fast = options.querySelector<HTMLInputElement>('[data-recipe-option="fast"] input')!;
    expect(fast.closest('[data-settings-field]')).not.toBeNull();
    expect(options.querySelector<HTMLInputElement>('[data-recipe-option="safe"] input')!.checked).toBe(true);
    await act(async () => { fast.click(); });
    await settle();
    expect(sheet().querySelector('[data-profile-tab="run"] [data-profile-tab-dirty]')).not.toBeNull();
    expect(sheet().querySelector<HTMLButtonElement>('[data-profile-tab="raw"]')!.disabled).toBe(true);
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledExactlyOnceWith('agent', {
      scope: 'user', workspace_id: 'ws-one', source_file: '/fixture/agent/SYSTEM.md',
      recipe_options: { safe: true, legacy: false, fast: true },
    });
  });

  it('edits the subagent whitelist and a lease pin, keeping untouched entries bare', async () => {
    client.updateNamedAgentProfile.mockResolvedValue(main);
    await render();
    await open('agent');
    const field = sheet().querySelector<HTMLElement>('[data-subagents-field]')!;
    expect([...field.querySelectorAll('[data-subagent-row]')].map((row) => row.getAttribute('data-subagent-row'))).toEqual(['reviewer', 'explore']);
    await choose(field.querySelector<HTMLElement>('#lease-effort-explore')!, 'High');
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({
      allowed_subagents: ['reviewer', { name: 'explore', model_alias: 'fixture/lite', thinking_effort: 'high' }],
    }));
  });

  it('reorders subagents, showing inherited pins until a lease sets one', async () => {
    client.updateNamedAgentProfile.mockResolvedValue(main);
    await render();
    await open('agent');
    const field = sheet().querySelector<HTMLElement>('[data-subagents-field]')!;
    // reviewer has no lease: its own pin shows in the trigger.
    expect(field.querySelector('#lease-model-reviewer')?.textContent).toContain('typo/model');
    await act(async () => field.querySelector<HTMLButtonElement>('[data-subagent-down="reviewer"]')!.click());
    expect([...field.querySelectorAll('[data-subagent-row]')].map((row) => row.getAttribute('data-subagent-row'))).toEqual(['explore', 'reviewer']);
    expect(field.querySelector<HTMLButtonElement>('[data-subagent-up="explore"]')!.disabled).toBe(true);
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ allowed_subagents: ['explore', 'reviewer'] }));
  });

  it('lists same-name files the profile shadows', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...main, shadowed_files: ['/fixture/agent/old/SYSTEM.md'] }, sub, explore], complete: true });
    await render();
    await open('agent');
    expect(sheet().querySelector('[data-profile-diagnostic="shadows"] [data-shadowed-file="/fixture/agent/old/SYSTEM.md"]')).not.toBeNull();
  });

  it('sets and clears what dispatched helpers may use on the dispatch tab', async () => {
    const constrained = { ...main, spawn_constraints: { allowed_models: ['fixture/lite'], disallowed_tools: ['WebFetch'] } };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [constrained, sub, explore], complete: true });
    client.updateNamedAgentProfile.mockResolvedValue(constrained);
    await render();
    await open('agent');
    await openTab('dispatch');
    const advanced = sheet().querySelector<HTMLElement>('[data-model-rules="spawn"]')!;
    expect(advanced.querySelector('[data-alias-chips="spawn-allowed-models"] [data-alias-chip="fixture/lite"]')).not.toBeNull();
    await act(async () => advanced.querySelector<HTMLButtonElement>('[data-spawn-effort="max"]')!.click());
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('agent', expect.objectContaining({
      spawn_constraints: { allowed_models: ['fixture/lite'], allowed_efforts: ['max'], disallowed_tools: ['WebFetch'] },
    }));
    await act(async () => advanced.querySelector<HTMLButtonElement>('[data-spawn-clear]')!.click());
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenLastCalledWith('agent', expect.objectContaining({ spawn_constraints: null }));
  });

  it('blocks saving a preset list that repeats a name, and accepts an explicitly empty one', async () => {
    await render();
    await open('reviewer');
    // An empty list is a real state: no preset is selectable here, while a
    // preset file given by path still works, so it is not a save blocker.
    const field = sheet().querySelector<HTMLElement>('[data-dispatch-allowed]')!;
    expect(field.getAttribute('data-declared')).toBe('true');
    expect(field.querySelector('[data-dispatch-allowed-empty]')?.textContent).toBe('No presets');
    // Nothing is edited, so the footer is not a save blocker: the old
    // "empty list" rejection is gone with the removed three-way control.
    expect(sheet().querySelector('[data-settings-draft]')?.getAttribute('data-dirty')).not.toBe('true');
  });

  it('edits model candidates with their condition and effort', async () => {
    client.updateNamedAgentProfile.mockResolvedValue(sub);
    await render();
    await open('reviewer');
    const whenInput = sheet().querySelector<HTMLInputElement>('#mp-when-0')!;
    expect(whenInput.value).toBe('short diffs');
    await typeIn(whenInput, 'diffs under 200 lines');
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-model-profile-add]')!.click());
    await choose(sheet().querySelector<HTMLElement>('#mp-model-1')!, 'fixture/opus');
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('reviewer', expect.objectContaining({
      model_profiles: [
        { alias: 'fixture/lite', when: 'diffs under 200 lines', thinking_effort: 'high' },
        { alias: 'fixture/opus', when: null, thinking_effort: null },
      ],
    }));
  });

  it('keeps raw external model rules and child leases separate from the native catalog', async () => {
    const external: NamedAgentProfile = { ...sub, executor: 'example-acp', pinned_model_alias: 'vendor-high',
      thinking_effort: 'max', allowed_models: ['vendor-high'], preferred_models: ['vendor-fast'],
      deny_models: ['vendor-retired'], model_profiles: [{ alias: 'vendor-high', thinking_effort: 'max' }] };
    const lead = { ...main, allowed_subagents: [{ name: 'reviewer', model_alias: 'vendor-high' }] };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [lead, external, explore], complete: true });
    await render();
    await open('reviewer');
    expect(sheet().querySelector('[data-alias-missing]')).toBeNull();
    expect(sheet().querySelector('[data-alias-missing="true"]')).toBeNull();
    expect(sheet().querySelector('#profile-effort')?.textContent).toContain('Max');
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-agent-back]')!.click());
    await settle();
    await open('agent');
    expect(sheet().querySelector('#lease-model-reviewer [data-alias-missing]')).toBeNull();
  });

  it('reports the missing alias beside the model field and in diagnostics', async () => {
    await render();
    await open('reviewer');
    expect(sheet().querySelector('[data-profile-diagnostic="aliasMissing"]')?.textContent).toContain('typo/model');
    expect(sheet().querySelector('[data-profile-field="model"] [data-alias-missing]')).not.toBeNull();
  });

  it('turns main on for an existing profile', async () => {
    client.updateNamedAgentProfile.mockResolvedValue({ ...sub, main: true });
    await render();
    await open('reviewer');
    const toggle = sheet().querySelector<HTMLInputElement>('[data-profile-field="main"] input[type="checkbox"]')!;
    await act(async () => toggle.click());
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('reviewer', expect.objectContaining({ main: true }));
  });

  it('keeps the compaction point under Advanced and clears it with null', async () => {
    const pinned = { ...main, auto_compact: 650_000 };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [pinned, sub, explore], complete: true });
    client.updateNamedAgentProfile.mockResolvedValue({ ...pinned, auto_compact: undefined });
    await render();
    await open('agent');
    const input = sheet().querySelector<HTMLInputElement>('[data-profile-section="advanced"] [data-profile-auto-compact] input')!;
    expect(input.value).toBe('650k');
    await act(async () => { input.focus(); });
    await typeIn(input, '');
    await act(async () => { input.blur(); });
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ auto_compact: null }));
  });

  it('names engines from the executor catalog and greys fields the external engine ignores', async () => {
    const grok: NamedAgentProfile = { ...sub, name: 'grok-helper', executor: 'grok-acp', tools: ['Read'], pinned_model_alias: 'grok-4.7',
      executor_fields: { tools: { state: 'ignored', reason: 'Grok Build decides its own tools.' }, thinking_effort: { state: 'mapped' } } };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore, grok], complete: true });
    client.getConfig.mockResolvedValue({ raw: { agent_executor_overrides: { 'claude-acp': { show_in_profile_list: true } } } });
    client.listExecutors.mockResolvedValue({ items: [
      { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
      { id: 'grok-acp', label: 'Grok Build', protocol: 'acp', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
      { id: 'claude-acp', label: 'Claude Code', protocol: 'acp', status: 'unavailable', model_binding: 'mapped', thinking_binding: 'unavailable' },
      { id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
    ] });
    await render();
    expect(container.querySelector('[data-team-row="grok-helper"] [data-team-engine]')?.textContent).toBe('Grok Build');
    await open('grok-helper');
    // New choices are engines explicitly turned on. The bound engine stays. An enabled missing binary says so.
    await act(async () => sheet().querySelector<HTMLElement>('#profile-engine')!.click());
    const engineOptions = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent ?? '');
    expect(engineOptions.some((text) => text.includes('Claude Code') && text.includes('not found on this machine'))).toBe(true);
    expect(engineOptions.some((text) => text.includes('Grok Build'))).toBe(true);
    expect(engineOptions.some((text) => text.includes('Codex'))).toBe(false);
    expect(engineOptions.some((text) => text.includes('OpenCode'))).toBe(false);
    await act(async () => sheet().querySelector<HTMLElement>('#profile-engine')!.click());
    expect(sheet().querySelector('[data-profile-field="tools"]')?.getAttribute('data-field-applicability')).toBe('ignored');
    expect(sheet().querySelector('[data-profile-field="tools"]')?.textContent).toContain('Grok Build decides its own tools.');
    expect(sheet().querySelector('[data-profile-field="effort"]')?.textContent).toContain('Translated to the Grok Build equivalent.');
    expect(sheet().querySelector('[data-prompt-delivery]')).not.toBeNull();
    // External model ids are not checked against the Kiki catalog.
    expect(sheet().querySelector('[data-profile-diagnostic="aliasMissing"]')).toBeNull();
    expect(sheet().querySelector('[data-profile-diagnostic="executorIgnored"]')?.textContent).toContain('tools');
  });

  it('edits the executor prompt per engine, previews the delivery, and lists ignored fields with reasons', async () => {
    const claude: NamedAgentProfile = { ...sub, name: 'claude-helper', executor: 'claude-acp', service_tier: 'priority', pinned_model_alias: 'opus',
      executor_prompt: { delivery: 'append', include: ['agents_md'] },
      executor_fields: { service_tier: { state: 'ignored', reason: 'Provider service tiers apply only to native execution' },
        request_params: { state: 'ignored', reason: 'Provider request parameters apply only to native execution' } } };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore, claude], complete: true });
    client.listExecutors.mockResolvedValue({ items: [
      { id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready', model_binding: 'mapped', thinking_binding: 'unavailable',
        capabilities: { prompt_deliveries: ['preamble'], steer: 'next_turn_preamble', permission: { trust_engine_settings: false }, thinking_binding: false } },
    ] });
    client.updateNamedAgentProfile.mockImplementation(async (_name: string, body: Record<string, unknown>) => ({ ...claude, ...body }));
    client.previewExecutorPrompt.mockResolvedValue({ executor: 'claude-acp',
      delivery: { requested: 'append', actual: 'preamble', downgraded: true },
      blocks: [{ id: 'body', text: 'Check changes' }, { id: 'agents_md', text: 'Rendered workspace policy' }],
      text: 'Check changes\n\nRendered workspace policy' });
    await render();
    await open('claude-helper');
    const section = sheet().querySelector<HTMLElement>('[data-profile-section="executor-prompt"]')!;
    const preview = section.querySelector<HTMLElement>('[data-executor-prompt-preview]')!;
    expect(client.previewExecutorPrompt).toHaveBeenCalledWith('claude-helper', 'ws-one', 'claude-acp');
    expect(preview.getAttribute('data-preview-source')).toBe('server');
    expect(preview.textContent).toContain('Rendered workspace policy');
    expect(preview.getAttribute('data-preview-delivery')).toBe('preamble');
    expect(preview.querySelector('[data-executor-prompt-downgrade]')?.textContent).toContain('can’t use Append');
    expect([...preview.querySelectorAll('[data-preview-part]')].map((part) => part.getAttribute('data-preview-part'))).toEqual(['body', 'agents_md']);
    expect(preview.querySelector('[data-executor-prompt-steer]')?.textContent).toContain('held for the next turn');
    // Customize for Claude Code: a per-engine override with its own blocks.
    await act(async () => section.querySelector<HTMLButtonElement>('[data-executor-prompt-scope="claude-acp"]')!.click());
    await act(async () => section.querySelector<HTMLButtonElement>('[data-executor-prompt-add-override]')!.click());
    await act(async () => section.querySelector<HTMLInputElement>('[data-executor-prompt-block="memory_snapshot"] input')!.click());
    await act(async () => section.querySelector<HTMLButtonElement>('[data-executor-prompt-delivery="preamble"]')!.click());
    expect(preview.getAttribute('data-preview-source')).toBe('plan');
    expect(preview.textContent).not.toContain('Rendered workspace policy');
    expect([...section.querySelectorAll('[data-preview-part]')].map((part) => part.getAttribute('data-preview-part'))).toEqual(['body', 'agents_md', 'memory_snapshot']);
    expect(section.querySelector('[data-executor-prompt-downgrade]')).toBeNull();
    // The not-used fold names each ignored field with the server's reason and marks values the file sets.
    const ignored = sheet().querySelector<HTMLElement>('[data-profile-section="ignored-fields"]')!;
    expect(ignored.querySelector('[data-ignored-field="service_tier"]')?.textContent).toContain('set in this file');
    expect(ignored.querySelector('[data-ignored-field="request_params"]')?.textContent).toContain('only to native execution');
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('claude-helper', expect.objectContaining({
      executor_prompt: { delivery: 'append', include: ['agents_md'], per_engine: { 'claude-acp': { delivery: 'preamble', include: ['agents_md', 'memory_snapshot'] } } },
    }));
  });

  it('splits the sheet into question tabs, moves by arrow keys, marks unsaved tabs and locks the file tab', async () => {
    await render();
    await open('agent');
    const tabs = [...sheet().querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Who it is', 'How it runs', 'Who it dispatches', 'Tools', 'Advanced', 'File']);
    expect(sheet().querySelector('[data-profile-panel="identity"]')?.hasAttribute('hidden')).toBe(false);
    await act(async () => { tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(sheet().querySelector('[data-profile-tab="run"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(sheet().querySelector('[data-profile-tab="run"]'));
    expect(sheet().querySelector('[data-profile-panel="identity"]')?.hasAttribute('hidden')).toBe(true);
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#profile-prompt')!, 'Edited');
    expect(sheet().querySelector('[data-profile-tab="identity"] [data-profile-tab-dirty]')).not.toBeNull();
    expect(sheet().querySelector('[data-profile-tab="run"] [data-profile-tab-dirty]')).toBeNull();
    expect(sheet().querySelector<HTMLButtonElement>('[data-profile-tab="raw"]')!.disabled).toBe(true);
  });

  it('reports a dirty draft, discards on request, and closes through the guarded navigator', async () => {
    await render();
    await open('agent');
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#profile-prompt')!, 'Unsaved');
    expect(reportDirty).toHaveBeenCalledWith('agent-detail:user:/fixture/agent/SYSTEM.md:agent', true);
    await act(async () => buttonIn(sheet(), 'Discard changes').click());
    expect(sheet().querySelector<HTMLTextAreaElement>('#profile-prompt')!.value).toBe('Old instructions');
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-agent-back]')!.click());
    await settle();
    await settle();
    // Closing is a guarded navigation, so the shared leave prompt owns any draft.
    expect(navigate).toHaveBeenLastCalledWith(-1);
    expect(currentSearch).toBe('');
    expect(document.body.querySelector('[data-detail-pane]')).toBeNull();
    expect(document.body.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('edits the raw file as a separate mode and reloads the form from the echo', async () => {
    client.updateNamedAgentProfile.mockResolvedValue({ ...sub, description: 'Raw edited' });
    await render();
    await open('reviewer');
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-profile-mode="raw"]')!.click());
    await settle();
    const raw = sheet().querySelector<HTMLTextAreaElement>('[data-profile-raw] textarea')!;
    expect(raw.value).toContain('name: reviewer');
    await typeIn(raw, raw.value.replace('Review work', 'Raw edited'));
    await act(async () => buttonIn(sheet(), 'Save raw file').click());
    await settle();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('reviewer', expect.objectContaining({ raw_text: expect.stringContaining('Raw edited') }));
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-profile-mode="form"]')!.click());
    expect(sheet().querySelector<HTMLTextAreaElement>('#profile-description')!.value).toBe('Raw edited');
  });

  it('shows a built-in as read-only with a duplicate path', async () => {
    await render();
    await open('explore');
    expect(sheet().querySelector('#profile-prompt')?.tagName).toBe('DIV');
    expect(sheet().querySelector('[data-profile-readonly]')).not.toBeNull();
    await act(async () => buttonIn(sheet(), 'Duplicate to edit').click());
    expect(sheet().querySelector<HTMLInputElement>('#new-profile-name')!.value).toBe('explore-copy');
  });
});

describe('new profile', () => {
  it('copies an agent by default and creates it under a new name', async () => {
    const created = { ...explore, name: 'explore-fast', source: 'user', source_file: '/fixture/home/agents/explore-fast.md', workspace_id: 'ws-one' };
    client.createAgentProfile.mockResolvedValue(created);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-profile-new]')!.click());
    expect(sheet().querySelector('[data-new-start="copy"]')?.getAttribute('aria-pressed')).toBe('true');
    // Defaults to a built-in subagent source with a prefilled name.
    expect(sheet().querySelector<HTMLInputElement>('#new-profile-name')!.value).toBe('explore-copy');
    await typeIn(sheet().querySelector<HTMLInputElement>('#new-profile-name')!, 'explore-fast');
    await act(async () => buttonIn(sheet(), 'Create agent').click());
    await settle();
    expect(client.createAgentProfile).toHaveBeenCalledWith({
      workspace_id: 'ws-one', name: 'explore-fast', scope: 'user', template: 'duplicate:explore',
    });
  });

  it('allows creating an agent with the suggested -copy name when ready', async () => {
    const created = { ...explore, name: 'explore-copy', source: 'user', source_file: '/fixture/home/agents/explore-copy.md', workspace_id: 'ws-one' };
    client.createAgentProfile.mockResolvedValue(created);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-profile-new]')!.click());
    expect(sheet().querySelector<HTMLInputElement>('#new-profile-name')!.value).toBe('explore-copy');
    expect(buttonIn(sheet(), 'Create agent').disabled).toBe(false);
    await act(async () => buttonIn(sheet(), 'Create agent').click());
    await settle();
    expect(client.createAgentProfile).toHaveBeenCalledWith({
      workspace_id: 'ws-one', name: 'explore-copy', scope: 'user', template: 'duplicate:explore',
    });
  });

  it('preserves profile-name preedit and trims the name at creation', async () => {
    client.createAgentProfile.mockResolvedValue({ ...explore, name: 'helper', source: 'user' });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-profile-new]')!.click());
    const input = sheet().querySelector<HTMLInputElement>('#new-profile-name')!;
    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' helper ');
      input.setSelectionRange(3, 3);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    expect(input.value).toBe(' helper ');
    expect(input.selectionStart).toBe(3);
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await act(async () => buttonIn(sheet(), 'Create agent').click());
    await settle();
    expect(client.createAgentProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'helper' }));
  });

  it('refuses a taken or malformed name and a blank agent without instructions', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-profile-new]')!.click());
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-new-start="blank"]')!.click());
    const name = sheet().querySelector<HTMLInputElement>('#new-profile-name')!;
    await typeIn(name, 'reviewer');
    expect(sheet().textContent).toContain('reviewer is already used by another agent.');
    await typeIn(name, 'Bad Name');
    expect(buttonIn(sheet(), 'Create agent').disabled).toBe(true);
    await typeIn(name, 'helper');
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#new-profile-description')!, 'Helps');
    expect(buttonIn(sheet(), 'Create agent').disabled).toBe(true);
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#new-profile-prompt')!, 'Help here');
    expect(buttonIn(sheet(), 'Create agent').disabled).toBe(false);
  });

  it('accepts an underscore-separated profile name', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-profile-new]')!.click());
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-new-start="blank"]')!.click());
    await typeIn(sheet().querySelector<HTMLInputElement>('#new-profile-name')!, 'helper_agent');
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#new-profile-description')!, 'Helps');
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#new-profile-prompt')!, 'Help here');
    expect(buttonIn(sheet(), 'Create agent').disabled).toBe(false);
  });

  it('keeps shipped tombstones restorable below the table', async () => {
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
    await act(async () => [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Restore original')!.click());
    await settle();
    expect(client.restoreShippedAgentProfile).toHaveBeenCalledWith('plan');
  });
});


describe('profile menu restriction and advice editor', () => {
  it('starts off by default and saves the menu switch without changing the menu', async () => {
    client.updateNamedAgentProfile.mockResolvedValue({ ...main, restrict_models_to_menu: true });
    await render();
    await open('agent');
    const toggle = sheet().querySelector<HTMLButtonElement>('[data-profile-field="restrictModelsToMenu"] [role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await settle();
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', {
      scope: 'user', workspace_id: 'ws-one', source_file: main.source_file, restrict_models_to_menu: true,
    });
  });

  it('edits preferred models and efforts as soft advice without writing hard rules', async () => {
    client.updateNamedAgentProfile.mockResolvedValue({ ...main, preferred_models: ['fixture/lite'], preferred_efforts: ['low'] });
    await render();
    await open('agent');
    await openTab('run');
    const rules = sheet().querySelector<HTMLElement>('[data-model-rules="self"]')!;
    expect([...rules.querySelectorAll('[data-rule-column]')].map((node) => node.textContent)).toEqual(['Only these', 'Prefer', 'Avoid', 'Never']);
    await choose(rules.querySelector<HTMLElement>('#preferred-models-add')!, 'fixture/lite');
    await act(async () => rules.querySelector<HTMLButtonElement>('[data-preferred-effort="low"]')!.click());
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', {
      scope: 'user', workspace_id: 'ws-one', source_file: main.source_file,
      preferred_models: ['fixture/lite'], preferred_efforts: ['low'],
    });
  });
});


it('previews default-model removal before saving and keeps the full catalog editable', async () => {
  const restricted = { ...main, restrict_models_to_menu: true, model_profiles: [],
    declared_model_menu: { aliases: ['fixture/opus'], default_alias: 'fixture/opus', identities: ['fixture/opus'] },
    effective_model_aliases: ['fixture/opus'] };
  client.listNamedAgentProfiles.mockResolvedValue({ items: [restricted], complete: true });
  let resolvePreview!: (value: unknown) => void;
  client.klient.rest.agents.previewModelMenu.mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
  client.updateNamedAgentProfile.mockResolvedValue({ ...restricted, pinned_model_alias: 'fixture/lite' });
  await render();
  await open('agent');
  expect(sheet().querySelector('[data-menu-declared]')?.textContent).toContain('fixture/opusDefault');
  await choose(sheet().querySelector<HTMLElement>('#profile-model')!, 'fixture/lite');
  expect(buttonIn(sheet(), 'Save').disabled).toBe(true);
  expect(client.updateNamedAgentProfile).not.toHaveBeenCalled();
  await act(async () => resolvePreview({ restrict_models_to_menu: true,
    declared_model_menu: { aliases: ['fixture/lite'], default_alias: 'fixture/lite', identities: ['fixture/lite'] },
    effective_model_aliases: ['fixture/lite'], added_model_identities: ['fixture/lite'], removed_model_identities: ['fixture/opus'],
  }));
  await settle();
  expect(sheet().querySelector('[data-menu-added]')?.textContent).toContain('fixture/lite');
  expect(sheet().querySelector('[data-menu-removed]')?.textContent).toContain('fixture/opus');
  await save();
  expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ pinned_model_alias: 'fixture/lite' }));
});

it('requires an explicit save after a restricted TeamView default change', async () => {
  const restricted = { ...main, restrict_models_to_menu: true };
  client.listNamedAgentProfiles.mockResolvedValue({ items: [restricted], complete: true });
  client.klient.rest.agents.previewModelMenu.mockResolvedValue({ restrict_models_to_menu: true,
    declared_model_menu: { aliases: ['fixture/lite'], default_alias: 'fixture/lite', identities: ['fixture/lite'] },
    effective_model_aliases: ['fixture/lite'], added_model_identities: ['fixture/lite'], removed_model_identities: ['fixture/opus'],
  });
  client.updateNamedAgentProfile.mockResolvedValue({ ...restricted, pinned_model_alias: 'fixture/lite' });
  await render();
  await choose(container.querySelector<HTMLElement>('[data-team-row="agent"] [data-team-model] button')!, 'fixture/lite');
  await settle();
  expect(client.updateNamedAgentProfile).not.toHaveBeenCalled();
  // The menu review is a popover anchored to the model cell, portaled to <body>.
  const review = document.body.querySelector<HTMLElement>('[data-team-menu-review="agent"]')!;
  expect(review.querySelector('[data-menu-removed]')?.textContent).toContain('fixture/opus');
  await act(async () => review.querySelector<HTMLButtonElement>('[data-team-menu-save]')!.click());
  await settle();
  expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ pinned_model_alias: 'fixture/lite' }));
});

it('keeps failed previews unsavable and shows an empty effective set after retry', async () => {
  client.klient.rest.agents.previewModelMenu.mockRejectedValueOnce(new Error('preview unavailable'));
  await render();
  await open('agent');
  await act(async () => sheet().querySelector<HTMLInputElement>('[data-profile-field="restrictModelsToMenu"] input')!.click());
  await settle();
  expect(buttonIn(sheet(), 'Save').disabled).toBe(true);
  expect(sheet().querySelector('[data-model-menu-preview]')?.textContent).toContain('Could not calculate');
  client.klient.rest.agents.previewModelMenu.mockResolvedValue({ restrict_models_to_menu: true,
    declared_model_menu: { aliases: ['fixture/opus'], default_alias: 'fixture/opus', identities: ['fixture/opus'] },
    effective_model_aliases: [], added_model_identities: [], removed_model_identities: [],
  });
  await act(async () => buttonIn(sheet(), 'Retry').click());
  await settle();
  expect(sheet().querySelector('[data-menu-empty]')?.textContent).toContain('No model can bind');
  expect(sheet().querySelector('[data-menu-declared]')?.textContent).toContain('fixture/opus');
  expect(buttonIn(sheet(), 'Save').disabled).toBe(false);
});

describe('profile prompt editing', () => {
  afterEach(() => {
    for (const [, patch] of client.updateNamedAgentProfile.mock.calls) {
      assert.doesNotThrow(() => updateNamedAgentProfileRequestSchema.parse(patch));
    }
  });

  it.each([false, true])('explicit sharing can be cleared directly after common content is absent (empty on load: %s)', async (emptyOnLoad) => {
    const profile: NamedAgentProfile = { ...sub, prompt_overrides: {
      main: 'same', independent: 'off', fields: emptyOnLoad ? undefined : { 'system.shared': 'Common instructions' },
    } };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile], complete: true });
    client.updateNamedAgentProfile.mockImplementation(async (_name, patch) => ({ ...profile, ...patch }));
    await render(); await open('reviewer');
    const fields = sheet().querySelector('[data-profile-section="prompt-overrides"]')!;
    if (!emptyOnLoad) {
      await act(async () => fields.querySelector<HTMLButtonElement>('[data-prompt-common] [data-identity-field-row] button')!.click());
    }
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#profile-description')!, 'Updated description');
    expect(buttonIn(sheet(), 'Save').disabled).toBe(true);
    const same = fields.querySelector<HTMLButtonElement>('[data-prompt-branch-main="same"]')!;
    expect(same.getAttribute('aria-pressed')).toBe('true');
    await act(async () => same.click());
    expect(buttonIn(sheet(), 'Save').disabled).toBe(true);
    expect(client.updateNamedAgentProfile).not.toHaveBeenCalled();
    const clear = fields.querySelector<HTMLButtonElement>('[data-prompt-clear-explicit="main"]');
    expect(clear, 'a direct recovery action for an explicit same declaration').not.toBeNull();
    await act(async () => clear!.click());
    expect(buttonIn(sheet(), 'Save').disabled).toBe(false);
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('reviewer', expect.objectContaining({
      description: 'Updated description', prompt_overrides: { independent: 'off' },
    }));
  });

  it('preserves valid explicit sharing when saving an unrelated profile field', async () => {
    const profile: NamedAgentProfile = { ...sub, prompt_overrides: { main: 'same', fields: { 'system.shared': 'Keep this content' } } };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile], complete: true });
    client.updateNamedAgentProfile.mockImplementation(async (_name, patch) => ({ ...profile, ...patch }));
    await render(); await open('reviewer');
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#profile-description')!, 'Updated description');
    expect(buttonIn(sheet(), 'Save').disabled).toBe(false);
    await save();
    expect(client.updateNamedAgentProfile.mock.calls[0]![1].prompt_overrides).toBeUndefined();
    expect(sheet().querySelector<HTMLTextAreaElement>('[data-profile-section="prompt-overrides"] [data-identity-field-row] textarea')!.value).toBe('Keep this content');
  });

  it('clears model-specific body and mode together when no body is selected', async () => {
    const profile: NamedAgentProfile = { ...sub,
      model_profiles: [{ alias: 'fixture/lite', prompt_mode: 'append', prompt: 'Common instructions' }] };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile], complete: true });
    client.updateNamedAgentProfile.mockResolvedValue({ ...profile, model_profiles: [{ alias: 'fixture/lite' }] });
    await render(); await open('reviewer');
    const content = sheet().querySelector('[data-model-profile-prompts] [data-prompt-common] [data-model-prompt-content]')!;
    await act(async () => content.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click());
    await act(async () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === 'No model-specific instructions')!.click());
    expect(content.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('reviewer', expect.objectContaining({ model_profiles: [{
      alias: 'fixture/lite', when: null, thinking_effort: null,
      prompt_mode: null, prompt: null, main: null, independent: null,
    }] }));
  });

  it('clears model main differences with null while leaving fields and menu untouched', async () => {
    const profile: NamedAgentProfile = { ...sub, restrict_models_to_menu: true,
      model_profiles: [{ alias: 'fixture/lite', prompt_mode: 'append', prompt: 'Common instructions',
        main: { prompt_mode: 'append', prompt: 'Main instructions' },
        prompt_overrides: { main: 'off', fields: { 'tool.read.guidance': 'Read complete context' } } }] };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile], complete: true });
    client.updateNamedAgentProfile.mockResolvedValue(profile);
    await render(); await open('reviewer');
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-model-profile-prompts] [data-prompt-branch-main="same"]')!.click());
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('reviewer', expect.objectContaining({ model_profiles: [{
      alias: 'fixture/lite', when: null, thinking_effort: null,
      prompt_mode: 'append', prompt: 'Common instructions', main: null, independent: null,
    }] }));
    expect(client.klient.rest.agents.previewModelMenu).not.toHaveBeenCalled();
  });

  it('edits profile fields separately from model body and round trips from the save echo', async () => {
    const profile: NamedAgentProfile = { ...sub, prompt_overrides: { fields: { 'system.shared': 'Common' }, main: 'off' } };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile], complete: true });
    client.updateNamedAgentProfile.mockImplementation(async (_name, patch) => ({ ...profile, prompt_overrides: patch.prompt_overrides }));
    await render(); await open('reviewer');
    const field = sheet().querySelector<HTMLTextAreaElement>('[data-profile-section="prompt-overrides"] [data-prompt-common] [data-identity-field-row] textarea')!;
    await typeIn(field, 'Updated common');
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('reviewer', expect.objectContaining({
      prompt_overrides: { fields: { 'system.shared': 'Updated common' }, main: 'off' },
    }));
    expect(client.updateNamedAgentProfile.mock.calls[0]![1].model_profiles).toBeUndefined();
    expect(sheet().querySelector<HTMLTextAreaElement>('[data-profile-section="prompt-overrides"] [data-identity-field-row] textarea')!.value).toBe('Updated common');
  });

  it('sets lease replace explicitly without changing the child model table', async () => {
    const leaseModels = [{ alias: 'fixture/lite', prompt_mode: 'append' as const, prompt: 'Caller instructions' }];
    const profile: NamedAgentProfile = { ...main, allowed_subagents: [{ name: 'explore', model_profiles: leaseModels }] };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [profile, explore], complete: true });
    client.updateNamedAgentProfile.mockResolvedValue(profile);
    await render(); await open('agent');
    await act(async () => buttonIn(sheet().querySelector('[data-lease-model-prompts]')!, 'Replace').click());
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({
      allowed_subagents: [{ name: 'explore', model_alias: null, thinking_effort: null, model_prompts: 'replace', model_profiles: leaseModels }],
    }));
  });
});

describe('handing a new agent to Kiki', () => {
  it('opens one session whose composer waits for an editable /kiki-profile line naming the workspace', async () => {
    client.createSession.mockResolvedValue({ id: 'agent-ask-session' });
    writeDraft('new', 'half-typed agent question');
    await render();

    const ask = container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!;
    expect(ask.textContent).toBe('Ask Kiki');
    expect(ask.getAttribute('aria-label')).toBe('Let Kiki create the agent with you');
    await act(async () => { ask.click(); });
    await settle();

    expect(client.createSession).toHaveBeenCalledTimes(1);
    // The session must run in the workspace this page is filtered to, or the
    // server mints a fresh "Untitled workspace" and the named save target lies.
    expect(client.createSession).toHaveBeenCalledWith({ workspace_id: 'ws-one' });
    expect(navigate).toHaveBeenCalledWith('/s/agent-ask-session',
      { state: { createdSession: { id: 'agent-ask-session', scopeId: 'local' } } });
    const draft = readDraft('agent-ask-session');
    expect(draft).toMatch(/^\/kiki-profile /);
    // The label is for the reader; the id above is the address. A display name
    // is never used as an address, and no config value rides along.
    expect(draft).toContain('Saved in: Fixture');
    expect(draft).not.toContain('ws-one');
    // /new's own draft and the editor's state are untouched.
    expect(readDraft('new')).toBe('half-typed agent question');
    expect(client.createAgentProfile).not.toHaveBeenCalled();
    expect(client.updateNamedAgentProfile).not.toHaveBeenCalled();
  });

  it('asks before leaving the sheet, so an unsaved agent draft is not dropped silently', async () => {
    client.createSession.mockResolvedValue({ id: 'agent-ask-dirty' });
    await render(); await open('agent');
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#profile-prompt')!, 'half-written instructions');
    confirmDiscard.mockClear();

    await act(async () => container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!.click());
    await settle();

    // The sheet still owns the dirty id, so leaving is the guard's decision.
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/s/agent-ask-dirty', expect.anything());
  });

  it('addresses the workspace the picker actually shows, not the first one', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [
      { id: 'ws-old', root: '/old', name: 'Older' },
      { id: 'ws-new', root: '/new', name: 'Chosen' },
    ] });
    client.createSession.mockResolvedValue({ id: 'agent-ask-chosen' });
    await render();

    // Pick the second workspace through the real picker.
    await choose(container.querySelector<HTMLElement>('#agents-workspace-select')!, 'Chosen');
    await settle();

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!.click(); });
    await settle();

    expect(client.createSession).toHaveBeenCalledWith({ workspace_id: 'ws-new' });
    expect(readDraft('agent-ask-chosen')).toContain('Saved in: Chosen');
  });

  it('refuses the handoff, and says why, while the workspace list has failed', async () => {
    client.listWorkspaceCatalog.mockRejectedValue(new Error('workspace list unavailable'));
    client.createSession.mockResolvedValue({ id: 'agent-ask-unknown' });
    await render();

    // `selectedWorkspaceId` collapses to undefined on a failed list, and an
    // empty body here would make the server mint a throwaway directory.
    const ask = container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!;
    expect(ask.disabled).toBe(true);
    // The reason is on screen, not just a dead button.
    expect(container.textContent).toContain('workspace list unavailable');

    await act(async () => { ask.click(); });
    await settle();

    expect(client.createSession).not.toHaveBeenCalled();
    expect(readDraft('agent-ask-unknown')).toBe('');
  });

  it('refuses the handoff while the workspace list is still loading', async () => {
    let release: (value: { items: unknown[] }) => void = () => {};
    client.listWorkspaceCatalog.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    client.createSession.mockResolvedValue({ id: 'agent-ask-loading' });
    await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const ask = container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!;
    expect(ask.disabled).toBe(true);
    await act(async () => { ask.click(); });
    await settle();
    expect(client.createSession).not.toHaveBeenCalled();

    // Once the list answers, the same button works — it is not permanently off.
    await act(async () => { release({ items: [{ id: 'ws-late', root: '/late', name: 'Late' }] }); await new Promise((resolve) => setTimeout(resolve, 5)); });
    await settle();

    expect(container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!.disabled).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!.click(); });
    await settle();
    expect(client.createSession).toHaveBeenCalledWith({ workspace_id: 'ws-late' });
  });

  it('keeps a working handoff when this machine truly has no workspace', async () => {
    client.listWorkspaceCatalog.mockResolvedValue({ items: [] });
    client.createSession.mockResolvedValue({ id: 'agent-ask-none' });
    await render();

    const ask = container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!;
    expect(ask.disabled, 'an empty list is an answer, not a failure').toBe(false);
    await act(async () => { ask.click(); });
    await settle();

    // Same body /new sends when there is nothing to inherit; the server applies
    // its own auto workspace. The draft is still prefilled and unsent.
    expect(client.createSession).toHaveBeenCalledWith({});
    expect(readDraft('agent-ask-none')).toMatch(/^\/kiki-profile /);
  });

  it('creates one session even when the button is clicked twice', async () => {
    client.createSession.mockResolvedValue({ id: 'agent-ask-once' });
    await render();
    const button = container.querySelector<HTMLButtonElement>('[data-agent-ask-kiki]')!;

    await act(async () => { button.click(); button.click(); });
    await settle();

    expect(client.createSession).toHaveBeenCalledTimes(1);
  });
});
