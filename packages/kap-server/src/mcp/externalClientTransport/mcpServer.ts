import type { ServerResponse } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  ExternalClientError,
  isActiveExternalClientGrant,
  type ExternalClientCallMeta,
  type ExternalClientToolDescriptor,
  type ExternalClientTransportHost,
} from './host';

export interface ExternalClientMcpServerOptions {
  readonly grantId: string;
  readonly transportSessionId?: () => string | undefined;
  readonly onError?: (error: unknown) => void;
}

interface CatalogSlot {
  response: ServerResponse | undefined;
  pending: boolean;
  tail: Promise<void>;
  report: (error: unknown) => void;
}

const catalogSlots = new WeakMap<Server, CatalogSlot>();

/** Mark this response as the open listener stream and flush a queued catalog notification. */
export function activateExternalClientCatalogListener(server: Server, response: ServerResponse): void {
  const slot = catalogSlots.get(server);
  if (slot === undefined) return;
  slot.response = response;
  if (!slot.pending) return;
  publishToolListChanged(server, slot);
}

/** Release this listener stream so a later matching catalog change stays queued. */
export function deactivateExternalClientCatalogListener(server: Server, response: ServerResponse): void {
  const slot = catalogSlots.get(server);
  if (slot === undefined || slot.response !== response) return;
  slot.response = undefined;
}

function publishToolListChanged(server: Server, slot: CatalogSlot): void {
  if (!isOpenStandaloneSse(slot.response)) {
    slot.pending = true;
    return;
  }
  const response = slot.response;
  slot.pending = false;
  const delivery = slot.tail.then(() => {
    if (slot.response !== response || !isOpenStandaloneSse(response)) {
      slot.pending = true;
      return;
    }
    return server.sendToolListChanged();
  });
  slot.tail = delivery.then(() => undefined, () => undefined);
  void delivery.then(() => undefined, (error: unknown) => {
    slot.report(error);
  });
}

function isOpenStandaloneSse(response: ServerResponse | undefined): boolean {
  if (response === undefined) return false;
  if (response.destroyed || response.writableEnded || response.closed) return false;
  if (response.req?.destroyed || response.req?.aborted) return false;
  if (response.socket?.destroyed) return false;
  if (!response.headersSent || response.statusCode !== 200) return false;
  return true;
}

export async function createExternalClientMcpServer(
  host: ExternalClientTransportHost,
  options: ExternalClientMcpServerOptions,
): Promise<Server> {
  const initialGrant = await host.resolveGrant(options.grantId);
  if (!isActiveExternalClientGrant(initialGrant)) throw new Error('External client connection is unavailable.');
  const server = new Server(
    { name: 'kiki-external-client', version: '0.3.3' },
    { capabilities: { tools: { listChanged: host.onCatalogChanged !== undefined } } },
  );
  const slot: CatalogSlot = {
    response: undefined,
    pending: false,
    tail: Promise.resolve(),
    report: (error) => {
      options.onError?.(error);
    },
  };
  catalogSlots.set(server, slot);
  const catalogSubscription = host.onCatalogChanged?.((grantId) => {
    if (grantId !== options.grantId) return;
    publishToolListChanged(server, slot);
  });
  const onclose = server.onclose;
  server.onclose = () => {
    catalogSubscription?.dispose();
    slot.response = undefined;
    slot.pending = false;
    catalogSlots.delete(server);
    onclose?.();
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const grant = await host.resolveGrant(options.grantId);
    if (!isActiveExternalClientGrant(grant)) throw new Error('External client connection is unavailable.');
    const descriptors = await host.catalog(grant);
    return { tools: descriptors.map(toMcpTool) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (
    request,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<CallToolResult> => {
    const grant = await host.resolveGrant(options.grantId);
    if (!isActiveExternalClientGrant(grant)) throw new Error('External client connection is unavailable.');
    const descriptors = await host.catalog(grant);
    const descriptor = descriptors.find((candidate) => candidate.name === request.params.name);
    if (descriptor === undefined) throw new Error(`External client tool is unavailable: ${request.params.name}`);
    const meta: ExternalClientCallMeta = {
      requestId: extra.requestId,
      transportSessionId: extra.sessionId ?? options.transportSessionId?.(),
      _meta: asRecord(extra._meta ?? request.params._meta),
    };
    try {
      const result = await host.call(grant, descriptor.name, asRecord(request.params.arguments), meta, extra.signal);
      return normalizeToolResult(result);
    } catch (error) {
      if (!(error instanceof ExternalClientError)) throw error;
      const structuredContent: Record<string, unknown> = {
        code: error.code,
        message: error.message,
        details: error.details,
      };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }
  });
  return server;
}

function toMcpTool(descriptor: ExternalClientToolDescriptor): Record<string, unknown> {
  return {
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    annotations: descriptor.annotations,
    execution: descriptor.execution,
    icons: descriptor.icons,
    _meta: descriptor._meta,
  };
}

function normalizeToolResult(value: unknown): CallToolResult {
  if (isRecord(value) && Array.isArray(value['content'])) return value as unknown as CallToolResult;
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
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
