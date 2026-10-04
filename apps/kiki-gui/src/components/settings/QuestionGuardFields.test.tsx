// @vitest-environment jsdom

/**
 * The frequency guard on both surfaces, through the real controls.
 *
 * The unit tests next door pin the patch arithmetic; this file proves the two
 * places a person actually types reach the right call: the global card writes
 * `interaction.ask_user_question_guard`, and the model row writes
 * `behavior.ask_user_question_guard` on the model's own entity while leaving
 * every other model field alone.
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { optionLabels, pickValue } from './testControls';
import { QuestionGuardFields } from './QuestionGuardFields';
import { SessionsSection } from './SessionsSection';
import { ModelCatalogCard } from './ModelsSection';
import {
  EMPTY_GUARD_DRAFT,
  clearGuardNumber,
  guardDraftFromModelBehavior,
  guardInherited,
  setGuardNumber,
  type QuestionGuardDraft,
} from './questionGuardDraft';

const getConfig = vi.fn();
const patchConfig = vi.fn();
const getModel = vi.fn();
const updateModel = vi.fn();
const listModels = vi.fn();
const listProviders = vi.fn();
const meta = vi.fn();
const setDefaultModel = vi.fn();
const listOAuthMethods = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig, getModel, updateModel, listModels, listProviders, meta, setDefaultModel, listOAuthMethods } }),
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

let stored: Record<string, unknown> = {};

/**
 * Puts a starting config in place. A test that overrides the read without
 * seeding this leaves the write path talking to a different config than the
 * one on screen, which is how a write can look rejected when it was not.
 */
function seed(config: Record<string, unknown>) {
  stored = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
beforeEach(() => {
  stored = {};
  // The real server answers a config patch with the whole resolved config —
  // `toConfigResponse(config.getAll())` — not the patch it was sent. Both mocks
  // hand back fresh objects, because a shared one makes the query cache see no
  // change and skip the update the card depends on.
  getConfig.mockReset().mockImplementation(async () => JSON.parse(JSON.stringify(stored)) as Record<string, unknown>);
  patchConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => {
    const interaction = ((patch['interaction'] ?? {}) as Record<string, unknown>);
    const guard = interaction['ask_user_question_guard'] as Record<string, unknown> | undefined;
    const current = { ...((stored['interaction'] ?? {}) as Record<string, unknown>) };
    const currentGuard = { ...((current['askUserQuestionGuard'] ?? {}) as Record<string, unknown>) };
    if (guard !== undefined) {
      for (const [key, value] of Object.entries(guard)) {
        const camel = key.replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
        // A patch leaves an untouched field as a present-but-undefined key, and
        // `JSON.stringify` drops exactly those, so a value that is not a
        // number and not null is never one this write actually set. `null` is
        // the only wire value that removes a stored field.
        if (value === null) delete currentGuard[camel];
        else if (value !== undefined) currentGuard[camel] = value;
      }
      current['askUserQuestionGuard'] = currentGuard;
    }
    if (interaction['ask_user_question'] !== undefined) current['askUserQuestion'] = interaction['ask_user_question'];
    stored = { ...stored, interaction: current };
    // `interactionConfigSchema` fills the blocking option with its default, so
    // the response names it whether or not this patch mentioned it.
    return { ...JSON.parse(JSON.stringify(stored)) as Record<string, unknown>, interaction: { askUserQuestion: 'background', ...current } } as Record<string, unknown>;
  });
  listModels.mockReset().mockResolvedValue({ items: [] });
  listProviders.mockReset().mockResolvedValue({ items: [] });
  meta.mockReset().mockResolvedValue({});
  setDefaultModel.mockReset().mockResolvedValue({});
  listOAuthMethods.mockReset().mockResolvedValue([]);
  updateModel.mockReset().mockResolvedValue({});
  getModel.mockReset().mockRejectedValue(new Error('not used here'));
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});
afterAll(() => { vi.unstubAllGlobals(); });

async function render(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider></MemoryRouter>);
  });
  // The config query resolves after the first paint and the card renders from
  // what it returns, so a test that reads the screen has to let it land first.
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  return container;
}

function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function commit(container: HTMLElement, wire: string, text: string) {
  const field = input(container, wire);
  await act(async () => { type(field, text); });
  // The box re-renders on commit, so the value is read from a fresh lookup
  // rather than from a node the previous render already replaced.
  await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
}

const input = (container: HTMLElement, wire: string) =>
  container.querySelector<HTMLInputElement>(`[data-question-guard-${wire}]`)!;

/** The guard's own switch, not the background/blocking segmented above it. */
function guardSwitch(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('fieldset[data-question-guard] input[type="checkbox"]')!;
}

/** Turns the guard on and lets its thresholds appear. */
async function enableGuard(container: HTMLElement) {
  await act(async () => { guardSwitch(container).click(); });
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
}

/** The same, through the model row's three-way select instead of its switch. */
async function turnGuardOn(container: HTMLElement, scope: 'model') {
  await pickValue(container.querySelector('[data-question-guard-enabled]')!, 'data-question-guard-enabled', scope === 'model' ? 'on' : 'on');
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
}

describe('the global card', () => {
  it('shows the guard off with the engine defaults, and hides the thresholds', async () => {
    const container = await render(<SessionsSection />);
    const guard = container.querySelector<HTMLElement>('[data-question-guard="global"]')!;
    expect(guard).not.toBeNull();
    expect(container.querySelector('[data-settings-dependent]')).toBeNull();
  });

  it('leaves the background/blocking choice untouched and untouched by the guard', async () => {
    seed({ interaction: { askUserQuestion: 'blocking' } });
    const container = await render(<SessionsSection />);
    const pressed = [...container.querySelectorAll('[data-question-behavior] button')]
      .find((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed?.textContent).toBe('Block');
  });

  it('saves the whole guard under interaction when it is switched on', async () => {
    const container = await render(<SessionsSection />);
    await enableGuard(container);
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(patchConfig.mock.calls[0]![0]).toEqual({
      interaction: { ask_user_question_guard: { enabled: true } },
    });
  });

  it('saves one threshold and leaves the blocking option out of the write', async () => {
    seed({ interaction: { askUserQuestion: 'blocking' } });
    const container = await render(<SessionsSection />);
    await enableGuard(container);
    patchConfig.mockClear();
    await commit(container, 'max-per-window', '6');
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(patchConfig.mock.calls[0]![0]).toEqual({ interaction: { ask_user_question_guard: { max_per_window: 6 } } });
  });

  it('writes a single threshold, not the blocking option, on the same domain', async () => {
    const container = await render(<SessionsSection />);
    await enableGuard(container);
    patchConfig.mockClear();
    // The blocking option is what this card already saved; a guard write must
    // not drag it along, or clearing it would be impossible to express.
    await commit(container, 'max-per-user-round', '2');
    const patch = patchConfig.mock.calls[0]![0];
    expect(patch.interaction).not.toHaveProperty('ask_user_question');
  });

  it('shows the window in minutes and stores milliseconds', async () => {
    const container = await render(<SessionsSection />);
    await enableGuard(container);
    patchConfig.mockClear();
    await commit(container, 'window-ms', '15');
    expect(patchConfig.mock.calls[0]![0]).toEqual({ interaction: { ask_user_question_guard: { window_ms: 900_000 } } });
    expect(input(container, 'window-ms').value).toBe('15');
  });

  it('refuses zero, a negative and an out-of-range count without writing', async () => {
    const container = await render(<SessionsSection />);
    await enableGuard(container);
    patchConfig.mockClear();
    for (const bad of ['0', '-1', '1001']) {
      await commit(container, 'max-per-user-round', bad);
      expect(patchConfig, `accepted ${bad}`).not.toHaveBeenCalled();
      expect(input(container, 'max-per-user-round').getAttribute('aria-invalid')).toBe('true');
    }
  });

  it('reads a stored window back as minutes, not milliseconds', async () => {
    seed({ interaction: { askUserQuestionGuard: { enabled: true, windowMs: 600_000, maxPerWindow: 5 } } });
    const container = await render(<SessionsSection />);
    expect(input(container, 'window-ms').value).toBe('10');
    expect(input(container, 'max-per-window').value).toBe('5');
  });

  /**
   * The server answers with the whole resolved config, so a guard it has
   * dropped comes back absent — and a card that merged its own cache into the
   * answer would go on showing the removed value as if it had been kept. A
   * setting that is gone has to read as gone.
   */
  it('lets a guard the server dropped read as off again, not as the cached one', async () => {
    seed({ interaction: { askUserQuestionGuard: { enabled: true, maxPerUserRound: 4, maxPerWindow: 9, windowMs: 1_800_000 } } });
    const container = await render(<SessionsSection />);
    expect(guardSwitch(container).checked).toBe(true);

    // The stored guard is removed outright, the way a reset leaves it.
    stored = { interaction: { askUserQuestion: 'background' } };
    patchConfig.mockImplementationOnce(async () => JSON.parse(JSON.stringify(stored)) as Record<string, unknown>);
    await act(async () => { guardSwitch(container).click(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });

    // Off, thresholds collapsed — not the 4 / 9 / 30 the cache still held.
    const off = guardSwitch(container);
    expect(off.checked).toBe(false);
    expect(container.querySelector('[data-settings-dependent]')).toBeNull();

    // And the thresholds it does show are the engine's, not the removed ones.
    await act(async () => { off.click(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(input(container, 'max-per-user-round').value).toBe('1');
    expect(input(container, 'max-per-window').value).toBe('3');
    expect(input(container, 'window-ms').value).toBe('10');
  });
});

describe('the model guard control', () => {
  it('starts on inherit, with no value of its own', () => {
    expect(guardDraftFromModelBehavior(undefined)).toEqual(EMPTY_GUARD_DRAFT);
    expect(guardDraftFromModelBehavior({})).toEqual(EMPTY_GUARD_DRAFT);
  });

  it('names the global layer for a field the model does not hold', async () => {
    const container = await render(<Harness global={{ enabled: true, maxPerWindow: 5 }} />);
    expect(container.querySelector('[data-question-guard-inherited="max_per_window"]')?.textContent)
      .toContain('5');
    expect(container.querySelector('[data-question-guard-inherited="window_ms"]')?.textContent)
      .toContain('default');
  });

  it('stops naming a source once the model sets the field', async () => {
    const container = await render(<Harness global={{ enabled: true, maxPerWindow: 5 }} behavior={{ ask_user_question_guard: { max_per_user_round: 2 } }} />);
    expect(container.querySelector('[data-question-guard-inherited="max_per_user_round"]')).toBeNull();
  });

  it('offers a way to hand a field back only while the model holds one', async () => {
    const inheriting = await render(<Harness global={{ enabled: true }} />);
    expect(inheriting.querySelector('[data-question-guard-clear="max_per_user_round"]')).toBeNull();

    const overriding = await render(<Harness global={{ enabled: true }} behavior={{ ask_user_question_guard: { max_per_user_round: 2 } }} />);
    expect(overriding.querySelector('[data-question-guard-clear="max_per_user_round"]')).not.toBeNull();
  });

  it('empties the field when the row clears it', async () => {
    const container = await render(<Harness global={{ enabled: true }} behavior={{ ask_user_question_guard: { max_per_user_round: 2 } }} />);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-question-guard-clear="max_per_user_round"]')!.click(); });
    expect(input(container, 'max-per-user-round').value).toBe('');
    // The cleared field falls back to naming where its value comes from again.
    expect(container.querySelector('[data-question-guard-inherited="max_per_user_round"]')).not.toBeNull();
  });

  it('offers inherit, on and off as the three choices a model can make', async () => {
    const model = await render(<Harness />);
    expect(await optionLabels(model.querySelector('[data-question-guard-enabled]')!))
      .toEqual(['Same as global', 'On', 'Off']);
  });
});

/** The model-scope fieldset on its own, driven the way the row drives it. */
function Harness({ global, behavior }: { global?: unknown; behavior?: unknown }) {
  const [draft, setDraft] = useState<QuestionGuardDraft>(guardDraftFromModelBehavior(behavior as never));
  return <QuestionGuardFields
    scope="model"
    draft={draft}
    enabled={draft.enabled === 'on' || (draft.enabled === 'inherit' && Boolean((global as { enabled?: boolean } | undefined)?.enabled))}
    inherited={(field) => guardInherited(field, global as never, draft)}
    onEnabledChange={(choice) => { setDraft({ ...draft, enabled: choice }); }}
    onNumberCommit={(field, text) => { setDraft(setGuardNumber(draft, field, text)); }}
    onNumberClear={(field) => { setDraft(clearGuardNumber(draft, field)); }}
  />;
}

/**
 * The model row, driven through the real catalog card: open a model, set one
 * threshold, save. What matters here is that the guard reaches the model's own
 * entity as `behavior` and that the rest of the row survives the save, because
 * this editor writes one sparse patch covering five drafts at once.
 */
describe('the model row editor', () => {
  const entity = (behavior?: unknown) => ({
    id: 'demo/model', provider_id: 'demo', provider_source: 'manual',
    display_name: 'Demo', remote_id: 'demo-v1',
    effective_parameters: {}, parameter_sources: {}, parameters: {},
    context_budget: 40_000, max_input_size: 30_000, reasoning_key: 'reasoning',
    revision: 'a'.repeat(64), issues: [], behavior,
  });

  async function openRow(behavior?: unknown) {
    listModels.mockResolvedValue({ items: [{ id: 'demo/model', provider_id: 'demo', remote_id: 'demo-v1', max_context_size: 200_000 }] });
    listProviders.mockResolvedValue({ items: [{ id: 'demo', type: 'openai_compatible', display_name: 'Demo' }] });
    getModel.mockImplementation(async () => entity(behavior));
    updateModel.mockImplementation(async (_id: string, patch: unknown) => ({ ...entity(), ...(patch as object) }));
    const container = await render(<ModelCatalogCard />);
    const row = container.querySelector<HTMLElement>('[data-model-row="demo/model"]')!;
    // The row's first button is the default-model star; the second opens the
    // detail panel the editor lives in.
    const open = row.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    if (open === null) throw new Error('the model row has no open control');
    await act(async () => { open.click(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    return container;
  }

  /**
   * The guard lives in the row's advanced disclosure, which renders its body
   * only once opened, so a test that has not opened it cannot see a control
   * that is present.
   */
  async function revealGuard(container: HTMLElement) {
    // The detail panel may render outside the card's own subtree, so the
    // document is the place to look for it.
    const editor = document.querySelector('[data-model-row-editor]');
    if (editor === null) throw new Error('the model row editor did not open');
    const disclosure = editor.querySelector<HTMLButtonElement>('[data-advanced] button');
    if (disclosure === null) throw new Error('the advanced disclosure is missing');
    if (disclosure.getAttribute('aria-expanded') !== 'true') {
      await act(async () => { disclosure.click(); });
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    }
    return document.body;
  }

  it('opens inheriting, with no threshold of its own and no write', async () => {
    const container = await revealGuard(await openRow());
    expect(container.querySelector('[data-question-guard="model"]')).not.toBeNull();
    // Inheriting and off is the engine default, so the thresholds stay
    // collapsed until the row has a reason to show them.
    expect(container.querySelector('[data-settings-dependent]')).toBeNull();
    expect(updateModel).not.toHaveBeenCalled();
  });

  it('saves one threshold as behavior and leaves the other model fields alone', async () => {
    const container = await revealGuard(await openRow());
    await turnGuardOn(container, 'model');
    await commit(container, 'max-per-user-round', '2');
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
    await act(async () => { save!.click(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(updateModel).toHaveBeenCalled();
    const [id, patch] = updateModel.mock.calls[0]!;
    expect(id).toBe('demo/model');
    // Turning the guard on and setting a threshold are two decisions, so the
    // patch carries both and nothing else from the guard.
    expect((patch as { behavior?: unknown }).behavior).toEqual({
      ask_user_question_guard: { enabled: true, max_per_user_round: 2 },
    });
    // The rows above the guard are not dragged into this write.
    expect(patch).not.toHaveProperty('reasoning_key');
    expect(patch).not.toHaveProperty('context_budget');
  });

  it('does not write behavior at all for a model that was only opened', async () => {
    const container = await revealGuard(await openRow());
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
    await act(async () => { save?.click(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    if (updateModel.mock.calls.length > 0) {
      expect(updateModel.mock.calls[0]![1]).not.toHaveProperty('behavior');
    }
  });

  it('sends null for a field the model hands back', async () => {
    const container = await revealGuard(await openRow({ ask_user_question_guard: { enabled: true, max_per_user_round: 2 } }));
    const clear = container.querySelector<HTMLButtonElement>('[data-question-guard-clear="max_per_user_round"]');
    expect(clear).not.toBeNull();
    await act(async () => { clear!.click(); });
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
    await act(async () => { save!.click(); });
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect((updateModel.mock.calls[0]![1] as { behavior?: unknown }).behavior)
      .toEqual({ ask_user_question_guard: { max_per_user_round: null } });
  });
});
