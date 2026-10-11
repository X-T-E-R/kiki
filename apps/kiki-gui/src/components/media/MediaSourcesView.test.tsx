// @vitest-environment jsdom

/**
 * The media source list and its detail, against the host's real four methods.
 *
 * The contract being proved here is the one the change is about: ONE package
 * carries many sources, and every write is addressed by a single source's own
 * provider id. A test that mounted one source per package would pass a view
 * that silently configured whole packages, which is exactly the failure this
 * slice exists to remove — so the harness below seeds one package with three
 * sibling sources and asserts, after each write, which one moved.
 *
 * It is also where the two claims a screenshot cannot make are checked: a
 * stored secret is never rendered back, and a removed source keeps its
 * configuration while the tools stop offering it.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaManagedSource } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { MediaSourcesView } from './MediaSourcesView';

/** The one package every source below lives in. */
const PACKAGE = 'kiki-media';

interface Backend {
  sources: MediaManagedSource[];
  /** Every `updateSource` call, in order, so "which one moved" is checkable. */
  updates: { provider: string; values?: Record<string, unknown>; enabled?: boolean; removed?: boolean }[];
  adds: { id: string; protocol?: string; kinds?: readonly string[]; environment?: Record<string, string> }[];
  /** A `sourceSettings` read, by provider, so a per-row read is visible. */
  settingsReads: string[];
  /** The media package's stored settings, as the host holds them. */
  settings: Record<string, string | number | boolean>;
  /** Per-call delays and refusals, so a write can be slow or can fail. */
  delays: { update?: number; add?: number; defaults?: number };
  refusals: { update?: boolean; add?: boolean; defaults?: boolean };
}

const backend: Backend = { sources: [], updates: [], adds: [], settingsReads: [], settings: {}, delays: {}, refusals: {} };

function managed(id: string, label: string, over: Partial<MediaManagedSource> = {}): MediaManagedSource {
  return {
    provider: `${PACKAGE}/${id}`,
    sourceId: id,
    pluginId: PACKAGE,
    label,
    custom: false,
    enabled: true,
    removed: false,
    definitions: [{ schemaVersion: 1, id, kinds: ['image'], label, resumeVersion: 1 }],
    schema: {
      schemaVersion: 1,
      schema: {
        type: 'object',
        properties: {
          apiKey: { type: 'string', title: 'API key', secret: true },
          baseUrl: { type: 'string', title: 'Endpoint', default: 'https://api.example.test/v1' },
        },
        required: ['apiKey'],
      },
    },
    values: { baseUrl: 'https://api.example.test/v1' },
    secretsConfigured: [],
    missing: ['apiKey'],
    ...over,
  };
}

function seed(): void {
  backend.sources = [
    managed('alpha', 'Alpha Media', { secretsConfigured: ['apiKey'], missing: [] }),
    managed('beta', 'Beta Media'),
    managed('gamma', 'Gamma Media', { enabled: false }),
  ];
  backend.updates = [];
  backend.adds = [];
  backend.settingsReads = [];
  // Alpha holds the image default, and speech points at nothing: a modality
  // with no default is the case where a write that dropped the OTHER keys
  // would show up.
  backend.settings = { defaultImageProvider: `${PACKAGE}/alpha`, defaultTtsProvider: '' };
  backend.delays = {};
  backend.refusals = {};
}

const wait = async (ms: number) => { if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms)); };

function settle(source: MediaManagedSource, values: Record<string, unknown>, enabled?: boolean, removed?: boolean): MediaManagedSource {
  const next = { ...source, values: { ...source.values }, secretsConfigured: [...source.secretsConfigured] };
  for (const [key, value] of Object.entries(values)) {
    const property = source.schema.schema.properties[key];
    if (value === null) {
      delete (next.values as Record<string, unknown>)[key];
      next.secretsConfigured = next.secretsConfigured.filter((item) => item !== key);
    } else if (property?.secret === true) {
      // A secret is stored and reported, never echoed. An empty one is not a
      // removal, which is the whole reason a blank field is not sent.
      if (value !== '') next.secretsConfigured = [...new Set([...next.secretsConfigured, key])];
    } else {
      (next.values as Record<string, unknown>)[key] = value;
    }
  }
  if (enabled !== undefined) next.enabled = enabled;
  if (removed !== undefined) next.removed = removed;
  next.missing = (next.schema.schema.required ?? []).filter((key) => {
    const effective = (next.values as Record<string, unknown>)[key] ?? next.schema.schema.properties[key]?.default;
    return !effective && !next.secretsConfigured.includes(key);
  });
  return next;
}

const client = {
  klient: {
    global: {
      media: {
        managedSources: async () => structuredClone(backend.sources),
        sourceSettings: async ({ provider }: { provider: string }) => {
          backend.settingsReads.push(provider);
          const found = backend.sources.find((item) => item.provider === provider);
          if (found === undefined) throw new Error(`media source not found: ${provider}`);
          return structuredClone(found);
        },
        updateSource: async (input: { provider: string; values?: Record<string, unknown>; enabled?: boolean; removed?: boolean }) => {
          backend.updates.push(structuredClone(input));
          // A slow write is the ordinary case on a real server: the request is
          // in flight while the form is still on screen.
          await wait(backend.delays.update ?? 0);
          if (backend.refusals.update) throw new Error('the host refused this write');
          const index = backend.sources.findIndex((item) => item.provider === input.provider);
          if (index === -1) throw new Error(`media source not found: ${input.provider}`);
          const next = settle(backend.sources[index]!, input.values ?? {}, input.enabled, input.removed);
          backend.sources = backend.sources.map((item, at) => (at === index ? next : item));
          return structuredClone(next);
        },
        addScriptSource: async (input: { id: string; label: string; kinds: readonly ('image' | 'video' | 'tts')[]; command: string; args?: string[]; cwd?: string; protocol?: 'file' | 'json'; format?: string; mime?: string; environment?: Record<string, string> }) => {
          backend.adds.push(structuredClone(input));
          await wait(backend.delays.add ?? 0);
          if (backend.refusals.add) throw new Error('Script source id already exists');
          const created = managed(`script-${input.id}`, input.label, {
            provider: `${PACKAGE}/script-${input.id}`,
            sourceId: `script-${input.id}`,
            custom: true,
            schema: { schemaVersion: 1, schema: { type: 'object', properties: { environment: { type: 'string', title: 'Environment variables (JSON)', secret: true } } } },
            values: { command: input.command, args: JSON.stringify(input.args ?? []), cwd: input.cwd ?? '', protocol: input.protocol ?? 'file', format: input.format ?? '', mime: input.mime ?? '' },
            secretsConfigured: input.environment === undefined ? [] : ['environment'],
            missing: [],
          });
          backend.sources = [...backend.sources, created];
          return structuredClone(created);
        },
        sources: async () => [],
        setSources: async () => [],
      },
    },
    session: () => ({ agent: () => ({ media: { cancel: async () => ({}), resume: async () => ({}) } }) }),
  },
  // One installed, healthy package carrying all three sources. A missing or
  // erroring package would make every row broken, which is a different fact
  // from the ones under test.
  listPlugins: async () => ({
    plugins: [{ id: PACKAGE, displayName: 'Media', enabled: true, state: 'ok' as const, hasErrors: false, version: '0.2.0' }],
  }),
  // A GET is never slow and never refused in these cases: that is precisely
  // why reading values back instead of awaiting the write looked like proof
  // of success.
  getPluginSettings: async (pluginId: string) => (pluginId === PACKAGE
    ? { schema: { schema: { properties: {} } }, values: { ...backend.settings }, secretsConfigured: [] }
    : { schema: { schema: { properties: {} } }, values: {}, secretsConfigured: [] }),
  setPluginSettings: vi.fn(async (pluginId: string, values: Record<string, string | number | boolean | null>) => {
    await wait(backend.delays.defaults ?? 0);
    if (backend.refusals.defaults) throw new Error('the host refused this write');
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete backend.settings[key];
      else backend.settings[key] = value;
    }
    // The host's own echo of the whole settings document, not of the patch.
    return { schema: { schema: { properties: {} } }, values: { ...backend.settings }, secretsConfigured: [] };
  }),
  listProviders: async () => ({ items: [] }),
  meta: async () => ({ experimental_flags: {} }),
} as never;

vi.mock('../../state/connection', () => ({ useConnection: () => ({ client, scopeId: 'local' }) }));

// React needs to know this is an act-driven test before the first render, or
// every flush warns and the queue settles a frame late.
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

let root: Root;
let container: HTMLDivElement;
let query: QueryClient;
const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
// The dialog is portaled to `<body>`, so the whole document is what a reader
// sees — not only the subtree this root owns.
const q = (selector: string) => document.querySelector(selector);
const qa = (selector: string) => [...document.querySelectorAll(selector)];
const row = (provider: string) => q(`[data-media-source="${provider}"]`);
/** Press a source row, the way a reader does: the button inside the row. */
const openSource = async (provider: string) => {
  const node = row(provider)?.querySelector('button');
  if (node === null || node === undefined) throw new Error(`no row button for ${provider}`);
  await act(async () => { (node as HTMLElement).click(); });
  await flush();
};
/**
 * Press a default switch and let its write settle.
 *
 * The click alone is not enough: the write is now awaited and the badge only
 * moves when the host has answered, so a test that asserted immediately after
 * the click would be asserting against the click rather than the save.
 */
const pressDefault = async (kind: string) => {
  const node = q(`[data-media-default="${kind}"]`);
  if (node === null) throw new Error(`no default switch for ${kind}`);
  await act(async () => { (node as HTMLElement).click(); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
};
const click = async (selector: string) => {
  const node = q(selector);
  if (node === null) throw new Error(`no element for ${selector}`);
  await act(async () => { (node as HTMLElement).click(); });
  await flush();
};
/**
 * Type into a field the way a reader does.
 *
 * The native setter is used rather than `node.value = …` because React tracks
 * the previous value on the DOM node, and a plain assignment is swallowed by
 * that check. A textarea needs its own prototype's setter, and both dispatch
 * the same `input` event the real control listens for.
 */
const fill = async (selector: string, value: string) => {
  const node = q(selector);
  if (node === null) throw new Error(`no field for ${selector}`);
  const element = node as HTMLInputElement;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
};

describe('media sources on a unified package', () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    seed();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { act(() => { root.unmount(); }); container.remove(); actEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });

  const mount = async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={query}>
            <I18nProvider>
              <MediaSourcesView onBack={() => {}} />
            </I18nProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();
  };

  it('draws one row per source, not one per package', async () => {
    await mount();
    const rows = qa('[data-media-source]');
    expect(rows).toHaveLength(3);
    // Three rows, one package: the whole difference this slice makes.
    expect(new Set(rows.map((node) => node.getAttribute('data-media-source')?.split('/')[0])).size).toBe(1);
    // The rows are ordered by what needs attention first, so the names are
    // checked as a set rather than as a sequence.
    const text = container.textContent ?? '';
    expect(['Alpha Media', 'Beta Media', 'Gamma Media'].every((name) => text.includes(name))).toBe(true);
    // And the state each one is in is a row, not a shared verdict.
    // Alpha holds the saved image default, so it reads `default`: a choice the
    // reader made, which is a different fact from whether it is configured.
    expect(row('kiki-media/alpha')?.getAttribute('data-media-source-status')).toBe('default');
    expect(row('kiki-media/beta')?.getAttribute('data-media-source-status')).toBe('needs-config');
    expect(row('kiki-media/gamma')?.getAttribute('data-media-source-status')).toBe('off');
  });

  it('reads the whole list in one call, and a row needs no settings read to be drawn', async () => {
    await mount();
    // The list itself cost one `managedSources`; opening nothing cost zero
    // settings reads. A row that was "not checked" would need one.
    expect(backend.settingsReads).toEqual([]);
  });

  it('saves one source key without moving its siblings', async () => {
    await mount();
    await openSource('kiki-media/beta');
    await flush();
    expect(q('[data-media-source-detail]')?.getAttribute('data-media-source-detail')).toBe('kiki-media/beta');

    await fill('[data-media-setting="apiKey"] [data-secret-field] input', 'sk-not-a-real-key');
    await click('[data-media-source-settings] [data-settings-draft] button');

    expect(backend.updates).toHaveLength(1);
    expect(backend.updates[0]?.provider).toBe('kiki-media/beta');
    // Exactly the one changed key. An unsent key must not appear in the patch,
    // because a host that treats a missing key as "set it to nothing" would
    // clear the endpoint on the same save.
    expect(backend.updates[0]?.values).toEqual({ apiKey: 'sk-not-a-real-key' });

    const alpha = backend.sources.find((item) => item.sourceId === 'alpha')!;
    const beta = backend.sources.find((item) => item.sourceId === 'beta')!;
    expect(beta.secretsConfigured).toEqual(['apiKey']);
    expect(beta.missing).toEqual([]);
    expect(alpha.values).toEqual({ baseUrl: 'https://api.example.test/v1' });
  });

  it('never renders a stored secret back into the form', async () => {
    await mount();
    await openSource('kiki-media/alpha');
    await flush();
    const field = q('[data-media-setting="apiKey"] [data-secret-field] input') as HTMLInputElement | null;
    expect(field).not.toBeNull();
    // The stored secret is reported, not echoed: the field offers a new value.
    expect(field?.value).toBe('');
    expect(container.textContent).not.toContain('sk-');
  });

  it('sends no value at all for a secret the reader did not touch', async () => {
    await mount();
    await openSource('kiki-media/alpha');
    await flush();
    await fill('[data-media-setting="baseUrl"] input', 'https://other.example.test/v1');
    await click('[data-media-source-settings] [data-settings-draft] button');
    expect(backend.updates[0]?.values).toEqual({ baseUrl: 'https://other.example.test/v1' });
    expect(backend.updates[0]?.values).not.toHaveProperty('apiKey');
  });

  it('keeps a source switched off, and brings it back without touching the others', async () => {
    await mount();
    await openSource('kiki-media/gamma');
    await flush();
    await click('[data-media-source-in-use] [role="switch"]');
    expect(backend.updates.at(-1)).toMatchObject({ provider: 'kiki-media/gamma', enabled: true, removed: false });
    await click('[data-media-source-in-use] [role="switch"]');
    expect(backend.updates.at(-1)).toMatchObject({ provider: 'kiki-media/gamma', enabled: false });
    // A switch is a switch, not a package operation: nothing else was written.
    expect(backend.updates.every((update) => update.provider === 'kiki-media/gamma')).toBe(true);
  });

  it('removes a source reversibly, keeping its configuration', async () => {
    await mount();
    await openSource('kiki-media/alpha');
    await flush();
    await click('[data-media-source-remove]');
    expect(backend.updates.at(-1)).toMatchObject({ provider: 'kiki-media/alpha', removed: true });
    // Removal keeps the values and the stored secret: nothing is uninstalled,
    // nothing is cleared, and the source is still a row the reader can restore.
    expect(backend.sources.find((item) => item.sourceId === 'alpha')?.values).toEqual({ baseUrl: 'https://api.example.test/v1' });
    expect(backend.sources.find((item) => item.sourceId === 'alpha')?.secretsConfigured).toEqual(['apiKey']);
    expect(q('[data-media-source-remove]')?.getAttribute('data-media-source-remove')).toBe('restore');

    await click('[data-media-source-remove]');
    expect(backend.updates.at(-1)).toMatchObject({ provider: 'kiki-media/alpha', removed: false, enabled: true });
  });

  it('adds a reader own script through the sources entry, and opens it', async () => {
    await mount();
    await click('[data-media-add-script]');
    await flush();
    expect(q('[data-media-script-dialog]')).not.toBeNull();

    await fill('[data-media-script-field="id"]', 'local-renderer');
    await fill('[data-media-script-field="label"]', 'My renderer');
    await fill('[data-media-script-field="command"]', 'python');
    await fill('[data-media-script-field="args"]', 'render.py\n--width\n1024');
    await fill('[data-media-script-field="format"]', 'png');
    await fill('[data-media-script-field="environment"]', '{"RENDER_API_KEY":"value"}');
    await click('[data-media-script-submit]');
    await flush();

    expect(backend.adds).toHaveLength(1);
    // Arguments arrive as a list, one per line, and never through a shell.
    expect(backend.adds[0]).toMatchObject({
      id: 'local-renderer',
      label: 'My renderer',
      command: 'python',
      args: ['render.py', '--width', '1024'],
      format: 'png',
      environment: { RENDER_API_KEY: 'value' },
    });
    // Optional fields the reader left empty are omitted, not sent as blanks:
    // an empty environment must not be a write that could clear one.
    expect(backend.adds[0]).not.toHaveProperty('cwd');
    expect(backend.adds[0]).not.toHaveProperty('mime');
    expect(backend.adds[0]?.protocol).toBe('file');
  });

  it('keeps the draft when a script source cannot be added', async () => {
    backend.refusals.add = true;
    await mount();
    await click('[data-media-add-script]');
    await flush();
    await fill('[data-media-script-field="id"]', 'local-renderer');
    await fill('[data-media-script-field="label"]', 'My renderer');
    await fill('[data-media-script-field="command"]', 'python');
    await click('[data-media-script-submit]');
    await flush();

    expect(q('[data-feedback-tone="error"]')).not.toBeNull();
    // Every typed character is still there, because a failed save must not
    // cost the reader the command line they just wrote.
    expect((q('[data-media-script-field="command"]') as HTMLInputElement).value).toBe('python');
    expect((q('[data-media-script-field="id"]') as HTMLInputElement).value).toBe('local-renderer');
  });

  // -------------------------------------------------------------------------
  // The save contract. A read-back is a second question, and asking it
  // instead of the write makes a refused save indistinguishable from a good
  // one — because a plain GET still answers.
  // -------------------------------------------------------------------------

  it('does not read the stored values back while the write is still in flight', async () => {
    // A slow write with a fast GET. If the form asked the GET first it would
    // see the OLD value, treat that as the save, and clear the draft — losing
    // the key the reader had just typed, before the host had it.
    backend.delays.update = 40;
    await mount();
    await openSource('kiki-media/beta');
    await fill('[data-media-setting="apiKey"] [data-secret-field] input', 'sk-not-a-real-key');

    const node = q('[data-media-source-settings] [data-settings-draft] button') as HTMLElement;
    const fields = q('[data-media-source-settings] fieldset') as HTMLFieldSetElement;
    await act(async () => { node.click(); });

    // One tick, long before the write settles: the form is busy, and every
    // field is disabled. This is where the read-back-as-proof bug showed — a
    // GET issued now returns the OLD value while the write is still open, and
    // treating that as the save would clear the typed key.
    await act(async () => { await Promise.resolve(); });
    expect(backend.updates).toHaveLength(1);
    expect(fields.disabled).toBe(true);
    expect(q('[data-settings-draft-saved]')).toBeNull();
    expect(q('[data-feedback-tone="error"]')).toBeNull();

    // Settled: the write landed, the echo came back, and only then is the
    // draft replaced by what the host holds.
    for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
    expect(q('[data-settings-draft-saved]')).not.toBeNull();
    expect(fields.disabled).toBe(false);
    expect(backend.sources.find((item) => item.sourceId === 'beta')?.secretsConfigured).toEqual(['apiKey']);
  });

  it('keeps the draft and says so when the host refuses the write, even though a read would succeed', async () => {
    // The deceptive case: the write is refused, and `sourceSettings` — the
    // read the form used to treat as proof — still answers normally with the
    // old value. Consuming that would show "saved" and drop the new key.
    backend.refusals.update = true;
    await mount();
    await openSource('kiki-media/beta');
    await fill('[data-media-setting="apiKey"] [data-secret-field] input', 'sk-not-a-real-key');
    await click('[data-media-source-settings] [data-settings-draft] button');

    // The refusal is reported.
    expect(q('[data-feedback-tone="error"]')?.textContent).toContain('refused');
    // No tick: nothing was saved.
    expect(q('[data-settings-draft-saved]')).toBeNull();
    // The draft is intact, new key included, and still dirty.
    expect((q('[data-media-setting="apiKey"] [data-secret-field] input') as HTMLInputElement).value).toBe('sk-not-a-real-key');
    expect(q('[data-settings-draft]')?.getAttribute('data-dirty')).toBe('true');
    // And the host is still where it was.
    expect(backend.sources.find((item) => item.sourceId === 'beta')?.secretsConfigured).toEqual([]);
  });

  it('leaves a refused switch off, with the outcome line under the control', async () => {
    backend.refusals.update = true;
    await mount();
    await openSource('kiki-media/beta');
    await click('[data-media-source-in-use] [role="switch"]');
    // The control reports the refusal instead of silently reverting with no
    // explanation, and the host's state is untouched.
    expect(q('[data-feedback-tone="error"]')?.textContent).toContain('refused');
    expect(backend.sources.find((item) => item.sourceId === 'beta')?.enabled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The advanced fold, and the per-modality default.
  // -------------------------------------------------------------------------

  it('opens the advanced fold, so a script command is reachable rather than inert', async () => {
    await mount();
    await openSource('kiki-media/beta');
    // Closed to begin with, and genuinely closed: the primitive marks its
    // content inert, so a fold wired to a constant `false` hides facts the
    // reader cannot get anywhere else.
    const panel = q('[data-media-source-advanced]');
    expect(panel?.getAttribute('data-open')).toBe('false');
    expect(panel?.querySelector('[inert]')).not.toBeNull();

    await click('[data-media-source-advanced] button');
    expect(panel?.getAttribute('data-open')).toBe('true');
    expect(panel?.querySelector('[inert]')).toBeNull();
    expect(q('[data-media-source-advanced]')?.textContent).toContain('kiki-media/beta');

    await click('[data-media-source-advanced] button');
    expect(panel?.getAttribute('data-open')).toBe('false');
  });

  it('moves a default on save, with the old holder released and no reload', async () => {
    await mount();
    // Alpha holds the image default; beta is configured and available.
    expect(row('kiki-media/alpha')?.getAttribute('data-media-source-status')).toBe('default');
    await openSource('kiki-media/beta');
    await pressDefault('image');

    // The detail and the list agree immediately, from the host's own echo.
    expect(q('[data-media-default="image"]')?.getAttribute('data-media-default-on')).toBe('true');
    expect(backend.settings['defaultImageProvider']).toBe(PACKAGE + '/beta');

    await click('[data-media-source-back]');
    await flush();
    // Exactly one holder, and it is the new one. No refetch: the list redrew
    // from the cache the write landed in.
    const defaults = qa('[data-media-source-status="default"]').map((node) => node.getAttribute('data-media-source'));
    expect(defaults).toEqual([PACKAGE + '/beta']);
    // The other modality's key survived the write that only moved images.
    expect(backend.settings['defaultTtsProvider']).toBe('');
  });

  it('gives a modality back when the default is taken away', async () => {
    await mount();
    await openSource('kiki-media/alpha');
    expect(q('[data-media-default="image"]')?.getAttribute('data-media-default-on')).toBe('true');
    await pressDefault('image');
    expect(backend.settings['defaultImageProvider']).toBeUndefined();
    await click('[data-media-source-back]');
    await flush();
    expect(qa('[data-media-source-status="default"]')).toHaveLength(0);
  });

  it('leaves the default where it was when the host refuses the write', async () => {
    backend.refusals.defaults = true;
    await mount();
    await openSource('kiki-media/beta');
    await pressDefault('image');
    // The switch did not move, the row kept the badge, and the reason is on
    // screen — the three states a refused choice has to be able to be in.
    // The wording is what `errorText` makes of a plain Error, so the
    // assertion is that a refusal was reported at all, not how it reads.
    expect(q('[data-media-default="image"]')?.getAttribute('data-media-default-on')).toBe('false');
    expect(q('[data-media-defaults-error]')).not.toBeNull();
    expect(backend.settings['defaultImageProvider']).toBe(PACKAGE + '/alpha');
    await click('[data-media-source-back]');
    await flush();
    expect(row('kiki-media/alpha')?.getAttribute('data-media-source-status')).toBe('default');
  });

  /**
   * The two pages that share `['plugin-settings', 'kiki-media']`.
   *
   * They are separate components reading ONE cache entry, so a write from
   * either has to leave behind an entry the other can still use. A media
   * default write that stored only `.values` would leave PluginSettingsForm —
   * which reads `schema` and `secretsConfigured` off the same entry and
   * renders nothing at all without a schema — with nothing to show the next
   * time anyone moved a default. These read the entry the way each page does.
   */
  describe('the shared plugin-settings entry', () => {
    it('keeps the shape the plugin settings form needs after a media default write', async () => {
      await mount();
      await openSource('kiki-media/beta');
      await pressDefault('image');
      expect(backend.settings['defaultImageProvider']).toBe(PACKAGE + '/beta');

      // What PluginSettingsForm reads off this entry: a full response, or its
      // `schema` is missing and it renders nothing at all.
      const cached = query.getQueryData(['plugin-settings', PACKAGE]);
      expect(cached).toMatchObject({ schema: { schema: { properties: {} } }, secretsConfigured: [] });
      // And the defaults it carries are the ones the media page just wrote.
      expect((cached as { values: Record<string, unknown> }).values['defaultImageProvider']).toBe(PACKAGE + '/beta');
    });

    it('still moves the media default when the entry arrived from a plugin settings write', async () => {
      // Seed the shared entry the way PluginSettingsForm's own write-through
      // leaves it: the complete host echo, not a values fragment.
      query.setQueryData(['plugin-settings', PACKAGE], {
        schema: { schema: { properties: { defaultImageProvider: { type: 'string' } } } },
        values: { ...backend.settings },
        secretsConfigured: ['defaultImageProvider'],
      });
      await mount();
      expect(row('kiki-media/alpha')?.getAttribute('data-media-source-status')).toBe('default');

      await openSource('kiki-media/beta');
      await pressDefault('image');
      // The media read took `.values` off the shared entry and moved the
      // badge: one holder for images, and the old one released.
      expect(q('[data-media-default="image"]')?.getAttribute('data-media-default-on')).toBe('true');
      await click('[data-media-source-back]');
      await flush();
      expect(qa('[data-media-source-status="default"]')).toHaveLength(1);
      expect(row('kiki-media/beta')?.getAttribute('data-media-source-status')).toBe('default');
      // Alpha lost the badge and falls back to what it otherwise is — a
      // configured source — rather than keeping a default it no longer holds.
      expect(row('kiki-media/alpha')?.getAttribute('data-media-source-status')).toBe('ready');
      // The seed's OTHER keys survived a write that patched one — including a
      // modality deliberately left empty, which is the case a write that
      // rebuilt the whole document would fill in or drop.
      expect(backend.settings['defaultTtsProvider']).toBe('');
      expect(backend.settings['defaultImageProvider']).toBe(PACKAGE + '/beta');
      // And the entry is still a full response for whoever reads it next.
      expect(query.getQueryData(['plugin-settings', PACKAGE])).toMatchObject({ schema: expect.anything(), secretsConfigured: expect.anything() });
    });

    it('leaves the shared entry untouched when the host refuses a default', async () => {
      backend.refusals.defaults = true;
      await mount();
      await openSource('kiki-media/beta');
      const before = query.getQueryData(['plugin-settings', PACKAGE]);
      await pressDefault('image');
      // A refused write changes no cache at all: not the badge the reader is
      // looking at, and not the entry the other page reads.
      expect(query.getQueryData(['plugin-settings', PACKAGE])).toEqual(before);
      await click('[data-media-source-back]');
      await flush();
      expect(row('kiki-media/alpha')?.getAttribute('data-media-source-status')).toBe('default');
    });
  });
});
