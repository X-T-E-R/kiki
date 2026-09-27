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
  readonly headers: string;
  readonly bearerTokenEnvVar: string;
  readonly auth?: 'oauth';
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

function parseMcpLines(text: string, field: 'env' | 'headers'): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  const headerNames = new Set<string>();
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === '') continue;
    const separator = raw.indexOf('=');
    if (separator <= 0) throw new Error(`st.mcp.${field}Invalid`);
    const key = raw.slice(0, separator).trim();
    if (key === '' || (field === 'headers' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key))) {
      throw new Error(`st.mcp.${field}Invalid`);
    }
    if (field === 'headers') {
      const normalized = key.toLowerCase();
      if (headerNames.has(normalized)) throw new Error('st.mcp.headersDuplicate');
      headerNames.add(normalized);
    }
    entries.push([key, raw.slice(separator + 1)]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

export function mcpConfigFromDraft(draft: McpEditorDraft): McpServerConfig {
  const original = draft.original?.mutable ? draft.original.config : undefined;
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
      env: parseMcpLines(draft.env, 'env'),
    };
  }
  const url = draft.url.trim();
  try {
    new URL(url);
  } catch {
    throw new Error('st.mcp.urlInvalid');
  }
  const sameTarget = original !== undefined && original.transport === draft.transport && original.url === url;
  return {
    ...mcpCommonConfig(original),
    transport: draft.transport,
    url,
    headers: parseMcpLines(draft.headers, 'headers'),
    bearerTokenEnvVar: draft.bearerTokenEnvVar.trim() || undefined,
    auth: sameTarget ? draft.auth : undefined,
  };
}
