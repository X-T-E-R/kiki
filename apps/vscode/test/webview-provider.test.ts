import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KimiWebviewProvider } from "../src/KimiWebviewProvider";

const host = vi.hoisted(() => {
  class Uri {
    constructor(readonly fsPath: string) {}
    static joinPath(base: Uri, ...segments: string[]): Uri {
      return new Uri(join(base.fsPath, ...segments));
    }
    static file(path: string): Uri {
      return new Uri(path);
    }
    static parse(value: string): Uri {
      return new Uri(value);
    }
  }
  return { Uri };
});

vi.mock("vscode", () => ({
  Uri: host.Uri,
  ViewColumn: { One: 1 },
  window: {},
  workspace: { fs: {} },
  commands: {},
  env: {},
}));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GUI webview carrier", () => {
  it("loads local GUI assets and injects loopback connection policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "kiki-vscode-webview-"));
    roots.push(root);
    await mkdir(join(root, "media", "gui", "assets"), { recursive: true });
    await writeFile(
      join(root, "media", "gui", "index.html"),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css"></body></html>',
    );

    let receiveMessage: ((message: unknown) => Promise<void>) | undefined;
    const webview = {
      html: "",
      options: {},
      cspSource: "vscode-webview://test",
      asWebviewUri: (uri: { fsPath: string }) => ({
        toString: () => `vscode-resource:${uri.fsPath.replaceAll("\\", "/")}`,
      }),
      onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
        receiveMessage = handler;
        return { dispose: vi.fn() };
      },
      postMessage: vi.fn(async () => true),
    };
    const view = {
      webview,
      onDidDispose: vi.fn(),
    };
    const provider = new KimiWebviewProvider(new host.Uri(root) as never, {
      url: "http://127.0.0.1:8123",
      token: "secret-token",
    });

    await provider.resolveWebviewView(view as never);

    expect(webview.html).toContain('Content-Security-Policy');
    expect(webview.html).toContain('connect-src vscode-webview://test http://127.0.0.1:*');
    expect(webview.html).toContain('ws://127.0.0.1:*');
    expect(webview.html).not.toContain('secret-token');
    expect(webview.html).toContain(`src="vscode-resource:${root.replaceAll("\\", "/")}/media/gui/assets/app.js"`);
    expect(webview.html).toContain(`href="vscode-resource:${root.replaceAll("\\", "/")}/media/gui/assets/app.css"`);

    await receiveMessage?.({
      channel: "kiki.vscode-host.request",
      id: "connection-1",
      method: "connection.discover",
      params: {},
    });
    expect(webview.postMessage).toHaveBeenCalledWith({
      channel: "kiki.vscode-host.response",
      id: "connection-1",
      ok: true,
      result: {
        config: { url: "http://127.0.0.1:8123", token: "secret-token" },
        persist: false,
      },
    });
  });
});
