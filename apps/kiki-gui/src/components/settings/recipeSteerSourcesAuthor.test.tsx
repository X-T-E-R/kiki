// @vitest-environment jsdom
/**
 * Per-source steering inside a Recipe package, as an author drives it.
 *
 * This file exists because the first version of this row got the one thing
 * wrong that matters: it always opened an empty inline box, so a single
 * keystroke replaced a package's stored file reference or its segment list with
 * plain text. The author's shape is their own writing, and losing it silently
 * is the failure this asserts against.
 *
 * The package is an installed, editable one, so this is the real author
 * component with a real manifest and real package files behind it — no live
 * server, and nothing is installed or forked.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { modelSteeringSourceIds, modelSteeringSourcesSchema, type RecipeDetail } from '@kiki/protocol';
import { z } from 'zod';

import { I18nProvider } from '../../i18n';
import { parseRecipeManifest, readDeclaration, referencedFiles } from '../../lib/recipeFiles';
import { RecipeAuthorWorkbench } from './RecipeAuthorWorkbench';

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

const INSTALLATION = 'inst-clear-work';

/**
 * A package that declares all three prose shapes across its sources, which is
 * the only way a test can show that editing one of them leaves the others
 * alone: a file reference, a mixed segment list, and plain inline text.
 */
const MANIFEST = `schema_version = 1
id = "clear-work"
name = "Clear work"
version = "1.2.0"

[prompts]
# The author's own note; a semantic serializer drops this.
system = { text = "Work clearly." }

[prompts.steering_sources.thread]
mode = "custom"
custom = { steering = { file = "reminders/thread.md" }, steering_on_turn = false, steering_interval_steps = 3 }

[prompts.steering_sources.task]
mode = "custom"
custom = { steering = [{ text = "Check the task list before answering." }, { file = "reminders/task.md" }] }

[prompts.steering_sources.cron]
mode = "custom"
custom = { steering = { text = "Say when the run starts and finishes." } }

[prompts.steering_sources.hook]
mode = "inherit"

[prompts.steering_sources.room]
mode = "off"
`;

const PACKAGE: RecipeDetail = {
  summary: {
    installation_id: INSTALLATION,
    manifest_id: 'clear-work',
    name: 'Clear work',
    version: '1.2.0',
    revision: 'sha256:a91d',
    source: { locator: `installation:${INSTALLATION}` },
    update_mode: 'pinned',
    health: 'ready',
  },
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
  files: {
    'recipe.toml': MANIFEST,
    'reminders/thread.md': 'Another thread is waiting on this one.\n',
    'reminders/task.md': 'The background task is still running.\n',
  },
  history: [],
  editable: true,
  used_by: [],
};

/**
 * The package files a source points at.
 *
 * Spelled through `String.raw` so the newline is visible in the source as the
 * escape it is, rather than being an actual line break inside a literal.
 */
const FILE_TASK = String.raw`The background task is still running.
`;
const FILE_THREAD = String.raw`Another thread is waiting on this one.
`;

/** Bodies an author types, named so the assertions read as prose. */
const NEW_THREAD = `Thread words rewritten.\n`;
const NEW_TASK = `The background task finished.\n`;
const NEW_CRON = `Cron words rewritten.\n`;

/**
 * The manifest's source table, parsed with the very schema the server parses a
 * Recipe's sources with.
 *
 * The body schema it is parameterised by is the one part that has to be
 * restated: the server's own union lives in agent-core, which the GUI must not
 * import. `zod` itself is a dependency of `@kiki/protocol`, not of this app, so
 * the check is done through a schema object that protocol hands back rather
 * than by importing zod here — which also means this cannot drift from the
 * mode/custom nesting the server requires.
 */
const RECIPE_SOURCE = z.object({ text: z.string() }).strict();
const RECIPE_SLOT = z.union([
  z.union([RECIPE_SOURCE, z.object({ file: z.string().min(1) }).strict()]),
  z.array(z.union([RECIPE_SOURCE, z.object({ file: z.string().min(1) }).strict()])).min(1).max(64),
  z.literal('off'),
]);
const RECIPE_STEERING_SOURCES = modelSteeringSourcesSchema(RECIPE_SLOT);
const saveCalls: { installation_id: string; expected_revision: string; files: Record<string, string> }[] = [];

vi.mock('../../state/connection', () => ({
  useConnection: () => ({
    client: {
      saveLocalRecipe: (input: { installation_id: string; expected_revision: string; files: Record<string, string> }) => {
        saveCalls.push(input);
        return Promise.resolve({ ...PACKAGE, files: input.files, summary: { ...PACKAGE.summary, revision: `sha256:next-${saveCalls.length}` } });
      },
      listRecipes: () => Promise.resolve([PACKAGE.summary]),
      getRecipe: () => Promise.resolve(PACKAGE),
      previewRecipe: () => Promise.resolve({ preview_id: 'p', summary: PACKAGE.summary, resolved: PACKAGE.resolved, diagnostics: [] }),
      installRecipe: () => Promise.resolve(PACKAGE.summary),
      exportRecipe: () => Promise.resolve({ name: 'x', revision: 'r', files: {} }),
    },
    config: { url: 'https://server.example.test/', token: 'test-token' },
  }),
}));

let container: HTMLElement;
let root: Root;

async function renderAuthor(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <I18nProvider>
            <RecipeAuthorWorkbench detail={PACKAGE} onApplied={() => {}} onBack={() => {}} />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  // The per-source list is collapsed, exactly as it is for a person arriving.
  await click('[data-recipe-steer-sources] button');
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

async function typeIn(node: Element, text: string): Promise<void> {
  await act(async () => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, text);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

beforeEach(() => {
  saveCalls.length = 0;
});

afterEach(() => {
  if (root !== undefined) act(() => { root.unmount(); });
  container?.remove();
});

describe('a Recipe source keeps the shape its author chose', () => {
  it('opens a stored file source on its real file, not an empty inline box', async () => {
    await renderAuthor();

    const shape = container.querySelector<HTMLElement>('[data-recipe-steer-shape-kind="thread"]');
    expect(shape?.textContent, 'the row says the words come from a package file').toContain('package file');
    // The file's own content is what the author edits, with the reference above it.
    const body = container.querySelector<HTMLTextAreaElement>('[data-recipe-steer-file-body="thread"]');
    expect(body, 'a file source must offer the file body').not.toBeNull();
    expect(body!.value).toBe('Another thread is waiting on this one.\n');
    const reference = container.querySelector<HTMLInputElement>('[data-recipe-steer-file="thread"]');
    expect(reference!.value).toBe('reminders/thread.md');
    // And no inline box that could replace it on the first keystroke.
    expect(count('[data-recipe-steer-prose="thread"]')).toBe(0);
  });

  it('writes the file buffer when the body is typed into, leaving the reference alone', async () => {
    await renderAuthor();
    await typeIn(container.querySelector('[data-recipe-steer-file-body="thread"]')!, 'Another thread changed its mind.\n');
    await click('[data-recipe-save-package]');

    const saved = saveCalls[0]!;
    expect(saved.files['reminders/thread.md']).toBe('Another thread changed its mind.\n');
    const declared = readDeclaration(parseRecipeManifest(saved.files['recipe.toml']!)).prompts?.steering_sources;
    expect(declared?.['thread']?.steering).toEqual({ kind: 'file', file: 'reminders/thread.md' });
    // Cadence declared alongside the prose survives the same save.
    expect(declared?.['thread']?.steering_on_turn).toBe(false);
    expect(declared?.['thread']?.steering_interval_steps).toBe(3);
    // The file is still a referenced file, so a rename can still follow it.
    expect(referencedFiles(readDeclaration(parseRecipeManifest(saved.files['recipe.toml']!)))).toContain('reminders/thread.md');
  });

  it('leaves the manifest byte-identical when only a file body is typed into', async () => {
    await renderAuthor();
    // A file body is Markdown this package owns. Writing it must not drag the
    // manifest through the semantic serializer: that would reorder it, drop
    // the author's comment and clear the reformat notice for an edit that
    // never touched a single manifest byte.
    // Proved against the fixture itself, so the assertion below is about what
    // the page did rather than about what this file happens to contain.
    expect(MANIFEST, 'the fixture carries a comment the serializer would drop').toContain('# The author');

    await typeIn(container.querySelector('[data-recipe-steer-file-body="thread"]')!, NEW_THREAD);
    await click('[data-recipe-save-package]');

    expect(saveCalls[0]!.files['reminders/thread.md']).toBe(NEW_THREAD);
    expect(saveCalls[0]!.files['recipe.toml'], 'the manifest must be untouched').toBe(MANIFEST);
    // And nothing else in the package moved either.
    expect(saveCalls[0]!.files['reminders/task.md']).toBe(FILE_TASK);
    expect(count('[data-recipe-reformat-notice]'), 'no formatting change to announce').toBe(0);
  });

  it('keeps a formatting notice raised by a declaration change after a file body is edited', async () => {
    await renderAuthor();
    // The fixture's comment is what makes the manifest re-serialize differently,
    // so a declaration change raises the notice about formatting.
    expect(count('[data-recipe-reformat-notice]'), 'nothing has been rewritten yet').toBe(0);
    await click('[data-recipe-steer-source="cron"] [data-recipe-steer-mode="inherit"]');
    expect(count('[data-recipe-reformat-notice]'), 'changing a mode rewrites the manifest').toBe(1);

    // Now edit a Markdown file. That touches no manifest byte, so the notice
    // about the manifest sitting rewritten is still true and must stay up:
    // clearing it here would let a person save a package whose manifest lost a
    // comment without ever being told.
    await typeIn(container.querySelector('[data-recipe-steer-file-body="thread"]')!, NEW_THREAD);
    expect(count('[data-recipe-reformat-notice]'), 'a file edit must not silence a manifest notice').toBe(1);

    await click('[data-recipe-save-package]');
    expect(saveCalls[0]!.files['reminders/thread.md']).toBe(NEW_THREAD);
    // The draft is right: the mode change the author made is in the manifest,
    // and the comment they wrote is gone because they chose to change a
    // declaration, not because a Markdown file was touched.
    const written = saveCalls[0]!.files['recipe.toml']!;
    expect(readDeclaration(parseRecipeManifest(written)).prompts?.steering_sources?.['cron']?.mode).toBe('inherit');
    expect(readDeclaration(parseRecipeManifest(written)).prompts?.steering_sources?.['cron']?.steering,
      'and the draft the source had is still its own').toEqual({ kind: 'inline', text: 'Say when the run starts and finishes.' });
  });

  it('leaves the manifest byte-identical when a file segment body is typed into', async () => {
    await renderAuthor();
    const fileSegment = container.querySelectorAll<HTMLElement>('[data-recipe-steer-segments="task"] [data-recipe-steer-segment]')[1]!;
    await typeIn(fileSegment.querySelector('textarea')!, NEW_TASK);
    await click('[data-recipe-save-package]');

    expect(saveCalls[0]!.files['reminders/task.md']).toBe(NEW_TASK);
    expect(saveCalls[0]!.files['recipe.toml'], 'the array did not need rewriting').toBe(MANIFEST);
    expect(count('[data-recipe-reformat-notice]')).toBe(0);
  });

  it('writes a manifest the real schema accepts, and reads the same words back', async () => {
    await renderAuthor();
    await typeIn(container.querySelector('[data-recipe-prose-cron], [data-recipe-steer-prose="cron"]')!, NEW_CRON);
    await click('[data-recipe-steer-source="room"] [data-recipe-steer-mode="custom"]');
    await click('[data-recipe-save-package]');

    const written = saveCalls[0]!.files['recipe.toml']!;
    // Parsed with the schema the server itself uses, straight out of
    // `@kiki/protocol` — not a copy of it, so it cannot drift from the contract
    // it is checking. This reads the manifest's own tables, because the schema
    // describes the file: the editor's flat view is an internal convenience and
    // is deliberately not what the package ships.
    const raw = parseRecipeManifest(written);
    const rawSources = (raw['prompts'] as Record<string, unknown> | undefined)?.['steering_sources'];
    const accepted = RECIPE_STEERING_SOURCES.safeParse(rawSources);
    expect(accepted.success, accepted.success ? '' : JSON.stringify(accepted.error.issues)).toBe(true);

    // The same thing the server's parser does after it accepts the manifest:
    // walk the fixed source order and keep each entry's mode and its private
    // draft, with the prose resolved to text. This is the step a person would
    // otherwise have to take on faith, and it is where a flat declaration would
    // have read back as a source with no words at all.
    const resolved: Record<string, { mode: string; custom?: { steering?: unknown; steering_interval_steps?: number } }> = {};
    for (const source of modelSteeringSourceIds) {
      const setting = (accepted.data as Record<string, { mode: string; custom?: { steering?: unknown; steering_interval_steps?: number } }> | undefined)?.[source];
      if (setting === undefined) continue;
      resolved[source] = {
        mode: setting.mode,
        ...(setting.custom === undefined ? {} : {
          custom: {
            ...(setting.custom.steering === undefined ? {} : { steering: setting.custom.steering }),
            ...(setting.custom.steering_interval_steps === undefined ? {} : { steering_interval_steps: setting.custom.steering_interval_steps }),
          },
        }),
      };
    }
    expect(resolved['thread'], 'the file reference survives the round trip').toEqual({
      mode: 'custom',
      custom: { steering: { file: 'reminders/thread.md' }, steering_interval_steps: 3 },
    });
    expect(resolved['cron']?.custom?.steering, 'the words this person typed reach the model').toEqual({ text: NEW_CRON });
    expect(resolved['task']?.custom?.steering, 'a mixed list stays a list').toEqual([
      { text: 'Check the task list before answering.' },
      { file: 'reminders/task.md' },
    ]);
    expect(resolved['hook'], 'a source that follows the user carries no draft of its own').toEqual({ mode: 'inherit' });

    const declared = readDeclaration(raw).prompts?.steering_sources;
    // Round trip: what the page wrote is what it reads back, with the cadence
    // the author declared and the prose they typed.
    expect(declared?.['thread']).toEqual({
      mode: 'custom',
      steering: { kind: 'file', file: 'reminders/thread.md' },
      steering_on_turn: false,
      steering_interval_steps: 3,
    });
    expect(declared?.['cron']?.steering).toEqual({ kind: 'inline', text: NEW_CRON });
    expect(declared?.['task']?.steering).toEqual({
      kind: 'segments',
      parts: [{ kind: 'inline', text: 'Check the task list before answering.' }, { kind: 'file', file: 'reminders/task.md' }],
    });
  });

  it("keeps the words of a source that is switched off, and offers the way back", async () => {
    await renderAuthor();
    await click('[data-recipe-steer-source="cron"] [data-recipe-steer-mode="off"]');
    await click('[data-recipe-save-package]');

    // `off` hides the row but keeps the draft, exactly as the engine does: the
    // engine's own test asserts an off source still resolves its stored body.
    expect(readDeclaration(parseRecipeManifest(saveCalls[0]!.files['recipe.toml']!)).prompts?.steering_sources?.['cron'])
      .toEqual({ mode: 'off', steering: { kind: 'inline', text: 'Say when the run starts and finishes.' } });

    // A custom source whose prose is itself off is a different fact, shown as
    // such rather than as an empty inline box.
    await click('[data-recipe-steer-source="task"] [data-recipe-steer-mode="custom"]');
    await click('[data-recipe-steer-source="task"] [data-recipe-steer-shape] button');
    await act(async () => {
      const option = document.querySelector<HTMLElement>('[data-option-value="off"]');
      assert.ok(option !== null, 'the shape picker must offer off');
      option.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(count('[data-recipe-steer-prose-off="task"]'), 'declared off, not an empty editor').toBe(1);
    expect(count('[data-recipe-steer-segments="task"]')).toBe(0);
    await click('[data-recipe-steer-restore="task"]');
    expect(count('[data-recipe-steer-prose="task"]'), 'and the way back writes prose again').toBe(1);
  });

  it('edits one segment of a mixed list without flattening the rest', async () => {
    await renderAuthor();

    const segments = [...container.querySelectorAll<HTMLElement>('[data-recipe-steer-segments="task"] [data-recipe-steer-segment]')];
    expect(segments, 'a segment array is shown segment by segment').toHaveLength(2);
    expect(segments[0]!.dataset['recipeSegmentKind']).toBe('inline');
    expect(segments[1]!.dataset['recipeSegmentKind']).toBe('file');
    expect((segments[0]!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Check the task list before answering.');
    expect((segments[1]!.querySelector('textarea') as HTMLTextAreaElement).value).toBe(FILE_TASK);

    // Edit the inline segment only.
    await typeIn(segments[0]!.querySelector('textarea')!, 'Check the task list before answering, out loud.');
    await click('[data-recipe-save-package]');

    const declared = readDeclaration(parseRecipeManifest(saveCalls[0]!.files['recipe.toml']!)).prompts?.steering_sources;
    expect(declared?.['task']?.steering).toEqual({
      kind: 'segments',
      parts: [
        { kind: 'inline', text: 'Check the task list before answering, out loud.' },
        { kind: 'file', file: 'reminders/task.md' },
      ],
    });
    // The file segment's own buffer is untouched by editing its neighbour.
    expect(saveCalls[0]!.files['reminders/task.md']).toBe('The background task is still running.\n');
  });

  it('edits a file segment by writing that file, keeping the array a segment list', async () => {
    await renderAuthor();
    const fileSegment = container.querySelectorAll<HTMLElement>('[data-recipe-steer-segments="task"] [data-recipe-steer-segment]')[1]!;
    await typeIn(fileSegment.querySelector('textarea')!, 'The background task finished.\n');
    await click('[data-recipe-save-package]');

    expect(saveCalls[0]!.files['reminders/task.md']).toBe('The background task finished.\n');
    const declared = readDeclaration(parseRecipeManifest(saveCalls[0]!.files['recipe.toml']!)).prompts?.steering_sources;
    expect(declared?.['task']?.steering).toEqual({
      kind: 'segments',
      parts: [
        { kind: 'inline', text: 'Check the task list before answering.' },
        { kind: 'file', file: 'reminders/task.md' },
      ],
    });
  });

  it('edits inline prose in place for a source that stores it inline', async () => {
    await renderAuthor();
    const prose = container.querySelector<HTMLTextAreaElement>('[data-recipe-steer-prose="cron"]');
    expect(prose!.value).toBe('Say when the run starts and finishes.');
    await typeIn(prose!, 'Say when the run starts, finishes, and stalls.');
    await click('[data-recipe-save-package]');

    const declared = readDeclaration(parseRecipeManifest(saveCalls[0]!.files['recipe.toml']!)).prompts?.steering_sources;
    expect(declared?.['cron']?.steering).toEqual({ kind: 'inline', text: 'Say when the run starts, finishes, and stalls.' });
  });
});

describe('a Recipe source keeps its private draft across a mode round trip', () => {
  it('holds the stored prose while off and inherit, and restores it on custom', async () => {
    await renderAuthor();

    // off and inherit show the choice, and the author's own words are still there.
    await click('[data-recipe-steer-source="cron"] [data-recipe-steer-mode="off"]');
    expect(count('[data-recipe-steer-editor="cron"]'), 'off shows no editor').toBe(0);
    await click('[data-recipe-steer-source="cron"] [data-recipe-steer-mode="inherit"]');
    expect(count('[data-recipe-steer-editor="cron"]'), 'inherit shows no editor').toBe(0);
    await click('[data-recipe-steer-source="cron"] [data-recipe-steer-mode="custom"]');
    expect((container.querySelector('[data-recipe-steer-prose="cron"]') as HTMLTextAreaElement).value,
      'the words the author wrote are still here').toBe('Say when the run starts and finishes.');

    // The words survive a mode change in both directions, which is the whole
    // point: the draft is private to the source, not to the current mode.
    await click('[data-recipe-steer-source="cron"] [data-recipe-steer-mode="inherit"]');
    await click('[data-recipe-steer-source="cron"] [data-recipe-steer-mode="custom"]');
    expect((container.querySelector('[data-recipe-steer-prose="cron"]') as HTMLTextAreaElement).value,
      'a second round trip still has the words').toBe('Say when the run starts and finishes.');
  });

  it('keeps a file reference while the source is off, and writes only the mode', async () => {
    await renderAuthor();
    await click('[data-recipe-steer-source="thread"] [data-recipe-steer-mode="off"]');
    await click('[data-recipe-save-package]');

    const declared = readDeclaration(parseRecipeManifest(saveCalls[0]!.files['recipe.toml']!)).prompts?.steering_sources;
    expect(declared?.['thread']).toEqual({
      mode: 'off',
      steering: { kind: 'file', file: 'reminders/thread.md' },
      steering_on_turn: false,
      steering_interval_steps: 3,
    });
    expect(saveCalls[0]!.files['reminders/thread.md'], 'the file the source points at is not rewritten').toBe('Another thread is waiting on this one.\n');
  });
});

describe('the shape switch is an explicit choice, not a side effect of typing', () => {
  it('offers every shape from any shape, and only writes on the choice', async () => {
    await renderAuthor();
    const trigger = container.querySelector<HTMLElement>('[data-recipe-steer-source="thread"] [data-recipe-steer-shape] button');
    expect(trigger, 'the shape is reachable from a file source').not.toBeNull();
    expect(trigger!.textContent, 'it names the shape the source actually has').toContain('package file');

    // Choosing inline is the only way a file source becomes inline.
    await act(async () => {
      trigger!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The picker opens in a portal, so it is read off the document rather than
    // the component's own subtree.
    const menu = document.querySelector<HTMLElement>('[data-option-value="inline"]');
    assert.ok(menu !== null, 'the picker must offer inline');
    await act(async () => { (menu as HTMLElement).click(); await new Promise((resolve) => setTimeout(resolve, 10)); });

    expect(container.querySelector<HTMLTextAreaElement>('[data-recipe-steer-prose="thread"]'), 'now it is inline').not.toBeNull();
    await click('[data-recipe-save-package]');
    const declared = readDeclaration(parseRecipeManifest(saveCalls[0]!.files['recipe.toml']!)).prompts?.steering_sources;
    expect(declared?.['thread']?.steering).toEqual({ kind: 'inline', text: '' });
    // The old reference is gone from the manifest, but its file is still shipped.
    expect(referencedFiles(readDeclaration(parseRecipeManifest(saveCalls[0]!.files['recipe.toml']!)))).not.toContain('reminders/thread.md');
    expect(saveCalls[0]!.files['reminders/thread.md'], 'the package still carries the file it had').toBe('Another thread is waiting on this one.\n');
  });
});

describe('the package is still one save and one revision', () => {
  it('sends every source edit in a single package save at the read revision', async () => {
    await renderAuthor();
    await typeIn(container.querySelector('[data-recipe-steer-file-body="thread"]')!, 'Thread words rewritten.\n');
    await click('[data-recipe-steer-source="task"] [data-recipe-steer-mode="inherit"]');
    await typeIn(container.querySelector('[data-recipe-steer-prose="cron"]')!, 'Cron words rewritten.\n');
    await click('[data-recipe-save-package]');

    expect(saveCalls, 'three edits are one package save, not three').toHaveLength(1);
    expect(saveCalls[0]!.expected_revision).toBe('sha256:a91d');
    expect(saveCalls[0]!.installation_id).toBe(INSTALLATION);
    const declared = readDeclaration(parseRecipeManifest(saveCalls[0]!.files['recipe.toml']!)).prompts?.steering_sources;
    expect(declared?.['thread']?.steering).toEqual({ kind: 'file', file: 'reminders/thread.md' });
    expect(declared?.['task']?.mode).toBe('inherit');
    // A source switched to inherit keeps its own words rather than dropping them.
    expect(declared?.['task']?.steering).toEqual({
      kind: 'segments',
      parts: [{ kind: 'inline', text: 'Check the task list before answering.' }, { kind: 'file', file: 'reminders/task.md' }],
    });
    expect(declared?.['cron']?.steering).toEqual({ kind: 'inline', text: 'Cron words rewritten.\n' });
  });
});
