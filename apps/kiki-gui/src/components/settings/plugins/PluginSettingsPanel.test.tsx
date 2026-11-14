// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DirtyGuardContext } from '../../dirtyGuard';
import { I18nProvider } from '../../../i18n';
import { PluginSettingsPage } from './PluginSettingsPage';
import { PluginSettingsPanel, settingsPanelOf } from './PluginSettingsPanel';

/* The thinnest in-repo stand-in for a plugin's panel document: it names the
 * channel so the slot's contract assertions run without depending on a sibling
 * repository or this machine's layout. The shipped media document's end-to-end
 * behavior is covered separately by the host-slot harness. */
const html = '<!doctype html><html><body><script>window.CHANNEL = \'kiki.panel.v1\';</script></body></html>';
const getPluginPanelDocument = vi.hoisted(() => vi.fn());
const getPluginSettings = vi.hoisted(() => vi.fn());
const setPluginSettings = vi.hoisted(() => vi.fn());
const listPlugins = vi.hoisted(() => vi.fn());
const listPluginMarketplace = vi.hoisted(() => vi.fn());
const getPlugin = vi.hoisted(() => vi.fn());
const callPluginPanelBridge = vi.hoisted(() => vi.fn());
const openPluginPanelStream = vi.hoisted(() => vi.fn());
const connectionBag = vi.hoisted(() => ({ scopeId: 'scope-a', serverId: 'server-a', baseUrl: 'https://server.example.test' }));

vi.mock('../../../state/connection', () => ({
  useConnection: () => ({
    scopeId: connectionBag.scopeId,
    meta: { server_id: connectionBag.serverId },
    client: { baseUrl: connectionBag.baseUrl, getPluginPanelDocument, getPluginSettings, setPluginSettings, listPlugins, listPluginMarketplace, getPlugin, callPluginPanelBridge, openPluginPanelStream },
  }),
}));

const stored = {
  schema: { schema: { properties: { openai__imageModel: { type: 'string', title: 'Default image model' } } } },
  values: { openai__imageModel: 'gpt-image-1.5' },
  secretsConfigured: [] as string[],
  revision: 1,
};

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const renderings = new WeakMap<HTMLIFrameElement, { readonly root: Root; readonly queryClient: QueryClient }>();
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

/* jsdom fires the srcdoc iframe's load before a post-stub can land, so the
 * frame's postMessage is captured from the moment the window exists. */
const framePosts = new WeakMap<Window, unknown[]>();
const framePostTransfers = new WeakMap<Window, Array<Transferable[] | undefined>>();
let restoreContentWindow: (() => void) | undefined;
let restoreMessageChannel: (() => void) | undefined;
let originalMessageChannel: PropertyDescriptor | undefined;

class SettingsTestPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly messages: Array<{ readonly data: unknown; readonly transfer?: Transferable[] }> = [];
  readonly start = vi.fn();
  readonly close = vi.fn();
  postMessage = vi.fn((data: unknown, transfer?: Transferable[]) => { this.messages.push({ data, transfer }); });
  dispatch(data: unknown): void { this.onmessage?.({ data } as MessageEvent<unknown>); }
}

class SettingsTestMessageChannel {
  static readonly instances: SettingsTestMessageChannel[] = [];
  readonly port1 = new SettingsTestPort();
  readonly port2 = new SettingsTestPort();
  constructor() { SettingsTestMessageChannel.instances.push(this); }
}

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  const original = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (original?.get !== undefined) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const win = original.get!.call(this) as Window | null;
        if (win !== null && !framePosts.has(win)) {
          framePosts.set(win, []);
          framePostTransfers.set(win, []);
          win.postMessage = ((message: unknown, _target?: string, transfer?: Transferable[]) => {
            framePosts.get(win)!.push(message);
            framePostTransfers.get(win)!.push(transfer);
          }) as typeof win.postMessage;
        }
        return win;
      },
    });
    restoreContentWindow = () => {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', original);
    };
  }
});
beforeEach(() => {
  SettingsTestMessageChannel.instances.length = 0;
  originalMessageChannel = Object.getOwnPropertyDescriptor(globalThis, 'MessageChannel');
  Object.defineProperty(globalThis, 'MessageChannel', { configurable: true, writable: true, value: SettingsTestMessageChannel });
  restoreMessageChannel = () => {
    if (originalMessageChannel === undefined) delete (globalThis as { MessageChannel?: unknown }).MessageChannel;
    else Object.defineProperty(globalThis, 'MessageChannel', originalMessageChannel);
  };
  getPluginPanelDocument.mockReset().mockResolvedValue({ html });
  getPluginSettings.mockReset().mockResolvedValue(stored);
  setPluginSettings.mockReset().mockImplementation(async (_id: string, values: Record<string, string>) => ({
    ...stored,
    values: { ...stored.values, ...values },
    revision: 2,
  }));
  listPlugins.mockReset();
  listPluginMarketplace.mockReset().mockResolvedValue({ configured: false, entries: [] });
  getPlugin.mockReset();
  callPluginPanelBridge.mockReset().mockResolvedValue({ result: { catalog: ['m1'] } });
  openPluginPanelStream.mockReset();
  connectionBag.scopeId = 'scope-a';
  connectionBag.serverId = 'server-a';
  connectionBag.baseUrl = 'https://server.example.test';
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  restoreMessageChannel?.();
  restoreMessageChannel = undefined;
});
afterAll(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  restoreContentWindow?.();
  vi.unstubAllGlobals();
});

async function waitFrame(container: HTMLDivElement, previous?: HTMLIFrameElement): Promise<HTMLIFrameElement> {
  for (let i = 0; i < 12; i++) {
    const frame = container.querySelector('iframe');
    if (frame !== null && frame !== previous) return frame;
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  }
  throw new Error('settings slot did not mount');
}

/* jsdom loads the srcdoc document on its own, and a browser fires exactly one
 * load per document — the slot counts loads to handshake each one. Wait for
 * that init; only if the environment never fired do we nudge a load ourselves. */
async function awaitInit(frame: HTMLIFrameElement): Promise<unknown[]> {
  let posted = framePosts.get(frame.contentWindow!) ?? [];
  for (let i = 0; i < 12; i++) {
    if (posted.some((message) => (message as { kind?: string }).kind === 'init')) return posted;
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    posted = framePosts.get(frame.contentWindow!) ?? posted;
  }
  await act(async () => {
    frame.dispatchEvent(new Event('load'));
    await new Promise((done) => setTimeout(done, 0));
  });
  return framePosts.get(frame.contentWindow!) ?? [];
}

function settingsPanelElement(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <PluginSettingsPanel pluginId="kiki-media" panelId="settings" label="Settings" />
      </I18nProvider>
    </QueryClientProvider>
  );
}

async function renderPanel(): Promise<{ frame: HTMLIFrameElement; posted: unknown[] }> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(settingsPanelElement(queryClient)); });
  // The iframe appears once the document query resolves; posts are captured
  // per content window from creation, so nothing the frame is sent is missed.
  const frame = await waitFrame(container);
  renderings.set(frame, { root, queryClient });
  const posted = await awaitInit(frame);
  return { frame, posted };
}

function request(frame: HTMLIFrameElement, data: Record<string, unknown>): void {
  const event = new MessageEvent('message', { data, origin: 'null' });
  Object.defineProperty(event, 'source', { value: frame.contentWindow });
  window.dispatchEvent(event);
}

describe('the settings slot reads and saves the media document', () => {
  it('serves the panel document and writes the patched value through the settings route', async () => {
    const { frame, posted } = await renderPanel();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.getAttribute('srcdoc')).toContain('kiki.panel.v1');
    expect(frame.getAttribute('srcdoc')).toContain('function applyPresentation(p)');
    expect(getPluginPanelDocument).toHaveBeenCalledWith('kiki-media', 'settings');

    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 1, method: 'plugin.settings.get' });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(getPluginSettings).toHaveBeenCalledWith('kiki-media');
    expect(posted.at(-1)).toMatchObject({ channel: 'kiki.panel.v1', kind: 'response', id: 1, ok: true, result: stored });

    await act(async () => {
      request(frame, {
        channel: 'kiki.panel.v1', kind: 'request', id: 2, method: 'plugin.settings.patch',
        values: { openai__imageModel: 'gpt-image-2' },
      });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(setPluginSettings).toHaveBeenCalledWith('kiki-media', { openai__imageModel: 'gpt-image-2' });
    expect(posted.at(-1)).toMatchObject({
      id: 2,
      ok: true,
      result: { values: { openai__imageModel: 'gpt-image-2' }, revision: 2 },
    });
  });

  it('loads a server document URL relative to the connected server without adding a client srcDoc bridge', async () => {
    getPluginPanelDocument.mockResolvedValueOnce({ html, url: '/api/plugin-panels/kiki-media/settings/document.html' });
    const { frame } = await renderPanel();

    expect(frame.getAttribute('src')).toBe('https://server.example.test/api/plugin-panels/kiki-media/settings/document.html');
    expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('loads a same-origin document when Web Access uses an empty client base URL', async () => {
    connectionBag.baseUrl = '';
    getPluginPanelDocument.mockResolvedValueOnce({ html, url: '/plugin-panel/settings-grant' });
    const { frame } = await renderPanel();
    expect(frame.getAttribute('src')).toBe(`${window.location.origin}/plugin-panel/settings-grant`);
    expect(frame.getAttribute('srcdoc')).toBeNull();
  });

  it('relays plugin.models.list and plugin.call through the panel bridge without session', async () => {
    const { frame, posted } = await renderPanel();

    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 10, method: 'plugin.models.list' });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(callPluginPanelBridge).toHaveBeenCalledWith('kiki-media', 'settings', { method: 'plugin.models.list' });
    expect(posted.at(-1)).toMatchObject({ channel: 'kiki.panel.v1', kind: 'response', id: 10, ok: true, result: { catalog: ['m1'] } });

    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 11, method: 'plugin.call', action: 'configuration', args: {} });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(callPluginPanelBridge).toHaveBeenCalledWith('kiki-media', 'settings', { method: 'plugin.call', session_id: undefined, action: 'configuration', args: {} });
    expect(posted.at(-1)).toMatchObject({ channel: 'kiki.panel.v1', kind: 'response', id: 11, ok: true });
  });

  it('supports kiki-output-layer settings.html protocol flow: configuration call, models list, and settings patch', async () => {
    const { frame, posted } = await renderPanel();

    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 1, method: 'plugin.call', action: 'configuration', args: {} });
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 2, method: 'plugin.models.list' });
      await new Promise((done) => setTimeout(done, 0));
    });

    expect(callPluginPanelBridge).toHaveBeenCalledWith('kiki-media', 'settings', {
      method: 'plugin.call',
      session_id: undefined,
      action: 'configuration',
      args: {},
    });
    expect(callPluginPanelBridge).toHaveBeenCalledWith('kiki-media', 'settings', {
      method: 'plugin.models.list',
    });
    expect(posted.find((m: any) => m.id === 1)).toMatchObject({ ok: true });
    expect(posted.find((m: any) => m.id === 2)).toMatchObject({ ok: true, result: { catalog: ['m1'] } });

    const patchPayload = {
      presets: JSON.stringify([{ id: 'p1', label: '新预设', instruction: '测试' }]),
      groupChars: 600,
      historyTokens: 16384,
    };
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 3, method: 'plugin.settings.patch', values: patchPayload });
      await new Promise((done) => setTimeout(done, 0));
    });

    expect(setPluginSettings).toHaveBeenCalledWith('kiki-media', patchPayload);
    expect(posted.find((m: any) => m.id === 3)).toMatchObject({ ok: true });

    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 4, method: 'plugin.settings.get' });
      await new Promise((done) => setTimeout(done, 0));
    });

    expect(getPluginSettings).toHaveBeenCalledWith('kiki-media');
    expect(posted.find((m: any) => m.id === 4)).toMatchObject({ ok: true });
  });

  it('offers the presentation context on init and pushes theme flips without a re-init', async () => {
    const { posted } = await renderPanel();
    const init = posted.find((message) => (message as { kind?: string }).kind === 'init');
    expect(init).toMatchObject({
      channel: 'kiki.panel.v1',
      kind: 'init',
      sessionId: null,
      presentation: { locale: 'en', theme: 'light' },
    });
    const before = posted.length;
    await act(async () => {
      document.documentElement.dataset['theme'] = 'dark';
      await new Promise((done) => setTimeout(done, 0));
    });
    const updates = posted.slice(before).filter((message) => (message as { kind?: string }).kind === 'presentation');
    expect(updates.at(-1)).toMatchObject({
      channel: 'kiki.panel.v1',
      kind: 'presentation',
      presentation: { locale: 'en', theme: 'dark' },
    });
    expect(posted.slice(before).some((message) => (message as { kind?: string }).kind === 'init')).toBe(false);
    delete document.documentElement.dataset['theme'];
  });

  it('re-runs the init handshake when the route switches the panel to another plugin', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPluginPanelDocument.mockImplementation(async (pluginId: string) => ({ html: `<!-- ${pluginId} -->${html}` }));
    const page = (pluginId: string) => (
      <QueryClientProvider client={client}>
        <I18nProvider>
          <PluginSettingsPanel pluginId={pluginId} panelId="settings" label="Settings" />
        </I18nProvider>
      </QueryClientProvider>
    );
    await act(async () => { root.render(page('kiki-media')); });
    const frameA = await waitFrame(container);
    const postsA = await awaitInit(frameA);
    expect(postsA.filter((message) => (message as { kind?: string }).kind === 'init')).toHaveLength(1);

    // Same mounted component, new plugin: the old document unloads and the new
    // one must get its own init — the stale-document frame is never re-used.
    await act(async () => { root.render(page('kiki-other')); });
    const frameB = await waitFrame(container, frameA);
    const postsB = await awaitInit(frameB);
    expect(postsB.filter((message) => (message as { kind?: string }).kind === 'init')).toHaveLength(1);
    expect(postsA.filter((message) => (message as { kind?: string }).kind === 'init')).toHaveLength(1);
    expect(getPluginPanelDocument).toHaveBeenCalledWith('kiki-other', 'settings');
  });

  it('hands a zh host locale to the panel', async () => {
    localStorage.setItem('kiki.locale', 'zh');
    try {
      const { posted } = await renderPanel();
      const init = posted.find((message) => (message as { kind?: string }).kind === 'init');
      expect(init).toMatchObject({ presentation: { locale: 'zh' } });
    } finally {
      localStorage.removeItem('kiki.locale');
    }
  });

  it('keeps a nested label and summary button editable after the locale flips', async () => {
    const scenario = (await import('../../../../fixtures/plugin-settings-pages.scenario.mjs')).default;
    const pluginHtml = scenario.pluginPanels['kiki-output-layer']?.[0]?.html;
    if (pluginHtml === undefined) throw new Error('kiki-output-layer panel html is missing');
    expect(pluginHtml).toContain('<label id="name-label">');
    expect(pluginHtml).toContain('<summary id="actions">');
    getPluginPanelDocument.mockResolvedValue({ html: pluginHtml });
    const { frame } = await renderPanel();
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).not.toContain('EN_MAP');
    expect(srcdoc).not.toContain("querySelectorAll('h2,label,summary,button,#status')");

    const probe = document.createElement('iframe');
    document.body.append(probe);
    const patches: unknown[] = [];
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { channel?: string; kind?: string; method?: string; id?: number; values?: unknown };
      if (data?.channel !== 'kiki.panel.v1' || data.kind !== 'request' || event.source !== probe.contentWindow) return;
      if (data.method === 'plugin.settings.patch') patches.push(data.values);
      const result = data.method === 'plugin.settings.get'
        ? { values: { presetName: 'Reading' } }
        : data.method === 'plugin.settings.patch'
          ? { values: data.values }
          : true;
      const response = new MessageEvent('message', {
        data: { channel: 'kiki.panel.v1', kind: 'response', id: data.id, ok: true, result },
      });
      Object.defineProperty(response, 'source', { value: window });
      probe.contentWindow?.dispatchEvent(response);
    };
    window.addEventListener('message', onMessage);
    let restorePost: (() => void) | undefined;
    try {
      const win = probe.contentWindow as (Window & { __kikiFixture?: boolean; eval: (source: string) => void }) | null;
      const doc = probe.contentDocument;
      expect(win).not.toBeNull();
      expect(doc).not.toBeNull();
      const sources = [...srcdoc.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? '');
      doc?.open();
      doc?.write(srcdoc.replace(/<script[\s\S]*?<\/script>/gi, ''));
      doc?.close();
      const parentWindow = win?.parent as (Window & { postMessage: (message: unknown, target?: string) => void }) | undefined;
      if (parentWindow !== undefined) {
        const originalPost = parentWindow.postMessage.bind(parentWindow);
        restorePost = () => { parentWindow.postMessage = originalPost; };
        parentWindow.postMessage = (message: unknown) => {
          setTimeout(() => onMessage({ data: message, source: win } as MessageEvent), 0);
        };
      }
      try {
        for (const source of sources) win?.eval(source);
      } catch (error) {
        throw new Error(`panel script failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      expect(win?.__kikiFixture).toBe(true);
      const deliver = (data: unknown) => {
        const event = new MessageEvent('message', { data });
        Object.defineProperty(event, 'source', { value: win?.parent ?? window });
        win?.dispatchEvent(event);
      };
      const present = (locale: string) => {
        deliver({
          channel: 'kiki.panel.v1',
          kind: 'presentation',
          presentation: { locale, theme: 'light', tokens: { '--color-paper': 'rgb(1, 2, 3)', '--color-ink': '#111' } },
        });
      };
      const inputOf = () => doc?.querySelector('label#name-label input#name') as HTMLInputElement | null;
      const saveOf = () => doc?.querySelector('summary#actions button#save') as HTMLButtonElement | null;
      const labelText = () => (doc?.getElementById('name-label')?.childNodes[0]?.textContent ?? '').trim();
      for (let i = 0; i < 20 && inputOf()?.value !== 'Reading'; i += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
      const input = inputOf();
      const save = saveOf();
      expect(input).not.toBeNull();
      expect(save).not.toBeNull();
      expect(labelText()).toBe('名称');

      present('en');
      await new Promise((done) => setTimeout(done, 0));
      expect(inputOf()).toBe(input);
      expect(saveOf()).toBe(save);
      expect(labelText()).toBe('Name');
      expect(doc?.documentElement.lang).toBe('en');
      expect(doc?.documentElement.style.getPropertyValue('--paper')).toBe('rgb(1, 2, 3)');
      expect(input?.value).toBe('Reading');
      if (input !== null) input.value = 'Night reading';
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      save?.click();
      for (let i = 0; i < 20 && patches.length === 0; i += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
      expect(patches).toEqual([{ presetName: 'Night reading' }]);
      expect(inputOf()).toBe(input);
      expect(saveOf()).toBe(save);
      expect(input?.value).toBe('Night reading');

      present('zh');
      await new Promise((done) => setTimeout(done, 0));
      expect(inputOf()).toBe(input);
      expect(saveOf()).toBe(save);
      expect(labelText()).toBe('名称');
      expect(input?.value).toBe('Night reading');
      expect(doc?.documentElement.lang).toBe('zh-CN');

      present('fr');
      await new Promise((done) => setTimeout(done, 0));
      expect(inputOf()).toBe(input);
      expect(saveOf()).toBe(save);
      expect(labelText()).toBe('名称');
      expect(doc?.documentElement.lang).toBe('zh-CN');
    } finally {
      restorePost?.();
      window.removeEventListener('message', onMessage);
      probe.remove();
    }
  });

  it('keeps dirty notices out of the request budget and preserves edits newer than a save', async () => {
    const reports: Array<readonly [string, boolean]> = [];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DirtyGuardContext.Provider value={{
            dirty: false,
            reportDirty: (id, bit) => { reports.push([id, bit]); },
            navigate: () => {},
          }}
          >
            <I18nProvider>
              <PluginSettingsPanel pluginId="kiki-media" panelId="settings" label="Settings" />
            </I18nProvider>
          </DirtyGuardContext.Provider>
        </QueryClientProvider>,
      );
    });
    const frame = await waitFrame(container);
    await awaitInit(frame);
    await act(async () => {
      for (let id = 30; id < 75; id++) request(frame, { channel: 'kiki.panel.v1', kind: 'request', id, method: 'plugin.dirty', dirty: true });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(reports).toContainEqual(['plugin-settings:kiki-media', true]);
    await act(async () => {
      request(frame, {
        channel: 'kiki.panel.v1', kind: 'request', id: 5, method: 'plugin.settings.patch',
        values: { openai__imageModel: 'gpt-image-2' },
      });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(reports.at(-1)).toEqual(['plugin-settings:kiki-media', false]);
    expect(setPluginSettings).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plugin', 'kiki-media'] });
    let finish!: (value: typeof stored) => void;
    setPluginSettings.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 80, method: 'plugin.dirty', dirty: true });
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 81, method: 'plugin.settings.patch', values: { openai__imageModel: 'm2' } });
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 82, method: 'plugin.dirty', dirty: true });
      await new Promise((done) => setTimeout(done, 0));
      finish(stored);
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(reports.at(-1)).toEqual(['plugin-settings:kiki-media', true]);
  });

  it('returns the settings error and refuses a patch that is not a flat value map', async () => {
    getPluginSettings.mockRejectedValue(new Error('settings unavailable'));
    const { frame, posted } = await renderPanel();
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 6, method: 'plugin.settings.get' });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(posted.at(-1)).toMatchObject({ id: 6, ok: false, error: 'settings unavailable' });

    await act(async () => {
      request(frame, {
        channel: 'kiki.panel.v1', kind: 'request', id: 7, method: 'plugin.settings.patch',
        values: { token: { raw: 'super-secret' } },
      });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(setPluginSettings).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ id: 7, ok: false, error: 'invalid settings' });
  });

  it('keeps A\'s accepted patch off B after B is dirty, then still serves B', async () => {
    const reports: Array<readonly [string, boolean]> = [];
    let releaseA!: (value: { values: Record<string, string>; revision: number }) => void;
    const gate = new Promise<{ values: Record<string, string>; revision: number }>((resolve) => { releaseA = resolve; });
    setPluginSettings.mockImplementation((id: string, values: Record<string, string>) => (
      id === 'plugin-a'
        ? gate.then(() => ({ ...stored, values: { ...stored.values, ...values }, revision: 9 }))
        : Promise.resolve({ ...stored, values: { ...stored.values, ...values }, revision: 3 })
    ));
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (pluginId: string) => (
      <QueryClientProvider client={client}>
        <DirtyGuardContext.Provider value={{
          dirty: false,
          reportDirty: (id, bit) => { reports.push([id, bit]); },
          navigate: () => {},
        }}
        >
          <I18nProvider>
            <PluginSettingsPanel pluginId={pluginId} panelId="settings" label="Settings" />
          </I18nProvider>
        </DirtyGuardContext.Provider>
      </QueryClientProvider>
    );
    await act(async () => { root.render(page('plugin-a')); });
    const frameA = await waitFrame(container);
    await awaitInit(frameA);
    await act(async () => {
      request(frameA, {
        channel: 'kiki.panel.v1', kind: 'request', id: 8, method: 'plugin.settings.patch',
        values: { openai__imageModel: 'from-a' },
      });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(setPluginSettings).toHaveBeenCalledWith('plugin-a', { openai__imageModel: 'from-a' });

    await act(async () => { root.render(page('plugin-b')); });
    const frameB = await waitFrame(container, frameA);
    const postsB = await awaitInit(frameB);
    await act(async () => {
      request(frameB, { channel: 'kiki.panel.v1', kind: 'request', id: 1, method: 'plugin.dirty', dirty: true });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(reports).toContainEqual(['plugin-settings:plugin-b', true]);

    await act(async () => {
      releaseA({ values: { openai__imageModel: 'from-a' }, revision: 9 });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(postsB.some((message) => (message as { id?: number }).id === 8)).toBe(false);
    expect(framePosts.get(frameB.contentWindow!)?.some((message) => (message as { id?: number }).id === 8)).toBe(false);
    expect(reports.at(-1)).toEqual(['plugin-settings:plugin-b', true]);
    expect(setPluginSettings.mock.calls.some(([id]) => id === 'plugin-b')).toBe(false);

    await act(async () => {
      request(frameB, { channel: 'kiki.panel.v1', kind: 'request', id: 2, method: 'plugin.settings.get' });
      await new Promise((done) => setTimeout(done, 0));
    });
    const postedB = framePosts.get(frameB.contentWindow!) ?? [];
    expect(postedB.at(-1)).toMatchObject({ id: 2, ok: true, result: stored });
    expect(getPluginSettings).toHaveBeenCalledWith('plugin-b');
    expect(reports.at(-1)).toEqual(['plugin-settings:plugin-b', true]);
  });

  it('fetches the panel document again when the connection changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPluginPanelDocument.mockImplementation(async () => ({ html: `<!-- ${connectionBag.scopeId} -->${html}` }));
    const page = () => (
      <QueryClientProvider client={client}>
        <I18nProvider>
          <PluginSettingsPanel pluginId="field-notes" panelId="prefs" label="Preferences" />
        </I18nProvider>
      </QueryClientProvider>
    );
    await act(async () => { root.render(page()); });
    const frameA = await waitFrame(container);
    await awaitInit(frameA);
    expect(frameA.getAttribute('srcdoc')).toContain('<!-- scope-a -->');
    const callsAfterA = getPluginPanelDocument.mock.calls.length;

    connectionBag.scopeId = 'scope-b';
    await act(async () => { root.render(page()); });
    const frameB = await waitFrame(container, frameA);
    await awaitInit(frameB);
    expect(frameB.getAttribute('srcdoc')).toContain('<!-- scope-b -->');
    expect(frameB.getAttribute('srcdoc')).not.toContain('<!-- scope-a -->');
    expect(getPluginPanelDocument.mock.calls.length).toBeGreaterThan(callsAfterA);
  });

  it('drops server A\'s late patch when the same scope moves to server B, and refetches the document', async () => {
    const reports: Array<readonly [string, boolean]> = [];
    let releaseA!: (value: { values: Record<string, string>; revision: number }) => void;
    const gate = new Promise<{ values: Record<string, string>; revision: number }>((resolve) => { releaseA = resolve; });
    setPluginSettings.mockImplementation((_id: string, values: Record<string, string>) => (
      gate.then(() => ({ ...stored, values: { ...stored.values, ...values }, revision: 9 }))
    ));
    getPluginPanelDocument.mockImplementation(async () => ({ html: `<!-- ${connectionBag.serverId} -->${html}` }));
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = () => (
      <QueryClientProvider client={client}>
        <DirtyGuardContext.Provider value={{
          dirty: false,
          reportDirty: (id, bit) => { reports.push([id, bit]); },
          navigate: () => {},
        }}
        >
          <I18nProvider>
            <PluginSettingsPanel pluginId="field-notes" panelId="prefs" label="Preferences" />
          </I18nProvider>
        </DirtyGuardContext.Provider>
      </QueryClientProvider>
    );
    await act(async () => { root.render(page()); });
    const frameA = await waitFrame(container);
    await awaitInit(frameA);
    expect(frameA.getAttribute('srcdoc')).toContain('<!-- server-a -->');
    expect(connectionBag.scopeId).toBe('scope-a');
    await act(async () => {
      request(frameA, {
        channel: 'kiki.panel.v1', kind: 'request', id: 8, method: 'plugin.settings.patch',
        values: { openai__imageModel: 'from-a' },
      });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(setPluginSettings).toHaveBeenCalledTimes(1);
    expect(setPluginSettings).toHaveBeenCalledWith('field-notes', { openai__imageModel: 'from-a' });
    const callsAfterA = getPluginPanelDocument.mock.calls.length;

    connectionBag.serverId = 'server-b';
    await act(async () => { root.render(page()); });
    const frameB = await waitFrame(container, frameA);
    await awaitInit(frameB);
    expect(connectionBag.scopeId).toBe('scope-a');
    expect(frameB.getAttribute('srcdoc')).toContain('<!-- server-b -->');
    expect(frameB.getAttribute('srcdoc')).not.toContain('<!-- server-a -->');
    expect(getPluginPanelDocument.mock.calls.length).toBeGreaterThan(callsAfterA);
    const callsAfterB = getPluginPanelDocument.mock.calls.length;

    await act(async () => {
      request(frameB, { channel: 'kiki.panel.v1', kind: 'request', id: 1, method: 'plugin.dirty', dirty: true });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(reports.at(-1)).toEqual(['plugin-settings:field-notes', true]);

    await act(async () => { root.render(page()); });
    expect(container.querySelector('iframe')).toBe(frameB);
    expect(getPluginPanelDocument.mock.calls.length).toBe(callsAfterB);
    expect(reports.at(-1)).toEqual(['plugin-settings:field-notes', true]);

    await act(async () => {
      releaseA({ values: { openai__imageModel: 'from-a' }, revision: 9 });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(framePosts.get(frameB.contentWindow!)?.some((message) => (message as { id?: number }).id === 8)).toBe(false);
    expect(reports.at(-1)).toEqual(['plugin-settings:field-notes', true]);
    expect(setPluginSettings).toHaveBeenCalledTimes(1);
  });
});

const INSTALLED = {
  id: 'field-notes',
  displayName: 'Field Notes',
  version: '2.0.0',
  enabled: true,
  globalEnabled: true,
  state: 'ok' as const,
  skillCount: 0,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  hasErrors: false,
  source: 'local-path' as const,
};

const SCHEMA = {
  schema: { schema: { properties: {
    workspace: { type: 'string', title: 'Workspace' },
    token: { type: 'string', title: 'Vault token', secret: true },
  } } },
  values: { workspace: 'notes-1', token: 'super-secret' },
  secretsConfigured: ['token'],
  revision: 1,
};

function manifest(extensionKey: 'kiki' | 'x-kiki', slots: readonly { slot: string; id: string; label: string }[]) {
  return { name: 'field-notes', [extensionKey]: { panels: slots } };
}

async function renderSettingsPage(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <I18nProvider>
            <PluginSettingsPage pluginId="field-notes" />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !ready(); i += 1) {
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  }
}

describe('the settings page chooses the declared panel or the generic schema form', () => {
  it('reads a settings slot from either extension key and ignores every other slot', () => {
    const panels = [
      { slot: 'workspace', id: 'board', label: 'Board' },
      { slot: 'settings', id: 'prefs', label: 'Preferences' },
    ];
    expect(settingsPanelOf({ kiki: { panels } })).toEqual({ id: 'prefs', label: 'Preferences' });
    expect(settingsPanelOf({ 'x-kiki': { panels } })).toEqual({ id: 'prefs', label: 'Preferences' });
    expect(settingsPanelOf({ kiki: { panels: [panels[0]] } })).toBeUndefined();
    expect(settingsPanelOf({ name: 'kiki-media' })).toBeUndefined();
    expect(settingsPanelOf(null)).toBeUndefined();
  });

  it('mounts the plugin document instead of the schema form when a settings panel is declared', async () => {
    listPlugins.mockResolvedValue({ plugins: [INSTALLED] });
    getPlugin.mockResolvedValue({
      ...INSTALLED,
      manifest: manifest('x-kiki', [
        { slot: 'workspace', id: 'board', label: 'Board' },
        { slot: 'settings', id: 'prefs', label: 'Preferences' },
      ]),
    });
    const container = await renderSettingsPage();
    await until(() => container.querySelector('iframe') !== null);
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('data-plugin-settings-panel')).toBe('field-notes');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(getPluginPanelDocument).toHaveBeenCalledWith('field-notes', 'prefs');
    expect(container.querySelector('[data-plugin-settings="field-notes"]')).toBeNull();
    expect(container.textContent).not.toContain('super-secret');
  });

  it('keeps the generic schema form, including a secret that is never written back onto the page', async () => {
    listPlugins.mockResolvedValue({ plugins: [INSTALLED] });
    getPlugin.mockResolvedValue({
      ...INSTALLED,
      manifest: manifest('kiki', [{ slot: 'sidebar', id: 'side', label: 'Side' }]),
    });
    getPluginSettings.mockResolvedValue(SCHEMA);
    const container = await renderSettingsPage();
    await until(() => container.querySelector('[data-plugin-setting="workspace"]') !== null);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[data-plugin-settings="field-notes"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-plugin-setting="workspace"] input')?.value).toBe('notes-1');
    const secret = container.querySelector('[data-plugin-setting="token"]');
    expect(secret?.querySelector('[data-secret-field]')).not.toBeNull();
    expect(secret?.textContent).not.toContain('super-secret');
    expect(container.textContent).not.toContain('super-secret');
  });

  it('directs the user to Enable without replacing a disabled dedicated panel with a schema form', async () => {
    listPlugins.mockResolvedValue({ plugins: [{ ...INSTALLED, enabled: false }] });
    getPlugin.mockResolvedValue({
      ...INSTALLED,
      enabled: false,
      manifest: manifest('kiki', [{ slot: 'settings', id: 'prefs', label: 'Preferences' }]),
    });
    const container = await renderSettingsPage();
    await until(() => container.querySelector('[data-plugin-settings-panel-off]') !== null);
    expect(container.querySelector('[data-plugin-settings-panel-off]')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(getPluginPanelDocument).not.toHaveBeenCalled();
    expect(getPluginSettings).not.toHaveBeenCalled();
  });

  it('retries a failed dedicated document without exposing a schema form', async () => {
    listPlugins.mockResolvedValue({ plugins: [INSTALLED] });
    getPlugin.mockResolvedValue({ ...INSTALLED, manifest: manifest('kiki', [{ slot: 'settings', id: 'prefs', label: 'Preferences' }]) });
    getPluginPanelDocument.mockRejectedValueOnce(new Error('Panel is temporarily unavailable'));
    const container = await renderSettingsPage();
    await until(() => container.querySelector('[data-plugin-panel-error] button') !== null);
    expect(container.textContent).toContain('Panel is temporarily unavailable');
    expect(getPluginSettings).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-plugin-panel-error] button')!.click(); });
    await waitFrame(container);
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-plugin-panel-error]')).toBeNull();
  });

  it('keeps the mounted editor if refreshing known metadata fails', async () => {
    listPlugins.mockResolvedValue({ plugins: [INSTALLED] });
    getPlugin.mockResolvedValue({ ...INSTALLED, manifest: manifest('kiki', [{ slot: 'settings', id: 'prefs', label: 'Preferences' }]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = await renderSettingsPage(queryClient);
    const frame = await waitFrame(container);
    getPlugin.mockRejectedValue(new Error('Metadata temporarily unavailable'));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['plugin', 'field-notes'] }); });
    expect(container.querySelector('iframe')).toBe(frame);
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-plugin-settings="field-notes"]')).toBeNull();
  });

  it('reports a failed plugin detail instead of reading it as "no settings", and one retry repairs the body', async () => {
    listPlugins.mockResolvedValue({ plugins: [INSTALLED] });
    getPlugin.mockRejectedValueOnce(new Error('plugin detail unavailable'));
    getPluginSettings.mockResolvedValue({ schema: undefined, values: {}, secretsConfigured: [] });
    const container = await renderSettingsPage();
    await until(() => container.querySelector('[data-plugin-settings-manifest-error]') !== null);
    // The page does not know whether a panel exists, so it must not claim the plugin declares nothing.
    expect(container.querySelector('[data-plugin-settings-none]')).toBeNull();
    expect(container.textContent).toContain('plugin detail unavailable');

    getPlugin.mockResolvedValue({
      ...INSTALLED,
      manifest: manifest('kiki', [{ slot: 'settings', id: 'prefs', label: 'Preferences' }]),
    });
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.click();
      await new Promise((done) => setTimeout(done, 0));
    });
    await until(() => container.querySelector('iframe') !== null);
    expect(container.querySelector('[data-plugin-settings-manifest-error]')).toBeNull();
    expect(getPluginPanelDocument).toHaveBeenCalledWith('field-notes', 'prefs');
  });

  it('keeps the settings iframe mounted when a background refetch mints a new grant URL for unchanged HTML', async () => {
    getPluginPanelDocument
      .mockResolvedValueOnce({ html, url: '/plugin-panel/grant-a' })
      .mockResolvedValueOnce({ html, url: '/plugin-panel/grant-b' });
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <PluginSettingsPanel pluginId="kiki-media" panelId="settings" label="Settings" />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    const frame = await waitFrame(container);
    await awaitInit(frame);
    expect(frame.getAttribute('src')).toBe('https://server.example.test/plugin-panel/grant-a');

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-panel-document'] });
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(2);
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame.getAttribute('src')).toBe('https://server.example.test/plugin-panel/grant-a');
  });

  it('adopts a refreshed grant on settings remount when the cached entry exceeds the reuse window', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(
      ['plugin-panel-document', 'scope-a', 'server-a', 'kiki-media', 'settings', 'settings'],
      { html, url: '/plugin-panel/expired-grant' },
      { updatedAt: Date.now() - 11 * 60_000 },
    );
    getPluginPanelDocument.mockResolvedValueOnce({ html, url: '/plugin-panel/fresh-grant' });

    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <PluginSettingsPanel pluginId="kiki-media" panelId="settings" label="Settings" />
          </I18nProvider>
        </QueryClientProvider>,
      );
      await new Promise((done) => setTimeout(done, 0));
    });
    await waitFrame(container);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (container.querySelector('iframe')?.getAttribute('src')?.endsWith('/fresh-grant')) break;
      await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    }
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(1);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://server.example.test/plugin-panel/fresh-grant');
    queryClient.clear();
  });
});


describe('the settings panel stream bridge', () => {
  it('opens with a transferred port and relays binary, text, object and close frames', async () => {
    let binaryListener: ((chunk: ArrayBuffer) => void) | undefined;
    let textListener: ((text: string) => void) | undefined;
    let closeListener: ((code: number, reason: string) => void) | undefined;
    const stream = {
      result: { ready: true },
      sendBinary: vi.fn(() => true),
      sendText: vi.fn(() => true),
      close: vi.fn(),
      onBinary: vi.fn((listener: (chunk: ArrayBuffer) => void) => { binaryListener = listener; return () => { binaryListener = undefined; }; }),
      onText: vi.fn((listener: (text: string) => void) => { textListener = listener; return () => { textListener = undefined; }; }),
      onClose: vi.fn((listener: (code: number, reason: string) => void) => { closeListener = listener; return () => { closeListener = undefined; }; }),
    };
    openPluginPanelStream.mockResolvedValueOnce(stream);
    const { frame, posted } = await renderPanel();
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 90, method: 'plugin.openStream', stream: 'settings-live', args: { mode: 'compact' } });
      await new Promise((done) => setTimeout(done, 0));
    });

    const channel = SettingsTestMessageChannel.instances[0]!;
    const response = posted.find((message) => (message as { id?: number }).id === 90) as Record<string, unknown>;
    expect(openPluginPanelStream).toHaveBeenCalledWith('kiki-media', 'settings', {
      stream: 'settings-live', args: { mode: 'compact' }, session_id: undefined, workspace_id: undefined,
    });
    expect(response).toMatchObject({ ok: true, result: { ready: true } });
    expect(response).not.toHaveProperty('port');
    const transferLog = framePostTransfers.get(frame.contentWindow!) ?? [];
    expect(transferLog[posted.indexOf(response)]).toEqual([channel.port2]);

    const binary = new ArrayBuffer(2);
    const view = new Uint8Array([7, 8]);
    await act(async () => {
      channel.port1.dispatch(binary);
      channel.port1.dispatch(view);
      channel.port1.dispatch('text-input');
      channel.port1.dispatch({ action: 'update' });
      binaryListener?.(new ArrayBuffer(3));
      textListener?.('text-output');
    });
    expect(stream.sendBinary.mock.calls).toEqual([[binary], [view]]);
    expect(stream.sendText.mock.calls).toEqual([['text-input'], [JSON.stringify({ action: 'update' })]]);
    expect(channel.port1.postMessage).toHaveBeenCalledWith('text-output');

    await act(async () => { closeListener?.(1001, 'going away'); });
    expect(channel.port1.postMessage).toHaveBeenCalledWith({ __kikiStreamEvent: 'close', code: 1001, reason: 'going away' });
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).not.toHaveBeenCalled();
  });
});


describe('settings panel stream lifetimes', () => {
  it('closes streams on iframe reload, document identity change, and unmount, including pending opens', async () => {
    const makeStream = () => ({
      result: true,
      sendBinary: vi.fn(() => true),
      sendText: vi.fn(() => true),
      close: vi.fn(),
      onBinary: vi.fn(() => vi.fn()),
      onText: vi.fn(() => vi.fn()),
      onClose: vi.fn(() => vi.fn()),
    });

    const reloadStream = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(reloadStream);
    const { frame: reloadFrame } = await renderPanel();
    await act(async () => {
      request(reloadFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 91, method: 'plugin.openStream', stream: 'settings-live' });
      await new Promise((done) => setTimeout(done, 0));
    });
    const reloadChannel = SettingsTestMessageChannel.instances[0]!;
    await act(async () => { reloadFrame.dispatchEvent(new Event('load')); });
    expect(reloadStream.close).toHaveBeenCalledTimes(1);
    expect(reloadChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(reloadChannel.port2.close).toHaveBeenCalledTimes(1);

    let finish!: (stream: ReturnType<typeof makeStream>) => void;
    openPluginPanelStream.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { frame: oldFrame } = await renderPanel();
    await act(async () => {
      request(oldFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 92, method: 'plugin.openStream', stream: 'settings-live' });
    });
    const pendingChannel = SettingsTestMessageChannel.instances[1]!;
    const { root, queryClient } = renderings.get(oldFrame)!;
    connectionBag.scopeId = 'scope-b';
    await act(async () => { root.render(settingsPanelElement(queryClient)); });
    expect(pendingChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(pendingChannel.port2.close).toHaveBeenCalledTimes(1);
    const stale = makeStream();
    await act(async () => { finish(stale); await Promise.resolve(); });
    expect(stale.close).toHaveBeenCalledTimes(1);

    const unmountStream = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(unmountStream);
    const { frame: unmountFrame } = await renderPanel();
    await act(async () => {
      request(unmountFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 93, method: 'plugin.openStream', stream: 'settings-live' });
      await new Promise((done) => setTimeout(done, 0));
    });
    const unmountChannel = SettingsTestMessageChannel.instances[2]!;
    const unmountRoot = renderings.get(unmountFrame)!.root;
    await act(async () => { unmountRoot.unmount(); });
    roots.splice(roots.indexOf(unmountRoot), 1);
    expect(unmountStream.close).toHaveBeenCalledTimes(1);
    expect(unmountChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(unmountChannel.port2.close).toHaveBeenCalledTimes(1);
  });
});
