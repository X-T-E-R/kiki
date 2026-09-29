// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NamedAgentProfile } from '@kiki/protocol';
import { I18nProvider } from '../../i18n';
import { UnifiedAgentManager } from './UnifiedAgentManager';

const { client, reportDirty, confirmDiscard, navigate } = vi.hoisted(() => ({
  reportDirty: vi.fn(), navigate: vi.fn(), confirmDiscard: vi.fn((_id: string, action: () => void) => action()),
  client: {
    listNamedAgentProfiles: vi.fn(), listShippedAgentProfiles: vi.fn(), listWorkspaces: vi.fn(), getConfig: vi.fn(),
    updateNamedAgentProfile: vi.fn(), createAgentProfile: vi.fn(), patchConfig: vi.fn(), restoreShippedAgentProfile: vi.fn(),
    readHostFile: vi.fn(), getAgentCapabilities: vi.fn(), listModels: vi.fn(), listExecutors: vi.fn(),
    previewExecutorPrompt: vi.fn(),
  },
}));
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client }), useOptionalConnection: () => ({ client }),
}));
vi.mock('../dirtyGuard', () => ({
  useDirtyGuard: () => ({ confirmDiscard }), useGuardedNavigate: () => navigate,
  useDirtyReporter: (id: string, dirty: boolean) => reportDirty(id, dirty),
}));

const main: NamedAgentProfile = {
  name: 'agent', main: true, source: 'user', source_file: '/fixture/agent/SYSTEM.md',
  workspace_id: 'ws-one', description: 'Default', prompt: 'Old instructions', disabled: false, routes: [],
  pinned_model_alias: 'fixture/opus', thinking_effort: 'high',
  subagents: ['reviewer', { name: 'explore', model_alias: 'fixture/lite', thinking_effort: 'max' }],
};
const sub: NamedAgentProfile = {
  name: 'reviewer', main: false, source: 'user', source_file: '/fixture/reviewer/SYSTEM.md',
  workspace_id: 'ws-one', description: 'Review work', prompt: 'Check changes', disabled: false, routes: [],
  pinned_model_alias: 'typo/model', subagents: [],
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
const sheet = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!;
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
async function save() {
  await act(async () => buttonIn(sheet(), 'Save').click());
  await settle();
}

beforeEach(() => {
  vi.resetAllMocks();
  confirmDiscard.mockImplementation((_id: string, action: () => void) => action());
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore], complete: true });
  client.listShippedAgentProfiles.mockResolvedValue({ items: [] });
  client.listWorkspaces.mockResolvedValue({ items: [{ id: 'ws-one', root: '/fixture', name: 'Fixture' }] });
  client.getConfig.mockResolvedValue({});
  client.listExecutors.mockResolvedValue({ items: [] });
  client.previewExecutorPrompt.mockRejectedValue(new Error('preview unavailable'));
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
  await act(async () => root.render(<QueryClientProvider client={queries}><I18nProvider>
    <UnifiedAgentManager />
  </I18nProvider></QueryClientProvider>));
  await settle();
}

describe('agents team view', () => {
  it('lists every agent with model, effort and whom it may call, and flags an alias the catalog lacks', async () => {
    await render();
    const rows = [...container.querySelectorAll<HTMLElement>('[data-team-row]')].map((row) => row.dataset['teamRow']);
    // Grouped by source (global before built-in); main agents first within a group.
    expect(rows).toEqual(['agent', 'reviewer', 'explore']);
    const lead = container.querySelector('[data-team-row="agent"]')!;
    expect(lead.querySelector('[data-team-dispatch]')?.textContent).toContain('reviewer, explore');
    expect(lead.querySelector('[data-team-effort]')?.textContent).toContain('High');
    const reviewer = container.querySelector('[data-team-row="reviewer"]')!;
    expect(reviewer.querySelector('[data-team-dispatch]')?.textContent).toContain('None');
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
    expect(container.textContent).toContain('Saved reviewer.');
  });

  it('filters to main agents', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-team-filter="main"]')!.click());
    expect(container.querySelectorAll('[data-team-row]')).toHaveLength(1);
  });

  it('groups workspace, global and built-in agents, main above subagents, and hides an empty group', async () => {
    const local: NamedAgentProfile = { ...sub, name: 'local-lead', main: true, source: 'workspace', source_file: '/fixture/.kiki/agents/local-lead.md' };
    const localSub: NamedAgentProfile = { ...sub, name: 'local-helper', source: 'workspace', source_file: '/fixture/.kiki/agents/local-helper.md' };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore, localSub, local], complete: true });
    await render();
    const groups = [...container.querySelectorAll<HTMLElement>('[data-team-group]')];
    expect(groups.map((group) => group.dataset['teamGroup'])).toEqual(['workspace', 'global', 'builtin']);
    expect([...groups[0]!.querySelectorAll<HTMLElement>('[data-team-row]')].map((row) => row.dataset['teamRow'])).toEqual(['local-lead', 'local-helper']);
    expect([...groups[0]!.querySelectorAll<HTMLElement>('[data-team-kind]')].map((row) => row.dataset['teamKind'])).toEqual(['main', 'subagent']);
    client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore], complete: true });
    await act(async () => { await queries.invalidateQueries(); });
    await settle();
    expect(container.querySelector('[data-team-group="workspace"]')).toBeNull();
  });

  it('shows each main agent with its roster, lease pins winning over the member pin', async () => {
    const second: NamedAgentProfile = { ...sub, name: 'lead-two', main: true, source_file: '/fixture/lead-two/SYSTEM.md', subagents: ['agent'] };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [main, sub, explore, second], complete: true });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-team-layout="teams"]')!.click());
    const teams = [...container.querySelectorAll<HTMLElement>('[data-roster-team]')].map((team) => team.dataset['rosterTeam']);
    expect(teams).toEqual(['agent', 'lead-two']);
    const lead = container.querySelector('[data-roster-team="agent"]')!;
    expect([...lead.querySelectorAll<HTMLElement>('[data-roster-member]')].map((row) => row.dataset['rosterMember'])).toEqual(['reviewer', 'explore']);
    const leased = lead.querySelector('[data-roster-member="explore"]')!;
    expect(leased.textContent).toContain('fixture/lite');
    expect(leased.textContent).toContain('set by agent');
    expect(lead.querySelector('[data-roster-member="reviewer"]')?.textContent).toContain('typo/model');
    // A main agent called by name is shown as it is, marked Main.
    expect(container.querySelector('[data-roster-team="lead-two"] [data-roster-member="agent"]')?.textContent).toContain('Main');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-roster-team="agent"] [data-roster-open="explore"]')!.click());
    await settle();
    expect(sheet().querySelector('[data-agent-detail="explore"]')).not.toBeNull();
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

describe('profile editor sheet', () => {
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

  it('edits the subagent whitelist and a lease pin, keeping untouched entries bare', async () => {
    client.updateNamedAgentProfile.mockResolvedValue(main);
    await render();
    await open('agent');
    const field = sheet().querySelector<HTMLElement>('[data-subagents-field]')!;
    expect([...field.querySelectorAll('[data-subagent-row]')].map((row) => row.getAttribute('data-subagent-row'))).toEqual(['reviewer', 'explore']);
    await choose(field.querySelector<HTMLElement>('#lease-effort-explore')!, 'High');
    await save();
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({
      subagents: ['reviewer', { name: 'explore', model_alias: 'fixture/lite', thinking_effort: 'high' }],
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
    expect(client.updateNamedAgentProfile).toHaveBeenCalledWith('agent', expect.objectContaining({ subagents: ['explore', 'reviewer'] }));
  });

  it('lists same-name files the profile shadows', async () => {
    client.listNamedAgentProfiles.mockResolvedValue({ items: [{ ...main, shadowed_files: ['/fixture/agent/old/SYSTEM.md'] }, sub, explore], complete: true });
    await render();
    await open('agent');
    expect(sheet().querySelector('[data-profile-diagnostic="shadows"] [data-shadowed-file="/fixture/agent/old/SYSTEM.md"]')).not.toBeNull();
  });

  it('sets and clears spawn constraints under Advanced', async () => {
    const constrained = { ...main, spawn_constraints: { allowed_models: ['fixture/lite'], disallowed_tools: ['WebFetch'] } };
    client.listNamedAgentProfiles.mockResolvedValue({ items: [constrained, sub, explore], complete: true });
    client.updateNamedAgentProfile.mockResolvedValue(constrained);
    await render();
    await open('agent');
    const advanced = sheet().querySelector<HTMLElement>('[data-profile-section="advanced"]')!;
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

  it('switches a leaf to an explicit list and blocks saving an empty one', async () => {
    await render();
    await open('reviewer');
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-subagents-mode="list"]')!.click());
    expect(buttonIn(sheet(), 'Save').disabled).toBe(true);
    expect(sheet().textContent).toContain('The subagent list is empty or repeats a name.');
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
    client.listExecutors.mockResolvedValue({ items: [
      { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
      { id: 'grok-acp', label: 'Grok Build', protocol: 'acp', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
      { id: 'claude-acp', label: 'Claude Code', protocol: 'acp', status: 'unavailable', model_binding: 'mapped', thinking_binding: 'unavailable' },
    ] });
    await render();
    expect(container.querySelector('[data-team-row="grok-helper"] [data-team-engine]')?.textContent).toBe('Grok Build');
    await open('grok-helper');
    // The engine picker lists the catalog, not a hard-coded set; a missing binary says so.
    await act(async () => sheet().querySelector<HTMLElement>('#profile-engine')!.click());
    const engineOptions = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent ?? '');
    expect(engineOptions.some((text) => text.includes('Claude Code') && text.includes('not found on this machine'))).toBe(true);
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

  it('guards a dirty draft when the sheet closes and discards on request', async () => {
    await render();
    await open('agent');
    await typeIn(sheet().querySelector<HTMLTextAreaElement>('#profile-prompt')!, 'Unsaved');
    expect(reportDirty).toHaveBeenCalledWith('agent-detail:user:/fixture/agent/SYSTEM.md:agent', true);
    await act(async () => buttonIn(sheet(), 'Discard changes').click());
    expect(sheet().querySelector<HTMLTextAreaElement>('#profile-prompt')!.value).toBe('Old instructions');
    await act(async () => sheet().querySelector<HTMLButtonElement>('[data-agent-back]')!.click());
    expect(confirmDiscard).toHaveBeenCalledWith('agent-raw:/fixture/agent/SYSTEM.md', expect.any(Function));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
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
