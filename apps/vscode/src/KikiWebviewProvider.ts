import { readFile } from "node:fs/promises";

import * as vscode from "vscode";

import type { VscodeIntegrationSettings } from "./settings";
import { VscodeHostBridge } from "./vscode-host-bridge";
import type { WebviewConnection } from "./webview-connection";

export class KikiWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly webviews = new Set<vscode.Webview>();
  private readonly bridge: VscodeHostBridge;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connection: WebviewConnection,
    settings: VscodeIntegrationSettings,
  ) {
    this.bridge = new VscodeHostBridge(connection, settings);
  }

  updateSettings(settings: VscodeIntegrationSettings): void {
    this.bridge.updateSettings(settings);
    for (const webview of this.webviews) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      void webview.postMessage({ channel: "kiki.vscode-host.settingsChanged", settings });
    }
  }

  dispose(): void {
    this.webviews.clear();
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    await this.setupWebview(webviewView.webview);
    webviewView.onDidDispose(() => this.webviews.delete(webviewView.webview));
  }

  createPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel("kikiPanel", "Kiki", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.guiRoot],
    });
    void this.setupWebview(panel.webview);
    panel.onDidDispose(() => this.webviews.delete(panel.webview));
    return panel;
  }

  reloadAllWebviews(): void {
    for (const webview of this.webviews) void this.loadHtml(webview);
  }

  private get guiRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, "media", "gui");
  }

  private async setupWebview(webview: vscode.Webview): Promise<void> {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.guiRoot],
    };
    this.webviews.add(webview);
    webview.onDidReceiveMessage(async (message: unknown) => {
      const response = await this.bridge.handle(message);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      if (response !== null) await webview.postMessage(response);
    });
    await this.loadHtml(webview);
  }

  private async loadHtml(webview: vscode.Webview): Promise<void> {
    const source = await readFile(vscode.Uri.joinPath(this.guiRoot, "index.html").fsPath, "utf8");
    webview.html = this.renderHtml(source, webview);
  }

  private renderHtml(source: string, webview: vscode.Webview): string {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob: ${this.connection.restOrigin}`,
      `font-src ${webview.cspSource} data:`,
      `media-src ${webview.cspSource} data: blob: ${this.connection.restOrigin}`,
      `connect-src ${webview.cspSource} ${this.connection.restOrigin} ${this.connection.socketOrigin}`,
      `worker-src ${webview.cspSource} blob:`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    ].join("; ");
    const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    return source
      .replace("<head>", `<head>${head}`)
      .replaceAll(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
      .replaceAll(/\b(src|href)="(?![a-z]+:|data:|#)([^"?]+)([^"]*)"/gi, (_match, attribute, path, suffix) => {
        const segments = String(path).replace(/^\.\//, "").replace(/^\//, "").split("/");
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(this.guiRoot, ...segments));
        return `${attribute}="${uri.toString()}${suffix}"`;
      });
  }
}
