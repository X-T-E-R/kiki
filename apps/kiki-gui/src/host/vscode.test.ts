/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  vi.resetModules();
});

describe('VS Code webview host adapter', () => {
  it('sends host requests and resolves matching responses', async () => {
    const postMessage = vi.fn();
    (globalThis as { acquireVsCodeApi?: () => { postMessage: typeof postMessage } }).acquireVsCodeApi =
      () => ({ postMessage });
    const { requestVscodeHost } = await import('./vscode');

    const response = requestVscodeHost<{ url: string }>('connection.discover');
    const request = postMessage.mock.calls[0]?.[0] as { id: string };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          channel: 'kiki.vscode-host.response',
          id: request.id,
          ok: true,
          result: { url: 'http://127.0.0.1:8123' },
        },
      }),
    );

    await expect(response).resolves.toEqual({ url: 'http://127.0.0.1:8123' });
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'kiki.vscode-host.request',
      id: expect.any(String),
      method: 'connection.discover',
      params: {},
    });
  });

  it('maps host errors to rejected requests', async () => {
    const postMessage = vi.fn();
    (globalThis as { acquireVsCodeApi?: () => { postMessage: typeof postMessage } }).acquireVsCodeApi =
      () => ({ postMessage });
    const { vscodeHost } = await import('./vscode');

    const response = vscodeHost.writeClipboard('text');
    const request = postMessage.mock.calls[0]?.[0] as { id: string };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          channel: 'kiki.vscode-host.response',
          id: request.id,
          ok: false,
          error: 'clipboard unavailable',
        },
      }),
    );

    await expect(response).rejects.toThrow('clipboard unavailable');
  });
});
