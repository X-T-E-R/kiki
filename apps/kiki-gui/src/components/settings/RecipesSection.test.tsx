// @vitest-environment jsdom
/**
 * The Recipe library's own page, as a person drives it.
 *
 * What these cases exist for is the page's one rule: managing a package and
 * binding a model are different writes. The library installs, reads, updates,
 * forks, edits and removes packages; the only model-facing write it ever makes
 * is the remove flow's stated detach, and it never binds anything.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecipeDetail } from '@kiki/protocol';
import { ApiError } from '@kiki/session-core/transport';

import { I18nProvider } from '../../i18n';
import { pickValue, selectText } from './testControls';

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

const source = (overrides: Partial<RecipeDetail['summary']> = {}): RecipeDetail['summary'] => ({
  installation_id: 'inst-clear-work',
  manifest_id: 'clear-work',
  name: 'Clear work',
  version: '1.2.0',
  revision: 'sha256:a91d',
  source: { locator: 'https://example.com/recipes/clear-work/recipe.toml' },
  update_mode: 'follow',
  health: 'ready',
  ...overrides,
});

const detail = (overrides: Partial<RecipeDetail> = {}, summary: Partial<RecipeDetail['summary']> = {}): RecipeDetail => ({
  summary: source(summary),
  resolved: {
    revision: 'sha256:a91d',
    branches: {
      main: { fields: {}, steering_on_turn: true, steering_on_input: true, steering_interval_steps: 0, system: 'Understand the job.' },
      sub: { fields: {} },
      independent: { fields: {} },
    },
    dependencies: [],
    origins: [],
    model: {},
    model_origins: {},
  },
  files: { 'recipe.toml': 'schema_version = 1\nid = "clear-work"\n\n[prompts]\nsystem = { text = "Understand the job." }\n' },
  history: [],
  editable: true,
  used_by: ['example/kimi-k2'],
  ...overrides,
});

/** Mutable stand-in for the installed set and the writes the GUI may send. */
let packages = new Map<string, RecipeDetail>();
const updateRecipeCalls: unknown[][] = [];
const removeRecipeCalls: { installation_id: string; disable_models?: boolean }[] = [];
const saveLocalCalls: unknown[][] = [];
const previewRecipeCalls: unknown[] = [];
let removeFailure = false;

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listRecipes: () => Promise.resolve([...packages.values()].map((entry) => ({ ...entry.summary, used_by: entry.used_by }))),
      getRecipe: (id: string) => Promise.resolve(packages.get(id)),
      listRecipeMarkets: () => Promise.resolve([]),
      checkRecipeUpdates: () => Promise.resolve([...packages.values()].map((entry) => entry.summary)),
      updateRecipe: (input: { installation_id: string; update_mode?: string }) => {
        updateRecipeCalls.push([input]);
        const found = packages.get(input.installation_id);
        if (found !== undefined && input.update_mode !== undefined) {
          found.summary = { ...found.summary, update_mode: input.update_mode as 'follow' | 'pinned' };
        }
        return Promise.resolve(found?.summary);
      },
      removeRecipe: (input: { installation_id: string; disable_models?: boolean }) => {
        removeRecipeCalls.push(input);
        if (removeFailure) return Promise.reject(new Error('still referenced'));
        packages.delete(input.installation_id);
        return Promise.resolve(undefined);
      },
      saveLocalRecipe: (input: { installation_id: string; expected_revision: string; files: Record<string, string> }) => {
        saveLocalCalls.push([input]);
        const found = packages.get(input.installation_id)!;
        if (input.expected_revision !== found.summary.revision) {
          return Promise.reject(new ApiError({
            code: 40001, msg: 'Recipe changed; reload before saving', data: null,
            details: { source: input.installation_id, path: 'expected_revision' },
          }));
        }
        const saved: RecipeDetail = {
          ...found,
          summary: { ...found.summary, revision: `${found.summary.revision}-saved` },
          files: { ...input.files },
        };
        packages.set(input.installation_id, saved);
        return Promise.resolve(saved);
      },
      forkRecipe: () => Promise.reject(new Error('not staged')),
      previewRecipe: (input: { source: { locator: string; sha256?: string } }) => {
        previewRecipeCalls.push(input);
        return Promise.resolve({
          preview_id: 'prev-zip',
          digest: 'sha256:a91d',
          summary: source({ source: input.source }),
          resolved: detail().resolved,
          diagnostics: [],
        });
      },
      installRecipe: () => Promise.reject(new Error('not staged')),
      exportRecipe: () => Promise.resolve({ name: 'x', revision: 'r', files: {} }),
    },
  }),
}));

const { RecipesSection } = await import('./RecipesSection');

let container: HTMLElement;
let root: Root;

async function renderLibrary(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <RecipesSection recipeId={null} />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function renderPackage(id: string, edit = false): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <RecipesSection recipeId={id} initialEdit={edit} />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function click(selector: string): Promise<void> {
  const node = container.querySelector(selector) ?? document.querySelector(selector);
  assert.ok(node !== null, `no element matched ${selector}`);
  await act(async () => {
    (node as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('the Recipe library', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    packages = new Map([['inst-clear-work', detail()]]);
    updateRecipeCalls.length = 0;
    removeRecipeCalls.length = 0;
    saveLocalCalls.length = 0;
    previewRecipeCalls.length = 0;
    removeFailure = false;
  });

  afterEach(() => {
    if (root !== undefined) act(() => { root.unmount(); });
    container?.remove();
    vi.restoreAllMocks();
  });

  it('lists each package with who uses it and its update rule', async () => {
    await renderLibrary();
    const row = container.querySelector('[data-recipes-row="inst-clear-work"]')!;
    expect(row.textContent).toContain('Clear work');
    expect(row.querySelector('[data-recipes-used-by="inst-clear-work"]')?.textContent ?? '').toContain('example/kimi-k2');
    expect(selectText(row.querySelector('[data-recipes-update-mode="inst-clear-work"]')!)).toBe('Following updates');
  });

  it('writes only the package when the update rule changes; no model is touched', async () => {
    await renderLibrary();
    const select = container.querySelector<HTMLElement>('[data-recipes-update-mode="inst-clear-work"]')!;
    await pickValue(select, 'data-option-value', 'pinned');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(updateRecipeCalls).toEqual([[{ installation_id: 'inst-clear-work', expected_revision: 'sha256:a91d', update_mode: 'pinned' }]]);
  });

  it('opens a package for reading, then edits and saves it without leaving the page', async () => {
    await renderPackage('inst-clear-work');
    // The read leads: the package's own words, not an editor.
    expect(container.querySelector('[data-recipe-package="inst-clear-work"]')).not.toBeNull();
    expect(container.textContent).toContain('Understand the job.');
    await click('[data-recipe-edit="inst-clear-work"]');
    expect(container.querySelector('[data-recipe-author="inst-clear-work"]')).not.toBeNull();
    // A clean package is not dirty, so the save button waits; type first.
    const body = container.querySelector('textarea');
    assert.ok(body !== null, 'the package must offer its body for editing');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(body as HTMLTextAreaElement, 'Understand the job, then finish it.\n');
      (body as HTMLTextAreaElement).dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // Saving stays: the workbench keeps the new revision rather than navigating away.
    await click('[data-recipe-save-package]');
    expect(saveLocalCalls.length).toBeGreaterThan(0);
  });

  it('asks before removing a package that a model still uses, naming the detach', async () => {
    await renderPackage('inst-clear-work');
    await click('[data-recipe-remove="inst-clear-work"]');
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('example/kimi-k2');
    expect(removeRecipeCalls.length).toBe(0);
    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    expect(removeRecipeCalls).toEqual([{ installation_id: 'inst-clear-work', expected_revision: 'sha256:a91d', disable_models: true }]);
  });

  it('keeps the draft through a save that lost a revision race, then saves on the newer copy', async () => {
    await renderPackage('inst-clear-work', true);
    const body = container.querySelector('textarea');
    assert.ok(body !== null, 'the package must offer its body for editing');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(body as HTMLTextAreaElement, 'My own words.\n');
      (body as HTMLTextAreaElement).dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // Someone else publishes first, adding a file this editor never touched.
    const theirs = packages.get('inst-clear-work')!;
    packages.set('inst-clear-work', {
      ...theirs,
      summary: { ...theirs.summary, revision: 'sha256:b7e2' },
      files: { ...theirs.files, 'notes.md': 'Their note.\n' },
    });
    await click('[data-recipe-save-package]');
    expect(container.querySelector('[data-recipe-author-conflict]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-recipe-save-package]')?.disabled).toBe(true);

    await click('[data-recipe-conflict-reload]');
    expect(container.querySelector('[data-recipe-author-conflict]')).toBeNull();
    expect(container.textContent).toContain('My own words.');

    await click('[data-recipe-save-package]');
    const last = saveLocalCalls.at(-1)![0] as { expected_revision: string; files: Record<string, string> };
    expect(last.expected_revision).toBe('sha256:b7e2');
    expect(last.files['notes.md']).toBe('Their note.\n');
    expect(Object.values(last.files).join('\n')).toContain('My own words.');
  });

  it('keeps the package when removal is refused', async () => {
    removeFailure = true;
    await renderPackage('inst-clear-work');
    await click('[data-recipe-remove="inst-clear-work"]');
    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    expect(packages.has('inst-clear-work')).toBe(true);
    expect(container.textContent).toContain('could not be removed');
  });

  it('previews a ZIP source without requiring a SHA-256 and validates an explicit checksum', async () => {
    await renderLibrary();
    const locatorInput = container.querySelector<HTMLInputElement>('[data-recipe-import-locator]')!;
    const shaInput = container.querySelector<HTMLInputElement>('[data-recipe-import-sha]')!;
    const previewButton = container.querySelector<HTMLButtonElement>('button[data-recipe-preview]')!;
    expect(shaInput.disabled).toBe(false);

    const setInput = async (el: HTMLInputElement, value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    };

    await setInput(locatorInput, 'https://example.test/recipes/custom.zip');
    expect(previewButton.disabled).toBe(false);
    await click('button[data-recipe-preview]');
    expect(previewRecipeCalls).toEqual([{ source: { locator: 'https://example.test/recipes/custom.zip', sha256: undefined } }]);

    await setInput(shaInput, 'not-a-digest');
    expect(previewButton.disabled).toBe(true);

    await setInput(shaInput, 'A'.repeat(64));
    expect(previewButton.disabled).toBe(false);
    await click('button[data-recipe-preview]');
    expect(previewRecipeCalls.at(-1)).toEqual({
      source: { locator: 'https://example.test/recipes/custom.zip', sha256: 'a'.repeat(64) },
    });
  });
});
