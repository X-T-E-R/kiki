import { basename, extname } from "node:path";

import * as vscode from "vscode";

import type { DaemonConnection } from "./daemon";
import type { VscodeIntegrationSettings } from "./settings";

interface HostRequest {
  readonly channel: "kiki.vscode-host.request";
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface HostResponse {
  readonly channel: "kiki.vscode-host.response";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/** Schemes the system handler may be asked to open from webview content. */
const EXTERNAL_OPEN_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export class VscodeHostBridge {
  private readonly injectedEditorContext = new Map<string, string>();
  private readonly connection: DaemonConnection;

  constructor(
    connection: DaemonConnection,
    private settings: VscodeIntegrationSettings,
  ) {
    this.connection = { url: connection.url, token: connection.token };
  }

  updateSettings(settings: VscodeIntegrationSettings): void {
    this.settings = settings;
  }

  async handle(message: unknown): Promise<HostResponse | null> {
    const request = parseHostRequest(message);
    if (request === null) return null;
    try {
      return {
        channel: "kiki.vscode-host.response",
        id: request.id,
        ok: true,
        result: await this.dispatch(request),
      };
    } catch (error) {
      return {
        channel: "kiki.vscode-host.response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async dispatch(request: HostRequest): Promise<unknown> {
    switch (request.method) {
      case "connection.discover":
        return { config: this.connection, persist: false };
      case "editor.preparePrompt":
        return this.preparePrompt(request.params);
      case "window.notify":
        await vscode.window.showInformationMessage(readString(request.params, "title"), {
          detail: readOptionalString(request.params, "body"),
          modal: false,
        });
        return undefined;
      case "window.focused":
        return vscode.window.state.focused;
      case "file.pick":
        return this.pickFiles();
      case "directory.pick":
        return this.pickDirectories(false);
      case "directory.pickMany":
        return this.pickDirectories(true);
      case "file.save":
        return this.saveFile(request.params);
      case "file.writeText":
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(readString(request.params, "path")),
          new TextEncoder().encode(readString(request.params, "text")),
        );
        return undefined;
      case "file.open":
        return this.openFile(request.params);
      case "path.reveal":
        await vscode.commands.executeCommand(
          "revealInExplorer",
          vscode.Uri.file(readString(request.params, "path")),
        );
        return undefined;
      case "diff.open":
        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.file(readString(request.params, "originalPath")),
          vscode.Uri.file(readString(request.params, "modifiedPath")),
          readOptionalString(request.params, "title"),
        );
        return undefined;
      case "terminal.open": {
        const cwd = readOptionalString(request.params, "cwd");
        const terminal = vscode.window.createTerminal({ cwd });
        terminal.show();
        return undefined;
      }
      case "clipboard.write":
        await vscode.env.clipboard.writeText(readString(request.params, "text"));
        return undefined;
      case "external.open":
        await this.openExternal(readString(request.params, "url"));
        return undefined;
      default:
        throw new Error(`Unknown VS Code host method: ${request.method}`);
    }
  }

  private async openExternal(url: string): Promise<void> {
    // `vscode.env.openExternal` hands any registered scheme to the OS.
    // Webview content reaches this path, so restrict it to web and mail
    // schemes; everything else (e.g. `ms-msdt:`, `search-ms:`) would launch a
    // local protocol handler.
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
    if (scheme === undefined || !EXTERNAL_OPEN_SCHEMES.has(`${scheme}:`)) {
      throw new Error(`Refusing to open external URL with scheme ${scheme ?? "(none)"}`);
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async pickFiles(): Promise<unknown> {
    const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: true });
    if (uris === undefined) return null;
    return Promise.all(
      uris.map(async (uri) => {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return {
          name: basename(uri.fsPath),
          type: mimeTypeForPath(uri.fsPath),
          bytes: [...bytes],
        };
      }),
    );
  }

  private async pickDirectories(many: boolean): Promise<string | readonly string[] | null> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: many,
    });
    if (uris === undefined) return null;
    return many ? uris.map((uri) => uri.fsPath) : (uris[0]?.fsPath ?? null);
  }

  private async saveFile(params: Record<string, unknown>): Promise<boolean> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(readString(params, "filename")),
    });
    if (target === undefined) return false;
    await vscode.workspace.fs.writeFile(target, Uint8Array.from(readNumberArray(params, "bytes")));
    return true;
  }

  private async openFile(params: Record<string, unknown>): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(readString(params, "path")));
    const editor = await vscode.window.showTextDocument(document);
    const line = readOptionalNumber(params, "line");
    if (line === undefined) return;
    const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, (readOptionalNumber(params, "column") ?? 1) - 1));
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  }

  private async preparePrompt(params: Record<string, unknown>): Promise<string> {
    const content = readString(params, "content");
    if (this.settings.autosave) await vscode.workspace.saveAll(false);
    const includeEditorContext = readOptionalBoolean(params, "includeEditorContext") ?? true;
    if (!includeEditorContext || this.settings.editorContext === "never") return content;

    const editor = vscode.window.activeTextEditor;
    const workspace = editor === undefined ? undefined : vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (editor === undefined || workspace === undefined) return content;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false).replaceAll("\\", "/");
    const conversationId = readOptionalString(params, "conversationId") ?? "new-conversation";
    const lastPath = this.injectedEditorContext.get(conversationId);
    if (this.settings.editorContext === "onConversationStart" && lastPath !== undefined) return content;
    if (this.settings.editorContext === "onFileChange" && lastPath === relativePath) return content;

    this.injectedEditorContext.set(conversationId, relativePath);
    const selection = editor.selection;
    const selectionInfo = selection.isEmpty
      ? ""
      : ` (L${selection.start.line + 1}-${selection.end.line + 1} selected)`;
    const unsavedInfo = editor.document.isDirty ? ", unsaved" : "";
    const context = `<system>Editor context (use only if relevant to user's query): ${relativePath}:${selection.active.line + 1}${selectionInfo}${unsavedInfo}.</system>`;
    return `${content}\n${context}`;
  }
}

export function parseHostRequest(message: unknown): HostRequest | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const value = message as Record<string, unknown>;
  if (value["channel"] !== "kiki.vscode-host.request") return null;
  if (
    typeof value["id"] !== "string" ||
    typeof value["method"] !== "string" ||
    typeof value["params"] !== "object" ||
    value["params"] === null ||
    Array.isArray(value["params"])
  ) {
    return null;
  }
  return {
    channel: "kiki.vscode-host.request",
    id: value["id"],
    method: value["method"],
    params: value["params"] as Record<string, unknown>,
  };
}

function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new TypeError(`${key} must be a string.`);
  return value;
}

function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${key} must be a string.`);
  return value;
}

function readOptionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new TypeError(`${key} must be a number.`);
  return value;
}

function readOptionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean.`);
  return value;
}

function readNumberArray(params: Record<string, unknown>, key: string): readonly number[] {
  const value = params[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) {
    throw new TypeError(`${key} must be a number array.`);
  }
  return value;
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
