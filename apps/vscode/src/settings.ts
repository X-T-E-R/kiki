import * as vscode from "vscode";

export type EditorContextMode = "never" | "onConversationStart" | "onFileChange";

export interface VscodeIntegrationSettings {
  readonly autosave: boolean;
  readonly editorContext: EditorContextMode;
}

export function readIntegrationSettings(): VscodeIntegrationSettings {
  const configuration = vscode.workspace.getConfiguration("kimi");
  return {
    autosave: configuration.get("autosave", true),
    editorContext: configuration.get("editorContext", "never"),
  };
}
