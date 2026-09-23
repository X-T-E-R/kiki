import { describe, expect, it, vi } from "vitest";

import { parseHostRequest, VscodeHostBridge } from "../src/vscode-host-bridge";

const host = vi.hoisted(() => {
  class Uri {
    constructor(readonly fsPath: string) {}
    static file(path: string): Uri {
      return new Uri(path);
    }
    static parse(value: string): Uri {
      return new Uri(value);
    }
  }
  class Position {
    constructor(readonly line: number, readonly character: number) {}
  }
  class Selection {
    constructor(readonly anchor: Position, readonly active: Position) {}
  }
  class Range {
    constructor(readonly start: Position, readonly end: Position) {}
  }
  return {
    Uri,
    Position,
    Selection,
    Range,
    executeCommand: vi.fn(async () => undefined),
    openTextDocument: vi.fn(async (uri: Uri) => ({ uri })),
    showTextDocument: vi.fn(async () => ({
      selection: undefined as Selection | undefined,
      revealRange: vi.fn(),
    })),
    showInformationMessage: vi.fn(async () => undefined),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    createTerminal: vi.fn(() => ({ show: vi.fn() })),
    readFile: vi.fn(),
    writeFile: vi.fn(async () => undefined),
    saveAll: vi.fn(async () => true),
    activeTextEditor: undefined as
      | {
          document: { uri: Uri; isDirty: boolean };
          selection: Selection & { isEmpty: boolean; start: Position; end: Position };
        }
      | undefined,
    clipboardWrite: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => true),
  };
});

vi.mock("vscode", () => ({
  Uri: host.Uri,
  Position: host.Position,
  Selection: host.Selection,
  Range: host.Range,
  commands: { executeCommand: host.executeCommand },
  workspace: {
    fs: { readFile: host.readFile, writeFile: host.writeFile },
    openTextDocument: host.openTextDocument,
    saveAll: host.saveAll,
    getWorkspaceFolder: () => ({ uri: new host.Uri("C:/repo") }),
    asRelativePath: () => "src/file.ts",
  },
  window: {
    state: { focused: true },
    get activeTextEditor() {
      return host.activeTextEditor;
    },
    showInformationMessage: host.showInformationMessage,
    showOpenDialog: host.showOpenDialog,
    showSaveDialog: host.showSaveDialog,
    showTextDocument: host.showTextDocument,
    createTerminal: host.createTerminal,
  },
  env: {
    clipboard: { writeText: host.clipboardWrite },
    openExternal: host.openExternal,
  },
}));

const bridge = new VscodeHostBridge(
  { url: "http://127.0.0.1:8123", token: "token" },
  { autosave: true, editorContext: "never" },
);

function request(method: string, params: Record<string, unknown> = {}) {
  return { channel: "kiki.vscode-host.request", id: "request-1", method, params };
}

describe("VS Code host bridge protocol", () => {
  it("ignores messages outside the bridge channel", () => {
    expect(parseHostRequest({ channel: "other", id: "1", method: "file.open", params: {} })).toBeNull();
    expect(parseHostRequest([])).toBeNull();
  });

  it("returns the daemon connection without persisting it in the webview", async () => {
    await expect(bridge.handle(request("connection.discover"))).resolves.toEqual({
      channel: "kiki.vscode-host.response",
      id: "request-1",
      ok: true,
      result: {
        config: { url: "http://127.0.0.1:8123", token: "token" },
        persist: false,
      },
    });
  });

  it("applies autosave and editor context settings before prompts", async () => {
    const position = new host.Position(6, 2);
    host.activeTextEditor = {
      document: { uri: new host.Uri("C:/repo/src/file.ts"), isDirty: false },
      selection: Object.assign(new host.Selection(position, position), {
        isEmpty: true,
        start: position,
        end: position,
      }),
    };
    bridge.updateSettings({ autosave: true, editorContext: "onFileChange" });

    const first = await bridge.handle(
      request("editor.preparePrompt", { content: "Question", conversationId: "session-1" }),
    );
    const second = await bridge.handle(
      request("editor.preparePrompt", { content: "Again", conversationId: "session-1" }),
    );

    expect(host.saveAll).toHaveBeenCalledTimes(2);
    expect(first?.result).toBe(
      "Question\n<system>Editor context (use only if relevant to user's query): src/file.ts:7.</system>",
    );
    expect(second?.result).toBe("Again");
    host.activeTextEditor = undefined;
  });

  it("runs autosave-only preflight without consuming editor context", async () => {
    host.saveAll.mockClear();
    const position = new host.Position(3, 0);
    host.activeTextEditor = {
      document: { uri: new host.Uri("C:/repo/src/file.ts"), isDirty: true },
      selection: Object.assign(new host.Selection(position, position), {
        isEmpty: true,
        start: position,
        end: position,
      }),
    };
    bridge.updateSettings({ autosave: true, editorContext: "onConversationStart" });

    const skill = await bridge.handle(
      request("editor.preparePrompt", {
        content: "",
        conversationId: "skill-session",
        includeEditorContext: false,
      }),
    );
    const prompt = await bridge.handle(
      request("editor.preparePrompt", {
        content: "Question",
        conversationId: "skill-session",
        includeEditorContext: true,
      }),
    );

    expect(skill?.result).toBe("");
    expect(prompt?.result).toContain("Editor context");
    expect(host.saveAll).toHaveBeenCalledTimes(2);
    host.activeTextEditor = undefined;
  });

  it("opens a file at a one-based line and column", async () => {
    const response = await bridge.handle(
      request("file.open", { path: "C:/repo/file.ts", line: 8, column: 3 }),
    );

    expect(response?.ok).toBe(true);
    expect(host.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "C:/repo/file.ts" }));
    const editor = await host.showTextDocument.mock.results.at(-1)?.value;
    expect(editor.selection).toEqual(
      new host.Selection(new host.Position(7, 2), new host.Position(7, 2)),
    );
  });

  it("dispatches diff, explorer, terminal, clipboard, and external actions", async () => {
    await bridge.handle(
      request("diff.open", {
        originalPath: "C:/repo/before.ts",
        modifiedPath: "C:/repo/after.ts",
        title: "Diff",
      }),
    );
    await bridge.handle(request("path.reveal", { path: "C:/repo/file.ts" }));
    await bridge.handle(request("terminal.open", { cwd: "C:/repo" }));
    await bridge.handle(request("clipboard.write", { text: "copied" }));
    await bridge.handle(request("external.open", { url: "https://example.com" }));

    expect(host.executeCommand).toHaveBeenCalledWith(
      "vscode.diff",
      expect.objectContaining({ fsPath: "C:/repo/before.ts" }),
      expect.objectContaining({ fsPath: "C:/repo/after.ts" }),
      "Diff",
    );
    expect(host.executeCommand).toHaveBeenCalledWith(
      "revealInExplorer",
      expect.objectContaining({ fsPath: "C:/repo/file.ts" }),
    );
    expect(host.createTerminal).toHaveBeenCalledWith({ cwd: "C:/repo" });
    expect(host.clipboardWrite).toHaveBeenCalledWith("copied");
    expect(host.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: "https://example.com" }),
    );
  });

  it("returns protocol errors for invalid method arguments", async () => {
    await expect(bridge.handle(request("file.open", { path: 42 }))).resolves.toEqual({
      channel: "kiki.vscode-host.response",
      id: "request-1",
      ok: false,
      error: "path must be a string.",
    });
  });

  it("refuses external.open with a non-web scheme before reaching openExternal", async () => {
    host.openExternal.mockClear();
    for (const url of ["ms-msdt:x", "search-ms:query", "file:///C:/Windows/System32/calc.exe", "not a url"]) {
      const response = await bridge.handle(request("external.open", { url }));
      expect(response?.ok, url).toBe(false);
      expect(response?.error, url).toContain("Refusing to open external URL");
    }
    expect(host.openExternal).not.toHaveBeenCalled();
  });

  it("still opens http, https, and mailto externally", async () => {
    host.openExternal.mockClear();
    await bridge.handle(request("external.open", { url: "https://example.com" }));
    await bridge.handle(request("external.open", { url: "http://example.com/a" }));
    await bridge.handle(request("external.open", { url: "mailto:someone@example.com" }));
    expect(host.openExternal).toHaveBeenCalledTimes(3);
  });
});
