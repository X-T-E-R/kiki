import type {
  McpManagedServer,
  McpManagedServerConfig,
  McpServerConfig,
  McpTransport,
} from '../transport';

export interface McpEditorDraft {
  readonly original?: McpManagedServer;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string;
  readonly args: string;
  readonly env: string;
  readonly url: string;
}

function mcpSecretMap(
  config: McpManagedServerConfig | undefined,
  field: 'env' | 'headers',
): Readonly<Record<string, string>> | undefined {
  if (config === undefined || !(field in config)) return undefined;
  const value = (config as unknown as Record<string, unknown>)[field];
  return value as Readonly<Record<string, string>> | undefined;
}

function mcpCommonConfig(config: McpManagedServerConfig | undefined) {
  return {
    enabled: config?.enabled,
    startupTimeoutMs: config?.startupTimeoutMs,
    toolTimeoutMs: config?.toolTimeoutMs,
    enabledTools: config?.enabledTools,
    disabledTools: config?.disabledTools,
  };
}

function parseMcpEnv(text: string): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === '') continue;
    const separator = raw.indexOf('=');
    if (separator <= 0) throw new Error('st.mcp.envInvalid');
    const key = raw.slice(0, separator).trim();
    if (key === '') throw new Error('st.mcp.envInvalid');
    entries.push([key, raw.slice(separator + 1)]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function mcpConfigFromDraft(draft: McpEditorDraft): McpServerConfig {
  const original = draft.original?.config;
  if (draft.transport === 'stdio') {
    const command = draft.command.trim();
    if (command === '') throw new Error('st.mcp.commandRequired');
    const kept = original?.transport === 'stdio'
      ? { cwd: original.cwd, executor: original.executor, runtime_id: original.runtime_id }
      : {};
    const args = draft.args.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    return {
      ...mcpCommonConfig(original),
      ...kept,
      transport: 'stdio',
      command,
      args: args.length === 0 ? undefined : args,
      env: parseMcpEnv(draft.env),
    };
  }
  const url = draft.url.trim();
  try {
    new URL(url);
  } catch {
    throw new Error('st.mcp.urlInvalid');
  }
  const kept = original !== undefined && original.transport === draft.transport
    ? {
        auth: original.auth,
        bearerTokenEnvVar: original.bearerTokenEnvVar,
        headers: mcpSecretMap(original, 'headers'),
      }
    : {};
  return {
    ...mcpCommonConfig(original),
    ...kept,
    transport: draft.transport,
    url,
  };
}
