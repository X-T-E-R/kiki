// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginPanelHost } from './PluginPanelHost';

const getPluginPanelDocument = vi.hoisted(() => vi.fn());
const connection = vi.hoisted(() => ({
  client: {
    baseUrl: 'https://server.example.test/root/',
    getPluginPanelDocument,
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

beforeEach(() => {
  getPluginPanelDocument.mockReset();
  connection.client.baseUrl = 'https://server.example.test/root/';
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

async function renderPanel(document: { readonly html: string; readonly url?: string }): Promise<HTMLIFrameElement> {
  getPluginPanelDocument.mockResolvedValueOnce(document);
  const container = window.document.createElement('div');
  window.document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PluginPanelHost pluginId="plugin-id" panelId="panel-id" />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (frame !== null) return frame;
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
});
