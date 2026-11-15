// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginPanelHost } from './PluginPanelHost';
import { isPluginPanelStreamName } from './pluginPanelBridge';

const getPluginPanelDocument = vi.hoisted(() => vi.fn());
const openPluginPanelStream = vi.hoisted(() => vi.fn());
const connection = vi.hoisted(() => ({
  client: {
    baseUrl: 'https://server.example.test/root/',
    getPluginPanelDocument,
    openPluginPanelStream,
  },
}));

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => connection,
  useConnection: () => connection,
}));
vi.mock('../../host', () => ({ useHost: () => ({}) }));
vi.mock('../../host/external', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];
const renderings = new WeakMap<HTMLIFrameElement, { readonly root: Root; readonly queryClient: QueryClient }>();
const reactAct = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

class TestPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly messages: Array<{ readonly data: unknown; readonly transfer?: Transferable[] }> = [];
  readonly start = vi.fn();
  readonly close = vi.fn();
  postMessage = vi.fn((data: unknown, transfer?: Transferable[]) => { this.messages.push({ data, transfer }); });
  dispatch(data: unknown): void { this.onmessage?.({ data } as MessageEvent<unknown>); }
}

class TestMessageChannel {
  static readonly instances: TestMessageChannel[] = [];
  readonly port1 = new TestPort();
  readonly port2 = new TestPort();
  constructor() { TestMessageChannel.instances.push(this); }
}

beforeEach(() => {
  reactAct.IS_REACT_ACT_ENVIRONMENT = true;
  TestMessageChannel.instances.length = 0;
  vi.stubGlobal('MessageChannel', TestMessageChannel);
  getPluginPanelDocument.mockReset();
  openPluginPanelStream.mockReset();
  connection.client.baseUrl = 'https://server.example.test/root/';
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  reactAct.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

interface TestPanelProps {
  readonly pluginId?: string;
  readonly panelId?: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
}

function panelElement(queryClient: QueryClient, props: TestPanelProps = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <PluginPanelHost
        pluginId={props.pluginId ?? 'plugin-id'}
        panelId={props.panelId ?? 'panel-id'}
        sessionId={props.sessionId}
        workspaceId={props.workspaceId}
      />
    </QueryClientProvider>
  );
}

async function renderPanel(document: { readonly html: string; readonly url?: string }, props: TestPanelProps = {}): Promise<HTMLIFrameElement> {
  getPluginPanelDocument.mockResolvedValueOnce(document);
  const container = window.document.createElement('div');
  window.document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(panelElement(queryClient, props));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (frame !== null) {
      renderings.set(frame, { root, queryClient });
      return frame;
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error('plugin panel did not mount');
}

describe('PluginPanelHost document source', () => {
  it('resolves a server document URL against the connected client base URL', async () => {
    const frame = await renderPanel({ html: '<p>unused fallback</p>', url: '../panels/panel.html' });

    expect(frame.getAttribute('src')).toBe('https://server.example.test/panels/panel.html');
    expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it.each(['/plugin-panel/grant', 'http://document.kiki-document.localhost:1234/plugin-panel/grant'])('resolves %s for the same-origin web client', async (url) => {
    connection.client.baseUrl = '';
    const frame = await renderPanel({ html: '<p>panel</p>', url });
    expect(frame.getAttribute('src')).toBe(new URL(url, window.location.origin).toString());
    expect(frame.getAttribute('srcdoc')).toBeNull();
  });

  it('initializes the bridge again after a document navigation', async () => {
    const frame = await renderPanel({ html: '<p>panel</p>', url: '/plugin-panel/grant' });
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await act(async () => { frame.dispatchEvent(new Event('load')); });
    await act(async () => { frame.dispatchEvent(new Event('load')); });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith({ channel: 'kiki.panel.v1', kind: 'init', sessionId: null }, '*');
  });

  it('keeps using srcDoc when the server document has no URL', async () => {
    const html = '<!doctype html><html><body><p>legacy panel</p></body></html>';
    const frame = await renderPanel({ html });

    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.getAttribute('srcdoc')).toBe(html);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('preserves the live iframe grant URL across background refetches when HTML is unchanged, and updates when HTML changes', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPluginPanelDocument
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: '/plugin-panel/grant-1' })
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: '/plugin-panel/grant-2' })
      .mockResolvedValueOnce({ html: '<p>v2</p>', url: '/plugin-panel/grant-3' });

    const container = window.document.createElement('div');
    window.document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginPanelHost pluginId="plugin-id" panelId="panel-id" />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    let frame: HTMLIFrameElement | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      frame = container.querySelector<HTMLIFrameElement>('iframe');
      if (frame !== null) break;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('src')).toBe('https://server.example.test/plugin-panel/grant-1');

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-panel-document'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(2);
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame!.getAttribute('src')).toBe('https://server.example.test/plugin-panel/grant-1');

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-panel-document'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (frame!.getAttribute('src') === 'https://server.example.test/plugin-panel/grant-3') break;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(3);
    expect(frame!.getAttribute('src')).toBe('https://server.example.test/plugin-panel/grant-3');
  });

  it('adopts a refreshed grant after remounting with a cached document older than the reuse window', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(
      ['plugin-panel-document', 'plugin-id', 'panel-id', ''],
      { html: '<p>v1</p>', url: '/plugin-panel/expired-grant' },
      { updatedAt: Date.now() - 11 * 60_000 },
    );
    getPluginPanelDocument.mockResolvedValueOnce({ html: '<p>v1</p>', url: '/plugin-panel/fresh-grant' });

    const container = window.document.createElement('div');
    window.document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginPanelHost pluginId="plugin-id" panelId="panel-id" />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (container.querySelector('iframe')?.getAttribute('src')?.endsWith('/fresh-grant')) break;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(1);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://server.example.test/plugin-panel/fresh-grant');
    queryClient.clear();
  });

  it.each([
    { changeServer: true, changeEndpoint: false },
    { changeServer: false, changeEndpoint: true },
  ])('replaces the previous server grant after server generation recovery: %j', async ({ changeServer, changeEndpoint }) => {
    const bag = connection as typeof connection & { scopeId?: string; meta?: { server_id: string } };
    bag.scopeId = 'local';
    bag.meta = { server_id: 'server-a' };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPluginPanelDocument
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: 'http://grant-a.kiki-document.localhost:1234/plugin-panel/a' })
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: 'http://grant-a2.kiki-document.localhost:1234/plugin-panel/a2' })
      .mockResolvedValueOnce({ html: '<p>v1</p>', url: 'http://grant-b.kiki-document.localhost:5678/plugin-panel/b' });

    const container = window.document.createElement('div');
    window.document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const render = () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginPanelHost pluginId="plugin-id" panelId="panel-id" />
        </QueryClientProvider>,
      );

    await act(async () => {
      render();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let attempt = 0; attempt < 12 && container.querySelector('iframe') === null; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('http://grant-a.kiki-document.localhost:1234/plugin-panel/a');

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['plugin-panel-document'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('http://grant-a.kiki-document.localhost:1234/plugin-panel/a');

    bag.meta = { server_id: changeServer ? 'server-b' : 'server-a' };
    if (changeEndpoint) bag.client.baseUrl = 'https://new-server.example.test/root/';
    await act(async () => {
      render();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (container.querySelector('iframe')?.getAttribute('src') === 'http://grant-b.kiki-document.localhost:5678/plugin-panel/b') break;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(getPluginPanelDocument).toHaveBeenCalledTimes(3);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('http://grant-b.kiki-document.localhost:5678/plugin-panel/b');
    queryClient.clear();
    delete bag.scopeId;
    delete bag.meta;
  });
});


function request(frame: HTMLIFrameElement, data: Record<string, unknown>): void {
  const event = new MessageEvent('message', { data, origin: 'null' });
  Object.defineProperty(event, 'source', { value: frame.contentWindow });
  window.dispatchEvent(event);
}

function makeStream() {
  let binaryListener: ((chunk: ArrayBuffer) => void) | undefined;
  let textListener: ((text: string) => void) | undefined;
  let closeListener: ((code: number, reason: string) => void) | undefined;
  const unsubscribeBinary = vi.fn(() => { binaryListener = undefined; });
  const unsubscribeText = vi.fn(() => { textListener = undefined; });
  const unsubscribeClose = vi.fn(() => { closeListener = undefined; });
  const stream = {
    result: { started: true },
    sendBinary: vi.fn(() => true),
    sendText: vi.fn(() => true),
    close: vi.fn(),
    onBinary: vi.fn((listener: (chunk: ArrayBuffer) => void) => { binaryListener = listener; return unsubscribeBinary; }),
    onText: vi.fn((listener: (text: string) => void) => { textListener = listener; return unsubscribeText; }),
    onClose: vi.fn((listener: (code: number, reason: string) => void) => { closeListener = listener; return unsubscribeClose; }),
  };
  return {
    stream,
    unsubscribeBinary,
    unsubscribeText,
    unsubscribeClose,
    emitBinary: (chunk: ArrayBuffer) => binaryListener?.(chunk),
    emitText: (text: string) => textListener?.(text),
    emitClose: (code: number, reason: string) => closeListener?.(code, reason),
  };
}

describe('PluginPanelHost streams', () => {
  it('validates stream names at the panel boundary', () => {
    expect(isPluginPanelStreamName('camera_1')).toBe(true);
    expect(isPluginPanelStreamName('A-'.repeat(32))).toBe(true);
    expect(isPluginPanelStreamName('1camera')).toBe(false);
    expect(isPluginPanelStreamName('camera/1')).toBe(false);
    expect(isPluginPanelStreamName('a'.repeat(65))).toBe(false);
  });

  it('opens with pinned ids and context, and transfers port2 in the success response', async () => {
    const live = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(live.stream);
    const frame = await renderPanel({ html: '<p>panel</p>' }, { sessionId: 'session-a', workspaceId: 'workspace-a' });
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');

    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 31, method: 'plugin.openStream', stream: 'capture', args: { quality: 'high' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(openPluginPanelStream).toHaveBeenCalledWith('plugin-id', 'panel-id', {
      stream: 'capture', args: { quality: 'high' }, session_id: 'session-a', workspace_id: 'workspace-a',
      signal: expect.any(AbortSignal),
    });
    const streamOptions = openPluginPanelStream.mock.calls[0]?.[2] as { signal?: AbortSignal } | undefined;
    expect(streamOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(streamOptions?.signal?.aborted).toBe(false);
    const response = (post.mock.calls as unknown as Array<[unknown, string?, Transferable[]?]>)
      .map(([message, , transfer]) => ({ message: message as Record<string, unknown>, transfer }))
      .find(({ message }) => message['id'] === 31);
    expect(response?.message).toMatchObject({ channel: 'kiki.panel.v1', kind: 'response', id: 31, ok: true, result: { started: true } });
    expect(response?.message).not.toHaveProperty('port');
    expect(response?.transfer).toEqual([TestMessageChannel.instances[0]?.port2]);
  });

  it('routes upstream binary, text and object frames and forwards downstream frames without copying binary buffers', async () => {
    const live = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(live.stream);
    const frame = await renderPanel({ html: '<p>panel</p>' });
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 32, method: 'plugin.openStream', stream: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const { port1 } = TestMessageChannel.instances[0]!;

    const binary = new ArrayBuffer(4);
    const view = new Uint8Array([1, 2, 3]);
    await act(async () => {
      port1.dispatch(binary);
      port1.dispatch(view);
      port1.dispatch('upstream text');
      port1.dispatch({ kind: 'frame', count: 1 });
    });
    expect(live.stream.sendBinary.mock.calls).toEqual([[binary], [view]]);
    expect(live.stream.sendText.mock.calls).toEqual([['upstream text'], [JSON.stringify({ kind: 'frame', count: 1 })]]);

    const output = new ArrayBuffer(8);
    const outputCallStart = port1.postMessage.mock.calls.length;
    await act(async () => {
      live.emitBinary(output);
      live.emitText('downstream text');
    });
    expect(port1.postMessage.mock.calls[outputCallStart]).toEqual([output, [output]]);
    expect(port1.postMessage.mock.calls[outputCallStart + 1]).toEqual(['downstream text']);
    expect(post.mock.calls.some(([message]) => (message as { id?: number }).id === 32)).toBe(true);
  });

  it('does not rate-limit more than 150 port frames; only open requests consume the request budget', async () => {
    const live = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(live.stream);
    const frame = await renderPanel({ html: '<p>panel</p>' });
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 40, method: 'plugin.openStream', stream: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const port = TestMessageChannel.instances[0]!.port1;
    await act(async () => {
      for (let index = 0; index < 151; index += 1) port.dispatch(`frame-${index}`);
    });
    expect(live.stream.sendText).toHaveBeenCalledTimes(151);

    await act(async () => {
      for (let id = 41; id < 190; id += 1) {
        request(frame, { channel: 'kiki.panel.v1', kind: 'request', id, method: 'plugin.openStream', stream: '' });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const responses = post.mock.calls.map(([message]) => message as { id?: number; error?: string });
    expect(responses.find((message) => message.id === 189)?.error).toBe('invalid stream');
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 190, method: 'plugin.openStream', stream: '' });
    });
    expect(post.mock.calls.map(([message]) => message as { id?: number; error?: string })
      .find((message) => message.id === 190)?.error).toBe('rate limited');
    expect(openPluginPanelStream).toHaveBeenCalledTimes(1);
  });

  it('closes the stream and both ports on an upstream close control', async () => {
    const live = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(live.stream);
    const frame = await renderPanel({ html: '<p>panel</p>' });
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 50, method: 'plugin.openStream', stream: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const channel = TestMessageChannel.instances[0]!;

    await act(async () => { channel.port1.dispatch({ __kikiStreamControl: 'close' }); });

    expect(live.stream.close).toHaveBeenCalledTimes(1);
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).toHaveBeenCalledTimes(1);
    expect(live.unsubscribeBinary).toHaveBeenCalledTimes(1);
    expect(live.unsubscribeText).toHaveBeenCalledTimes(1);
    expect(live.unsubscribeClose).toHaveBeenCalledTimes(1);
  });

  it('posts a close event before closing the host port when the stream closes', async () => {
    const live = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(live.stream);
    const frame = await renderPanel({ html: '<p>panel</p>' });
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 51, method: 'plugin.openStream', stream: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const channel = TestMessageChannel.instances[0]!;

    await act(async () => { live.emitClose(1000, 'complete'); });

    expect(channel.port1.postMessage).toHaveBeenCalledWith({ __kikiStreamEvent: 'close', code: 1000, reason: 'complete' });
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).not.toHaveBeenCalled();
  });

  it('closes active streams on unmount and iframe reload', async () => {
    const unmountStream = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(unmountStream.stream);
    const unmountFrame = await renderPanel({ html: '<p>panel</p>' });
    await act(async () => {
      request(unmountFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 60, method: 'plugin.openStream', stream: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const unmountChannel = TestMessageChannel.instances[0]!;
    const unmountRoot = renderings.get(unmountFrame)!.root;
    await act(async () => { unmountRoot.unmount(); });
    roots.splice(roots.indexOf(unmountRoot), 1);
    expect(unmountStream.stream.close).toHaveBeenCalledTimes(1);
    expect(unmountChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(unmountChannel.port2.close).toHaveBeenCalledTimes(1);

    const reloadStream = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(reloadStream.stream);
    const reloadFrame = await renderPanel({ html: '<p>panel</p>' });
    await act(async () => {
      request(reloadFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 61, method: 'plugin.openStream', stream: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const reloadChannel = TestMessageChannel.instances[1]!;
    await act(async () => { reloadFrame.dispatchEvent(new Event('load')); });
    expect(reloadStream.stream.close).toHaveBeenCalledTimes(1);
    expect(reloadChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(reloadChannel.port2.close).toHaveBeenCalledTimes(1);
  });

  it('closes a pending open without transferring its port when the session/document changes', async () => {
    let finish!: (stream: ReturnType<typeof makeStream>['stream']) => void;
    openPluginPanelStream.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const frame = await renderPanel({ html: '<p>panel</p>' }, { sessionId: 'session-a' });
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await act(async () => {
      request(frame, { channel: 'kiki.panel.v1', kind: 'request', id: 70, method: 'plugin.openStream', stream: 'capture' });
    });
    const channel = TestMessageChannel.instances[0]!;
    const pendingSignal = (openPluginPanelStream.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal;
    expect(pendingSignal?.aborted).toBe(false);
    const { root, queryClient } = renderings.get(frame)!;
    getPluginPanelDocument.mockResolvedValue({ html: '<p>panel</p>' });
    await act(async () => { root.render(panelElement(queryClient, { sessionId: 'session-b' })); });
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).toHaveBeenCalledTimes(1);
    expect(pendingSignal?.aborted).toBe(true);
    const stale = makeStream();
    await act(async () => { finish(stale.stream); await Promise.resolve(); });

    expect(stale.stream.close).toHaveBeenCalledTimes(1);
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(channel.port2.close).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.some(([message]) => (message as { id?: number }).id === 70)).toBe(false);
  });

  it('closes a pending open after iframe reload and on component unmount', async () => {
    let finishReload!: (stream: ReturnType<typeof makeStream>['stream']) => void;
    openPluginPanelStream.mockReturnValueOnce(new Promise((resolve) => { finishReload = resolve; }));
    const reloadFrame = await renderPanel({ html: '<p>panel</p>' });
    await act(async () => {
      request(reloadFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 80, method: 'plugin.openStream', stream: 'capture' });
    });
    const reloadChannel = TestMessageChannel.instances[0]!;
    const reloadSignal = (openPluginPanelStream.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal;
    expect(reloadSignal?.aborted).toBe(false);
    await act(async () => { reloadFrame.dispatchEvent(new Event('load')); });
    expect(reloadSignal?.aborted).toBe(true);
    expect(reloadChannel.port1.close).toHaveBeenCalledTimes(1);
    const staleReload = makeStream();
    await act(async () => { finishReload(staleReload.stream); await Promise.resolve(); });
    expect(staleReload.stream.close).toHaveBeenCalledTimes(1);
    expect(reloadChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(reloadSignal?.aborted).toBe(true);
    expect(reloadChannel.port2.close).toHaveBeenCalledTimes(1);

    let finishUnmount!: (stream: ReturnType<typeof makeStream>['stream']) => void;
    openPluginPanelStream.mockReturnValueOnce(new Promise((resolve) => { finishUnmount = resolve; }));
    const unmountFrame = await renderPanel({ html: '<p>panel</p>' });
    await act(async () => {
      request(unmountFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 81, method: 'plugin.openStream', stream: 'capture' });
    });
    const unmountChannel = TestMessageChannel.instances[1]!;
    const unmountSignal = (openPluginPanelStream.mock.calls[1]?.[2] as { signal?: AbortSignal }).signal;
    expect(unmountSignal?.aborted).toBe(false);
    const unmountRoot = renderings.get(unmountFrame)!.root;
    await act(async () => { unmountRoot.unmount(); });
    roots.splice(roots.indexOf(unmountRoot), 1);
    expect(unmountSignal?.aborted).toBe(true);
    expect(unmountChannel.port1.close).toHaveBeenCalledTimes(1);
    const staleUnmount = makeStream();
    await act(async () => { finishUnmount(staleUnmount.stream); await Promise.resolve(); });
    expect(staleUnmount.stream.close).toHaveBeenCalledTimes(1);
    expect(unmountChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(unmountSignal?.aborted).toBe(true);
    expect(unmountChannel.port2.close).toHaveBeenCalledTimes(1);
  });
});


describe('PluginPanelHost stream boundary failures', () => {
  it('closes the stream instead of silently dropping unserializable or undeliverable frames', async () => {
    const serializationStream = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(serializationStream.stream);
    const serializationFrame = await renderPanel({ html: '<p>panel</p>' });
    await act(async () => {
      request(serializationFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 100, method: 'plugin.openStream', stream: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const serializationChannel = TestMessageChannel.instances[0]!;
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    serializationChannel.port1.dispatch(cyclic);
    expect(serializationStream.stream.close).toHaveBeenCalledTimes(1);
    expect(serializationChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(serializationChannel.port2.close).toHaveBeenCalledTimes(1);

    const deliveryStream = makeStream();
    openPluginPanelStream.mockResolvedValueOnce(deliveryStream.stream);
    const deliveryFrame = await renderPanel({ html: '<p>panel</p>' });
    await act(async () => {
      request(deliveryFrame, { channel: 'kiki.panel.v1', kind: 'request', id: 101, method: 'plugin.openStream', stream: 'capture' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const deliveryChannel = TestMessageChannel.instances[1]!;
    deliveryChannel.port1.postMessage.mockImplementationOnce(() => { throw new Error('port closed'); });
    deliveryStream.emitText('late output');
    expect(deliveryStream.stream.close).toHaveBeenCalledTimes(1);
    expect(deliveryChannel.port1.close).toHaveBeenCalledTimes(1);
    expect(deliveryChannel.port2.close).toHaveBeenCalledTimes(1);
  });
});
