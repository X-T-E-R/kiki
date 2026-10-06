// @vitest-environment jsdom

/**
 * PlanSettings plan-gate defaults slice: the toggle writes `[plan] gate`
 * and the seconds field writes `enter_approval_timeout_ms` (floor 5000).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { GeneralSection } from './GeneralSection';
import { PermissionsSection } from './PermissionsSection';
import { PlanSettings } from './PlanSettings';
import { SessionsSection } from './SessionsSection';

const getConfig = vi.fn();
const patchConfig = vi.fn();
const meta = vi.fn();
const listModels = vi.fn();
const listTools = vi.fn(async () => ({ tools: [] }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig, meta, listModels, listTools } }),
}));
vi.mock('../../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));

const CONFIG: KikiConfigResponse = {
  default_permission_mode: 'manual',
  default_plan_mode: false,
  plan: { gate: 'gated', enterApprovalTimeoutMs: 15_000 },
} as KikiConfigResponse;

// Stand-ins for the server's two bodies. The built-in one is only ever read
// back from the fixture, never written by the component, so these stand in
// for two different sentences rather than a literal copy of the real default.
const DEFAULT_TITLE_PROMPT = 'Name the conversation in one line, at most 8 words.';
const CUSTOM_TITLE_PROMPT = 'Summarise what this thread is actually for.\nUse the words the user used.';

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

// The server's stored config, so a patch really round-trips: the card reads
// the echo back through GET /config, and a test that only asserted the patch
// body would pass while the stored value never moved.
let stored: KikiConfigResponse = { ...CONFIG };

beforeEach(() => {
  stored = { ...CONFIG };
  getConfig.mockReset().mockImplementation(async () => stored);
  meta.mockReset().mockResolvedValue({ experimental_flags: { auto_session_title: true } });
  listModels.mockReset().mockResolvedValue({
    items: [
      { id: 'kimi-for-coding', provider: 'kimi', name: 'Kimi for Coding' },
      { id: 'custom-model', provider: 'openai', name: 'Custom Model' },
    ],
  });
  patchConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => {
    if (typeof patch['default_permission_mode'] === 'string') {
      stored = { ...stored, default_permission_mode: patch['default_permission_mode'] as KikiConfigResponse['default_permission_mode'] };
    }
    if (typeof patch['default_plan_mode'] === 'boolean') {
      stored = { ...stored, default_plan_mode: patch['default_plan_mode'] as boolean };
    }
    if (typeof patch['plan'] === 'object' && patch['plan'] !== null) {
      stored = { ...stored, plan: { ...CONFIG.plan, ...(patch['plan'] as Record<string, unknown>) } as KikiConfigResponse['plan'] };
    }
    const sessionTitle = patch['session_title'] as Record<string, unknown> | undefined;
    if (sessionTitle !== undefined) {
      // The real route merges one field at a time and never replaces the
      // domain: `null` clears that field, an absent key leaves it alone, and
      // anything else stores it. A patch that carried the whole domain would
      // silently drop the fields it did not mention, which is exactly the
      // failure this mock is here to catch.
      const next = { ...stored.session_title } as Record<string, unknown>;
      for (const [key, value] of Object.entries(sessionTitle)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      stored = { ...stored, session_title: next as NonNullable<typeof stored.session_title> };
    }
    // The route derives the two metadata fields on every response rather than
    // storing them: the built-in body is always reported, and the source
    // follows whether an override is actually there.
    if (stored.session_title !== undefined) {
      stored = {
        ...stored,
        session_title: {
          ...stored.session_title,
          default_prompt: DEFAULT_TITLE_PROMPT,
          prompt_source: stored.session_title['prompt'] === undefined ? 'default' : 'custom',
        },
      };
    }
    const experimental = patch['experimental'] as Record<string, boolean> | undefined;
    if (experimental !== undefined) stored = { ...stored, experimental };
    return stored;
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderSection(section: 'general' | 'permissions' | 'sessions' | 'plan' = 'plan'): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <I18nProvider>
            {section === 'plan' ? <PlanSettings /> : section === 'permissions' ? <PermissionsSection /> : section === 'sessions' ? <SessionsSection /> : <GeneralSection />}
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Let the config query land and sync the local defaults.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function type(area: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function promptField(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-session-title-prompt]')!;
}

/** The editor inside an already-located prompt field. */
function promptBox(field: HTMLElement): HTMLTextAreaElement {
  return field.querySelector<HTMLTextAreaElement>('[data-session-title-prompt-input]')!;
}

async function commitInput(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function gateSwitch(container: HTMLDivElement): HTMLElement {
  const row = [...container.querySelectorAll('label')].find(
    (label) => label.textContent === 'Require approval when the model changes plan mode',
  );
  expect(row).toBeDefined();
  return row!.querySelector<HTMLElement>('[role="switch"]')!;
}

describe('PlanSettings plan gate defaults', () => {
  it('reflects the server plan gate and timeout', async () => {
    const container = await renderSection('plan');
    const toggle = gateSwitch(container);
    // gate: 'gated' reads as the approval switch being on.
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    expect(input.value).toBe('15');
  });

  it('writes plan.gate on toggle', async () => {
    const container = await renderSection('plan');
    const toggle = gateSwitch(container);
    await click(toggle);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(patchConfig).toHaveBeenCalledWith({ plan: { gate: 'free' } });
  });

  it('saves the timeout when the field commits (Enter or blur), like the other number fields', async () => {
    const container = await renderSection('plan');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    await setInputValue(input, '30');
    expect(patchConfig).not.toHaveBeenCalled();
    await commitInput(input);
    expect(patchConfig).toHaveBeenCalledWith({ plan: { enter_approval_timeout_ms: 30_000 } });
  });

  it('rejects a timeout below the 5s floor without patching', async () => {
    const container = await renderSection('plan');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    await setInputValue(input, '3');
    await commitInput(input);
    expect(patchConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('at least 5 seconds');
    expect(input.value).toBe('3');
  });

  it('merges a partial plan echo without dropping other config fields', async () => {
    const container = await renderSection('plan');
    patchConfig.mockResolvedValueOnce({ default_plan_mode: true } as KikiConfigResponse);
    const defaultPlanSwitch = container.querySelector<HTMLElement>('[data-plan-settings] [role="switch"]')!;
    await click(defaultPlanSwitch);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(defaultPlanSwitch.getAttribute('aria-checked')).toBe('true');
    expect(gateSwitch(container).getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('#plan-gate-timeout')?.value).toBe('15');
  });

  it('reverts a failed plan save to the server draft and keeps the error visible', async () => {
    const container = await renderSection('plan');
    patchConfig.mockRejectedValueOnce(new Error('fixture offline'));
    const defaultPlanSwitch = container.querySelector<HTMLElement>('[data-plan-settings] [role="switch"]')!;
    await click(defaultPlanSwitch);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(defaultPlanSwitch.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('fixture offline');
  });

  it('keeps General to device preferences and puts server defaults on their own pages', async () => {
    const app = await renderSection('general');
    expect(app.querySelector('#st-card-language')).not.toBeNull();
    expect(app.querySelector('#st-card-append-timing')).not.toBeNull();
    for (const moved of ['#st-card-permission-defaults', '#st-card-session-title', '#st-card-questions', '[data-question-behavior]']) {
      expect(app.querySelector(moved), moved).toBeNull();
    }
    // Nothing on General talks to the server.
    expect(getConfig).not.toHaveBeenCalled();
    const permissions = await renderSection('permissions');
    expect(permissions.querySelector('#st-card-permission-defaults')).not.toBeNull();
    expect(permissions.querySelector('#st-card-permission-defaults [data-settings-effect="newSessions"]')).not.toBeNull();
  });

  it('offers four permission defaults, saving review immediately', async () => {
    const container = await renderSection('permissions');
    const card = container.querySelector('#st-card-permission-defaults')!;
    const choices = [...card.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Default permission mode"] button')];
    expect(choices.map((choice) => choice.textContent)).toEqual(['Ask every time', 'Auto', 'Approve for me', 'Full access']);
    await click(choices[2]!);
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'review' });
    expect(card.textContent).toContain('reviewer checks sensitive actions');
  });

  it('writes the dangerous Bash guard from the default mode card', async () => {
    const container = await renderSection('permissions');
    const choice = container.querySelector<HTMLButtonElement>('#st-card-permission-defaults [role="group"][aria-label="Dangerous Bash commands"] button:nth-child(2)')!;
    await click(choice);
    expect(patchConfig).toHaveBeenCalledWith({ permission: { dangerous_bash: 'on' } });
    expect(container.textContent).toContain('Full access');
  });

  it('saves the question blocking choice immediately on Sessions', async () => {
    const container = await renderSection('sessions');
    const card = container.querySelector('#st-card-questions')!;
    expect(card.querySelector('[data-question-behavior]')?.textContent).toContain('Don’t block');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Block')!);
    expect(patchConfig).toHaveBeenCalledWith({ interaction: { ask_user_question: 'blocking' } });
  });

  it('keeps the model picker reachable while automatic titling is off', async () => {
    stored = { ...CONFIG, experimental: { auto_session_title: false } };
    meta.mockResolvedValue({ experimental_flags: { auto_session_title: false } });
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    // The picker is the decision, so the switch does not gate it: a user who
    // cannot reach it cannot turn automatic titling back on.
    expect(card.querySelector('#session-title-model')).not.toBeNull();
    expect(card.querySelector('[data-session-title-moments]')).toBeNull();
    expect([...card.querySelectorAll('button')].some((button) => button.textContent === 'Save')).toBe(false);
    await click(card.querySelector('[role="switch"]')!.closest('label')!.querySelector('input')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({
      experimental: { auto_session_title: true },
      replace_domains: ['experimental'],
    });
  });

  it('writes the title model the moment it is picked, and reads it back', async () => {
    stored = { ...CONFIG, experimental: { auto_session_title: true } };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    await click(card.querySelector('#session-title-model')!);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent?.includes('custom-model'))!;
    await click(option);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({ session_title: { model: 'custom-model' } });
    // Stored, not just sent: the next GET returns the picked model.
    expect(stored.session_title?.model).toBe('custom-model');
    expect(card.querySelector("#session-title-model")!.textContent).toContain("custom-model");
  });

  // An empty model is a real state now: the engine writes a title with
  // `session_title.model` and nothing else (no fast_model, no managed tool),
  // so the card must not present it as a default that still generates.
  it('presents an empty model as "no title model" and never as a managed default', async () => {
    stored = { ...CONFIG, fast_model: 'kimi-for-coding', experimental: { auto_session_title: true } };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    expect(card.querySelector('#session-title-model')!.textContent).toContain('No title model');
    expect(card.textContent).toContain('No model chosen, so Kiki sends no request to write a title.');
    // A fast model is not a title source any more, so it must not be named.
    expect(card.textContent).not.toContain('fast model: kimi-for-coding');

    await click(card.querySelector('#session-title-model')!);
    const unset = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes('No title model'))!;
    expect(unset.textContent).toContain('Pick a model to write titles');
    expect(unset.textContent).not.toContain('Included with your subscription');
    expect(unset.textContent).not.toContain('fast model');
  });

  // Without a model the boxes are still real stored state: a user stages the
  // moments they want, and the backend guarantees no request goes out. Drawing
  // the stored choice as empty would claim the choice was never saved.
  it('shows the stored moments even with no model, and lets a moment be preselected', async () => {
    stored = { ...CONFIG, experimental: { auto_session_title: true } };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    const box = (moment: string) => card.querySelector<HTMLInputElement>(`[data-title-moment="${moment}"] input`)!;
    // The engine default is a real choice, shown whether or not a model exists.
    expect(box('first_turn_completed').checked).toBe(true);
    // Exactly one line names the state, and it does not promise that picking a
    // model is the only thing still missing. The switch and the fieldset label
    // already say when titles are written, so neither is restated.
    expect(card.textContent).toContain('No model chosen, so Kiki sends no request to write a title.');
    expect(card.textContent).not.toContain('at the moments you pick');
    expect(card.textContent).not.toContain('turn titling on');

    await click(box('context_compacted'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(stored.session_title?.triggers).toEqual(['first_turn_completed', 'context_compacted']);
    // Still checked after the write, because it is still the stored state.
    expect(box('context_compacted').checked).toBe(true);
  });

  // Each title write touches one field, so the moments survive because they
  // were never part of the write.
  it('keeps every chosen moment when a model is picked', async () => {
    stored = {
      ...CONFIG,
      session_title: { triggers: ['first_user_message', 'context_compacted'] },
      experimental: { auto_session_title: true },
    };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    await click(card.querySelector('#session-title-model')!);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes('custom-model'))!;
    await click(option);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({ session_title: { model: 'custom-model' } });
    expect(stored.session_title?.triggers).toEqual(['first_user_message', 'context_compacted']);
  });

  // An explicit `[]` is a choice the user made, not an absent value, so picking
  // a model must not silently switch the moments back on for them.
  it('keeps an explicit empty moment set when a model is picked', async () => {
    stored = {
      ...CONFIG,
      session_title: { model: 'custom-model', triggers: [] },
      experimental: { auto_session_title: true },
    };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    expect([...card.querySelectorAll<HTMLInputElement>('[data-session-title-moments] input')].every((box) => !box.checked)).toBe(true);
    await click(card.querySelector('#session-title-model')!);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes('kimi-for-coding'))!;
    await click(option);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({ session_title: { model: 'kimi-for-coding' } });
    expect(stored.session_title?.triggers).toEqual([]);
  });

  it('shows the engine default moment and writes a chosen one without losing the model', async () => {
    stored = { ...CONFIG, session_title: { model: 'custom-model' }, experimental: { auto_session_title: true } };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    const box = (moment: string) => card.querySelector<HTMLInputElement>(`[data-title-moment="${moment}"] input`)!;
    // An absent `triggers` is the engine default: the first completed reply.
    expect(box('first_turn_completed').checked).toBe(true);
    expect(box('first_user_message').checked).toBe(false);

    await click(box('first_user_message'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({
      session_title: { triggers: ['first_user_message', 'first_turn_completed'] },
    });
    // Only the moments were written, so the model is untouched on the server.
    expect(stored.session_title?.model).toBe('custom-model');
    expect(stored.session_title?.triggers).toEqual(['first_user_message', 'first_turn_completed']);
    expect(box('first_user_message').checked).toBe(true);

    await click(box('first_turn_completed'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(stored.session_title?.triggers).toEqual(['first_user_message']);
    expect(stored.session_title?.model).toBe('custom-model');
  });

  // The card renders from a config read at mount, and a moment can be toggled
  // long after some other surface — another window, the models page, a REST
  // call — has changed the model the server actually holds. The write goes out
  // after a fresh read, so the honest thing it can send is the moment alone:
  // anything else is this page's now-stale copy of a field it was not asked to
  // change. This asserts the outgoing shape, so a version that carried the
  // model fails here rather than quietly reverting someone else's choice.
  it('writes only the moments when the model changed after this card rendered', async () => {
    stored = {
      ...CONFIG,
      session_title: { model: 'old-model', triggers: ['first_turn_completed'], prompt_source: 'default' },
      experimental: { auto_session_title: true },
    };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    // What the screen is showing right now, before anything else moves.
    expect(card.querySelector('#session-title-model')!.textContent).toContain('old-model');

    // Somewhere else, the model is re-chosen and the instruction is saved.
    stored = {
      ...stored,
      session_title: { model: 'new-model', triggers: ['first_turn_completed'], prompt: CUSTOM_TITLE_PROMPT },
    };

    await click(card.querySelector<HTMLInputElement>('[data-title-moment="first_user_message"] input')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // Exactly one field went out. A body carrying `model` here is the defect:
    // it would land `old-model` over the choice actually stored.
    expect(patchConfig).toHaveBeenLastCalledWith({
      session_title: { triggers: ['first_user_message', 'first_turn_completed'] },
    });
    // The server keeps the new model and the saved instruction, byte for byte.
    expect(stored.session_title?.model).toBe('new-model');
    expect(stored.session_title?.['prompt']).toBe(CUSTOM_TITLE_PROMPT);
    expect(stored.session_title?.triggers).toEqual(['first_user_message', 'first_turn_completed']);
  });

  it('reads back an empty trigger list as manual-only, not as the engine default', async () => {
    stored = {
      ...CONFIG,
      session_title: { model: 'custom-model', triggers: [] },
      experimental: { auto_session_title: true },
    } as KikiConfigResponse;
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    const moments = card.querySelector('[data-session-title-moments]')!;
    expect([...moments.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].some((box) => box.checked)).toBe(false);
  });

  // The wire ids are snake_case contract, not copy. A label built by pasting
  // the id into a key would render as `st.sessions.titleMoment.first_…`, and
  // only a screenshot catches that; this keeps it from coming back.
  it('labels each moment in words, never with a raw wire id', async () => {
    stored = { ...CONFIG, session_title: { model: 'custom-model' }, experimental: { auto_session_title: true } };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    expect(card.textContent).toContain('First message sent');
    expect(card.textContent).toContain('First reply finished');
    expect(card.textContent).toContain('Context compacted');
    expect(card.textContent).not.toContain('first_user_message');
    expect(card.textContent).not.toContain('first_turn_completed');
    expect(card.textContent).not.toContain('context_compacted');
    expect(card.textContent).not.toContain('st.sessions.titleMoment');
  });

  it('keeps every stored value when a save fails, and says what failed', async () => {
    stored = { ...CONFIG, session_title: { model: 'custom-model' }, experimental: { auto_session_title: true } };
    patchConfig.mockRejectedValueOnce(new Error('server said no'));
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    await click(card.querySelector('[data-title-moment="context_compacted"] input')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const error = card.querySelector('[data-feedback-tone="error"]');
    expect(error?.textContent).toContain('server said no');
    // The failure is reported, and nothing on the card moved.
    expect(card.querySelector("#session-title-model")!.textContent).toContain("custom-model");
    expect(stored.session_title?.model).toBe('custom-model');
    expect(stored.session_title?.triggers).toBeUndefined();
  });

  it('still saves each choice instantly with the explanation moved aside', async () => {
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const questions = container.querySelector('#st-card-questions')!;
    await click([...questions.querySelectorAll('button')].find((button) => button.textContent === 'Block')!);
    expect(patchConfig).toHaveBeenCalledWith({ interaction: { ask_user_question: 'blocking' } });
    expect(questions.querySelector('[data-saved-tick]')).not.toBeNull();
  });

  // The prompt body is a piece of prose the reader has to be able to see, so
  // the default is read from the server and shown as text rather than
  // paraphrased or hidden behind an action.
  it('says which body is in force and shows the built-in one on request', async () => {
    stored = {
      ...CONFIG,
      session_title: {
        model: 'custom-model',
        default_prompt: DEFAULT_TITLE_PROMPT,
        prompt_source: 'default',
      },
      experimental: { auto_session_title: true },
    };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = promptField(container);
    expect(field.dataset['promptSource']).toBe('default');
    expect(field.textContent).toContain('Built-in default');
    // The editor holds the custom body only. Opening it on a copy of the
    // default would show one text twice and invite saving it back as an
    // override that changes nothing.
    expect(promptBox(field).value).toBe('');
    // The built-in body is the server's, shown read-only and collapsed until
    // it is asked for.
    expect(container.textContent).not.toContain(DEFAULT_TITLE_PROMPT);
    await click(field.querySelector('[data-session-title-prompt-toggle-default]')!);
    expect(container.textContent).toContain(DEFAULT_TITLE_PROMPT);
    // It is still not editable: the preview is a reference, not a second box.
    expect(field.querySelectorAll('textarea')).toHaveLength(1);
  });

  // The full vertical path: default → custom → saved → read back, with the
  // model and the moments untouched, and no request for a title anywhere.
  it('saves a custom body, reads it back after a reload, and leaves the model and moments alone', async () => {
    stored = {
      ...CONFIG,
      session_title: {
        model: 'custom-model',
        triggers: ['first_user_message', 'context_compacted'],
        default_prompt: DEFAULT_TITLE_PROMPT,
        prompt_source: 'default',
      },
      experimental: { auto_session_title: true },
    };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = promptField(container);
    const box = promptBox(field);
    await type(box, CUSTOM_TITLE_PROMPT);
    await click(field.querySelector('[data-session-title-prompt-save]')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    // The body is stored verbatim: newlines and all, no trim, no expansion.
    expect(patchConfig).toHaveBeenCalledWith({ session_title: { prompt: CUSTOM_TITLE_PROMPT } });
    expect(stored.session_title?.['prompt']).toBe(CUSTOM_TITLE_PROMPT);
    // One field in the write, so the rest of the domain is not at risk.
    expect(stored.session_title?.model).toBe('custom-model');
    expect(stored.session_title?.triggers).toEqual(['first_user_message', 'context_compacted']);

    // A fresh read reports the custom body as the one in force, and the next
    // mount comes back with the reader's text in the box.
    const reloaded = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const next = promptField(reloaded);
    expect(next.dataset['promptSource']).toBe('custom');
    expect(next.textContent).toContain('Your version');
    expect(promptBox(next).value).toBe(CUSTOM_TITLE_PROMPT);
  });

  // Restoring is a deletion, not a copy: the built-in body must come back from
  // the server's authority rather than being written into the config as an
  // override that merely looks like it.
  it('removes the override on restore and falls back to the built-in body', async () => {
    stored = {
      ...CONFIG,
      session_title: {
        model: 'custom-model',
        prompt: CUSTOM_TITLE_PROMPT,
        default_prompt: DEFAULT_TITLE_PROMPT,
        prompt_source: 'custom',
      },
      experimental: { auto_session_title: true },
    };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = promptField(container);
    // Deleting a body is irreversible, so it says so before it does.
    await click(field.querySelector('[data-session-title-prompt-restore]')!);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Your version is removed.');
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(patchConfig).toHaveBeenCalledWith({ session_title: { prompt: null } });
    // `null` deletes; the default body is never stored as an override.
    expect(stored.session_title?.['prompt']).toBeUndefined();
    expect(stored.session_title?.model).toBe('custom-model');
    expect(promptField(container).dataset['promptSource']).toBe('default');
  });

  // A blank box is the same request as restore, so it must reach the server as
  // one rather than storing an empty override that reads as "custom, but empty".
  it('treats a blanked body as a restore', async () => {
    stored = {
      ...CONFIG,
      session_title: {
        model: 'custom-model',
        prompt: CUSTOM_TITLE_PROMPT,
        default_prompt: DEFAULT_TITLE_PROMPT,
        prompt_source: 'custom',
      },
      experimental: { auto_session_title: true },
    };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = promptField(container);
    await type(promptBox(field), '   ');
    expect(field.textContent).toContain('Empty means the built-in default');
    await click(field.querySelector('[data-session-title-prompt-save]')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({ session_title: { prompt: null } });
  });

  // The one moment the draft must not be taken away is a write that did not
  // land: retyping the whole body because the server said no is worse than the
  // failure itself.
  it('keeps the draft and the stored value when the save fails', async () => {
    stored = {
      ...CONFIG,
      session_title: {
        model: 'custom-model',
        default_prompt: DEFAULT_TITLE_PROMPT,
        prompt_source: 'default',
      },
      experimental: { auto_session_title: true },
    };
    patchConfig.mockRejectedValueOnce(new Error('server said no'));
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = promptField(container);
    await type(promptBox(field), CUSTOM_TITLE_PROMPT);
    await click(field.querySelector('[data-session-title-prompt-save]')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(field.querySelector('[data-field-issue]')?.textContent).toContain('server said no');
    expect(promptBox(field).value).toBe(CUSTOM_TITLE_PROMPT);
    // Nothing was stored, so the card still reports the default as in force.
    expect(stored.session_title?.['prompt']).toBeUndefined();
    expect(field.dataset['promptSource']).toBe('default');
  });

  // An older server sends neither metadata field. The card still names the body
  // in force and the editor still works; only the preview is missing, because
  // a second copy of the default would be a second authority for it.
  it('stays usable on a server that sends no default body', async () => {
    stored = { ...CONFIG, session_title: { model: 'custom-model' }, experimental: { auto_session_title: true } };
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const field = promptField(container);
    expect(field.dataset['promptSource']).toBe('default');
    expect(field.textContent).toContain('did not return a built-in default instruction');
    expect(field.querySelector('[data-session-title-prompt-toggle-default]')).toBeNull();

    const box = promptBox(field);
    expect(box).not.toBeNull();
    await type(box, CUSTOM_TITLE_PROMPT);
    await click(field.querySelector('[data-session-title-prompt-save]')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({ session_title: { prompt: CUSTOM_TITLE_PROMPT } });
  });
});
