// @vitest-environment jsdom
/**
 * Per-source steering on the model page, driven through the page's own Save.
 *
 * These are the cases that decide whether a source is real configuration or a
 * row of buttons: that a custom draft survives the `off` / `inherit` round trip
 * the interface invites, that a source is addressed by its own identity and the
 * identity on screen, that a source edit rides in the same model transaction as
 * every other pending edit, and that a refused write loses nothing.
 *
 * Nothing here calls `updateModel` directly. Each case changes something in the
 * rendered editor and presses the page's Save, so the draft, the patch and the
 * commit are all the production path.
 */

import { act } from 'react';
import { createRoot as createReactRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GetModelResponse, ModelCatalogItem, ProviderCatalogItem } from '@kiki/protocol';
import type { ServerConnection } from '@kiki/session-core/settings';

import { I18nProvider } from '../../i18n';
import { DirtyGuardContext } from '../dirtyGuard';

const CONNECTION: ServerConnection = { url: 'https://server.example.test/', token: 'test-token' };

const getModel = vi.fn();
const updateModel = vi.fn();
const listModels = vi.fn();
const listProviders = vi.fn();
const getConfig = vi.fn();
const listDiscoveredModels = vi.fn();
const refreshAllProviders = vi.fn();
const createModel = vi.fn();
const setDefaultModel = vi.fn();
const patchConfig = vi.fn();
const setSubagentDefaultModel = vi.fn();
const setFastModel = vi.fn();
const listRecipes = vi.fn();
const getRecipe = vi.fn();
const reportDirty = vi.fn();
const previewRecipe = vi.fn();
const installRecipe = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listDiscoveredModels, refreshAllProviders, createModel, listModels,
      getConfig, listProviders, setDefaultModel, patchConfig, getModel,
      updateModel, setSubagentDefaultModel, setFastModel, listRecipes, getRecipe, previewRecipe, installRecipe,
    },
    config: CONNECTION,
  }),
}));

const PROVIDER: ProviderCatalogItem = {
  id: 'managed:kimi-code',
  type: 'kimi',
  base_url: 'https://api.managed.example.test/v1',
  default_model: 'kimi-code/kimi-k2',
  has_api_key: false,
  status: 'connected',
  models: ['kimi-code/kimi-k2'],
};

const MODELS: ModelCatalogItem[] = [{
  id: 'kimi-code/kimi-k2',
  provider_id: 'managed:kimi-code',
  remote_id: 'kimi-k2',
  display_name: 'Kimi K2',
  max_context_size: 262144,
}];

/**
 * A model that has never been told about any other source, and that has real
 * prompt prose of its own at every level. The prose is the point: it is what a
 * source edit must not disturb.
 */
const ENTITY: GetModelResponse = {
  id: 'kimi-code/kimi-k2',
  provider_id: 'managed:kimi-code',
  provider_source: 'provider',
  remote_id: 'kimi-k2',
  display_name: 'Kimi K2',
  max_context_size: 262144,
  effective_parameters: {},
  parameter_sources: {},
  revision: 'rev-7',
  issues: [],
  cognition: {
    overlay: { text: 'Shared overlay.' },
    steering: { text: 'Shared reminder.' },
    main: { steering: { text: 'Main reminder.' } },
  },
  cognition_bodies: {
    revision: 'rev-7',
    branches: {
      common: {
        selection: 'common',
        source_scope: 'common',
        slots: {
          overlay: { channel: 'cognition_overlay', source: 'inline', text: 'Shared overlay.', writable: true, source_read_only: false },
          steering: { channel: 'cognition_steering', source: 'inline', text: 'Shared reminder.', writable: true, source_read_only: false },
          anchor: { channel: 'cognition_anchor', source: 'unset', writable: true, source_read_only: false },
        },
      },
      main: {
        selection: 'custom',
        source_scope: 'main',
        slots: {
          overlay: { channel: 'cognition_overlay', source: 'unset', writable: true, source_read_only: false },
          steering: { channel: 'cognition_steering', source: 'inline', text: 'Main reminder.', writable: true, source_read_only: false },
          anchor: { channel: 'cognition_anchor', source: 'unset', writable: true, source_read_only: false },
        },
      },
      independent: {
        selection: 'common',
        source_scope: 'independent',
        slots: {
          overlay: { channel: 'cognition_overlay', source: 'unset', writable: true, source_read_only: false },
          steering: { channel: 'cognition_steering', source: 'unset', writable: true, source_read_only: false },
          anchor: { channel: 'cognition_anchor', source: 'unset', writable: true, source_read_only: false },
        },
      },
    },
  },
  prompt_overrides: { fields: { 'system.language': 'Answer in the language they used.' } },
};

const { ModelCatalogCard } = await import('./ModelsSection');

let container: HTMLElement;
let root: Root;

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  listDiscoveredModels.mockReset().mockResolvedValue({ items: [] });
  refreshAllProviders.mockReset();
  createModel.mockReset();
  listModels.mockReset().mockResolvedValue({ items: MODELS });
  listProviders.mockReset().mockResolvedValue({ items: [PROVIDER] });
  getConfig.mockReset().mockResolvedValue({ default_model: 'kimi-code/kimi-k2', default_provider: 'managed:kimi-code' });
  setDefaultModel.mockReset();
  patchConfig.mockReset();
  setSubagentDefaultModel.mockReset();
  setFastModel.mockReset();
  getModel.mockReset().mockResolvedValue(structuredClone(ENTITY));
  listRecipes.mockReset().mockResolvedValue([]);
  getRecipe.mockReset();
  previewRecipe.mockReset();
  installRecipe.mockReset();
  reportDirty.mockReset();
  updateModel.mockReset().mockImplementation((_id: string, patch: Record<string, unknown>) => Promise.resolve({ ...ENTITY, ...patch }));
});

afterEach(() => {
  if (root !== undefined) act(() => { root.unmount(); });
  container?.remove();
});

async function renderCard(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createReactRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <DirtyGuardContext.Provider value={{ dirty: false, reportDirty, navigate: () => {} }}>
              <ModelCatalogCard />
            </DirtyGuardContext.Provider>
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function openEditor(): Promise<HTMLElement> {
  const editButton = document.body.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
  );
  expect(editButton, 'row edit toggle').not.toBeNull();
  await act(async () => { editButton!.click(); });
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    if (saveButton() !== undefined) break;
  }
  const fields = document.body.querySelector<HTMLElement>('[data-model-row-editor="kimi-code/kimi-k2"]');
  expect(fields, 'model editor').not.toBeNull();
  return fields!;
}

const saveButton = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((button) => button.textContent === 'Save')!;

const scopeButton = (scope: string) =>
  document.body.querySelector<HTMLButtonElement>(`[data-model-scope-choice="${scope}"]`)!;

const sourceRow = (source: string) =>
  document.body.querySelector<HTMLElement>(`[data-steer-source="${source}"]`)!;

const sourceModeButton = (source: string, mode: string) =>
  sourceRow(source).querySelector<HTMLButtonElement>(`[data-steer-mode="${mode}"]`)!;

const sourceEditor = (source: string) =>
  document.body.querySelector<HTMLTextAreaElement>(`[data-steer-body-editor="${source}"]`);

const sourceInterval = (source: string) =>
  document.body.querySelector<HTMLInputElement>(`[data-steer-cadence-interval="${source}"]`);

/** The per-source rows live under a disclosure that is closed by default. */
async function openSteerSources(): Promise<void> {
  const disclosure = document.body.querySelector<HTMLButtonElement>('[data-advanced="model-steer-kimi-code/kimi-k2"] button');
  expect(disclosure, 'the per-source disclosure').not.toBeNull();
  if (disclosure!.getAttribute('aria-expanded') === 'false') {
    await act(async () => { disclosure!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function openEditorWithSources(): Promise<HTMLElement> {
  const fields = await openEditor();
  await openSteerSources();
  return fields;
}

function typeIn(editor: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(editor, text);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

function typeNumber(editor: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(editor, text);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

async function pressSave(): Promise<void> {
  await act(async () => { saveButton().click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const lastPatch = (call = 0): Record<string, unknown> => updateModel.mock.calls[call]?.[1] as Record<string, unknown>;

describe('the per-source rows are there, collapsed, and describe themselves', () => {
  it('keeps all nine sources out of the way until Advanced is opened', async () => {
    await renderCard();
    await openEditor();

    const disclosure = document.body.querySelector<HTMLElement>('[data-advanced="model-steer-kimi-code/kimi-k2"]')!;
    expect(disclosure.dataset['open'], 'closed by default').toBeUndefined();
    // The body stays mounted so an edit survives collapsing, but it is not shown.
    expect(document.body.querySelector<HTMLElement>('[data-steer-source-rows]')!.closest('[hidden]')).not.toBeNull();
    expect(sourceRow('thread').querySelector<HTMLElement>('[data-steer-source-label]')!.textContent).toBe('Other thread');
    expect(sourceRow('external').querySelector<HTMLElement>('[data-steer-source-label]')!.textContent).toBe('External client');
  });

  it('shows the real current value of each source rather than a blank row', async () => {
    const stored = structuredClone(ENTITY);
    (stored.cognition as Record<string, unknown>)['steering_sources'] = {
      thread: { mode: 'inherit' },
      cron: { mode: 'custom', custom: { steering: { text: 'Cron words.' } } },
    };
    getModel.mockResolvedValue(stored);
    await renderCard();
    await openEditorWithSources();

    // The segmented control is the state; a row only adds a line when the
    // choice needs words the control cannot give.
    expect(sourceModeButton('cron', 'custom').getAttribute('aria-pressed')).toBe('true');
    expect(sourceRow('cron').textContent, 'a source with words needs no second line').not.toContain('no words yet');
    // A source with no declaration reads as off, not as missing.
    expect(sourceModeButton('agent', 'off').getAttribute('aria-pressed')).toBe('true');
    // `inherit` shows no copy of the user's own words.
    expect(sourceRow('thread').textContent).not.toContain('Shared reminder.');
    expect(sourceModeButton('thread', 'inherit').getAttribute('aria-pressed')).toBe('true');
    expect(sourceEditor('cron')!.value, 'a stored custom body is still editable').toBe('Cron words.');
  });

  it('says a cleared inline source has no words, unlike a file-backed one', async () => {
    const stored = structuredClone(ENTITY);
    (stored.cognition as Record<string, unknown>)['steering_sources'] = {
      cron: { mode: 'custom', custom: { steering: { text: 'Cron words.' } } },
    };
    getModel.mockResolvedValue(stored);
    await renderCard();
    await openEditorWithSources();
    expect(sourceRow('cron').textContent, 'a source with words needs no second line').not.toContain('no words yet');

    // Clearing the box really does mean no words. The engine's last projection
    // still holds the old text, and borrowing it here would describe a body
    // that no longer exists.
    await act(async () => { typeIn(sourceEditor('cron')!, ''); });
    expect(sourceRow('cron').textContent, 'an empty inline source says so').toContain('no words yet');
  });

  it('calls a file-backed custom source by its words, not by an empty draft', async () => {
    const stored = structuredClone(ENTITY);
    (stored.cognition as Record<string, unknown>)['steering_sources'] = {
      external: { mode: 'custom', custom: { steering: { file: 'steer/external.md' } } },
    };
    stored.cognition_bodies!.branches.common.steering_sources = {
      external: {
        channel: 'cognition_steering',
        source: 'files',
        text: 'An external client sent a record.',
        files: [{ path: 'steer/external.md', text: 'An external client sent a record.' }],
        writable: true,
        source_read_only: true,
      },
    };
    getModel.mockResolvedValue(stored);
    await renderCard();
    await openEditorWithSources();

    // The draft holds no text because the words live in a file the engine
    // resolved. Reporting "no words yet" here would invite a person to type
    // over a reminder that already exists.
    expect(sourceRow('external').textContent).not.toContain('no words yet');
    expect(sourceEditor('external'), 'a read-only file body is not an editor').toBeNull();
    expect(document.body.querySelector<HTMLElement>('[data-steer-body-readonly="external"]')!.textContent)
      .toBe('An external client sent a record.');
  });
});

describe('a source keeps its own words whichever mode it is in', () => {
  it('sends only the mode when someone switches away, and the words are still there on the way back', async () => {
    await renderCard();
    await openEditorWithSources();

    await act(async () => { sourceModeButton('agent', 'custom').click(); });
    await act(async () => { typeIn(sourceEditor('agent')!, 'When a subagent speaks, wait for its report.\n'); });
    await act(async () => { sourceModeButton('agent', 'off').click(); });
    expect(sourceEditor('agent'), 'off keeps no editor open').toBeNull();
    await act(async () => { sourceModeButton('agent', 'inherit').click(); });
    expect(sourceEditor('agent'), 'inherit shows no copy of the user words').toBeNull();
    await act(async () => { sourceModeButton('agent', 'custom').click(); });
    expect(sourceEditor('agent')!.value, 'the draft survived both switches').toBe('When a subagent speaks, wait for its report.\n');

    await pressSave();
    expect(updateModel).toHaveBeenCalledTimes(1);
    // A mode switch sends the mode alone: the stored custom is merged field by
    // field, and an entry written here would replace the whole object.
    expect(lastPatch()['steering_sources_patch']).toEqual({ common: { agent: { mode: 'custom', custom: { steering: { text: 'When a subagent speaks, wait for its report.\n' } } } } });
  });

  it('keeps a custom draft that was already stored when the source is switched off', async () => {
    const stored = structuredClone(ENTITY);
    (stored.cognition as Record<string, unknown>)['steering_sources'] = {
      hook: { mode: 'custom', custom: { steering: { text: 'Hook words.' }, steering_on_turn: false, steering_interval_steps: 3 } },
    };
    getModel.mockResolvedValue(stored);
    await renderCard();
    await openEditorWithSources();

    await act(async () => { sourceModeButton('hook', 'off').click(); });
    expect(sourceModeButton('hook', 'off').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { sourceModeButton('hook', 'custom').click(); });
    expect(sourceEditor('hook')!.value).toBe('Hook words.');
    expect(sourceInterval('hook')!.value, 'the stored cadence came back too').toBe('3');

    // Off and back to custom is the round trip that used to cost a person their
    // words. It ends where it started, so it writes nothing at all.
    expect(saveButton().disabled, 'a round trip back to the stored value is not an edit').toBe(true);
    await pressSave();
    expect(updateModel).not.toHaveBeenCalled();

    // Leaving it off is a real decision, and it is written as the mode alone:
    // the stored prose is the server's to keep.
    await act(async () => { sourceModeButton('hook', 'off').click(); });
    await pressSave();
    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(lastPatch()['steering_sources_patch']).toEqual({ common: { hook: { mode: 'off' } } });
  });

  it('leaves a source with no words empty rather than falling back to the user body', async () => {
    await renderCard();
    await openEditorWithSources();
    await act(async () => { sourceModeButton('room', 'custom').click(); });
    expect(sourceEditor('room')!.value).toBe('');
    expect(sourceRow('room').textContent).toContain('Its own setting, with no words yet.');
    await pressSave();
    expect(lastPatch()['steering_sources_patch']).toEqual({ common: { room: { mode: 'custom' } } });
  });
});

describe('a source belongs to one identity and one level', () => {
  it.each([undefined, 'same'] as const)('shows the effective shared sources for inherited %s without writing on a round trip', async (selection) => {
    const stored = structuredClone(ENTITY);
    stored.cognition = { ...stored.cognition, main: selection, steering_sources: {
      thread: { mode: 'inherit' },
      cron: { mode: 'custom', custom: { steering: 'steer/cron.md', steering_on_turn: false, steering_interval_steps: 4 } },
    } };
    stored.cognition_bodies!.branches.common.steering_sources = { cron: {
      channel: 'cognition_steering', source: 'files', text: 'Resolved cron words.',
      files: [{ path: 'steer/cron.md', text: 'Resolved cron words.' }], writable: false, source_read_only: true,
    } };
    stored.cognition_bodies!.branches.main = { ...stored.cognition_bodies!.branches.common };
    getModel.mockResolvedValue(stored);
    await renderCard();
    await openEditorWithSources();
    await act(async () => { scopeButton('main').click(); });
    expect(document.body.querySelector('[data-steer-identity-inherited]')!.textContent).toContain('separate copy of the full group');
    expect(sourceModeButton('thread', 'inherit').getAttribute('aria-pressed')).toBe('true');
    expect(sourceModeButton('cron', 'custom').getAttribute('aria-pressed')).toBe('true');
    expect(sourceModeButton('agent', 'off').getAttribute('aria-pressed')).toBe('true');
    expect(sourceInterval('cron')!.value).toBe('4');
    expect(document.body.querySelector('[data-steer-body-readonly="cron"]')!.textContent).toBe('Resolved cron words.');
    await act(async () => { sourceModeButton('cron', 'off').click(); });
    await act(async () => { sourceModeButton('cron', 'custom').click(); });
    await pressSave();
    expect(updateModel, 'an untouched inherited group remains inherited').not.toHaveBeenCalled();
    await act(async () => { sourceModeButton('thread', 'off').click(); });
    await pressSave();
    expect(lastPatch()['steering_sources_patch']).toEqual({ main: { thread: { mode: 'off' } } });
    expect(lastPatch()).not.toHaveProperty('cognition');
    expect(stored.cognition.main).toBe(selection);
  });

  it('does not carry a source set on one identity into another', async () => {
    await renderCard();
    await openEditorWithSources();
    // The page opens on the shared level; `main` is the first identity branch.
    expect(document.body.querySelector<HTMLElement>('[data-steer-sources]')!.dataset['steerSources']).toBe('common');
    await act(async () => { sourceModeButton('task', 'custom').click(); });
    await act(async () => { typeIn(sourceEditor('task')!, 'Shared words.\n'); });
    await act(async () => { scopeButton('main').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.body.querySelector<HTMLElement>('[data-steer-sources]')!.dataset['steerSources']).toBe('main');

    expect(sourceEditor('task'), 'the other identity has no such source yet').toBeNull();
    expect(sourceModeButton('task', 'off').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { sourceModeButton('task', 'inherit').click(); });

    await pressSave();
    expect(lastPatch()['steering_sources_patch']).toEqual({
      common: { task: { mode: 'custom', custom: { steering: { text: 'Shared words.\n' } } } },
      main: { task: { mode: 'inherit' } },
    });
  });

  it('addresses only the level on screen, leaving the others out of the patch', async () => {
    await renderCard();
    await openEditorWithSources();
    await act(async () => { sourceModeButton('cron', 'inherit').click(); });
    await pressSave();
    const patch = lastPatch()['steering_sources_patch'] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['common']);
    expect(patch['common']).toEqual({ cron: { mode: 'inherit' } });
  });
});

describe('a source edit is a model field, not a second save', () => {
  it('commits alongside the other pending edits under one revision', async () => {
    await renderCard();
    const fields = await openEditorWithSources();

    const name = fields.querySelector<HTMLInputElement>('input[aria-label="Display name for kimi-code/kimi-k2"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Kimi K2 renamed');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-prompt-body-editor="overlay"]')!, 'Prose edited at the same time.\n');
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-model-engine="promptOverrides"]')!,
        JSON.stringify({ fields: { 'system.language': 'New language.' } }));
    });
    await act(async () => { sourceModeButton('skill', 'custom').click(); });
    await act(async () => { typeIn(sourceEditor('skill')!, 'A skill run gets its own reminder.\n'); });

    await pressSave();
    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(lastPatch()).toMatchObject({
      base_revision: 'rev-7',
      display_name: 'Kimi K2 renamed',
      cognition: { overlay: { text: 'Prose edited at the same time.\n' } },
      prompt_overrides: { fields: { 'system.language': 'New language.' } },
      steering_sources_patch: { common: { skill: { mode: 'custom', custom: { steering: { text: 'A skill run gets its own reminder.\n' } } } } },
    });
    // The user's own reminder rides along untouched: a source change is a
    // separate field, and the sibling prose edit is the one that carries the
    // whole cognition object. What must not happen is the source's words
    // landing there.
    expect((lastPatch()['cognition'] as Record<string, unknown>)['steering']).toEqual({ text: 'Shared reminder.' });
    expect((lastPatch()['steering_sources_patch'] as Record<string, unknown>)['common']).not.toHaveProperty('main');
  });

  it('sends only the cadence fields that actually changed', async () => {
    await renderCard();
    await openEditorWithSources();
    await act(async () => { sourceModeButton('automation', 'custom').click(); });
    await act(async () => { typeNumber(sourceInterval('automation')!, '4'); });
    await pressSave();
    expect(lastPatch()['steering_sources_patch']).toEqual({
      common: { automation: { mode: 'custom', custom: { steering_interval_steps: 4 } } },
    });
  });

  it('refuses to send a half-typed repeat count and keeps the draft for a retry', async () => {
    await renderCard();
    await openEditorWithSources();
    await act(async () => { sourceModeButton('external', 'custom').click(); });
    await act(async () => { typeNumber(sourceInterval('external')!, '-3'); });

    await pressSave();
    expect(updateModel, 'an unparseable count must not reach the model').not.toHaveBeenCalled();
    expect(sourceInterval('external')!.value).toBe('-3');
    expect(saveButton().disabled, 'the page stays dirty so it can be corrected').toBe(false);
  });

  it('keeps every draft when the write is refused', async () => {
    updateModel.mockRejectedValueOnce(new Error('model_catalog.revision_conflict'));
    await renderCard();
    const fields = await openEditorWithSources();
    await act(async () => { typeIn(fields.querySelector<HTMLTextAreaElement>('[data-prompt-body-editor="overlay"]')!, 'Kept through a refusal.\n'); });
    await act(async () => { sourceModeButton('room', 'custom').click(); });
    await act(async () => { typeIn(sourceEditor('room')!, 'Room words kept too.\n'); });

    await pressSave();
    expect(updateModel).toHaveBeenCalledTimes(1);
    // Compared without the trailing newline a textarea re-mount drops on its
    // own: what must survive the refusal is the words themselves.
    expect(sourceEditor('room')!.value.trim(), 'a refused write must not discard what was typed').toBe('Room words kept too.');
    expect(sourceModeButton('room', 'custom').getAttribute('aria-pressed'), 'and the source stays in custom').toBe('true');
    expect(fields.querySelector<HTMLTextAreaElement>('[data-prompt-body-editor="overlay"]')!.value).toBe('Kept through a refusal.\n');
    expect(saveButton().disabled).toBe(false);
    updateModel.mockResolvedValueOnce(ENTITY);
    await pressSave();
    expect(updateModel).toHaveBeenCalledTimes(2);
    expect(lastPatch(1)).toEqual(lastPatch(0));
  });
});
