import * as vscode from "vscode";

export type EditorContextMode = "never" | "onConversationStart" | "onFileChange";

export interface VscodeIntegrationSettings {
  readonly autosave: boolean;
  readonly editorContext: EditorContextMode;
}

interface SettingInspection {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
}

const SETTING_SCOPES = [
  { inspectionKey: "globalValue", target: vscode.ConfigurationTarget.Global },
  { inspectionKey: "workspaceValue", target: vscode.ConfigurationTarget.Workspace },
  { inspectionKey: "workspaceFolderValue", target: vscode.ConfigurationTarget.WorkspaceFolder },
] as const;

export async function migrateLegacyIntegrationSettings(): Promise<void> {
  const legacy = vscode.workspace.getConfiguration("kimi");
  const current = vscode.workspace.getConfiguration("kiki");
  await migrateSetting(legacy, current, "autosave", isBoolean);
  await migrateSetting(legacy, current, "editorContext", isEditorContextMode);
}

export function readIntegrationSettings(): VscodeIntegrationSettings {
  const configuration = vscode.workspace.getConfiguration("kiki");
  return {
    autosave: configuration.get("autosave", true),
    editorContext: configuration.get("editorContext", "never"),
  };
}

async function migrateSetting(
  legacy: vscode.WorkspaceConfiguration,
  current: vscode.WorkspaceConfiguration,
  key: string,
  isValid: (value: unknown) => boolean,
): Promise<void> {
  const legacyInspection = legacy.inspect<unknown>(key) as SettingInspection | undefined;
  const currentInspection = current.inspect<unknown>(key) as SettingInspection | undefined;
  if (hasExplicitValue(currentInspection)) return;

  if (legacyInspection === undefined) {
    const legacyValue = legacy.get<unknown>(key);
    if (isValid(legacyValue)) {
      await current.update(key, legacyValue, vscode.ConfigurationTarget.Global);
    }
    return;
  }

  for (const scope of SETTING_SCOPES) {
    const legacyValue = legacyInspection[scope.inspectionKey];
    if (!isValid(legacyValue)) continue;
    await current.update(key, legacyValue, scope.target);
  }
}

function hasExplicitValue(inspection: SettingInspection | undefined): boolean {
  return SETTING_SCOPES.some(({ inspectionKey }) => inspection?.[inspectionKey] !== undefined);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isEditorContextMode(value: unknown): value is EditorContextMode {
  return value === "never" || value === "onConversationStart" || value === "onFileChange";
}
