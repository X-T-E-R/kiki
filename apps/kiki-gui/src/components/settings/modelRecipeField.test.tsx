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
import { EditorView } from '@codemirror/view';
import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@kiki/session-core/transport';
import type { RecipeDetail, RecipePreview } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { parseRecipeManifest, readDeclaration } from '../../lib/recipeFiles';

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
type SaveInput = { installation_id: string; expected_revision: string; files: Record<string, string> };
const saveCalls: SaveInput[] = [];
const saveAttempts: SaveInput[] = [];
const readCalls: string[] = [];
let acceptedFiles: Record<string, string> | null = null;
let deferredSave = false;
let deferredPreview = false;
let deferredInstall = false;
let releaseSave: (() => void) | null = null;
let releasePreview: (() => void) | null = null;
let releaseInstall: (() => void) | null = null;
const dirtyReports: boolean[] = [];
/*
  Script-hook wiring. These are recorded rather than asserted by identity: what
  matters is which requests the GUI is willing to send, and specifically that it
  never sends `consent` for a package that did not ask for one.
*/
const previewCalls: unknown[] = [];
const installCalls: { preview_id: string; consent?: boolean }[] = [];
let nextPreview: RecipePreview | null = null;
let previewFiles: [string, string][] = [];
let refuseSaveForConsent = false;
const readFailures: boolean[] = [];
let deferredReads = 0;
let releaseRead: (() => void) | null = null;
let missingReads = 0;

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      listRecipes: () => Promise.resolve([...packages.values()].map((entry) => entry.summary)),
      getRecipe: (id: string) => {
        readCalls.push(id);
        // One read held open, so a person can be typing across it. What is under
        // test is what happens to those words when it finally answers.
        if (deferredReads > 0) {
          deferredReads -= 1;
          return new Promise((resolve) => { releaseRead = () => { resolve(packages.get(id)); }; });
        }
        if (readFailures.length > 0) {
          readFailures.shift();
          return Promise.reject(new ApiError({ code: 50001, msg: 'The recipe could not be read right now.', data: null }));
        }
        if (missingReads > 0) {
          missingReads -= 1;
          return Promise.resolve(undefined);
        }
        return Promise.resolve(packages.get(id));
      },
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
      saveLocalRecipe: (input: SaveInput) => {
        saveAttempts.push(input);
        const refused = refuseSaveForConsent;
        const respond = () => {
          const before = packages.get(input.installation_id)!;
          if (input.expected_revision !== before.summary.revision) throw new Error('revision_conflict');
          if (refused) throw new ApiError({
            code: 40001,
            msg: 'Confirm installation to authorize new Recipe scripts',
            data: null,
            details: { code: 'recipe-hook-consent-required', source: undefined, path: 'hooks' },
          });
          const revision = `${before.summary.revision}-saved`;
          const saved: RecipeDetail = {
            ...before,
            summary: { ...before.summary, revision },
            resolved: { ...before.resolved, revision },
            files: { ...(acceptedFiles ?? input.files) },
          };
          packages.set(input.installation_id, saved);
          saveCalls.push(input);
          return saved;
        };
        if (deferredSave) {
          deferredSave = false;
          return new Promise((resolve, reject) => {
            releaseSave = () => { try { resolve(respond()); } catch (error) { reject(error); } };
          });
        }
        return Promise.resolve().then(respond);
      },
      previewRecipe: (input: { files?: Record<string, string> }) => {
        previewCalls.push(input);
        if (input.files !== undefined) previewFiles = Object.entries(input.files);
        if (nextPreview === null) return Promise.reject(new Error('no preview staged'));
        const target = nextPreview;
        if (deferredPreview) {
          deferredPreview = false;
          return new Promise((resolve) => { releasePreview = () => { resolve(target); }; });
        }
        return Promise.resolve(target);
      },
      installRecipe: (input: { preview_id: string; consent?: boolean }) => {
        installCalls.push(input);
        const target = nextPreview;
        if (target === undefined || target === null) return Promise.reject(new Error('no preview staged'));
        const respond = () => {
          const revision = `${target.summary.revision}-installed`;
          const installed: RecipeDetail = {
            summary: source({ ...target.summary, installation_id: 'inst-clear-work', revision, hooks_fingerprint: target.hooks?.fingerprint }),
            resolved: { ...target.resolved, revision },
            files: { ...(acceptedFiles ?? Object.fromEntries(previewFiles)) },
            history: [],
            editable: true,
            used_by: [],
          };
          packages.set(installed.summary.installation_id, installed);
          return installed.summary;
        };
        if (deferredInstall) {
          deferredInstall = false;
          return new Promise((resolve) => { releaseInstall = () => { resolve(respond()); }; });
        }
        return Promise.resolve(respond());
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
const { mergePublished } = await import('./RecipeAuthorWorkbench');

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
              onCommitRecipe={async (recipe) => { updateModelCalls.push([MODEL_ID, { recipe }]); }}
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
  const node = container.querySelector(selector) ?? document.querySelector(selector);
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

async function typeFile(path: string, text: string): Promise<void> {
  const editor = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${path}"]`);
  assert.ok(editor !== null, `the source view must offer ${path}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function typeManifest(text: string): Promise<void> {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!);
  assert.ok(view !== null, 'the real manifest editor must be mounted');
  await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); });
}

async function release(callback: (() => void) | null): Promise<void> {
  assert.ok(callback !== null, 'the request must be held open before releasing it');
  await act(async () => { callback(); });
  await settle();
}

describe('the model page Recipe field', () => {
  beforeEach(() => {
    /* jsdom has no text layout; exercise CodeMirror's live document, not pixels. */
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    packages = new Map([[READ_ONLY.summary.installation_id, READ_ONLY]]);
    updateModelCalls.length = 0;
    saveCalls.length = 0;
    saveAttempts.length = 0;
    readCalls.length = 0;
    acceptedFiles = null;
    deferredSave = false;
    deferredPreview = false;
    deferredInstall = false;
    releaseSave = null;
    releasePreview = null;
    releaseInstall = null;
    dirtyReports.length = 0;
    previewCalls.length = 0;
    installCalls.length = 0;
    nextPreview = null;
    previewFiles = [];
    refuseSaveForConsent = false;
    readFailures.length = 0;
    deferredReads = 0;
    releaseRead = null;
    missingReads = 0;
  });

  afterEach(() => {
    if (root !== undefined) act(() => { root.unmount(); });
    container?.remove();
    vi.restoreAllMocks();
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

  it('reads and saves mixed inline/file segments without flattening or changing the parent and other files', async () => {
    const manifest = 'schema_version = 1\nid = "mixed-work"\n\n[extends]\nsource = "https://example.com/recipes/parent/recipe.toml"\nrevision = "sha256:parent"\n\n[prompts]\nsystem = [{ text = "First inline." }, { file = "middle.md" }, { text = "Last inline." }]\nindependent = "off"\n';
    const mixed: RecipeDetail = {
      ...READ_ONLY, editable: true,
      files: { 'recipe.toml': manifest, 'middle.md': 'Middle file body.\n', 'other.md': 'Other file stays unchanged.\n' },
    };
    packages.set(mixed.summary.installation_id, mixed);
    await render(mixed.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-prose-segment]')).toBe(3); });
    const segments = () => [...container.querySelectorAll<HTMLTextAreaElement>('[data-recipe-prose-segment] textarea')];
    expect(segments().map((field) => field.value)).toEqual(['First inline.', 'Middle file body.\n', 'Last inline.']);
    expect(container.querySelector('[data-recipe-prose-slot="steering"] [data-recipe-prose-inherited]')).not.toBeNull();
    const edit = async (index: number, text: string) => {
      await act(async () => {
        const field = segments()[index]!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    await edit(1, 'Only the file buffer changed.\n');
    await click('[data-recipe-save-package]');
    expect(saveCalls[0]?.files['recipe.toml'], 'editing a file segment must not reserialize TOML').toBe(manifest);
    expect(saveCalls[0]?.files['middle.md']).toBe('Only the file buffer changed.\n');
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-prose-segment]')).toBe(3); });
    expect(segments().map((field) => field.value)).toEqual(['First inline.', 'Only the file buffer changed.\n', 'Last inline.']);
    await edit(0, 'Changed first inline.');
    await edit(1, 'Changed middle file.\n');
    await click('[data-recipe-save-package]');
    expect(saveCalls).toHaveLength(2);
    const saved = saveCalls[1]!.files;
    const declaration = readDeclaration(parseRecipeManifest(saved['recipe.toml']!));
    expect(declaration.prompts?.system).toEqual({ kind: 'segments', parts: [
      { kind: 'inline', text: 'Changed first inline.' }, { kind: 'file', file: 'middle.md' }, { kind: 'inline', text: 'Last inline.' },
    ] });
    expect(declaration.extends).toEqual({ source: 'https://example.com/recipes/parent/recipe.toml', revision: 'sha256:parent' });
    expect(declaration.independent).toBe('off');
    expect(declaration.prompts?.steering).toBeUndefined();
    expect(saved['middle.md']).toBe('Changed middle file.\n');
    expect(saved['other.md']).toBe('Other file stays unchanged.\n');
    expect(updateModelCalls).toHaveLength(0);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-prose-segment]')).toBe(3); });
    expect(segments().map((field) => field.value)).toEqual(['Changed first inline.', 'Changed middle file.\n', 'Last inline.']);
  });

  /*
    Script hooks. What is asserted here is never "a dialog appeared" — it is that
    the existing install button carries the whole decision, that a package which
    did not ask for consent is never sent one, and that a refused save keeps the
    draft instead of losing it to a consent round trip.
  */
  const HOOKED_MANIFEST = [
    'schema_version = 1',
    'id = "clear-work"',
    'name = "Clear work"',
    'version = "1.2.0"',
    '',
    '[prompts]',
    'system = { file = "main.md" }',
    '',
    '[[hooks]]',
    'event = "PreToolUse"',
    'command = "node scripts/guard.mjs"',
    'files = ["scripts/guard.mjs"]',
    '',
  ].join('\n');

  const HOOKED_BODY = 'echo guard\n';

  function hookedPreview(consentRequired: boolean): RecipePreview {
    return {
      preview_id: 'preview-hooked',
      digest: READ_ONLY.resolved.revision,
      summary: source(),
      resolved: READ_ONLY.resolved,
      diagnostics: [],
      hooks: {
        fingerprint: 'sha256:hookabc',
        consent_required: consentRequired,
        scripts: [{
          event: 'PreToolUse',
          command: 'node scripts/guard.mjs',
          source: 'https://example.com/recipes/clear-work/recipe.toml',
          files: [{ path: 'scripts/guard.mjs', sha256: 'b'.repeat(64), bytes: HOOKED_BODY.length }],
        }],
      },
    };
  }

  function installHooks(manifest = HOOKED_MANIFEST): RecipeDetail {
    const hooked: RecipeDetail = {
      ...READ_ONLY,
      editable: true,
      files: { 'recipe.toml': manifest, 'main.md': 'Body before the edit.\n', 'scripts/guard.mjs': HOOKED_BODY },
    };
    packages.set(hooked.summary.installation_id, hooked);
    return hooked;
  }

  const openStudio = async () => {
    await click('[data-recipe-open-studio]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-studio]')).toBe(1); });
    await click('[data-recipe-studio-tab="import"]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-import]')).toBe(1); });
  };

  const typeLocator = async (value: string) => {
    const field = container.querySelector('[data-recipe-import-locator]');
    assert.ok(field !== null, 'the import form must offer a source field');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field as HTMLInputElement, value);
      (field as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };

  const previewHooks = async (consentRequired: boolean) => {
    previewFiles = [['recipe.toml', HOOKED_MANIFEST], ['scripts/guard.mjs', HOOKED_BODY]];
    nextPreview = hookedPreview(consentRequired);
    await render(undefined);
    await openStudio();
    await typeLocator('https://example.com/recipes/clear-work/recipe.toml');
    await click('[data-recipe-preview]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-install-apply]')).toBe(1); });
  };

  it('shows the command, event, source and files in the one install confirmation', async () => {
    await previewHooks(true);

    // The command is shown as itself, not as a claim that scripts exist.
    expect(count('[data-recipe-hook-consent]')).toBe(1);
    expect(container.querySelector('[data-recipe-hook-script="0"] code')?.textContent)
      .toContain('node scripts/guard.mjs');
    expect(container.querySelector('[data-recipe-hook-event="PreToolUse"]')).not.toBeNull();
    expect(container.querySelector('[data-recipe-hook-file="scripts/guard.mjs"]')).not.toBeNull();
    // And what agreeing authorizes is said once, next to it.
    expect(container.querySelector('[data-recipe-hook-consent-power]')?.textContent ?? '').toMatch(/sandbox/iu);
    // One button, still the one that was always there.
    expect(count('[data-recipe-install-apply]')).toBe(1);
    expect(installCalls, 'previewing writes nothing').toHaveLength(0);
  });

  it('sends consent exactly once, on the existing install button', async () => {
    await previewHooks(true);
    await click('[data-recipe-install-apply]');
    await vi.waitFor(async () => { await settle(); expect(installCalls).toHaveLength(1); });

    // One click, one install, and the consent rides along in the same request.
    expect(installCalls[0]?.preview_id).toBe('preview-hooked');
    expect(installCalls[0]?.consent).toBe(true);
    expect(count('[role="alertdialog"]'),
      'the script decision must not open a second dialog on top of the button').toBe(0);
  });

  it('sends no consent for a package whose scripts this machine already trusts', async () => {
    await previewHooks(false);

    // Already trusted, so the commands are still shown — but there is nothing
    // to decide, and the request must not claim otherwise.
    expect(count('[data-recipe-hook-consent]'), 'a trusted package has nothing to consent to').toBe(0);
    expect(count('[data-recipe-hooks]'), 'its commands are still visible').toBe(1);
    await click('[data-recipe-install-apply]');
    await vi.waitFor(async () => { await settle(); expect(installCalls).toHaveLength(1); });
    expect(installCalls[0]?.consent).toBeUndefined();
  });

  it('keeps the typed draft when a save is refused for want of script consent', async () => {
    const hooked = installHooks();
    refuseSaveForConsent = true;
    previewFiles = [['recipe.toml', HOOKED_MANIFEST], ['scripts/guard.mjs', HOOKED_BODY]];
    nextPreview = hookedPreview(true);
    await render(hooked.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author]')).toBe(1); });

    await typeBody('Edited but refused, and still here.\n');
    await click('[data-recipe-save-package]');
    await vi.waitFor(async () => { await settle(); expect(saveCalls, 'a refused save writes nothing').toHaveLength(0); });

    // The same confirmation opens, on this package, and the draft is intact.
    expect(document.querySelectorAll('[data-recipe-hook-consent]')).toHaveLength(1);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value)
      .toBe('Edited but refused, and still here.\n');
    expect(lastReportedDirty(), 'the refused draft is still a draft').toBe(true);
    expect(count('[data-recipe-author]'), 'the refusal must not navigate away').toBe(1);

    // Declining writes nothing and keeps the words.
    await click('[role="alertdialog"] button:not([data-confirm-action])');
    await settle();
    expect(installCalls, 'declining installs nothing').toHaveLength(0);
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value)
      .toBe('Edited but refused, and still here.\n');
    expect(lastReportedDirty()).toBe(true);
  });

  it('publishes the save through the consented install when the person agrees', async () => {
    const hooked = installHooks();
    refuseSaveForConsent = true;
    previewFiles = [['recipe.toml', HOOKED_MANIFEST], ['scripts/guard.mjs', HOOKED_BODY]];
    nextPreview = hookedPreview(true);
    await render(hooked.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author]')).toBe(1); });
    await typeBody('Edited and confirmed.\n');
    await click('[data-recipe-save-package]');
    await vi.waitFor(async () => { await settle(); expect(document.querySelectorAll('[data-recipe-hook-consent]')).toHaveLength(1); });

    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    await vi.waitFor(async () => { await settle(); expect(installCalls).toHaveLength(1); });
    expect(installCalls[0]?.consent).toBe(true);
    // The preview carried the draft itself, so what gets confirmed is exactly
    // what was typed — never a re-download of the source.
    expect((previewCalls[0] as { files?: Record<string, string> } | undefined)?.files?.['main.md'])
      .toBe('Edited and confirmed.\n');
  });

  it('leaves an ordinary package with no scripts exactly as it was', async () => {
    previewFiles = [['recipe.toml', READ_ONLY.files['recipe.toml']!], ['main.md', READ_ONLY.files['main.md']!]];
    nextPreview = {
      preview_id: 'preview-plain',
      digest: READ_ONLY.resolved.revision,
      summary: source(),
      resolved: READ_ONLY.resolved,
      diagnostics: [],
    };
    await render(undefined);
    await openStudio();
    await typeLocator('https://example.com/recipes/plain/recipe.toml');
    await click('[data-recipe-preview]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-install-apply]')).toBe(1); });

    // No scripts section, no consent block, and the payload is what it was.
    expect(count('[data-recipe-hooks]')).toBe(0);
    expect(count('[data-recipe-hook-consent]')).toBe(0);
    await click('[data-recipe-install-apply]');
    await vi.waitFor(async () => { await settle(); expect(installCalls).toHaveLength(1); });
    expect(installCalls[0]?.consent).toBeUndefined();
    expect(Object.keys(installCalls[0] ?? {}).toSorted()).toEqual(['preview_id']);
  });

  it('keeps Save disabled for the whole flight, so one press makes one candidate', async () => {
    const hooked = installHooks();
    refuseSaveForConsent = true;
    previewFiles = [['recipe.toml', HOOKED_MANIFEST], ['scripts/guard.mjs', HOOKED_BODY]];
    nextPreview = hookedPreview(true);
    await render(hooked.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author]')).toBe(1); });
    await typeBody('Edited once.\n');
    await click('[data-recipe-save-package]');
    await vi.waitFor(async () => { await settle(); expect(document.querySelectorAll('[data-recipe-hook-consent]')).toHaveLength(1); });

    // The refusal continues into a preview and an install; Save is not a way to
    // start a second one beside it.
    const save = container.querySelector('[data-recipe-save-package]') as HTMLButtonElement;
    expect(save.disabled, 'Save must be disabled while the chain it started is still running').toBe(true);
    await click('[data-recipe-save-package]');
    expect(previewCalls, 'a disabled button sends nothing').toHaveLength(1);

    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    await vi.waitFor(async () => { await settle(); expect(installCalls).toHaveLength(1); });
    expect(previewCalls, 'one press, one preview').toHaveLength(1);
    expect(installCalls, 'one press, one install, one authorization').toHaveLength(1);
    expect(saveCalls, 'and the refused save was never retried').toHaveLength(0);
  });

  it('reports a committed save whose read-back failed, and recovers on a retry', async () => {
    const hooked = installHooks();
    refuseSaveForConsent = true;
    previewFiles = [['recipe.toml', HOOKED_MANIFEST], ['scripts/guard.mjs', HOOKED_BODY]];
    nextPreview = hookedPreview(true);
    await render(hooked.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author]')).toBe(1); });
    // The install lands; the read that would bring the editor up to date does
    // not. Armed here so it is the post-save read that fails, not the open.
    readFailures.push(true);
    await typeBody('Saved, then the read failed.\n');
    await click('[data-recipe-save-package]');
    await vi.waitFor(async () => { await settle(); expect(document.querySelectorAll('[data-recipe-hook-consent]')).toHaveLength(1); });
    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    await vi.waitFor(async () => { await settle(); expect(installCalls).toHaveLength(1); });

    // It says saved, and it offers a read rather than another write.
    const notice = container.querySelector('[data-recipe-author-readback]');
    expect(notice, 'a committed save must say so').not.toBeNull();
    expect(notice?.textContent ?? '').not.toMatch(/could not be saved/iu);
    const save = container.querySelector('[data-recipe-save-package]') as HTMLButtonElement;
    expect(save.disabled, 'the draft is already published; there is nothing to save again').toBe(true);

    // Retrying reads. It does not save, install, or ask about the scripts again.
    await click('[data-recipe-reload-saved]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author-readback]')).toBe(0); });
    expect(installCalls, 'a retry reads; it never installs again').toHaveLength(1);
    expect(saveCalls, 'and never saves again').toHaveLength(0);
    expect(previewCalls, 'and never asks about the scripts again').toHaveLength(1);
    // A read that succeeds ends the editing the workbench was opened for, which
    // is where it has always returned to — not a second write.
    expect(count('[data-recipe-author]'), 'a recovered save finishes the edit it was opened for').toBe(0);
    expect(count('[data-recipe-open-studio]')).toBe(1);
  });

  it('keeps words typed while the read-back is still open', async () => {
    const hooked = installHooks();
    refuseSaveForConsent = true;
    previewFiles = [['recipe.toml', HOOKED_MANIFEST], ['scripts/guard.mjs', HOOKED_BODY]];
    nextPreview = hookedPreview(true);
    await render(hooked.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author]')).toBe(1); });
    await typeBody('The body that gets published.\n');
    // One read held open, so there is a real window in which to keep typing.
    // Armed after the editor opened, so it is the read after the publish that
    // waits rather than the one that opened the editor.
    deferredReads = 1;
    await click('[data-recipe-save-package]');
    await vi.waitFor(async () => { await settle(); expect(document.querySelectorAll('[data-recipe-hook-consent]')).toHaveLength(1); });
    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    await vi.waitFor(async () => { await settle(); expect(releaseRead !== null).toBe(true); });

    // Typed while the server is being asked what it stored.
    await typeBody('The body that gets published, plus this.\n');
    await act(async () => { releaseRead?.(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    await settle();

    expect(releaseRead !== null, 'the read was held open and then answered once').toBe(true);
    expect(saveCalls, 'and no extra write while it was open').toHaveLength(0);
    expect(installCalls, 'nor an extra install').toHaveLength(1);
    /*
      What was published is the body as it stood at the press. The words typed
      after it were never sent, so the read must not treat them as published.
    */
    const sentBody = (previewCalls[0] as { files?: Record<string, string> } | undefined)?.files?.['main.md'];
    expect(sentBody).toBe('The body that gets published.\n');
  });

  it('treats a published package the server will not name as an unread save', async () => {
    const hooked = installHooks();
    refuseSaveForConsent = true;
    previewFiles = [['recipe.toml', HOOKED_MANIFEST], ['scripts/guard.mjs', HOOKED_BODY]];
    nextPreview = hookedPreview(true);
    await render(hooked.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author]')).toBe(1); });
    // Armed here so it is the read after the publish that answers "no such
    // package" — a failed read, not a successful reconciliation — rather than
    // the read that opened the editor.
    missingReads = 1;
    await typeBody('Published, then the package could not be read.\n');
    await click('[data-recipe-save-package]');
    await vi.waitFor(async () => { await settle(); expect(document.querySelectorAll('[data-recipe-hook-consent]')).toHaveLength(1); });
    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    await vi.waitFor(async () => { await settle(); expect(installCalls).toHaveLength(1); });

    // It is offered the same read again, and Save stays out of reach until that
    // read succeeds — the stale revision is exactly what makes it unsafe.
    expect(count('[data-recipe-author-readback]'), 'an absent read is an unread save').toBe(1);
    const save = container.querySelector('[data-recipe-save-package]') as HTMLButtonElement;
    expect(save.disabled, 'saving again would reuse the revision the publish replaced').toBe(true);
    await click('[data-recipe-reload-saved]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author-readback]')).toBe(0); });
    expect(installCalls, 'the retry only reads').toHaveLength(1);
    expect(saveCalls, 'and never writes again').toHaveLength(0);
  });

  it('offers the retry again after a second read-back failure', async () => {
    const hooked = installHooks();
    refuseSaveForConsent = true;
    previewFiles = [['recipe.toml', HOOKED_MANIFEST], ['scripts/guard.mjs', HOOKED_BODY]];
    nextPreview = hookedPreview(true);
    await render(hooked.summary.installation_id);
    await click('[data-recipe-open-package]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author]')).toBe(1); });
    // The read after the publish fails, and so does the retry. The button has to
    // come back, or the only way out of an unread save is a page reload.
    readFailures.push(true, true);
    await typeBody('Published, read failed, retry failed too.\n');
    await click('[data-recipe-save-package]');
    await vi.waitFor(async () => { await settle(); expect(document.querySelectorAll('[data-recipe-hook-consent]')).toHaveLength(1); });
    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author-readback]')).toBe(1); });

    await click('[data-recipe-reload-saved]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author-readback]')).toBe(1); });
    const retry = container.querySelector('[data-recipe-reload-saved]') as HTMLButtonElement;
    expect(retry.disabled, 'a finished request leaves the retry usable again').toBe(false);
    await click('[data-recipe-reload-saved]');
    await vi.waitFor(async () => { await settle(); expect(count('[data-recipe-author-readback]')).toBe(0); });
    expect(installCalls, 'however many reads it took, it published once').toHaveLength(1);
  });

  it.each(['plain', 'consent'] as const)('keeps a visible merged draft and saves it against the accepted revision (%s)', async (route) => {
    const manifest = HOOKED_MANIFEST.replace('system = { file = "main.md" }',
      'system = { file = "main.md" }\nsteering = { file = "keep.md" }');
    const installed = installHooks(manifest);
    installed.files['keep.md'] = 'Untouched at the press.\n';
    installed.files['other.md'] = 'An unreferenced file.\n';
    await render(installed.summary.installation_id);
    await click('[data-recipe-open-package]');
    await click('[data-recipe-author-tab="source"]');
    await typeFile('main.md', 'Press snapshot.\n');
    const sent = { ...installed.files, 'main.md': 'Press snapshot.\n' };
    acceptedFiles = { ...sent, 'keep.md': 'Accepted untouched content.\n', 'other.md': 'Accepted unreferenced content.\n' };
    deferredSave = true;
    refuseSaveForConsent = route === 'consent';
    nextPreview = hookedPreview(true);
    deferredPreview = route === 'consent';
    deferredInstall = route === 'consent';
    deferredReads = route === 'consent' ? 1 : 0;
    await click('[data-recipe-save-package]');
    await typeFile('main.md', 'Typed while save was open.\n');

    if (route === 'consent') {
      await release(releaseSave);
      expect((previewCalls[0] as SaveInput).files).toEqual(sent);
      await typeFile('main.md', 'Typed while preview was open.\n');
      await release(releasePreview);
      await click('[role="alertdialog"] [data-confirm-action="confirm"]');
      await typeFile('main.md', 'Typed while install was open.\n');
      await release(releaseInstall);
      await typeFile('main.md', 'Typed while read was open.\n');
    }
    const currentManifest = manifest.replace('steering = { file = "keep.md" }',
      'steering = [{ file = "keep.md" }, { file = "added.md" }]');
    await typeManifest(currentManifest);
    await typeFile('added.md', 'Added after the press.\n');
    const currentBody = route === 'consent' ? 'Typed while read was open.\n' : 'Typed while save was open.\n';
    await release(route === 'consent' ? releaseRead : releaseSave);

    const accepted = packages.get(installed.summary.installation_id)!;
    expect(accepted.files).toEqual(acceptedFiles);
    expect(saveAttempts[0]?.files).toEqual(sent);
    expect(count('[data-recipe-author]')).toBe(1);
    expect(lastReportedDirty()).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="main.md"]')?.value).toBe(currentBody);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="keep.md"]')?.value).toBe('Accepted untouched content.\n');
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="added.md"]')?.value).toBe('Added after the press.\n');
    expect(EditorView.findFromDOM(container.querySelector('.cm-editor')!)?.state.doc.toString()).toBe(currentManifest);
    expect((container.querySelector('[data-recipe-save-package]') as HTMLButtonElement).disabled).toBe(false);

    const merged = { ...accepted.files, 'recipe.toml': currentManifest, 'main.md': currentBody, 'added.md': 'Added after the press.\n' };
    acceptedFiles = null;
    refuseSaveForConsent = false;
    await click('[data-recipe-save-package]');
    expect(saveAttempts[1]).toEqual({ installation_id: installed.summary.installation_id, expected_revision: accepted.summary.revision, files: merged });
    expect(packages.get(installed.summary.installation_id)?.files).toEqual(merged);
    expect(count('[data-recipe-open-studio]')).toBe(1);
    expect(lastReportedDirty()).toBe(false);
  });

  it.each(['undefined', 'failure'] as const)('retries an unread publish with GET and the original press baseline (%s)', async (outcome) => {
    const installed = installHooks(HOOKED_MANIFEST.replace('system = { file = "main.md" }',
      'system = { file = "main.md" }\nsteering = { file = "keep.md" }'));
    installed.files['keep.md'] = 'Original steering bytes.\n';
    await render(installed.summary.installation_id);
    await click('[data-recipe-open-package]');
    await click('[data-recipe-author-tab="source"]');
    await typeFile('main.md', 'Published press bytes.\n');
    refuseSaveForConsent = true;
    nextPreview = hookedPreview(true);
    if (outcome === 'undefined') missingReads = 1;
    else readFailures.push(true);
    await click('[data-recipe-save-package]');
    await typeFile('main.md', 'Typed while consent was open.\n');
    await typeFile('keep.md', 'Typed before the failed read and kept through retry.\n');
    await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    expect(count('[data-recipe-author-readback]')).toBe(1);
    const accepted = packages.get(installed.summary.installation_id)!;
    expect(accepted.files['main.md']).toBe('Published press bytes.\n');
    expect(accepted.files['keep.md']).toBe('Original steering bytes.\n');
    await typeFile('main.md', 'Typed after the unsuccessful read.\n');
    const requestsBeforeRetry = { reads: readCalls.length, saves: saveAttempts.length, previews: previewCalls.length, installs: installCalls.length };
    await click('[data-recipe-reload-saved]');
    expect({ reads: readCalls.length, saves: saveAttempts.length, previews: previewCalls.length, installs: installCalls.length })
      .toEqual({ ...requestsBeforeRetry, reads: requestsBeforeRetry.reads + 1 });
    expect(count('[data-recipe-author]')).toBe(1);
    expect(lastReportedDirty()).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="main.md"]')?.value).toBe('Typed after the unsuccessful read.\n');
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="keep.md"]')?.value).toBe('Typed before the failed read and kept through retry.\n');
    expect((container.querySelector('[data-recipe-save-package]') as HTMLButtonElement).disabled).toBe(false);
    refuseSaveForConsent = false;
    await click('[data-recipe-save-package]');
    expect(saveAttempts[1]?.expected_revision).toBe(accepted.summary.revision);
    expect(saveCalls[0]?.files).toEqual({
      ...accepted.files, 'main.md': 'Typed after the unsuccessful read.\n', 'keep.md': 'Typed before the failed read and kept through retry.\n',
    });
    expect(count('[data-recipe-open-studio]')).toBe(1);
  });

  it.each(['plain', 'consent'] as const)('returns to the model row when the press leaves no newer draft (%s)', async (route) => {
    const installed = installHooks();
    await render(installed.summary.installation_id);
    await click('[data-recipe-open-package]');
    await typeBody('The complete edit.\n');
    refuseSaveForConsent = route === 'consent';
    nextPreview = hookedPreview(true);
    await click('[data-recipe-save-package]');
    if (route === 'consent') await click('[role="alertdialog"] [data-confirm-action="confirm"]');
    expect(packages.get(installed.summary.installation_id)?.files).toEqual({ ...installed.files, 'main.md': 'The complete edit.\n' });
    expect(count('[data-recipe-open-studio]')).toBe(1);
    expect(lastReportedDirty()).toBe(false);
  });
});

it('merges changed, added and deleted paths while keeping accepted untouched paths authoritative', () => {
  const sent = { 'keep.md': 'sent', 'edit.md': 'sent', 'delete.md': 'sent', 'server-delete.md': 'sent' };
  const accepted = { 'keep.md': 'accepted', 'edit.md': 'accepted', 'delete.md': 'accepted', 'server-add.md': 'accepted' };
  const current = { 'keep.md': 'sent', 'edit.md': 'new words', 'added.md': 'new file', 'server-delete.md': 'sent' };
  expect(mergePublished(accepted, sent, current)).toEqual({
    'keep.md': 'accepted', 'edit.md': 'new words', 'added.md': 'new file', 'server-add.md': 'accepted',
  });
  expect(sent).toEqual({ 'keep.md': 'sent', 'edit.md': 'sent', 'delete.md': 'sent', 'server-delete.md': 'sent' });
  expect(mergePublished({ 'added.md': 'server collision' }, {}, { 'added.md': '' })).toEqual({ 'added.md': '' });
  expect(mergePublished({}, { 'edited.md': 'sent' }, { 'edited.md': 'new words' })).toEqual({ 'edited.md': 'new words' });
});
