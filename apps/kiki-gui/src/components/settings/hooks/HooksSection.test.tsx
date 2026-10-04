// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../i18n';
import { commitText, pickOption } from '../testControls';
import { HooksSection } from './HooksSection';

interface FixtureConfig {
  hooks: unknown;
  [key: string]: unknown;
}

let config: FixtureConfig;
let patchError: Error | null = null;
const client = {
  getConfig: vi.fn(async () => structuredClone(config)),
  patchConfig: vi.fn(async (patch: Record<string, unknown>) => {
    if (patchError !== null) throw patchError;
    config = { ...config, ...patch };
    return structuredClone(config);
  }),
};
vi.mock('../../../state/connection', () => ({ useConnection: () => ({ client }) }));

const LEGACY_RULE = { event: 'PreToolUse', command: 'echo example', matcher: '^Read$', timeout: 17 };
const V2_MIXED = {
  schemaVersion: 2,
  enabled: true,
  disabled: ['user/off-rule'],
  files: ['hooks/extra.toml'],
  rules: [
    {
      id: 'focus', event: 'step.before', priority: 100, enabled: true,
      match: { tools: ['Write'] },
      cadence: { everyCompletedSteps: 3, counterScope: 'agent', partitionBy: 'model' },
      action: { type: 'inject', text: 'Remember the goal' },
    },
    { id: 'watch', event: 'tool.after', priority: 100, enabled: true, match: {}, action: { type: 'observe' } },
  ],
  legacy: [{ event: 'SessionStart', command: 'echo hi', timeout: 10 }],
};

let root: Root;
let container: HTMLDivElement;
let query: QueryClient;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
async function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(text: string, scope: Element = container) {
  const button = [...scope.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
}
async function clickAria(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.click(); });
  await flush();
}
/** Clicks the checkbox inside the Toggle whose visible label matches. */
async function flip(scope: Element, labelText: string) {
  const label = [...scope.querySelectorAll('label')].find((item) => item.textContent?.includes(labelText));
  expect(label, labelText).toBeTruthy();
  const box = label!.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(box, labelText).toBeTruthy();
  await act(async () => { box!.click(); });
  await flush();
}
async function mount() {
  await act(async () => root.render(<QueryClientProvider client={query}><I18nProvider><HooksSection /></I18nProvider></QueryClientProvider>));
  await flush();
  await flush();
}

const ruleRow = (key: string) => container.querySelector<HTMLButtonElement>(`[data-hooks-rule="${key}"]`)!;
const editor = (kind: 'legacy' | 'declarative') => container.querySelector(`[data-hook-editor="${kind}"]`)!;
const saveActions = () => click('Save actions');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  config = { hooks: [] };
  patchError = null;
  client.patchConfig.mockClear();
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); query.clear(); });

describe('hooks settings (dual shape)', () => {
  it('reads, edits, saves and re-reads a legacy rule without losing fields', async () => {
    config.hooks = [structuredClone(LEGACY_RULE)];
    await mount();
    expect(ruleRow('legacy:0').textContent).toContain('Before a tool runs');
    await act(async () => { ruleRow('legacy:0').click(); });
    await flush();
    const command = editor('legacy').querySelector<HTMLTextAreaElement>('textarea')!;
    expect(command.value).toBe('echo example');
    await change(command, 'echo updated');
    await saveActions();
    expect(config.hooks).toEqual([{ ...LEGACY_RULE, command: 'echo updated' }]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    await act(async () => { ruleRow('legacy:0').click(); });
    await flush();
    expect(editor('legacy').querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('echo updated');
  });

  it('blocks saving a new command rule until the command is filled, then removes it', async () => {
    await mount();
    expect(container.textContent).toContain('No automatic actions configured yet.');
    await click('Add command rule');
    await saveActions();
    expect(client.patchConfig).not.toHaveBeenCalled();
    expect(container.querySelector('[data-hook-issue="command"]')).not.toBeNull();
    const command = editor('legacy').querySelector<HTMLTextAreaElement>('textarea')!;
    await change(command, 'echo hi');
    await saveActions();
    expect(config.hooks).toEqual([{ event: 'PreToolUse', command: 'echo hi' }]);
    await act(async () => { ruleRow('legacy:0').click(); });
    await flush();
    await click('Remove rule');
    await saveActions();
    expect(config.hooks).toEqual([]);
  });

  it('reads a mixed v2 object and saves one rule edit without dropping anything else', async () => {
    config.hooks = structuredClone(V2_MIXED);
    await mount();
    expect(container.textContent).toContain('Declarative rules');
    expect(container.textContent).toContain('Command rules');
    expect(ruleRow('declarative:focus').textContent).toContain('Before each step');
    expect(ruleRow('declarative:watch').textContent).toContain('Observe');
    await act(async () => { ruleRow('declarative:focus').click(); });
    await flush();
    const id = editor('declarative').querySelector<HTMLInputElement>('input.font-mono')!;
    expect(id.value).toBe('focus');
    const text = editor('declarative').querySelector<HTMLTextAreaElement>('textarea')!;
    expect(text.value).toBe('Remember the goal');
    await change(text, 'New guidance');
    await saveActions();
    const saved = config.hooks as typeof V2_MIXED;
    expect(saved).toEqual({
      ...V2_MIXED,
      rules: [{ ...V2_MIXED.rules[0], action: { type: 'inject', text: 'New guidance' } }, V2_MIXED.rules[1]],
    });
  });

  it('converts a legacy array to v2 explicitly when the first declarative rule is added', async () => {
    config.hooks = [{ event: 'Stop', command: 'echo stop' }];
    await mount();
    await click('Add declarative rule');
    // The legacy rule moved into the v2 object; the new rule is open for editing.
    expect(ruleRow('legacy:0').textContent).toContain('Before an agent stops');
    expect(editor('declarative').querySelector<HTMLInputElement>('input.font-mono')!.value).toBe('rule-1');
    await saveActions();
    expect(client.patchConfig).not.toHaveBeenCalled();
    expect(container.querySelector('[data-hook-issue="text"]')).not.toBeNull();
    await change(editor('declarative').querySelector<HTMLTextAreaElement>('textarea')!, 'Guide the turn');
    await saveActions();
    expect(config.hooks).toEqual({
      schemaVersion: 2,
      enabled: true,
      disabled: [],
      files: [],
      rules: [{ id: 'rule-1', event: 'prompt.submit', priority: 100, enabled: true, match: {}, action: { type: 'inject', text: 'Guide the turn' } }],
      legacy: [{ event: 'Stop', command: 'echo stop' }],
    });
  });

  it('switches the whole declarative set off without touching command rules', async () => {
    config.hooks = structuredClone(V2_MIXED);
    await mount();
    const toggle = container.querySelector<HTMLInputElement>('#hooks-v2-enabled')!;
    expect(toggle.checked).toBe(true);
    await act(async () => { toggle.click(); });
    await flush();
    await saveActions();
    expect((config.hooks as typeof V2_MIXED).enabled).toBe(false);
    expect((config.hooks as typeof V2_MIXED).legacy).toEqual(V2_MIXED.legacy);
  });

  it('edits rule files and disabled ids as lists', async () => {
    config.hooks = structuredClone(V2_MIXED);
    await mount();
    await clickAria('Remove hooks/extra.toml');
    const input = container.querySelector<HTMLInputElement>('[data-hooks-files] input')!;
    await commitText(input, 'hooks/more.toml');
    await flush();
    const disabledInput = container.querySelector<HTMLInputElement>('[data-hooks-disabled] input')!;
    await commitText(disabledInput, 'workspace/lint');
    await flush();
    await saveActions();
    expect((config.hooks as typeof V2_MIXED).files).toEqual(['hooks/more.toml']);
    expect((config.hooks as typeof V2_MIXED).disabled).toEqual(['user/off-rule', 'workspace/lint']);
  });

  it('round-trips both shapes through the raw JSON editor and rejects broken JSON in place', async () => {
    config.hooks = structuredClone(V2_MIXED);
    await mount();
    await click('Advanced: edit JSON');
    const json = container.querySelector<HTMLTextAreaElement>('#st-card-hooks textarea')!;
    expect(json.value).toContain('"schemaVersion": 2');
    await change(json, '{broken');
    await click('Use rule form');
    expect(container.querySelector<HTMLTextAreaElement>('#st-card-hooks textarea')).not.toBeNull();
    expect(client.patchConfig).not.toHaveBeenCalled();
    await change(json, JSON.stringify([LEGACY_RULE]));
    await click('Use rule form');
    expect(ruleRow('legacy:0').textContent).toContain('Before a tool runs');
    await saveActions();
    expect(config.hooks).toEqual([LEGACY_RULE]);
  });

  it('flattens a rule-less v2 object back to a plain command array on request', async () => {
    config.hooks = { schemaVersion: 2, enabled: true, disabled: [], files: [], rules: [], legacy: [{ event: 'Stop', command: 'echo stop' }] };
    await mount();
    await click('Use command rules only');
    await saveActions();
    expect(config.hooks).toEqual([{ event: 'Stop', command: 'echo stop' }]);
  });

  it('removes a declarative rule and keeps the rest of the object intact', async () => {
    config.hooks = structuredClone(V2_MIXED);
    await mount();
    await act(async () => { ruleRow('declarative:watch').click(); });
    await flush();
    await click('Remove rule');
    expect(container.querySelector('[data-hooks-rule="declarative:watch"]')).toBeNull();
    await saveActions();
    const saved = config.hooks as typeof V2_MIXED;
    expect(saved.rules).toEqual([V2_MIXED.rules[0]]);
    expect(saved.files).toEqual(V2_MIXED.files);
    expect(saved.disabled).toEqual(V2_MIXED.disabled);
  });

  it('keeps the draft on a failed save and on an external config refetch', async () => {
    config.hooks = structuredClone(V2_MIXED);
    await mount();
    await act(async () => { ruleRow('declarative:focus').click(); });
    await flush();
    const text = editor('declarative').querySelector<HTMLTextAreaElement>('textarea')!;
    await change(text, 'Edited text');
    patchError = new Error('offline');
    await saveActions();
    expect(container.textContent).toContain('offline');
    expect(editor('declarative').querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Edited text');
    await act(async () => query.setQueryData(['config'], { hooks: [] }));
    await flush();
    expect(editor('declarative').querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Edited text');
    patchError = null;
    await saveActions();
    expect((config.hooks as typeof V2_MIXED).rules[0]!.action).toEqual({ type: 'inject', text: 'Edited text' });
  });

  it('coerces event and preserves typed text when switching between inject and observe', async () => {
    config.hooks = structuredClone(V2_MIXED);
    await mount();
    await act(async () => { ruleRow('declarative:focus').click(); });
    await flush();
    const eventTrigger = () => editor('declarative').querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
    // The rule carries a cadence, which pins it to step events — drop the
    // cadence first so a non-step event becomes selectable again.
    await flip(editor('declarative'), 'Repeat every N completed steps');
    // Inject on step.before → switching to observe frees every event.
    await act(async () => { editor('declarative').querySelector<HTMLButtonElement>('[data-hook-action="observe"]')!.click(); });
    await flush();
    await pickOption(eventTrigger(), 'After a tool runs');
    expect(eventTrigger().textContent).toContain('After a tool runs');
    // Back to inject on an incompatible event: the event moves to prompt submit.
    await act(async () => { editor('declarative').querySelector<HTMLButtonElement>('[data-hook-action="inject"]')!.click(); });
    await flush();
    expect(eventTrigger().textContent).toContain('On prompt submit');
    expect(editor('declarative').querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Remember the goal');
  });
});
