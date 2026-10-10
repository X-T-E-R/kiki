import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface ExternalClientLocalCredential {
  readonly mcpUrl: URL | string;
  readonly token: string;
}

export interface ExternalClientStdioBridgeOptions {
  readonly connectionId: string;
  readonly resolveCredential: (connectionId: string) => Promise<ExternalClientLocalCredential | null>;
  readonly fetch?: typeof globalThis.fetch;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface ExternalClientStdioBridge {
  readonly server: Server;
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
}

export async function createExternalClientStdioBridge(
  options: ExternalClientStdioBridgeOptions,
): Promise<ExternalClientStdioBridge> {
  const initialCredential = await options.resolveCredential(options.connectionId);
  if (initialCredential === null) throw new Error('External client local credential is unavailable.');
  if (initialCredential.token.length === 0) throw new Error('External client local credential is invalid.');
  const endpoint = parseExternalClientEndpoint(initialCredential.mcpUrl);
  let currentToken = initialCredential.token;
  let refreshPromise: Promise<void> | undefined;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const fetchWithCredential: typeof globalThis.fetch = async (input, init) => {
    const requestToken = currentToken;
    const response = await baseFetch(input, withAuthorization(init, requestToken));
    if (response.status !== 401) return response;
    await response.body?.cancel();
    if (currentToken === requestToken) {
      refreshPromise ??= refreshCredential(options, endpoint).then((token) => {
        currentToken = token;
      }).finally(() => {
        refreshPromise = undefined;
      });
      await refreshPromise;
    } else if (refreshPromise !== undefined) {
      await refreshPromise;
    }
    return baseFetch(input, withAuthorization(init, currentToken));
  };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: fetchWithCredential,
  });
  const client = new Client({
    name: options.clientName ?? 'kiki-stdio-bridge',
    version: options.clientVersion ?? '0.3.3',
  });
  await client.connect(transport);
  await client.listTools();
  const server = new Server(
    { name: 'kiki-external-client-stdio', version: '0.3.3' },
    { capabilities: { tools: { listChanged: true } } },
  );
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    void server.sendToolListChanged().catch(() => undefined);
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (
    request,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<CallToolResult> => {
    const result = await client.callTool(
      { name: request.params.name, arguments: asRecord(request.params.arguments), _meta: asRecord(extra._meta ?? request.params._meta) },
      undefined,
      { signal: extra.signal },
    );
    return normalizeResult(result);
  });
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  let closePromise: Promise<void> | undefined;
  return {
    server,
    client,
    transport,
    close() {
      closePromise ??= (async () => {
        await server.close();
        await client.close();
      })();
      return closePromise;
    },
  };
}

export async function runExternalClientStdioBridge(options: ExternalClientStdioBridgeOptions): Promise<void> {
  await createExternalClientStdioBridge(options);
}

function parseExternalClientEndpoint(value: URL | string): URL {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('External client MCP URL is invalid.');
  return endpoint;
}

function withAuthorization(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
}

async function refreshCredential(
  options: ExternalClientStdioBridgeOptions,
  endpoint: URL,
): Promise<string> {
  const credential = await options.resolveCredential(options.connectionId);
  if (credential === null) throw new Error('External client local credential is unavailable.');
  if (credential.token.length === 0) throw new Error('External client local credential is invalid.');
  const nextEndpoint = parseExternalClientEndpoint(credential.mcpUrl);
  if (nextEndpoint.href !== endpoint.href) throw new Error('External client MCP endpoint changed; restart the stdio bridge.');
  return credential.token;
}

function normalizeResult(value: unknown): CallToolResult {
  if (isRecord(value) && Array.isArray(value['content'])) return value as unknown as CallToolResult;
  return { content: [{ type: 'text', text: safeJson(value) }] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded ?? String(value);
  } catch {
    return '[unserializable MCP result]';
  }
}
