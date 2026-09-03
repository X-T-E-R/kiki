import * as vscode from "vscode";

import { ensureDaemon } from "./daemon";
import { KimiWebviewProvider } from "./KimiWebviewProvider";

let outputChannel: vscode.OutputChannel | undefined;
let provider: KimiWebviewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Kimi Code");
  const remoteInfo = vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : "";
  log(`Kimi Code ${context.extension.packageJSON.version as string} activating${remoteInfo}`);

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const connection = await ensureDaemon({ workspacePath });
  log(`Attached to Kimi daemon at ${connection.url}`);

  provider = new KimiWebviewProvider(context.extensionUri, connection);
  context.subscriptions.push(
    provider,
    outputChannel,
    vscode.window.registerWebviewViewProvider("kimi.webview", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("kimi.openInTab", () => provider?.createPanel()),
    vscode.commands.registerCommand("kimi.openInSideBar", () =>
      vscode.commands.executeCommand("kimi.webview.focus"),
    ),
    vscode.commands.registerCommand("kimi.showLogs", () => outputChannel?.show()),
    vscode.commands.registerCommand("kimi.resetKimi", () => provider?.reloadAllWebviews()),
  );

  log("Kimi Code activated");
}

export function deactivate(): void {
  log("Kimi Code deactivating");
  provider?.dispose();
  provider = undefined;
}

function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export { log };
