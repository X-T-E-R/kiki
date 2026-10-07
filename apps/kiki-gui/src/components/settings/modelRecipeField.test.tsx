// @vitest-environment jsdom
/**
 * The Recipe field's fork flow, as a person drives it.
 *
 * The fork is the one place two writes could collide: creating a package and
 * then editing it. Both the store and the DOM are asserted, because the failure
 * this file exists for was a render crash that no type check could see.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecipeDetail } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

const MODEL_ID = 'example/kimi-k2';

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

const READ_ONLY: RecipeDetail = {
  summary: source(),
  resolved: {
    revision: 'sha256:a91d',
    branches: {
      main: { fields: {}, steering_on_turn: true, steering_on_input: true, steering_interval_steps: 0 },
      sub: { fields: {} },
      independent: { fields: {} },
    },
    dependencies: [],
    origins: [],
    model: {},
    model_origins: {},
  },
  // A real package carries the prose its manifest points at; without the files
  // the editor would have nothing to edit, which is not a state a package is in.
  files: {
    'recipe.toml': 'schema_version = 1\nid = "clear-work"\n\n[prompts]\nsystem = { file = "main.md" }\n',
    'main.md': 'Understand the job, then finish it.\n',
  },
  history: [],
  editable: false,
  used_by: [MODEL_ID],
};

/** Mutable stand-in for the installed set, keyed the way the server keys it. */
let packages = new Map<string, RecipeDetail>();
const updateModelCalls: unknown[][] = [];
const saveCalls: { installation_id: string; files: Record<string, string> }[] = [];
const dirtyReports: boolean[] = [];

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listRecipes: () => Promise.resolve([...packages.values()].map((entry) => entry.summary)),
      getRecipe: (id: string) => Promise.resolve(packages.get(id)),
      forkRecipe: (input: RecipeDetail['summary'] extends never ? never : { installation_id: string; mode: string; id: string; name: string }) => {
        const from = packages.get(input.installation_id);
        if (from === undefined) throw new Error(`no such package ${input.installation_id}`);
        const fork: RecipeDetail = {
          ...from,
          summary: source({
            ...from.summary,
            installation_id: `inst-${input.id}`,
            manifest_id: input.id,
            name: input.name,
            source: { locator: `installation:${input.id}` },
          }),
          resolved: {
            ...from.resolved,
            dependencies: input.mode === 'extend'
              ? [{ source: from.summary.source, manifest_id: from.summary.manifest_id, version: from.summary.version, revision: from.summary.revision }]
              : [],
          },
          editable: true,
          used_by: [],
        };
        packages.set(fork.summary.installation_id, fork);
        return Promise.resolve(fork);
      },
      saveLocalRecipe: (input: { installation_id: string; files: Record<string, string> }) => {
        const saved: RecipeDetail = { ...packages.get(input.installation_id)!, files: input.files };
        packages.set(input.installation_id, saved);
        saveCalls.push(input);
        return Promise.resolve(saved);
      },
      updateModel: (...args: unknown[]) => {
        updateModelCalls.push(args);
        return Promise.resolve({});
      },
      exportRecipe: () => Promise.resolve({ name: 'x', revision: 'r', files: {} }),
    },
  }),
}));

const { ModelRecipeField } = await import('./ModelRecipeField');

let container: HTMLElement;
let root: Root;

async function render(appliedId: string | undefined): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <ModelRecipeField
              modelId={MODEL_ID}
              modelName="Kimi K2"
              modelRevision="rev-1"
              appliedId={appliedId}
              onDraftChange={(dirty) => { dirtyReports.push(dirty); }}
            />
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
  const node = container.querySelector(selector);
  assert.ok(node !== null, `no element matched ${selector}`);
  await act(async () => {
    (node as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const count = (selector: string) => container.querySelectorAll(selector).length;

/** The last state the field reported to its page, which owns the leave rule. */
const lastReportedDirty = () => dirtyReports.at(-1);

async function typeBody(text: string): Promise<void> {
  const editor = container.querySelector('textarea');
  assert.ok(editor !== null, 'the package must offer its body for editing');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(editor as HTMLTextAreaElement, text);
    (editor as HTMLTextAreaElement).dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('the model page Recipe field', () => {
  beforeEach(() => {
    packages = new Map([[READ_ONLY.summary.installation_id, READ_ONLY]]);
    updateModelCalls.length = 0;
    saveCalls.length = 0;
    dirtyReports.length = 0;
  });

  afterEach(() => {
    if (root !== undefined) act(() => { root.unmount(); });
    container?.remove();
  });

  it('offers a read-only package as copy or extend rather than an editor', async () => {
    await render(READ_ONLY.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-fork-choice]')).toBe(1); });
    expect(count('[data-recipe-fork-copy]')).toBe(1);
    expect(count('[data-recipe-fork-extend]')).toBe(1);
    expect(count('[data-recipe-save-package]')).toBe(0);
  });

  it('opens the package it just forked instead of returning to the model row', async () => {
    await render(READ_ONLY.summary.installation_id);
    await click('[data-recipe-open-package]');
    await click('[data-recipe-fork-extend]');

    const author = container.querySelectorAll('[data-recipe-author]');
    expect(author).toHaveLength(1);
    expect((author[0] as HTMLElement).dataset['recipeAuthor']).toBe('inst-clear-work-local');
    expect(count('[data-recipe-save-package]')).toBe(1);
    expect(count('[data-recipe-open-studio]')).toBe(0);
  });

  it('binds nothing while forking', async () => {
    await render(READ_ONLY.summary.installation_id);
    await click('[data-recipe-open-package]');
    await click('[data-recipe-fork-extend]');
    expect(updateModelCalls).toHaveLength(0);
  });

  it('asks before leaving a package whose words were not saved', async () => {
    await render(READ_ONLY.summary.installation_id);
    await click('[data-recipe-open-package]');
    await click('[data-recipe-fork-extend]');
    await typeBody('Edited but not saved.\n');

    expect(lastReportedDirty(), 'the page must be told the package is a draft').toBe(true);

    await click('[data-recipe-author-back]');
    expect(count('[data-recipe-author]'),
      'leaving with unsaved words must ask rather than drop them').toBe(1);
    expect(saveCalls, 'nothing was saved on the way out').toHaveLength(0);
    expect(count('[role="alertdialog"]')).toBe(1);
    await click('[role="alertdialog"] button:not([data-confirm-action])');
    // Staying keeps the draft exactly as typed.
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value)
      .toBe('Edited but not saved.\n');
    expect(lastReportedDirty()).toBe(true);
    await click('[data-recipe-author-back]');
    await click('[data-confirm-action="confirm"]');
    expect(count('[data-recipe-author]')).toBe(0);
    expect(lastReportedDirty(), 'discarding the author draft must clear the page dirty report').toBe(false);
    expect(saveCalls).toHaveLength(0);
  });

  it('leaves without asking once the package is saved', async () => {
    await render(READ_ONLY.summary.installation_id);
    await click('[data-recipe-open-package]');
    await click('[data-recipe-fork-extend]');
    await typeBody('Edited and saved.\n');
    await click('[data-recipe-save-package]');

    expect(lastReportedDirty(), 'a saved package is not a draft').toBe(false);
    expect(count('[data-recipe-open-studio]')).toBe(1);
  });

  it('reports no draft for a package that was only read', async () => {
    await render(READ_ONLY.summary.installation_id);
    await click('[data-recipe-open-package]');
    // Browsing must not put the page into a state where closing it asks a
    // question the person never created.
    expect(lastReportedDirty()).toBe(false);
    await click('[data-recipe-fork-extend]');
    expect(lastReportedDirty(),
      'a freshly forked package matches what was stored, so nothing is pending').toBe(false);
  });

  it('returns to the model row once the forked package is saved', async () => {
    await render(READ_ONLY.summary.installation_id);
    await click('[data-recipe-open-package]');
    await click('[data-recipe-fork-extend]');

    // Saving is only offered for something actually edited, so the body has to
    // change first — which is itself the point of forking.
    const editor = container.querySelector('textarea');
    assert.ok(editor !== null, 'the forked package must offer its body for editing');
    await act(async () => {
      const field = editor as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(field, 'Edited inside the fork.\n');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    await click('[data-recipe-save-package]');
    expect(count('[data-recipe-author]')).toBe(0);
    expect(count('[data-recipe-open-studio]')).toBe(1);
    // What was saved is the fork, not the package it came from.
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]?.installation_id).toBe('inst-clear-work-local');
  });
});