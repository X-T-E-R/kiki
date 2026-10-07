// @vitest-environment jsdom
/**
 * The model page's prompt bodies, driven through the editor's own save.
 *
 * These are the cases the save function got wrong while every unit around it
 * stayed green: a body typed and never saved, two bodies where the second
 * silently replaced the first, a scope switch that carried one identity's words
 * into another's, and a rejection that threw the work away.
 *
 * Nothing here calls `updateModel` directly. Each case types into the rendered
 * editor and presses the page's Save, so the draft, the patch and the commit
 * are all the production path.
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

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listDiscoveredModels, refreshAllProviders, createModel, listModels,
      getConfig, listProviders, setDefaultModel, patchConfig, getModel,
      updateModel, setSubagentDefaultModel, setFastModel, listRecipes, getRecipe,
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
 * A model whose prompt prose is split the way a real one can be: the shared
 * level still points at an author file, `main` carries its own inline body, and
 * `independent` is switched off entirely.
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
    overlay: 'cognition/legacy.md',
    steering: 'cognition/legacy-steer.md',
    main: { overlay: { text: 'Main overlay, stored on the model.' }, steering: { text: 'Main reminder.' } },
    independent: 'off',
  },
  cognition_bodies: {
    revision: 'rev-7',
    branches: {
      common: {
        selection: 'common',
        source_scope: 'common',
        slots: {
          overlay: {
            channel: 'cognition_overlay',
            source: 'files',
            text: 'Shared file body.',
            files: [{ path: 'cognition/legacy.md', text: 'Shared file body.' }],
            writable: true,
            source_read_only: true,
          },
          steering: {
            channel: 'cognition_steering',
            source: 'files',
            text: 'Shared file reminder.',
            files: [{ path: 'cognition/legacy-steer.md', text: 'Shared file reminder.' }],
            writable: true,
            source_read_only: true,
          },
          anchor: { channel: 'cognition_anchor', source: 'unset', writable: true, source_read_only: false },
        },
      },
      main: {
        selection: 'custom',
        source_scope: 'main',
        slots: {
          overlay: { channel: 'cognition_overlay', source: 'inline', text: 'Main overlay, stored on the model.', writable: true, source_read_only: false },
          steering: { channel: 'cognition_steering', source: 'inline', text: 'Main reminder.', writable: true, source_read_only: false },
          anchor: { channel: 'cognition_anchor', source: 'unset', writable: true, source_read_only: false },
        },
      },
      independent: {
        selection: 'off',
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
});

beforeEach(() => {
  listDiscoveredModels.mockReset().mockResolvedValue({ items: [] });
  refreshAllProviders.mockReset();
  createModel.mockReset();
  listModels.mockReset().mockResolvedValue({ items: MODELS });
  listProviders.mockReset().mockResolvedValue({ items: [PROVIDER] });
  getConfig.mockReset().mockResolvedValue({
    default_model: 'kimi-code/kimi-k2',
    default_provider: 'managed:kimi-code',
  });
  setDefaultModel.mockReset();
  patchConfig.mockReset();
  setSubagentDefaultModel.mockReset();
  setFastModel.mockReset();
  getModel.mockReset().mockResolvedValue(ENTITY);
  listRecipes.mockReset().mockResolvedValue([]);
  getRecipe.mockReset();
  updateModel.mockReset().mockImplementation((_id: string, patch: Record<string, unknown>) => Promise.resolve({ ...ENTITY, ...patch }));
});

afterEach(() => {
  if (root !== undefined) act(() => { root.unmount(); });
  container?.remove();
});

async function renderCard(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.append(container);
  root = createReactRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <DirtyGuardContext.Provider value={{ dirty: false, reportDirty: () => {}, navigate: () => {} }}>
              <ModelCatalogCard />
            </DirtyGuardContext.Provider>
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return document.body;
}

async function openEditor(): Promise<HTMLElement> {
  const editButton = document.body.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit parameters for kimi-code/kimi-k2"]',
  );
  expect(editButton, 'row edit toggle').not.toBeNull();
  await act(async () => { editButton!.click(); });
  // The prose group hangs off the entity read, so it lands a tick or two after
  // the fields that were already on screen.
  for (let tick = 0; tick < 8; tick += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    if (bodyEditor('overlay') !== null && saveButton() !== undefined) break;
  }
  const fields = document.body.querySelector<HTMLElement>('[data-model-row-editor="kimi-code/kimi-k2"]');
  expect(fields, 'model editor').not.toBeNull();
  return fields!;
}

const saveButton = () => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((button) => button.textContent === 'Save')!;

const scopeButton = (scope: string) =>
  document.body.querySelector<HTMLButtonElement>(`[data-model-scope-choice="${scope}"]`)!;

function typeIn(editor: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(editor, text);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

const bodyEditor = (slot: string) =>
  document.body.querySelector<HTMLTextAreaElement>(`[data-prompt-body-editor="${slot}"]`);

async function pressSave(): Promise<void> {
  await act(async () => { saveButton().click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('the model editor saves the prompt prose a person typed', () => {
  it('offers Save for a body-only edit and commits it through the one model transaction', async () => {
    await renderCard();
    const fields = await openEditor();

    // Nothing else on the page has changed, so the whole edit is the prose.
    expect(saveButton().disabled, 'Save starts disabled while the page is clean').toBe(true);

    const overlay = bodyEditor('overlay');
    expect(overlay, 'shared overlay editor').not.toBeNull();
    await act(async () => { typeIn(overlay!, 'Words typed into the shared overlay.\n'); });

    expect(saveButton().disabled, 'typing prose must make the page dirty').toBe(false);
    await pressSave();

    expect(updateModel).toHaveBeenCalledTimes(1);
    const [, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    const cognition = patch['cognition'] as Record<string, unknown>;
    expect(cognition['overlay']).toEqual({ text: 'Words typed into the shared overlay.\n' });
    expect(patch['base_revision']).toBe('rev-7');
  });

  it('keeps both bodies when two slots are edited before one Save', async () => {
    await renderCard();
    const fields = await openEditor();

    await act(async () => {
      typeIn(bodyEditor('overlay')!, 'First body.\n');
      typeIn(bodyEditor('anchor')!, 'Second body.\n');
    });
    await pressSave();

    const [, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    const cognition = patch['cognition'] as Record<string, unknown>;
    expect(cognition['overlay']).toEqual({ text: 'First body.\n' });
    expect(cognition['anchor']).toEqual({ text: 'Second body.\n' });
    // The slot nobody typed keeps its file reference.
    expect(cognition['steering']).toBe('cognition/legacy-steer.md');
    // The stored branch for `main` is untouched by a shared-scope edit.
    expect(cognition['main']).toEqual({
      overlay: { text: 'Main overlay, stored on the model.' },
      steering: { text: 'Main reminder.' },
    });
  });

  it('keeps the stored prompt fields when only a body changed', async () => {
    await renderCard();
    const fields = await openEditor();

    // The page does not edit `prompt_overrides` itself, but the model's stored
    // fields are real configuration: a body-only save must not drop them.
    await act(async () => { typeIn(bodyEditor('overlay')!, 'Words typed too.\n'); });
    await pressSave();

    const [, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    expect((patch['cognition'] as Record<string, unknown>)['overlay']).toEqual({ text: 'Words typed too.\n' });
    // Carried over whole or left out entirely — never half-written by a change
    // that did not touch it.
    if (patch['prompt_overrides'] !== undefined) {
      expect(patch['prompt_overrides']).toEqual(ENTITY.prompt_overrides);
    }
  });

  it('does not carry one identity\'s words into another when the scope changes', async () => {
    await renderCard();
    const fields = await openEditor();

    await act(async () => { typeIn(bodyEditor('overlay')!, 'Shared words.\n'); });
    await act(async () => { scopeButton('main').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

    const mainFields = document.body.querySelector<HTMLElement>('[data-model-row-editor="kimi-code/kimi-k2"]')!;
    const mainOverlay = bodyEditor('overlay');
    expect(mainOverlay!.value,
      'switching scope must show that identity\'s own body, not the shared draft')
      .toBe('Main overlay, stored on the model.');

    await act(async () => { typeIn(mainOverlay!, 'Main words instead.\n'); });
    await pressSave();

    const [, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    const cognition = patch['cognition'] as Record<string, unknown>;
    // The main branch keeps the slot it declared and gains the edit there. The
    // shared slot keeps its own edit, because it was typed before the switch —
    // what must never happen is one identity's words landing in the other.
    expect(cognition['main']).toEqual({
      overlay: { text: 'Main words instead.\n' },
      steering: { text: 'Main reminder.' },
    });
    expect(cognition['overlay']).toEqual({ text: 'Shared words.\n' });
    // The shared steering reference nobody touched is still a file.
    expect(cognition['steering']).toBe('cognition/legacy-steer.md');
    // `independent` is off and must stay off.
    expect(cognition['independent']).toBe('off');
  });

  it('keeps both a prose edit and a raw-table edit of the same object', async () => {
    await renderCard();
    const fields = await openEditor();

    // The same object has two editors on this page: the prose boxes above and
    // the raw JSON table under Advanced. Both are whole-object writes, so letting
    // one replace the other silently dropped whichever the reader was not
    // looking at.
    await act(async () => { typeIn(bodyEditor('overlay')!, 'Prose edited here.\n'); });
    const raw = fields.querySelector<HTMLTextAreaElement>('[data-model-engine="cognition"]');
    expect(raw, 'the raw cognition table must be reachable').not.toBeNull();
    await act(async () => {
      typeIn(raw!, JSON.stringify({ ...ENTITY.cognition as Record<string, unknown>, steering: 'edited/reminder.md' }));
    });

    await pressSave();

    expect(updateModel).toHaveBeenCalledTimes(1);
    const [, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    const cognition = patch['cognition'] as Record<string, unknown>;
    // Both edits are in one commit...
    expect(cognition['overlay'], 'the prose edit must survive').toEqual({ text: 'Prose edited here.\n' });
    expect(cognition['steering'], 'the raw-table edit must survive').toBe('edited/reminder.md');
    // ...and so is everything neither of them touched.
    expect(cognition['main']).toEqual({
      overlay: { text: 'Main overlay, stored on the model.' },
      steering: { text: 'Main reminder.' },
    });
    expect(cognition['independent']).toBe('off');
  });

  it('leaves the identity that was never opened alone', async () => {
    await renderCard();
    const fields = await openEditor();
    await act(async () => { typeIn(bodyEditor('anchor')!, 'Shared anchor.\n'); });
    await pressSave();

    const [, patch] = updateModel.mock.calls[0] as [string, Record<string, unknown>];
    const cognition = patch['cognition'] as Record<string, unknown>;
    expect(cognition['main']).toEqual({
      overlay: { text: 'Main overlay, stored on the model.' },
      steering: { text: 'Main reminder.' },
    });
    expect(cognition['independent']).toBe('off');
  });

  it('keeps every draft when the write is refused', async () => {
    updateModel.mockRejectedValueOnce(new Error('model_catalog.revision_conflict'));
    await renderCard();
    const fields = await openEditor();
    await act(async () => { typeIn(bodyEditor('overlay')!, 'Kept through a refusal.\n'); });
    await pressSave();

    expect(updateModel).toHaveBeenCalledTimes(1);
    const after = document.body.querySelector<HTMLElement>('[data-model-row-editor="kimi-code/kimi-k2"]')!;
    void after;
    expect(bodyEditor('overlay')!.value,
      'a refused write must not discard what the person typed')
      .toBe('Kept through a refusal.\n');
    expect(saveButton().disabled, 'the page stays dirty so the write can be retried').toBe(false);
    updateModel.mockResolvedValueOnce(ENTITY);
    await pressSave();
    expect(updateModel).toHaveBeenCalledTimes(2);
    expect(updateModel.mock.calls[1]).toEqual(updateModel.mock.calls[0]);
  });

  it('gives the dedicated body editor priority when raw JSON edits that exact slot too', async () => {
    await renderCard();
    const fields = await openEditor();
    await act(async () => {
      typeIn(bodyEditor('overlay')!, 'Body wins.\n');
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-model-engine="cognition"]')!,
        JSON.stringify({ ...ENTITY.cognition as Record<string, unknown>, overlay: { text: 'Raw loses.' }, anchor: { text: 'Raw anchor.' } }));
    });
    await pressSave();
    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(updateModel.mock.calls[0]?.[1].cognition).toEqual({
      ...ENTITY.cognition as Record<string, unknown>, overlay: { text: 'Body wins.\n' }, anchor: { text: 'Raw anchor.' },
    });
  });

  it('respects raw deletions instead of resurrecting stored branches', async () => {
    await renderCard();
    const fields = await openEditor();
    await act(async () => {
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-model-engine="cognition"]')!,
        JSON.stringify({ steering: 'new/reminder.md', main: 'off' }));
      typeIn(bodyEditor('overlay')!, 'One explicit slot.\n');
    });
    await pressSave();
    expect(updateModel.mock.calls[0]?.[1].cognition).toEqual({
      steering: 'new/reminder.md', main: 'off', overlay: { text: 'One explicit slot.\n' },
    });
  });

  it.each(['', '{}'])('carries a raw whole-object clear (%j) as null without stale prose', async (clear) => {
    await renderCard();
    const fields = await openEditor();
    await act(async () => {
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-model-engine="cognition"]')!, clear);
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-model-engine="promptOverrides"]')!, clear);
    });
    await pressSave();
    expect(updateModel.mock.calls[0]?.[1]).toMatchObject({ cognition: null, prompt_overrides: null, base_revision: 'rev-7' });
  });

  it('adds only the body intent after clearing raw cognition, while prompt fields stay cleared', async () => {
    await renderCard();
    const fields = await openEditor();
    await act(async () => {
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-model-engine="cognition"]')!, '');
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-model-engine="promptOverrides"]')!, '');
      typeIn(bodyEditor('anchor')!, 'After clear.\n');
    });
    await pressSave();
    expect(updateModel.mock.calls[0]?.[1]).toMatchObject({
      cognition: { anchor: { text: 'After clear.\n' } }, prompt_overrides: null,
    });
    expect(Object.keys(updateModel.mock.calls[0]?.[1].cognition)).toEqual(['anchor']);
  });

  it('accumulates all three scopes and retains raw prompt fields in the same CAS', async () => {
    const entity = structuredClone(ENTITY);
    (entity.cognition as Record<string, unknown>)['independent'] = { anchor: { text: 'Independent anchor.' } };
    entity.cognition_bodies!.branches.independent = {
      ...entity.cognition_bodies!.branches.independent, selection: 'custom',
      slots: {
        ...entity.cognition_bodies!.branches.independent.slots,
        anchor: { channel: 'cognition_anchor', source: 'inline', text: 'Independent anchor.', writable: true, source_read_only: false },
      },
    };
    getModel.mockResolvedValue(entity);
    await renderCard();
    const fields = await openEditor();
    await act(async () => { typeIn(bodyEditor('overlay')!, 'Shared draft.\n'); });
    await act(async () => { scopeButton('main').click(); });
    await act(async () => { typeIn(bodyEditor('steering')!, 'Main draft.\n'); });
    await act(async () => { scopeButton('independent').click(); });
    expect(bodyEditor('anchor')!.value).toBe('Independent anchor.');
    await act(async () => { typeIn(bodyEditor('anchor')!, 'Independent draft.\n'); });
    await act(async () => { scopeButton('shared').click(); });
    expect(bodyEditor('overlay')!.value).toBe('Shared draft.\n');
    const promptFields = { fields: { 'system.language': 'Updated language.', 'system.style': 'Keep this too.' }, main: 'off' };
    await act(async () => {
      typeIn(fields.querySelector<HTMLTextAreaElement>('[data-model-engine="promptOverrides"]')!, JSON.stringify(promptFields));
    });
    await pressSave();
    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(updateModel.mock.calls[0]?.[1]).toMatchObject({
      base_revision: 'rev-7', prompt_overrides: promptFields,
      cognition: {
        overlay: { text: 'Shared draft.\n' }, steering: 'cognition/legacy-steer.md',
        main: { overlay: { text: 'Main overlay, stored on the model.' }, steering: { text: 'Main draft.\n' } },
        independent: { anchor: { text: 'Independent draft.\n' } },
      },
    });
  });

  it('becomes clean when the body is restored to its original text', async () => {
    await renderCard();
    await openEditor();
    await act(async () => { typeIn(bodyEditor('overlay')!, 'Temporary draft.'); });
    expect(saveButton().disabled).toBe(false);
    await act(async () => { typeIn(bodyEditor('overlay')!, 'Shared file body.'); });
    expect(saveButton().disabled).toBe(true);
    expect(updateModel).not.toHaveBeenCalled();
  });

  it('guards external model-panel closing while author prose is unsaved', async () => {
    getModel.mockResolvedValue({ ...ENTITY, recipe: 'inst-local' });
    getRecipe.mockResolvedValue({
      summary: {
        installation_id: 'inst-local', manifest_id: 'local', name: 'Local work', version: '1.0.0',
        revision: 'sha256:test', source: { locator: 'installation:local' }, update_mode: 'pinned', health: 'ready',
      },
      resolved: { revision: 'sha256:test', branches: {}, model: {}, model_origins: {}, dependencies: [], origins: [] },
      files: { 'recipe.toml': 'schema_version = 1\nid = "local"\n\n[prompts]\nsystem = { file = "main.md" }\n', 'main.md': 'Original package words.\n' },
      editable: true, used_by: [ENTITY.id], history: [],
    });
    await renderCard();
    await openEditor();
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-recipe-open-package]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const author = document.body.querySelector<HTMLTextAreaElement>('[data-recipe-author] textarea')!;
    expect(author).not.toBeNull();
    await act(async () => { typeIn(author, 'Keep this unsaved draft.\n'); });
    expect(saveButton().disabled, 'model Save cannot pretend to save the package').toBe(true);
    const close = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Close')!;
    await act(async () => { close.click(); });
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog, 'the existing model discard guard must own external close').not.toBeNull();
    await act(async () => { dialog.querySelector<HTMLButtonElement>('button:not([data-confirm-action])')!.click(); });
    expect(author.value).toBe('Keep this unsaved draft.\n');
    expect(document.body.querySelector('[data-recipe-author]')).not.toBeNull();
    await act(async () => { close.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-confirm-action="confirm"]')!.click(); });
    expect(document.body.querySelector('[data-model-row-editor]')).toBeNull();
    expect(updateModel).not.toHaveBeenCalled();
  });
});