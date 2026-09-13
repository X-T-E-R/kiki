import { migrateLegacyIntegrationSettings, readIntegrationSettings } from "../src/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  const configurations = new Map<string, {
    inspect: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  }>();
  const getConfiguration = vi.fn((section: string) => {
    const configuration = configurations.get(section);
    if (configuration === undefined) throw new Error(`Missing configuration ${section}`);
    return configuration;
  });
  return { configurations, getConfiguration };
});

vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  workspace: { getConfiguration: host.getConfiguration },
}));

beforeEach(() => {
  host.configurations.clear();
  host.getConfiguration.mockClear();
});

describe("VS Code settings migration", () => {
  it("copies legacy values at their existing scopes", async () => {
    const legacy = makeConfiguration({
      autosave: { globalValue: false },
      editorContext: { workspaceValue: "onFileChange" },
    });
    const current = makeConfiguration({ autosave: {}, editorContext: {} });
    host.configurations.set("kimi", legacy);
    host.configurations.set("kiki", current);

    await migrateLegacyIntegrationSettings();

    expect(current.update).toHaveBeenNthCalledWith(1, "autosave", false, 1);
    expect(current.update).toHaveBeenNthCalledWith(2, "editorContext", "onFileChange", 2);
    expect(current.update).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite an explicitly configured Kiki value", async () => {
    const legacy = makeConfiguration({
      autosave: { globalValue: false },
      editorContext: { workspaceValue: "onFileChange" },
    });
    const current = makeConfiguration({
      autosave: { globalValue: true },
      editorContext: { workspaceValue: "never" },
    });
    host.configurations.set("kimi", legacy);
    host.configurations.set("kiki", current);

    await migrateLegacyIntegrationSettings();

    expect(current.update).not.toHaveBeenCalled();
  });

  it("falls back to the effective legacy value when the old setting is no longer registered", async () => {
    const legacy = makeConfiguration({}, { autosave: false, editorContext: "onConversationStart" });
    const current = makeConfiguration({}, { autosave: true, editorContext: "never" });
    host.configurations.set("kimi", legacy);
    host.configurations.set("kiki", current);

    await migrateLegacyIntegrationSettings();

    expect(current.update).toHaveBeenNthCalledWith(1, "autosave", false, 1);
    expect(current.update).toHaveBeenNthCalledWith(2, "editorContext", "onConversationStart", 1);
  });

  it("reads integration settings from the Kiki namespace", () => {
    const current = makeConfiguration({}, { autosave: false, editorContext: "onFileChange" });
    host.configurations.set("kiki", current);

    expect(readIntegrationSettings()).toEqual({ autosave: false, editorContext: "onFileChange" });
    expect(host.getConfiguration).toHaveBeenCalledWith("kiki");
  });
});

function makeConfiguration(
  inspections: Record<string, unknown>,
  values: Record<string, unknown> = {},
) {
  return {
    inspect: vi.fn((key: string) => inspections[key]),
    get: vi.fn((key: string, fallback: unknown) => values[key] ?? fallback),
    update: vi.fn(async () => undefined),
  };
}
