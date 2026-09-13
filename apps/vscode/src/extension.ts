import * as vscode from "vscode";

import { ensureDaemon } from "./daemon";
import { KikiWebviewProvider } from "./KikiWebviewProvider";
import { migrateLegacyIntegrationSettings, readIntegrationSettings } from "./settings";
import { resolveWebviewConnection } from "./webview-connection";

let outputChannel: vscode.OutputChannel | undefined;
let provider: KikiWebviewProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Kiki");
  const remoteInfo = vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : "";
  log(`Kiki ${context.extension.packageJSON.version as string} activating${remoteInfo}`);

  try {
    await migrateLegacyIntegrationSettings();
  } catch (error) {
    log(`Kiki settings migration skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const connection = await ensureDaemon({ workspacePath });
  const webviewConnection = await resolveWebviewConnection(connection);
  log(`Attached to Kiki web server at ${connection.url}`);

  provider = new KikiWebviewProvider(context.extensionUri, webviewConnection, readIntegrationSettings());
  context.subscriptions.push(
    provider,
    outputChannel,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("kiki.autosave") || event.affectsConfiguration("kiki.editorContext")) {
        provider?.updateSettings(readIntegrationSettings());
      }
    }),
    vscode.window.registerWebviewViewProvider("kiki.webview", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("kiki.openInTab", () => provider?.createPanel()),
    vscode.commands.registerCommand("kiki.openInSideBar", () =>
      vscode.commands.executeCommand("kiki.webview.focus"),
    ),
    vscode.commands.registerCommand("kiki.showLogs", () => outputChannel?.show()),
    vscode.commands.registerCommand("kiki.resetKiki", () => provider?.reloadAllWebviews()),
  );

  log("Kiki activated");
}

export function deactivate(): void {
  log("Kiki deactivating");
  provider?.dispose();
  provider = undefined;
}

function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export { log };
